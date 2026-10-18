"""Activity rows that carry a button (a declined install's Turn on).

resolve_action marks the matching rows done so the row says what happened
instead of offering the button again, and survives a reload from disk.
"""
from romm_sync_engine import activity_log


def test_resolve_marks_matching_rows_done(tmp_path, monkeypatch):
    monkeypatch.setattr(activity_log, "_file", lambda: tmp_path / "activity.json")
    monkeypatch.setattr(activity_log, "_loaded", False)
    activity_log._entries.clear()
    activity_log.record('error', 'declined c64', action={'kind': 'enable_platform', 'platform': 'c64'})
    activity_log.record('error', 'declined gb', action={'kind': 'enable_platform', 'platform': 'gb'})
    activity_log.record('save', 'plain row')

    assert activity_log.resolve_action('enable_platform', platform='c64') == 1
    assert activity_log.resolve_action('enable_platform', platform='c64') == 0

    activity_log._entries.clear()
    monkeypatch.setattr(activity_log, "_loaded", False)
    rows = {e['title']: e for e in activity_log.get_recent()}
    assert rows['declined c64']['action']['done'] is True
    assert 'done' not in rows['declined gb']['action']
    assert 'action' not in rows['plain row']


def test_take_pending_removes_only_waiting_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(activity_log, "_file", lambda: tmp_path / "activity.json")
    monkeypatch.setattr(activity_log, "_loaded", False)
    activity_log._entries.clear()
    activity_log.record('error', 'old', action={'kind': 'enable_platform', 'platform': 'c64', 'done': True})
    activity_log.record('error', 'waiting', action={'kind': 'enable_platform', 'platform': 'c64', 'count': 2})
    activity_log.record('error', 'other', action={'kind': 'enable_platform', 'platform': 'gb'})
    taken = activity_log.take_pending('enable_platform', platform='c64')
    assert [e['title'] for e in taken] == ['waiting']
    assert [e['title'] for e in activity_log.get_recent()] == ['other', 'old']
