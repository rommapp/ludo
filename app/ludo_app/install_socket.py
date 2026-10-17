"""RomM's ``/devices`` socket: a nudge when an install is queued for this device.

The socket carries no install details. Every request is still read through the
claim endpoint, so this only decides *when* the install loop claims: on connect
(anything queued while we were away) and on ``install:queued``. The loop's own
timed claim stays as the fallback for a socket that is down or never opens.
"""
import logging
import threading

try:
    import socketio
except ImportError:  # an older bundle without the dependency: polling only
    socketio = None

NAMESPACE = '/devices'
SOCKET_PATH = 'ws/socket.io'
# The server refuses with these; retrying the same token cannot succeed.
REFUSALS = {'unauthorized', 'disabled'}


class InstallSocket:
    """One socket per (url, token). ``wake`` is set whenever a claim is due."""

    def __init__(self, wake: threading.Event):
        self._wake = wake
        self._lock = threading.Lock()
        self._sio = None
        self._target = None
        self._refused = None   # target the server refused; held off until it changes

    @property
    def connected(self):
        return bool(self._sio and self._sio.connected)

    def ensure(self, url, token, verify=True):
        """Keep a socket open for this target, or close it when there is none."""
        target = (url.rstrip('/'), token) if (url and token) else None
        with self._lock:
            if target is None or socketio is None:
                self._close()
                return
            if target == self._refused:
                return
            if target == self._target and self._sio is not None:
                return
            self._close()
            self._refused = None
            self._target = target
            sio = self._sio = self._build(verify)
        threading.Thread(target=self._open, args=(sio, target), daemon=True,
                         name='romm-device-socket').start()

    def close(self):
        with self._lock:
            self._close()

    def _close(self):
        sio, self._sio, self._target = self._sio, None, None
        if sio is not None:
            try:
                sio.disconnect()
            except Exception:
                pass

    def _build(self, verify):
        sio = socketio.Client(reconnection=True, reconnection_delay=1,
                              reconnection_delay_max=60, randomization_factor=0.5,
                              ssl_verify=verify, logger=False, engineio_logger=False)

        @sio.on('connect', namespace=NAMESPACE)
        def _connected():
            logging.info('[INSTALL] device socket connected')
            self._wake.set()

        @sio.on('install:queued', namespace=NAMESPACE)
        def _queued(*_):
            logging.info('[INSTALL] RomM queued an install for this device')
            self._wake.set()

        @sio.on('connect_error', namespace=NAMESPACE)
        def _refused(data=None):
            reason = (data or {}).get('message') if isinstance(data, dict) else data
            if reason in REFUSALS:
                logging.info(f'[INSTALL] device socket refused: {reason}')
                with self._lock:
                    if self._sio is sio:
                        self._refused = self._target
                        threading.Thread(target=self._close_if, args=(sio,),
                                         daemon=True).start()
        return sio

    def _close_if(self, sio):
        with self._lock:
            if self._sio is sio:
                self._close()

    def _open(self, sio, target):
        url, token = target
        try:
            sio.connect(url, namespaces=[NAMESPACE], auth={'token': token},
                        socketio_path=SOCKET_PATH, transports=['websocket'],
                        wait_timeout=15, retry=True)
        except Exception as e:
            # A refusal lands in _refused; anything else just means polling for now.
            logging.debug(f'[INSTALL] device socket not open: {e}')
