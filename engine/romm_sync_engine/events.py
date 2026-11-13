"""Change nudges from the engine to whatever UI is attached.

The UI used to find out about things by asking on a timer: is there a toast
queued, a save conflict waiting, a play session synced, a connection change?
Each of those has exactly one place in the engine where it happens, so the
engine says so there instead, and the UI fetches the detail through the same
RPC it always used.

A nudge carries only a topic name, never the data. That keeps one source of
truth (the RPC), makes a duplicate or a missed nudge harmless (the UI refetches
and gets the current answer; its slow fallback poll covers a lost one), and
lets each host deliver it however suits it: Decky's event bridge on a Deck, a
long-poll on the desktop.

Topics:
    notifications  a toast was queued            -> drain_notifications
    conflicts      a save conflict was parked     -> get_save_conflicts
    session        a play session's sync finished -> get_sync_epoch
    connection     connection / library-load state changed
                                                  -> get_service_status(lite)
    game           an emulator started or closed  -> game_running
    downloads      a download started, changed phase or ended
                                                  -> get_downloads
"""
import logging
import threading
import time

TOPICS = ('notifications', 'conflicts', 'session', 'connection', 'game', 'downloads')

_sinks = []
_lock = threading.Lock()


def add_sink(fn):
    """Register `fn(topic)`; returns a function that removes it.

    Sinks are called on whatever thread published, often an engine worker, so
    they must hand off to their own loop rather than doing work inline.
    """
    with _lock:
        _sinks.append(fn)

    def remove():
        with _lock:
            if fn in _sinks:
                _sinks.remove(fn)
    return remove


# A library fetch moves its progress every chunk; the UI only needs a nudge
# every so often, as long as the last one lands after the last change.
MIN_INTERVAL = 0.25

_last_sent = {}
_trailing = {}


def _deliver(topic):
    with _lock:
        sinks = list(_sinks)
        _last_sent[topic] = time.monotonic()
        _trailing.pop(topic, None)
    for fn in sinks:
        try:
            fn(topic)
        except Exception as e:  # a broken sink must not break the engine
            logging.debug(f"event sink failed for {topic}: {e}")


def publish(topic):
    """Tell every attached UI that `topic` changed. Never raises.

    At most one nudge per topic per MIN_INTERVAL; a burst inside the window is
    folded into one trailing nudge at its end, so the UI always hears about the
    final change.
    """
    with _lock:
        if not _sinks:
            return
        wait = MIN_INTERVAL - (time.monotonic() - _last_sent.get(topic, 0.0))
        if wait > 0:
            if topic not in _trailing:
                t = threading.Timer(wait, _deliver, args=(topic,))
                t.daemon = True
                _trailing[topic] = t
                t.start()
            return
    _deliver(topic)
