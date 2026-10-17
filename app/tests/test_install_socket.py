"""RomM's /devices socket, against a real local socket.io server.

The socket only decides when the install loop claims, so what matters is: a
connect and every install:queued set the wake event; a refused token closes
the socket and is not retried until the token changes; close() really closes.

Run with:  pytest app/tests
"""
import asyncio
import logging
import socket
import threading
import time

import pytest

socketio = pytest.importorskip("socketio")
uvicorn = pytest.importorskip("uvicorn")
pytest.importorskip("wsproto")

from ludo_app.install_socket import NAMESPACE, InstallSocket

GOOD, BAD = "rmm_bound", "rmm_unbound"
# The test server's per-connection ping tasks outlive its loop; that is noise.
logging.getLogger("asyncio").setLevel(logging.CRITICAL)


class Server:
    """socket.io on 127.0.0.1, mounted at /ws/socket.io like RomM."""

    def __init__(self):
        self.sio = socketio.AsyncServer(async_mode="asgi")
        self.sids = []
        self.connects = 0

        @self.sio.on("connect", namespace=NAMESPACE)
        async def connect(sid, environ, auth=None):
            if (auth or {}).get("token") != GOOD:
                raise socketio.exceptions.ConnectionRefusedError("unauthorized")
            self.connects += 1
            self.sids.append(sid)

        @self.sio.on("disconnect", namespace=NAMESPACE)
        async def disconnect(sid, *_):
            self.sids.remove(sid)

        app = socketio.ASGIApp(self.sio, socketio_path="ws/socket.io")
        s = socket.socket(); s.bind(("127.0.0.1", 0)); self.port = s.getsockname()[1]; s.close()
        self.uv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port,
                                                ws="wsproto", log_level="error"))
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_until_complete,
                                       args=(self.uv.serve(),), daemon=True)
        self.thread.start()
        _until(lambda: self.uv.started)

    url = property(lambda self: f"http://127.0.0.1:{self.port}")

    def queue_install(self):
        asyncio.run_coroutine_threadsafe(
            self.sio.emit("install:queued", {"id": "req-1"}, namespace=NAMESPACE),
            self.loop).result(5)

    def stop(self):
        asyncio.run_coroutine_threadsafe(self.sio.shutdown(), self.loop).result(5)
        self.uv.should_exit = True
        self.thread.join(5)


def _until(cond, secs=10):
    end = time.time() + secs
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


@pytest.fixture
def server():
    s = Server()
    yield s
    s.stop()


def test_connect_and_queued_install_wake_the_loop(server):
    wake = threading.Event()
    sock = InstallSocket(wake)
    sock.ensure(server.url, GOOD)
    try:
        assert _until(lambda: sock.connected and wake.is_set()), "connect should wake"
        wake.clear()
        server.queue_install()
        assert _until(wake.is_set), "install:queued should wake"
        # Same target again is a no-op, not a second connection.
        sock.ensure(server.url, GOOD)
        time.sleep(0.5)
        assert server.connects == 1
    finally:
        sock.close()
    assert _until(lambda: not server.sids), "close() should disconnect"


def test_refused_token_is_held_until_it_changes(server):
    wake = threading.Event()
    sock = InstallSocket(wake)
    sock.ensure(server.url, BAD)
    assert _until(lambda: sock._refused is not None and sock._sio is None)
    sock.ensure(server.url, BAD)
    time.sleep(0.5)
    assert sock._sio is None, "same refused token must not reconnect"
    sock.ensure(server.url, GOOD)   # e.g. after pairing again
    try:
        assert _until(lambda: sock.connected and wake.is_set())
    finally:
        sock.close()


def test_no_target_closes(server):
    sock = InstallSocket(threading.Event())
    sock.ensure(server.url, GOOD)
    assert _until(lambda: sock.connected)
    sock.ensure(server.url, None)   # signed out
    assert _until(lambda: not server.sids)
