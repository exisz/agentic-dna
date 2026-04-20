#!/usr/bin/env bash
# onboarding.sh — Acceptance test for `dna mesh tour`
# A new agent runs these 5 commands to understand the empire.
# Each must exit 0 and produce non-empty output.

set -euo pipefail

PASS=0
FAIL=0

run_test() {
  local desc="$1"
  shift
  echo "▶  $desc"
  echo "   cmd: $*"
  local output
  if output=$("$@" 2>&1); then
    local lines
    lines=$(echo "$output" | wc -l)
    if [ "$lines" -gt 3 ]; then
      echo "   ✅  OK ($lines lines)"
    else
      echo "   ❌  Output too short ($lines lines)"
      echo "$output"
      FAIL=$((FAIL + 1))
      return
    fi
  else
    echo "   ❌  Command failed (exit $?)"
    echo "$output"
    FAIL=$((FAIL + 1))
    return
  fi
  PASS=$((PASS + 1))
}

echo ""
echo "🧪  dna mesh tour — onboarding acceptance test"
echo "================================================"
echo ""

# 1. Discover that agents exist
run_test "Overview: discover agents and realms" \
  dna mesh tour

# 2. Learn about nebula
run_test "Agent tour: dna://agent/nebula" \
  dna mesh tour dna://agent/nebula

# 3. Follow a governance pointer
run_test "Philosophy tour: dna://philosophy/dual-purpose" \
  dna mesh tour dna://philosophy/dual-purpose

# 4. Understand a tool
run_test "Tool tour: dna://tool/lazyjira" \
  dna mesh tour dna://tool/lazyjira

# 5. Understand a cron
run_test "Cron tour: dna://cron/nebula-engineer-pod" \
  dna mesh tour dna://cron/nebula-engineer-pod

echo ""
echo "================================================"
echo "Results: ✅ $PASS passed, ❌ $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
