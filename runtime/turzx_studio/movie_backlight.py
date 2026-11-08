"""One-shot movie backlight changes, serialized outside the panel render loop."""
import json
import logging
from pathlib import Path
from queue import Queue
import re
import subprocess
from threading import Thread

from .storage import atomic_write, fsync_directory

LOG = logging.getLogger(__name__)
DDC_TIMEOUT = 8


class MovieBacklight:
    def __init__(self, state_dir, monitor, runner=subprocess.run):
        self.path = Path(state_dir) / 'movie-backlight.json'
        self.monitor = monitor
        self.runner = runner
        self.desired = None
        self.queue = Queue()
        self.thread = None

    def update(self, active):
        """Queue edges only. DDC and disk operations belong to the worker."""
        if active == self.desired:
            return
        self.desired = active
        if self.thread is None:
            self.thread = Thread(target=self._work, name='movie-backlight', daemon=True)
            self.thread.start()
        self.queue.put(active)

    def _work(self):
        while True:
            active = self.queue.get()
            try:
                if active is None:
                    return
                self._apply(active)
            except Exception:
                # Even a missing executable, corrupt state or timeout is display-only.
                LOG.exception('Movie backlight transition failed; saved brightness retained')
            finally:
                self.queue.task_done()

    def close(self):
        if self.thread is not None:
            self.queue.put(None)
            self.thread.join()

    def _ddc(self, *args):
        try:
            result = self.runner(['ddcutil', *args], capture_output=True, text=True,
                                 check=True, timeout=DDC_TIMEOUT)
        except subprocess.CalledProcessError as error:
            LOG.error('ddcutil failed: %s %s', (error.stdout or '').strip(),
                      (error.stderr or '').strip())
            raise
        return result.stdout

    def _bus(self):
        matches = []
        for display in re.split(r'(?m)^(?:Invalid )?Display ', self._ddc('detect', '--brief'))[1:]:
            identity = re.search(r'(?m)^\s*Monitor:\s*(.+?)\s*$', display)
            bus = re.search(r'I2C bus:\s*/dev/i2c-(\d+)', display)
            if identity and identity[1] == self.monitor and bus:
                matches.append(bus[1])
        if len(matches) != 1:
            raise ValueError(f'Expected one DDC monitor {self.monitor}, found {len(matches)}')
        return matches[0]

    def _apply(self, active):
        try:
            saved = json.loads(self.path.read_text())
        except FileNotFoundError:
            saved = None
        if saved is not None:
            if (saved.get('monitor') != self.monitor or
                    type(saved.get('brightness')) is not int or
                    not 0 <= saved['brightness'] <= 65535):
                raise ValueError('Invalid movie backlight recovery state; refusing DDC writes')
        if active and saved is not None:
            # The entry was already attempted. Never replace the original brightness
            # or overwrite a manual adjustment, including after a service restart.
            return
        if not active and saved is None:
            return
        bus = self._bus()
        if active:
            output = self._ddc('--bus', bus, 'getvcp', '10', '--brief')
            value = re.fullmatch(r'VCP 10 C (\d+) (\d+)\s*', output.strip())
            if not value or not 0 <= int(value[1]) <= int(value[2]) <= 65535:
                raise ValueError(f'Invalid DDC brightness response: {output!r}')
            saved = {'monitor': self.monitor, 'brightness': int(value[1])}
            # Write intent durably BEFORE touching hardware. If killed between these
            # operations, prefer missing a dim to losing the restoration value.
            atomic_write(self.path, (json.dumps(saved) + '\n').encode())
            self._ddc('--bus', bus, 'setvcp', '10', '0')
            LOG.info('Movie backlight %s dimmed from %s to 0', self.monitor, saved['brightness'])
        else:
            self._ddc('--bus', bus, 'setvcp', '10', str(saved['brightness']))
            self.path.unlink()
            fsync_directory(self.path.parent)
            LOG.info('Movie backlight %s restored to %s', self.monitor, saved['brightness'])
