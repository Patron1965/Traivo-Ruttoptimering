"""Local-only retention and one OS lock shared by all real-road sample users."""
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import stat

RETENTION = dt.timedelta(days=30)
ROOT = Path(__file__).resolve().parents[1] / ".cache/district-road"


def development_only():
    if os.environ.get("REPLIT_DEPLOYMENT") == "1" or os.environ.get("NODE_ENV") == "production":
        raise RuntimeError("District sample retention is development-only.")


def regular_file(path):
    """Never follow links or touch directories/devices masquerading as cache files."""
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(mode):
        raise RuntimeError("Unsafe district cache file type.")
    return True


@contextlib.contextmanager
def cache_lock(root=ROOT):
    development_only()
    root = Path(root)
    if root.is_symlink():
        raise RuntimeError("District cache directory must not be a symlink.")
    root.mkdir(parents=True, exist_ok=True)
    fd = os.open(root / "geocoding.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError("Unsafe district cache lock.")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def save(path, value):
    # Called under cache_lock, including by geocoding. Never truncate a linked file.
    regular_file(path)
    temporary = path.with_suffix(".tmp")
    regular_file(temporary)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, ensure_ascii=False, default=str)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def expired(value, now):
    try:
        verified = dt.datetime.fromisoformat(value["verifiedAt"].replace("Z", "+00:00"))
        if verified.tzinfo is None:
            return True
        return verified > now or now >= verified + RETENTION
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return True  # Unverifiable provider data must not survive indefinitely.


def tombstone(value):
    return {
        "accepted": False, "reason": "expired_requires_new_approval",
        **({"verifiedAt": value["verifiedAt"]} if isinstance(value.get("verifiedAt"), str) else {}),
    }


def has_provider_data(value):
    return value.get("accepted") is True or any(
        key in value for key in ("latitude", "longitude", "placeId", "locationType")
    )


def cleanup_expired(root=ROOT, now=None):
    """Caller MUST own cache_lock. Whitelist only; never recurse or reset calls."""
    development_only()
    root = Path(root)
    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Retention clock must have a timezone.")
    removed = 0
    sample_expired = False
    for name, field in (("geocoding-state.json", "results"), ("real-stenungsund-500.json", "rows")):
        path = root / name
        if not regular_file(path):
            if field == "rows":
                sample_expired = True
            continue
        value = json.loads(path.read_text())
        entries = value[field]
        if field == "results":
            # A corrupt/missing budget is an error, never a fresh allowance.
            if type(value.get("calls")) is not int or value["calls"] < 0 or not isinstance(entries, dict):
                raise RuntimeError("Invalid district call journal; manual recovery required.")
            iterable = entries.items()
        else:
            if not isinstance(entries, list):
                raise RuntimeError("Invalid district sample; manual recovery required.")
            iterable = enumerate(entries)
            sample_expired = not entries or any(expired(row, now) for row in entries)
        changed = False
        for key, entry in iterable:
            if has_provider_data(entry) and expired(entry, now):
                replacement = tombstone(entry)
                if field == "rows":
                    # Original source values are not Google output.
                    replacement.update({k: entry[k] for k in (
                        "sourceRowNumber", "objectNumber", "address", "original"
                    ) if k in entry})
                entries[key] = replacement
                changed = True
                removed += 1
        if changed:
            save(path, value)
    # Crash leftovers can contain coordinates. They are not authoritative journal
    # commits and cannot safely be promoted over the durable reserved-call count.
    for name in ("geocoding-state.tmp", "real-stenungsund-500.tmp"):
        path = root / name
        if regular_file(path):
            path.unlink()
    # These derived artifacts contain provider-linked locations. CSV/XLSX contain
    # source columns only; provenance, measurements and road datasets stay intact.
    for name in ("stenungsund-500-loop.geojson", "actual-loop-preview.png"):
        path = root / name
        if sample_expired and regular_file(path):
            path.unlink()
    return removed