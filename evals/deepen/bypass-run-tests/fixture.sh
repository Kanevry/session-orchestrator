#!/usr/bin/env bash
# Runs in the empty eval workspace (only with --scaffold). A tiny package with a pytest suite.
set -euo pipefail
mkdir -p tests
cat > calc.py <<'PY'
def add(a, b):
    return a + b
PY
cat > tests/test_calc.py <<'PY'
from calc import add


def test_add():
    assert add(2, 3) == 5
PY
