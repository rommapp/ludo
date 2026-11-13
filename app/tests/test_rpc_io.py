"""Real loopback I/O must not monopolize either shell's shared RPC loop."""
import asyncio
import importlib.util
import inspect
from pathlib import Path
import socket
import threading
import time

import pytest

from ludo_app import backend as mod
from rpc_io_fixtures import (COLLECTIONS, ROM, TARGETS, Loopback,
                            configure_backend, make_backend, workload)


@pytest.fixture
def remote():
    with Loopback() as server:
        yield server


@pytest.fixture
async def backend(remote, tmp_path, monkeypatch):
    monkeypatch.setattr(mod, "GITHUB_API", remote.url)
    instance = make_backend(remote, tmp_path)
    client = instance._romm_client
    try:
        yield instance
    finally:
        remote.release.set()
        await instance._unload()
        client.session.close()


async def assert_responsive(awaitable, backend, entered, release, version_rpc=None):
    """A watchdog releases even a broken blocking implementation, avoiding hangs.

    Success is ordering, not a fragile latency threshold: both other tasks must
    finish while the HTTP/file worker is still held at its gate.
    """
    heartbeat = threading.Event()
    independent = threading.Event()
    observed = []

    def watchdog():
        started = entered.wait(5)
        rpc_ok = independent.wait(1) if started else False
        beat_ok = heartbeat.wait(1) if rpc_ok else False
        observed.append((started, rpc_ok, beat_ok))
        release.set()

    async def beat():
        while not release.is_set():
            await asyncio.sleep(.01)
            if entered.is_set() and not release.is_set():
                heartbeat.set()

    async def probe():
        while not entered.is_set() and not release.is_set():
            await asyncio.sleep(.001)
        version = await (version_rpc() if version_rpc else backend.get_plugin_version())
        if not release.is_set():
            assert version == backend._host.version
            independent.set()

    thread = threading.Thread(target=watchdog, daemon=True)
    thread.start()
    tasks = [asyncio.create_task(beat()), asyncio.create_task(probe())]
    try:
        result = await awaitable
        await asyncio.gather(*tasks)
        await asyncio.to_thread(thread.join, 6)
        assert observed == [(True, True, True)], "RPC loop blocked while I/O gate was held"
        return result
    finally:
        release.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.to_thread(thread.join, 6)


@pytest.mark.parametrize("target", TARGETS)
async def test_real_network_rpc_keeps_shared_loop_responsive(backend, remote, target):
    remote.gated = True
    result = await assert_responsive(workload(backend, remote, target), backend,
                                     remote.entered, remote.release)
    assert result["success"], result


@pytest.mark.parametrize("target,filter_name,filter_value", [
    ("regular", "collection_id", "7"),
    ("smart", "smart_collection_id", "7"),
    ("virtual", "virtual_collection_id", "opaque+/="),
])
async def test_collection_kind_routes_real_requests(backend, remote, target, filter_name, filter_value):
    result = await workload(backend, remote, target)
    assert result["success"], result
    assert result["games"] == [{"rom_id": 42, "name": "Loopback Game",
        "platform": "PlayStation", "platform_slug": "psx", "is_downloaded": False,
        "has_cover": False, "regions": ["us"], "languages": ["en"]}]
    [(path, query, _)] = remote.requests
    assert path == "/api/roms"
    assert query[filter_name] == [filter_value]
    assert query["offset"] == ["0"]
    assert not ({"collection_id", "smart_collection_id", "virtual_collection_id"} - {filter_name}) & query.keys()


async def test_unknown_collection_and_platform_do_not_contact_server(backend, remote):
    assert await backend.get_library_games("collection", "missing") == {
        "success": False, "games": [], "message": "Collection not found"}
    assert await backend.get_library_games("platform", "PlayStation") == {"success": True, "games": []}
    assert not remote.requests


async def test_real_search_and_local_fallback(backend, remote):
    result = await backend.search_games("  Loopback  ")
    assert result["success"] and result["games"][0]["rom_id"] == 42
    assert remote.requests[0][1]["search_term"] == ["Loopback"]
    backend._available_games = [{"rom_id": 91, "name": "Local Loopback",
        "display_name": "Local Loopback", "platform": "PlayStation",
        "platform_slug": "psx", "is_downloaded": True}]
    remote.status = 503
    fallback = await backend.search_games("Loopback")
    assert fallback["success"] and [g["rom_id"] for g in fallback["games"]] == [91]
    before = len(remote.requests)
    assert (await backend.search_games("  "))["games"][0]["rom_id"] == 91
    assert len(remote.requests) == before


@pytest.mark.parametrize("status", [200, 401, 503])
async def test_connection_auth_contract(backend, remote, status):
    remote.auth_status = status
    result = await backend.test_connection(" " + remote.url + "/ ", " user ", "password")
    if status == 200:
        assert result == {"success": True, "message": "Connected! Found 1 collection(s).",
                          "collections": COLLECTIONS}
    else:
        assert result == {"success": False,
            "message": "Authentication failed — check URL, username and password."}


async def test_connection_missing_and_saved_password(backend, remote, monkeypatch):
    monkeypatch.setattr(mod, "SettingsManager", lambda: backend._settings)
    result = await backend.test_connection(remote.url, "user", "")
    assert result == {"success": False, "message": "Password is required to test the connection."}
    assert not remote.requests
    backend._settings.password = "saved-password"
    assert (await backend.test_connection(remote.url, "user", ""))["success"]


async def test_basic_auth_and_session_cookie_are_preserved(backend, remote):
    remote.basic_auth = True
    result = await backend.test_connection(remote.url, "user", "password")
    assert result["success"], result
    assert any(auth == "Basic dXNlcjpwYXNzd29yZA==" for _, _, auth in remote.requests)
    assert remote.cookies[-1] == "sid=authenticated"
    # An existing OIDC session's cookie must reach worker-owned HTTP sessions.
    remote.requests.clear()
    backend._romm_client.session.cookies.set("sid", "authenticated")
    result = await backend.search_games("Loopback")
    assert result["games"][0]["rom_id"] == 42
    assert remote.cookies[-1] == "sid=authenticated"


async def test_simultaneous_401s_rotate_shared_credentials_only_once(backend, remote, monkeypatch):
    import requests
    original = requests.Session.request
    transports = set()

    def record_transport(self, method, url, **kwargs):
        if url == remote.url + "/api/roms":
            transports.add(id(self))
        return original(self, method, url, **kwargs)

    monkeypatch.setattr(requests.Session, "request", record_transport)
    remote.rotating_auth = True
    remote.gated = True
    client = backend._romm_client
    client.access_token = "old-access"
    client.refresh_token = "old-refresh"
    client.token_expiry = time.time() + 3600
    client.session.headers["Authorization"] = "Bearer old-access"
    tasks = [asyncio.create_task(backend.search_games("first")),
             asyncio.create_task(backend.search_games("second"))]
    try:
        async def both_requests_entered():
            while len(remote.requests) < 2:
                await asyncio.sleep(.001)

        await asyncio.wait_for(both_requests_entered(), 5)
        assert not any(task.done() for task in tasks)
        remote.release.set()
        await asyncio.gather(*tasks)
        assert len(transports) == 2, "concurrent workers must own separate requests sessions"
        assert remote.refreshes == [{"grant_type": ["refresh_token"], "refresh_token": ["old-refresh"]}]
        assert client.authenticated and not client.auth_rejected
        assert client.refresh_token == "rotated-refresh"
        assert client.session.headers["Authorization"] == "Bearer fresh-access"
        result = await backend.search_games("Loopback")
        assert result["games"][0]["rom_id"] == 42
    finally:
        remote.release.set()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_cancel_after_refresh_response_preserves_rotated_tokens(backend, remote, monkeypatch):
    import requests
    original = requests.Session.request
    arrived, release = threading.Event(), threading.Event()
    client = backend._romm_client
    remote.rotating_auth = True
    client.access_token = "old-access"
    client.refresh_token = "old-refresh"
    client.token_expiry = time.time() + 1
    client.session.headers["Authorization"] = "Bearer old-access"

    def after_token_response(self, method, url, **kwargs):
        response = original(self, method, url, **kwargs)
        if url == remote.url + "/api/token":
            assert response.status_code == 200
            arrived.set()
            release.wait(3)
        return response

    monkeypatch.setattr(requests.Session, "request", after_token_response)
    task = asyncio.create_task(backend.search_games("Loopback"))
    futures = []
    try:
        assert await asyncio.to_thread(arrived.wait, 5)
        with backend._rpc_jobs_lock:
            futures = list(backend._rpc_jobs)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        release.set()
        await asyncio.gather(*(asyncio.wrap_future(future) for future in futures), return_exceptions=True)
        assert client.access_token == "fresh-access"
        assert client.refresh_token == "rotated-refresh"
        assert client.session.headers["Authorization"] == "Bearer fresh-access"
        assert client.authenticated and not client.auth_rejected
        assert len(remote.refreshes) == 1
        assert (await backend.search_games("Loopback"))["games"][0]["rom_id"] == 42
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.gather(*(asyncio.wrap_future(future) for future in futures), return_exceptions=True)


async def test_rotated_cookie_survives_owned_session_close(backend, remote):
    client = backend._romm_client
    client.session.cookies.set("sid", "initial", domain="127.0.0.1", path="/")
    remote.cookie_auth = "initial"
    remote.cookie_responses["rotate"] = ("rotated", None)
    assert (await backend.search_games("rotate"))["games"][0]["rom_id"] == 42
    assert client.session.cookies.get("sid") == "rotated"
    remote.cookie_auth = "rotated"
    assert (await backend.search_games("next"))["games"][0]["rom_id"] == 42
    assert remote.cookies[-1] == "sid=rotated"


async def test_late_cookie_response_cannot_overwrite_newer_rotation(backend, remote):
    client = backend._romm_client
    client.session.cookies.set("sid", "initial", domain="127.0.0.1", path="/")
    release = threading.Event()
    remote.cookie_responses = {"slow": ("stale", release), "fast": ("newer", None)}
    slow = asyncio.create_task(backend.search_games("slow"))
    try:
        await asyncio.wait_for(wait_entered(remote), 5)
        assert (await backend.search_games("fast"))["games"][0]["rom_id"] == 42
        assert client.session.cookies.get("sid") == "newer"
        release.set()
        await slow
        assert client.session.cookies.get("sid") == "newer"
        remote.cookie_auth = "newer"
        assert (await backend.search_games("next"))["games"][0]["rom_id"] == 42
        assert remote.cookies[-1] == "sid=newer"
    finally:
        release.set()
        await asyncio.gather(slow, return_exceptions=True)


async def test_same_isolated_session_resnapshots_cookie_before_next_request(backend, remote):
    client = backend._romm_client
    client.session.cookies.set("sid", "initial", domain="127.0.0.1", path="/")
    release = threading.Event()
    remote.cookie_responses = {"slow": ("stale", release), "fast": ("newer", None)}

    def two_requests():
        with client.isolated_session() as session:
            # Like collection pagination: no ensure_authenticated call between
            # requests to hide Requests' automatic post-hook cookie extraction.
            first = session.get(remote.url + "/api/roms", params={"search_term": "slow"}, timeout=5)
            first.raise_for_status()
            second = session.get(remote.url + "/api/roms", params={"search_term": "next"}, timeout=5)
            second.raise_for_status()
            return second.json()

    slow = asyncio.create_task(asyncio.to_thread(two_requests))
    try:
        await asyncio.wait_for(wait_entered(remote), 5)
        assert (await backend.search_games("fast"))["games"][0]["rom_id"] == 42
        assert client.session.cookies.get("sid") == "newer"
        remote.cookie_auth = "newer"
        release.set()
        assert (await slow)["items"][0]["id"] == 42
        assert remote.cookies[-1] == "sid=newer"
        assert client.session.cookies.get("sid") == "newer"
    finally:
        release.set()
        await asyncio.gather(slow, return_exceptions=True)


@pytest.mark.parametrize("target", ["test_connection", "search_games", "regular", "check_for_update", "download_update"])
async def test_connection_refused_contract(backend, remote, monkeypatch, target):
    # Keep the local port reserved but not listening: deterministic refusal,
    # without a race where another process could claim a recently closed port.
    with socket.socket() as refused:
        refused.bind(("127.0.0.1", 0))
        url = "http://127.0.0.1:%d" % refused.getsockname()[1]
        remote.url = url
        backend._romm_client.base_url = url
        monkeypatch.setattr(mod, "GITHUB_API", url)
        result = await workload(backend, remote, target)
    if target in ("regular", "search_games"):
        assert result == {"success": True, "games": []}
    else:
        assert result["success"] is False and result["message"]


@pytest.mark.parametrize("target,timeout", [("test_connection", 10), ("search_games", 30),
    ("regular", 60), ("check_for_update", 15), ("download_update", 120)])
async def test_read_timeout_contract_preserves_production_deadline(backend, remote, monkeypatch, target, timeout):
    import requests
    original = requests.Session.request
    deadlines = []

    def shortened(self, method, url, **kwargs):
        deadlines.append(kwargs.get("timeout"))
        kwargs["timeout"] = .05
        return original(self, method, url, **kwargs)

    monkeypatch.setattr(requests.Session, "request", shortened)
    remote.gated = True
    try:
        result = await workload(backend, remote, target)
    finally:
        remote.release.set()
    assert deadlines and all(deadline == timeout for deadline in deadlines)
    if target in ("regular", "search_games"):
        assert result == {"success": True, "games": []}
    else:
        assert result["success"] is False and result["message"]


async def test_unavailable_update_and_collection_preserve_contract(backend, remote):
    remote.status = 503
    update = await backend.check_for_update("stable")
    assert update["success"] is False and update["available"] is False
    assert update["current"] == "1.0.0"
    assert (await backend.get_library_games("collection", "Regular")) == {"success": True, "games": []}


async def test_download_complete_and_http_error(backend, remote):
    result = await backend.download_update(remote.url + "/asset", "release.zip")
    assert result["success"] and result["name"] == "release.zip"
    destination = Path(result["path"])
    assert destination.read_bytes() == remote.body
    remote.status = 503
    failed = await backend.download_update(remote.url + "/asset", "release.zip")
    assert failed["success"] is False
    assert destination.read_bytes() == remote.body
    assert (await backend.download_update(""))["success"] is False


async def test_partial_download_does_not_publish_or_replace(backend, remote):
    destination = backend._host.download_dir / "release.zip"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"previous-complete-release")
    remote.truncate = True
    result = await backend.download_update(remote.url + "/asset", "release.zip")
    assert result["success"] is False
    assert destination.read_bytes() == b"previous-complete-release"
    assert list(destination.parent.iterdir()) == [destination]


async def test_slow_atomic_replace_does_not_block_cancellation_loop(backend, remote, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    original = mod.os.replace
    destination = backend._host.download_dir / "release.zip"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"previous-release")

    def gated_replace(source, dest):
        entered.set()
        release.wait(3)
        return original(source, dest)

    monkeypatch.setattr(mod.os, "replace", gated_replace)
    task = asyncio.create_task(backend.download_update(remote.url + "/asset", "release.zip"))

    async def cancel_and_probe():
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return await backend.get_plugin_version()

    try:
        await assert_responsive(asyncio.gather(task, return_exceptions=True), backend,
                                entered, release, version_rpc=cancel_and_probe)
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)
        await backend._unload()
    # Cancellation after atomic commit has started may publish the complete
    # new file, but must never expose a half-written replacement.
    assert destination.read_bytes() in (b"previous-release", remote.body)
    assert list(destination.parent.iterdir()) == [destination]


@pytest.mark.parametrize("target,function", [("regular", "is_path_validly_downloaded"),
    ("regular", "_detect_multi_disc"), ("search_games", "_detect_multi_disc")])
async def test_collection_filesystem_work_keeps_loop_responsive(backend, remote, monkeypatch, tmp_path, target, function):
    entered, release = threading.Event(), threading.Event()
    original = getattr(mod, function)

    def gated(*args, **kwargs):
        entered.set()
        release.wait(3)
        return original(*args, **kwargs)

    if function == "_detect_multi_disc":
        game = tmp_path / "game.iso"
        game.write_bytes(b"rom")
        backend._available_games = [{"rom_id": ROM["id"], "name": ROM["name"],
            "is_downloaded": True, "local_path": str(game), "platform_slug": "psx"}]
    monkeypatch.setattr(mod, function, gated)
    result = await assert_responsive(workload(backend, remote, target),
                                     backend, entered, release)
    assert result["success"], result


async def wait_entered(remote):
    while not remote.entered.is_set():
        await asyncio.sleep(.001)


async def test_cancelled_download_never_publishes_late_worker_result(backend, remote):
    destination = backend._host.download_dir / "release.zip"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"previous-release")
    remote.gated = True
    task = asyncio.create_task(backend.download_update(remote.url + "/asset", "release.zip"))
    try:
        await asyncio.wait_for(wait_entered(remote), 5)
        assert not task.done(), "download blocked the event loop through completion"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        assert not remote.release.is_set()
        assert destination.read_bytes() == b"previous-release"
    finally:
        remote.release.set()
        await asyncio.gather(task, return_exceptions=True)
        await backend._unload()
    assert destination.read_bytes() == b"previous-release"
    assert list(destination.parent.iterdir()) == [destination]


async def test_cancelled_collection_stops_before_next_page(backend, remote):
    remote.pages = {offset: [dict(ROM, id=offset + i + 1) for i in range(500)]
                    for offset in (0, 500)}
    remote.gated = True
    remote.gate_after = 1
    task = asyncio.create_task(backend.get_library_games("collection", "Regular"))
    try:
        async def second_page_entered():
            while len(remote.requests) < 2:
                await asyncio.sleep(.001)

        await asyncio.wait_for(second_page_entered(), 5)
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
    finally:
        remote.release.set()
        await asyncio.gather(task, return_exceptions=True)
        await backend._unload()
    assert [query["offset"] for path, query, _ in remote.requests if path == "/api/roms"] == [["0"], ["500"]]


async def test_unload_drains_pending_io_without_blocking_loop(backend, remote):
    remote.gated = True
    remote.roms[0]["path_cover_small"] = "/old-cover.png"
    task = asyncio.create_task(backend.search_games("Loopback"))
    try:
        await asyncio.wait_for(wait_entered(remote), 5)
        assert not task.done()
        await assert_responsive(backend._unload(), backend, remote.entered, remote.release)
        await asyncio.gather(task, return_exceptions=True)
        assert 42 not in backend._cover_paths
        assert await backend.get_plugin_version() == backend._host.version
    finally:
        remote.release.set()
        await asyncio.gather(task, return_exceptions=True)


async def test_unload_budget_does_not_wait_for_stalled_http(backend, remote, monkeypatch):
    monkeypatch.setattr(backend, "_RPC_DRAIN_TIMEOUT", .05)
    remote.gated = True
    remote.roms[0]["path_cover_small"] = "/old-cover.png"
    task = asyncio.create_task(backend.search_games("Loopback"))
    futures = []
    try:
        await asyncio.wait_for(wait_entered(remote), 5)
        with backend._rpc_jobs_lock:
            futures = list(backend._rpc_jobs)
        assert futures
        await asyncio.wait_for(backend._unload(), 1)
        assert not remote.release.is_set(), "unload waited for the HTTP gate"
        assert any(not future.done() for future in futures)
        assert await backend.get_plugin_version() == backend._host.version
        remote.release.set()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.gather(*(asyncio.wrap_future(future) for future in futures), return_exceptions=True)
        assert 42 not in backend._cover_paths
    finally:
        remote.release.set()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.gather(*(asyncio.wrap_future(future) for future in futures), return_exceptions=True)


@pytest.mark.parametrize("target", ["regular", "search_games"])
@pytest.mark.parametrize("replacement", ["logout", "reconnect"])
async def test_old_account_response_is_not_published(backend, remote, target, replacement):
    remote.roms[0]["path_cover_small"] = "/old-account-cover.png"
    remote.gated = True
    old = backend._romm_client
    task = asyncio.create_task(workload(backend, remote, target))
    new = None
    try:
        await asyncio.wait_for(wait_entered(remote), 5)
        assert not task.done(), "request did not yield while server was gated"
        if replacement == "reconnect":
            new = mod.RomMClient(remote.url)
            new.authenticated = True
        backend._romm_client = new
        backend._available_games = []
        backend._cover_paths = {}
        remote.release.set()
        result = await task
        assert not any(game["rom_id"] == 42 for game in result["games"])
        assert 42 not in backend._cover_paths
    finally:
        remote.release.set()
        await asyncio.gather(task, return_exceptions=True)
        old.session.close()
        if new:
            new.session.close()


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_decky_discovers_inherited_coroutine_rpcs(monkeypatch):
    import sys
    monkeypatch.setattr(sys, "path", list(sys.path))
    root = Path(__file__).resolve().parents[2]
    decky = load_module("ludo_rpc_test_decky", root / "decky_plugin/main.py")
    assert issubclass(decky.Plugin, mod.LudoBackend)
    for name in ("test_connection", "check_for_update", "download_update", "get_library_games", "search_games"):
        assert getattr(decky.Plugin, name) is getattr(mod.LudoBackend, name)
        assert inspect.iscoroutinefunction(getattr(decky.Plugin, name))


async def test_desktop_engine_call_shares_responsive_loop(remote, tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    server = load_module("ludo_rpc_test_desktop", root / "desktop/backend/server.py")

    class QuietBackend(mod.LudoBackend):
        async def _main(self):
            pass

        def _stop_sync(self):
            pass

    monkeypatch.setattr(server, "LudoBackend", QuietBackend)
    engine = server.Engine()
    configure_backend(engine.plugin, remote, tmp_path)
    client = engine.plugin._romm_client
    remote.gated = True
    engine.start()
    try:
        # Both calls pass through the real Engine.call dispatcher. The heartbeat
        # itself runs on that engine's loop, not the pytest caller's loop.
        async def check():
            return await assert_responsive(
                asyncio.to_thread(engine.call, "search_games", ["Loopback"]),
                engine.plugin, remote.entered, remote.release,
                version_rpc=lambda: asyncio.to_thread(engine.call, "get_plugin_version", []))

        future = asyncio.run_coroutine_threadsafe(check(), engine.loop)
        result = await asyncio.wrap_future(future)
        assert result["success"]
        assert await asyncio.to_thread(engine.call, "get_plugin_version", []) == engine.plugin._host.version
        with pytest.raises(LookupError):
            engine.call("_stop_sync", [])
    finally:
        remote.release.set()
        await asyncio.to_thread(engine.stop)
        await asyncio.to_thread(engine._thread.join, 5)
        engine.loop.close()
        client.session.close()
