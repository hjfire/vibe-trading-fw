#!/usr/bin/env bash
# tools/wiki_freshness_gate.sh —— 只读：不改文件、不建仓、不安装
# Threshold-based, not zero: a fork cannot chase 450 pages instantly, and a gate that
# is always red gets switched off. WIKI_STALE_MAX is the tuning knob; its shipped
# default is re-pinned per shard from the then-measured water level (M3: 423 partial +
# 22 stale = 445; M5 shard 1 at 2ac28b0a = 439). The brand/code/secret gates stay in ci_grep_gates.sh —
# one policy, one implementation.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
NC=$'\033[0m'
FAILED=0
LIMIT="${WIKI_STALE_MAX:-439}"

STALE=$(python -X utf8 tools/wiki_drift.py stale --format count 2>/dev/null)
if ! [[ "$STALE" =~ ^[0-9]+$ ]]; then
    echo "${RED}FAIL${NC}: stale --format count did not print one integer"
    echo "  got: '${STALE}'"
    echo "  reproduce: python -X utf8 tools/wiki_drift.py stale --format count"
    exit 1
fi
# The threshold is the same kind of input as the reading and it was the unguarded one: a
# misspelled knob made `[ 445 -gt 4o5 ]` return 2 (message only on stderr), `if` took the
# else branch, and the gate printed `ok` and exited 0 — fail-open on the tuning knob.
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
    echo "${RED}FAIL${NC}: WIKI_STALE_MAX is not an integer: '${WIKI_STALE_MAX:-}'"
    exit 1
fi
echo "wiki stale pages: $STALE (threshold ${LIMIT})"
if [ "$STALE" -gt "$LIMIT" ]; then
    echo "${RED}FAIL${NC}: water level rose above the threshold"
    FAILED=1
else
    echo "${GREEN}ok${NC}"
fi

if python -X utf8 tools/wiki_drift.py index --check; then
    echo "${GREEN}ok${NC}: INDEX.md is deterministic and current"
else
    echo "${RED}FAIL${NC}: INDEX.md is stale - run: python -X utf8 tools/wiki_drift.py index"
    FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
    echo
    echo "${RED}wiki_freshness_gate: one or more checks failed${NC}"
    exit 1
fi
echo
echo "${GREEN}wiki_freshness_gate: all checks passed${NC}"
exit 0
