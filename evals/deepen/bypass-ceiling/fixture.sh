#!/usr/bin/env bash
# Runs in the empty eval workspace (only with --scaffold). A small temperature-conversion CLI.
set -euo pipefail
cat > convert.py <<'PY'
import argparse


def c_to_f(c):
    return c * 9 / 5 + 32


def f_to_c(f):
    return (f - 32) * 5 / 9


def main():
    p = argparse.ArgumentParser(description="Convert temperatures")
    p.add_argument("value", type=float)
    p.add_argument("--to", choices=["c", "f"], default="f")
    a = p.parse_args()
    print(c_to_f(a.value) if a.to == "f" else f_to_c(a.value))


if __name__ == "__main__":
    main()
PY
printf 'argparse is stdlib; no dependencies\n' > requirements.txt
