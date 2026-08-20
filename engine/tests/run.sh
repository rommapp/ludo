#!/usr/bin/env bash
# Run the engine's test suite.
#
# These are NOT pytest tests. Each file is a standalone script with its own
# check() harness and a main() returning an exit code, so `pytest tests/`
# collects nothing and exits 0 — a green run that tested absolutely nothing.
# This script is the supported way in: it runs each file and fails loudly.
#
#   engine/tests/run.sh              # run everything
#   engine/tests/run.sh keys eden    # only files whose name matches
#
# Interpreter, in order of preference:
#   $LUDO_TEST_PYTHON  — an explicit choice, used as-is
#   the first python3 on PATH that can already import the engine's deps
#   engine/.venv-tests — created and populated on first use (needs network)
#
# The host may have no importable deps at all (the Silverblue case), which is
# why the venv fallback exists rather than an error telling you to sort it out.
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
engine=$(dirname "$here")

# What sync_core imports at MODULE scope, and so what an interpreter must
# already have before it can run anything here.
deps=(requests watchdog psutil)
# Not required, but installed into a venv we build ourselves so it resembles
# production: cryptography is imported lazily inside SettingsManager and falls
# back to plaintext storage when absent, and Pillow likewise only warns. Making
# either mandatory would reject interpreters that run the suite perfectly well
# — and Pillow in particular needs a build toolchain this has no business
# demanding.
extras=(cryptography)

have_deps() {
    "$1" - "${deps[@]}" <<'PY' >/dev/null 2>&1
import importlib.util, sys
sys.exit(0 if all(importlib.util.find_spec(m) for m in sys.argv[1:]) else 1)
PY
}

pick_python() {
    if [ -n "${LUDO_TEST_PYTHON:-}" ]; then
        echo "$LUDO_TEST_PYTHON"; return
    fi
    for candidate in python3 python; do
        command -v "$candidate" >/dev/null 2>&1 || continue
        if have_deps "$candidate"; then echo "$candidate"; return; fi
    done
    local venv="$engine/.venv-tests"
    if [ ! -x "$venv/bin/python" ]; then
        echo "No Python here has the engine's dependencies — building $venv" >&2
        python3 -m venv "$venv" >&2 || return 1
        "$venv/bin/pip" install --quiet --upgrade pip >&2
        "$venv/bin/pip" install --quiet "${deps[@]}" "${extras[@]}" >&2 || return 1
    fi
    echo "$venv/bin/python"
}

py=$(pick_python) || { echo "Could not find or build a usable Python." >&2; exit 2; }
have_deps "$py" || { echo "$py is missing the engine's dependencies." >&2; exit 2; }

files=()
for f in "$here"/test_*.py; do
    [ -e "$f" ] || continue
    if [ $# -gt 0 ]; then
        for pattern in "$@"; do
            case "$(basename "$f")" in *"$pattern"*) files+=("$f"); break;; esac
        done
    else
        files+=("$f")
    fi
done

if [ ${#files[@]} -eq 0 ]; then
    echo "No test files matched: $*" >&2
    exit 2
fi

echo "python: $py"
echo
failed=()
log=$(mktemp)
trap 'rm -f "$log"' EXIT

for f in "${files[@]}"; do
    name=$(basename "$f")
    printf '%-44s ' "$name"
    # cwd is the engine root: the files put parents[1] on sys.path themselves,
    # but anything reading a relative path expects to be there.
    if (cd "$engine" && "$py" "$f") >"$log" 2>&1; then
        echo 'PASS'
    else
        echo 'FAIL'
        # Only the failing run's output, indented — a passing suite stays a
        # readable column, and a failure shows its reason without a re-run.
        sed 's/^/    /' "$log"
        failed+=("$name")
    fi
done

echo
if [ ${#failed[@]} -gt 0 ]; then
    echo "${#failed[@]} of ${#files[@]} FAILED: ${failed[*]}"
    exit 1
fi
echo "all ${#files[@]} test files passed"
