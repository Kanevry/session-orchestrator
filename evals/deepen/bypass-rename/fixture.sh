#!/usr/bin/env bash
# Runs in the empty eval workspace (only with --scaffold). One small module with a variable `tmp`.
set -euo pipefail
cat > worker.py <<'PY'
import time


def fetch_with_retry(fetch, attempts=3):
    tmp = 0
    while tmp < attempts:
        try:
            return fetch()
        except ConnectionError:
            tmp += 1
            time.sleep(2 ** tmp)
    raise RuntimeError(f"gave up after {tmp} attempts")
PY
