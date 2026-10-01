#!/usr/bin/env bash
# Proves the .gitignore fix: VERIFICATION_FAILURE.log must NOT be ignored.
#
# This is the check that matters. The bug was silent — `git add -A` skipped the
# file and reported nothing — so "the file looks right in the repo" proves
# nothing. `git check-ignore` is what git itself uses to decide.
set -uo pipefail

cd "$(dirname "$0")/.."
TARGET=repo-scaffold/.gitignore

fail=0
expect_tracked() {
  local path="$1" should_be_tracked="$2" why="$3"
  # Copy into a throwaway worktree so we test the REAL scaffold .gitignore.
  local tmp; tmp=$(mktemp -d)
  cp "$TARGET" "$tmp/.gitignore"
  ( cd "$tmp" && git init -q . && touch "$path" ) >/dev/null 2>&1
  if git -C "$tmp" check-ignore -q "$path"; then
    local ignored=yes; else
    local ignored=no
  fi
  if [ "$should_be_tracked" = tracked ] && [ "$ignored" = yes ]; then
    echo "FAIL  $path is IGNORED but must be tracked — $why"
    fail=1
  elif [ "$should_be_tracked" = ignored ] && [ "$ignored" = no ]; then
    echo "FAIL  $path is tracked but must be ignored — $why"
    fail=1
  else
    echo "PASS  $path ignored=$ignored (expected $should_be_tracked)"
  fi
  rm -rf "$tmp"
}

expect_tracked VERIFICATION_FAILURE.log tracked "AGENTS.md rule 3 makes it the next turn's required reading"
expect_tracked VERIFICATION_NOTE.log tracked "same contract; standing test debt"
expect_tracked VERIFICATION_REPORT.md tracked "ECC ladder evidence, read by judges"
expect_tracked debug.log ignored "the # Logs rule still applies to real runtime logs"
expect_tracked app.log ignored "the # Logs rule still applies to real runtime logs"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "gitignore verification FAILED"
  exit 1
fi
echo ""
echo "gitignore verification passed"