"""No network or DB access. Periodic cleanup or a lease for the TS acceptance."""
import argparse
import sys
import time

from district_cache import ROOT, cache_lock, cleanup_expired


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--watch", action="store_true")
    mode.add_argument("--hold-lock", action="store_true")
    mode.add_argument("--hold-lock-only", action="store_true")
    args = parser.parse_args()
    while True:
        try:
            with cache_lock(ROOT):
                if not args.hold_lock_only:
                    cleanup_expired(ROOT)
                if args.hold_lock or args.hold_lock_only:
                    print("LOCKED", flush=True)
                    # EOF also releases the lock if the parent is killed.
                    sys.stdin.buffer.read()
                    if not args.hold_lock_only:
                        cleanup_expired(ROOT)
        except BlockingIOError:
            if not args.watch:
                print("District sample is in use; no files changed.", file=sys.stderr)
                raise SystemExit(75)  # Temporary contention, not a retention failure.
        except Exception:
            # Do not expose private data from malformed files in logs.
            print("District retention failed; inspect local cache safely.", file=sys.stderr, flush=True)
            if not args.watch:
                raise SystemExit(1)
        if not args.watch:
            return
        time.sleep(60)


if __name__ == "__main__":
    main()