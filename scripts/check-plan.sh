#!/usr/bin/env bash
set -e

PLAN_FILE="/Users/nufoos/dev-projects/ContextArmor/PLAN.md"

if [ ! -f "$PLAN_FILE" ]; then
  echo "ERROR: PLAN.md not found at $PLAN_FILE"
  exit 1
fi

VIOLATIONS=0

echo "Checking PLAN.md for forbidden hard-typed metrics and unverified claims..."

# 1. Check for \d+ms (latency numbers)
if grep -En '[0-9]+ms' "$PLAN_FILE"; then
  echo "VIOLATION: Found hard-typed latency (e.g. 123ms) in PLAN.md"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# 2. Check for \b\d+/100\b (scores like 0/100, 75/100)
if grep -En '\b[0-9]+/100\b' "$PLAN_FILE"; then
  echo "VIOLATION: Found hard-typed score (e.g. 75/100) in PLAN.md"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# 3. Check for [0-9a-f]{64} (sha256 hashes)
if grep -En '[0-9a-f]{64}' "$PLAN_FILE"; then
  echo "VIOLATION: Found sha256 hash in PLAN.md"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

# 4. Check for 'verified' or 'proven'
if grep -Eni '\b(verified|proven)\b' "$PLAN_FILE"; then
  echo "VIOLATION: Found forbidden assertion word ('verified'/'proven') in PLAN.md"
  VIOLATIONS=$((VIOLATIONS + 1))
fi

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "FAILED: Found $VIOLATIONS violation(s) in PLAN.md."
  exit 1
fi

echo "SUCCESS: PLAN.md clean of hard-typed measurements, scores, hashes, and unverified claims."
exit 0
