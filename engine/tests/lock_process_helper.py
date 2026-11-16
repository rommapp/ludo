"""Real subprocess lock probe, with a line protocol and bounded handshakes."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading

ENGINE = Path(__file__).resolve().parents[1]
ROOT = ENGINE.parent
TIMEOUT = 15


class LockProcess:
    def __init__(self, path, kind='plain'):
        self.output = []
        self.messages = queue.Queue()
        env = dict(os.environ, PYTHONPATH=os.pathsep.join((str(ENGINE), str(ROOT / 'app'))),
                   PYTHONDONTWRITEBYTECODE='1')
        self.process = subprocess.Popen(
            [sys.executable, '-u', str(Path(__file__).resolve()), kind, str(path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', env=env)

        def read():
            for line in self.process.stdout:
                self.output.append(line)
                if line.startswith('LOCKTEST '):
                    self.messages.put(json.loads(line[9:]))
            self.messages.put({'eof': True})
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        try:
            self.acquired = self.receive()['acquired']
        except BaseException:
            self.close()
            raise

    def receive(self):
        try:
            result = self.messages.get(timeout=TIMEOUT)
        except queue.Empty:
            raise AssertionError('lock worker timed out: ' + ''.join(self.output))
        if 'eof' in result:
            raise AssertionError('lock worker exited: ' + ''.join(self.output))
        return result

    def command(self, command):
        self.process.stdin.write(command + '\n')
        self.process.stdin.flush()
        return self.receive()

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=TIMEOUT)
        self.reader.join(timeout=TIMEOUT)
        self.process.stdin.close()
        self.process.stdout.close()


def main():
    sys.path[:0] = [str(ENGINE), str(ROOT / 'app')]
    from romm_sync_engine.process_lock import ProcessLock
    kind, path = sys.argv[1], Path(sys.argv[2])
    if kind == 'auto':
        from romm_sync_engine import sync_core
        sync_core.config_dir = lambda: path.parent
        lock = sync_core.AutoSyncLock()
        acquire = lambda: lock.acquire('process-test')
    elif kind == 'install':
        from ludo_app import backend
        backend.CONFIG_DIR = path.parent
        lock = backend.LudoBackend._take_install_lock()
        acquire = lambda: lock is not None
    else:
        lock = ProcessLock(path)
        acquire = lambda: lock.acquire(b'process-test\n')
    print('LOCKTEST ' + json.dumps({'acquired': acquire()}), flush=True)
    for command in sys.stdin:
        command = command.strip()
        if command == 'release':
            if lock:
                lock.release()
            result = {'released': True}
        elif command == 'acquire':
            result = {'acquired': acquire()}
        elif command == 'discard':
            lock = None
            import gc
            gc.collect()
            result = {'discarded': True}
        elif command == 'crash':
            os._exit(23)
        else:
            raise ValueError(command)
        print('LOCKTEST ' + json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
