"""Shared offline regeneration estimates from manually observed game counts.

No account lookup, spending simulation, reserve resources, or layout state.
All writers use a stable sibling lock file; snapshots only read the atomically
replaced state file and never create directories. The revision describes the
saved anchors, not the estimates that advance with the clock.
"""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
import time
from typing import Callable


MAX_BYTES = 64 * 1024
MAX_COUNT = 10000
# Normal regeneration caps, excluding separately stored reserve resources.
# Caps: https://www.hoyoverse.com/en-us/news/124031
#       https://www.hoyolab.com/article/33610162
# Game-screen rates: https://img.game8.jp/6283764/dd12de3a4009bffe680db11931f5e19b.png/original
#                    https://resource.supercheats.com/library/supercheats/740w/2024/1720986268wuwawaveplates1.webp
# Reproduced ZZZ item text: https://zzz.honeyhunterworld.com/501-item/?lang=EN
_GAMES = (
    ('genshin', 'Genshin Impact', 'Original Resin', 200, 480),
    ('wuwa', 'Wuthering Waves', 'Waveplate', 240, 360),
    ('zzz', 'Zenless Zone Zero', 'Battery Charge', 240, 360),
)
_IDS = frozenset(game[0] for game in _GAMES)
_TIMESTAMP = re.compile(
    r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})\Z'
)


class GameRevisionConflict(ValueError):
    """The supplied revision no longer matches the saved anchors."""


class GameStateUnavailable(ValueError):
    """State cannot be safely edited; existing bytes remain untouched."""


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def _timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not _TIMESTAMP.fullmatch(value):
        raise ValueError('observed_at must be an ISO timestamp with a timezone')
    if value[-1] != 'Z' and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
        raise ValueError('observed_at must have a valid timezone offset')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)
    except (ValueError, OverflowError) as error:
        raise ValueError('observed_at must be a valid ISO timestamp') from error
    return parsed


def _count(value: object) -> int:
    if type(value) is not int or not 0 <= value <= MAX_COUNT:
        raise ValueError(f'count must be an integer from 0 to {MAX_COUNT}')
    return value


def _encode(anchors: dict) -> bytes:
    return (json.dumps({'anchors': anchors}, sort_keys=True, separators=(',', ':'),
                       allow_nan=False) + '\n').encode('utf-8')


def _revision(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _pairs(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate game timer state field')
        result[key] = value
    return result


def _validate(raw: object) -> dict:
    if type(raw) is not dict or set(raw) != {'anchors'}:
        raise ValueError('Game timer state requires exactly anchors')
    anchors = raw['anchors']
    if type(anchors) is not dict or len(anchors) > 3 or not set(anchors) <= _IDS:
        raise ValueError('Game timer state accepts at most the three supported games')
    result = {}
    for identifier, anchor in anchors.items():
        if type(anchor) is not dict or set(anchor) != {'count', 'observedAt'}:
            raise ValueError('Game timer anchors require exactly count and observedAt')
        result[identifier] = {
            'count': _count(anchor['count']),
            'observedAt': _iso(_timestamp(anchor['observedAt'])),
        }
    return result


class GameResources:
    """A shared anchor file. All returned dictionaries are detached.

    set_timer and clear accept an optional snapshot revision as if_match.
    Invalid inputs raise ValueError; stale revisions raise GameRevisionConflict;
    corrupt or unreadable state raises GameStateUnavailable on mutation.
    """

    def __init__(self, state_path: Path, clock: Callable[[], float] = time.time) -> None:
        self.path = Path(os.path.abspath(state_path))
        self.clock = clock
        self._lock = threading.RLock()

    def _now(self) -> datetime:
        return datetime.fromtimestamp(self.clock(), timezone.utc)

    def _read(self) -> tuple[dict | None, str, str]:
        data = b''
        try:
            descriptor = os.open(self.path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError('Game timer state must be a regular file')
                data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError('Game timer state exceeds 64 KiB')
            anchors = _validate(json.loads(data.decode('utf-8'), object_pairs_hook=_pairs))
            return anchors, _revision(data), ''
        except FileNotFoundError:
            return {}, _revision(_encode({})), ''
        except (OSError, ValueError, RecursionError) as error:
            # Never disclose raw state or paths in a displayed error.
            reason = str(error) if isinstance(error, ValueError) and not isinstance(
                error, (json.JSONDecodeError, UnicodeError)
            ) else 'Game timer state is unreadable or invalid'
            revision_data = data or ('unavailable:' + type(error).__name__).encode()
            return None, _revision(revision_data), reason

    def _snapshot(self, anchors: dict | None, revision: str, note: str, now: datetime) -> dict:
        rows = []
        for identifier, name, resource, capacity, interval in _GAMES:
            row = {'id': identifier, 'name': name, 'resource': resource,
                   'current': None, 'capacity': capacity, 'status': 'not-configured',
                   'observedAt': None, 'fullAt': None,
                   'note': 'Set a count observed in the game to start this timer.'}
            if anchors is None:
                row.update(status='unavailable', note=note)
            elif identifier in anchors:
                anchor = anchors[identifier]
                observed = _timestamp(anchor['observedAt'])
                if observed > now:
                    row.update(status='unavailable', observedAt=anchor['observedAt'],
                               note='Check timer: set time is ahead.')
                    rows.append(row)
                    continue
                count = anchor['count']
                steps = int((now - observed).total_seconds() // interval)
                current = count if count >= capacity else min(capacity, count + steps)
                row.update(current=current, observedAt=anchor['observedAt'],
                           status='full' if current >= capacity else 'estimate',
                           note='Estimated from your saved count. Update after spending or refilling.')
                if current < capacity:
                    row['fullAt'] = _iso(observed + timedelta(seconds=(capacity - count) * interval))
                else:
                    row['note'] = 'Estimated full. Update after spending or refilling.'
                    if count > capacity:
                        row['note'] = 'Saved count exceeds the regeneration cap; no regeneration added.'
            rows.append(row)
        return {'games': rows, 'observedAt': _iso(now), 'revision': revision}

    def snapshot(self) -> dict:
        now = self._now()
        return self._snapshot(*self._read(), now)

    @contextmanager
    def _write_lock(self):
        # Do not unlink this inode: another process may already be waiting on it.
        with self._lock:
            self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            lock_path = self.path.with_name(self.path.name + '.lock')
            descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            try:
                if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                    raise GameStateUnavailable('Game timer lock must be a regular file')
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                os.fchmod(descriptor, 0o600)
                yield
            finally:
                os.close(descriptor)

    def _write(self, data: bytes) -> None:
        descriptor, temporary = tempfile.mkstemp(prefix='.' + self.path.name + '.', dir=self.path.parent)
        try:
            with os.fdopen(descriptor, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def _update(self, game_id: str, count: int | None, observed_at: str | None,
                if_match: str | None) -> dict:
        if not isinstance(game_id, str) or game_id not in _IDS:
            raise ValueError('game_id must be genshin, wuwa or zzz')
        if if_match is not None and (not isinstance(if_match, str) or not if_match):
            raise ValueError('if_match must be a nonempty revision string')
        with self._write_lock():
            now = self._now()
            observed = now if observed_at is None else _timestamp(observed_at)
            if observed > now:
                raise ValueError('observed_at must not be in the future')
            anchors, revision, note = self._read()
            if anchors is None:
                raise GameStateUnavailable(note)
            if if_match is not None and if_match != revision:
                raise GameRevisionConflict('Game timers changed; reload before saving again')
            before = _encode(anchors)
            if count is None:
                anchors.pop(game_id, None)
            else:
                anchors[game_id] = {'count': count, 'observedAt': _iso(observed)}
            data = _encode(anchors)
            if data != before:
                self._write(data)
                revision = _revision(data)
            return self._snapshot(anchors, revision, '', now)

    def set_timer(self, game_id: str, count: int, observed_at: str | None = None,
                  if_match: str | None = None) -> dict:
        return self._update(game_id, _count(count), observed_at, if_match)

    def clear(self, game_id: str, if_match: str | None = None) -> dict:
        return self._update(game_id, None, None, if_match)
