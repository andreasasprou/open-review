#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: retain-local-run.sh <repo-root> <run-dir> <codex-home> <run-start-marker> <clean|shared>" >&2
  exit 2
fi

canonicalize_directory() {
  local directory="$1"
  if [ ! -d "$directory" ]; then
    echo "error: directory does not exist: $directory" >&2
    return 1
  fi
  (
    cd -P "$directory"
    pwd -P
  )
}

REPO_ROOT="$(canonicalize_directory "$1")"
ACTUAL_REPO_ROOT="$(canonicalize_directory "$(git -C "$REPO_ROOT" rev-parse --show-toplevel)")"
if [ "$REPO_ROOT" != "$ACTUAL_REPO_ROOT" ]; then
  echo "error: repository root does not match the current checkout: $REPO_ROOT" >&2
  exit 1
fi

RUNS_ROOT_PATH="$REPO_ROOT/.agent-data/codex-review-local"
RUNS_ROOT="$(canonicalize_directory "$RUNS_ROOT_PATH")"
case "$RUNS_ROOT" in
  "$REPO_ROOT"/*) ;;
  *)
    echo "error: retention root resolves outside the current checkout: $RUNS_ROOT" >&2
    exit 1
    ;;
esac

RUN_DIR="$(canonicalize_directory "$2")"

case "$RUN_DIR" in
  "$RUNS_ROOT"/pr-*) ;;
  *)
    echo "error: refusing retention outside $RUNS_ROOT: $RUN_DIR" >&2
    exit 1
    ;;
esac

if [ "${RUN_DIR%/*}" != "$RUNS_ROOT" ]; then
  echo "error: run directory must be a direct child of $RUNS_ROOT: $RUN_DIR" >&2
  exit 1
fi

CODEX_HOME_DIR="$(canonicalize_directory "$3")"
RUN_START_MARKER="$RUN_DIR/session-start.marker"
if [ "$4" != "$RUN_START_MARKER" ] || [ ! -f "$RUN_START_MARKER" ]; then
  echo "error: run-start marker must be $RUN_START_MARKER" >&2
  exit 1
fi
CODEX_HOME_SCOPE="$5"
if [ "$CODEX_HOME_SCOPE" != "clean" ] && [ "$CODEX_HOME_SCOPE" != "shared" ]; then
  echo "error: Codex home scope must be clean or shared" >&2
  exit 1
fi

remove_run_worktree() {
  local run_dir="$1"
  local worktree="$run_dir/worktree"

  if [ ! -d "$worktree" ]; then
    return 0
  fi

  if git -C "$REPO_ROOT" worktree remove --force "$worktree"; then
    return 0
  fi

  echo "warning: git could not remove registered worktree $worktree; deleting the validated directory directly" >&2
  rm -rf -- "$worktree"
}

CODEX_LOG="$RUN_DIR/codex-output.jsonl"
if [ -f "$CODEX_LOG" ]; then
  gzip -f -- "$CODEX_LOG"
  SUMMARY_PATH="$RUN_DIR/summary.txt"
  SUMMARY_TEMP="$RUN_DIR/summary.retention.tmp"
  while IFS= read -r SUMMARY_LINE || [ -n "$SUMMARY_LINE" ]; do
    if [ "$SUMMARY_LINE" = "Raw log: $CODEX_LOG" ]; then
      printf 'Raw log: %s.gz\n' "$CODEX_LOG"
    else
      printf '%s\n' "$SUMMARY_LINE"
    fi
  done < "$SUMMARY_PATH" > "$SUMMARY_TEMP"
  mv "$SUMMARY_TEMP" "$SUMMARY_PATH"
fi

# A shared user home may contain concurrent unrelated sessions. The marker
# excludes older rollouts; session_meta.cwd attributes newer ones to this run.
if [ -d "$CODEX_HOME_DIR/sessions" ]; then
  while IFS= read -r -d '' ROLLOUT; do
    if [ "$CODEX_HOME_SCOPE" = "shared" ]; then
      SESSION_META="$(head -n 1 -- "$ROLLOUT")"
      if ! jq -e --arg cwd "$RUN_DIR/worktree" \
        '.type == "session_meta" and .payload.cwd == $cwd' \
        >/dev/null 2>&1 <<< "$SESSION_META"; then
        continue
      fi
    fi
    RELATIVE_ROLLOUT="${ROLLOUT#"$CODEX_HOME_DIR/sessions/"}"
    RETAINED_ROLLOUT="$RUN_DIR/sessions/$RELATIVE_ROLLOUT.gz"
    mkdir -p "${RETAINED_ROLLOUT%/*}"
    gzip -n -c -- "$ROLLOUT" > "$RETAINED_ROLLOUT"
  done < <(
    find "$CODEX_HOME_DIR/sessions" \
      -type f \
      -name 'rollout-*.jsonl' \
      -newer "$RUN_START_MARKER" \
      -print0
  )
fi

remove_run_worktree "$RUN_DIR"

while IFS= read -r -d '' OLD_RUN_DIR; do
  remove_run_worktree "$OLD_RUN_DIR"
  rm -rf -- "$OLD_RUN_DIR"
done < <(
  find "$RUNS_ROOT" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -name 'pr-*' \
    -mmin +20160 \
    -print0
)
