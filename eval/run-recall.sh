#!/usr/bin/env bash
# Run one or more rule-pack versions against a recall manifest and score them.
#
# usage: eval/run-recall.sh --manifest <path> --rules <path> --arm <name>=<git-ref> [--arm <name>=<git-ref> ...]
#                           [--case <pr>] [--samples <n>] [--parallel <n>] [--out <dir>]
#
# Run from a checkout of the repository whose PRs the manifest names. --rules
# is the repository-relative rule pack path; each arm is resolved once to a
# commit of that repository and stages the rule pack from <sha>:<rules path>
# (engine/run-local.sh --rules-ref), reviewing every manifest head with the PR
# discussion and description withheld. The engine prompt is this checkout's
# engine/prompt; to compare engine changes, run each engine version into its
# own --out and score the merged results.jsonl. Nothing is published. A failed
# review fails the run (exit 1) so a partial table is never mistaken for a
# result. Results are scored by score-recall.cjs: a known defect counts as
# found when an open issue names the same file within 15 lines.
#
# Manifest: {"cases": [{"pr": 12, "head": "<sha>", "defects": [{"id": "A",
# "file": "src/x.ts", "line": 54, "summary": "...", "anchors": [...]?,
# "excluded": "<reason>"?}]}]}
set -euo pipefail

EVAL_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
ENGINE_DIR="$(cd -P "$EVAL_DIR/../engine" && pwd -P)"
ROOT="$(git rev-parse --show-toplevel)"
MANIFEST=""
RULES=""
OUT_DIR="$ROOT/.agent-data/codex-review-recall/$(date -u +%Y%m%dT%H%M%SZ)"
PARALLEL=2
SAMPLES=1
CASE_FILTER=""
ARMS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --arm) ARMS+=("${2:-}"); shift 2 ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --rules) RULES="${2:-}"; shift 2 ;;
    --case) CASE_FILTER="${2:-}"; shift 2 ;;
    --parallel) PARALLEL="${2:-}"; shift 2 ;;
    --samples) SAMPLES="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; exit 1 ;;
  esac
done
[ -n "$MANIFEST" ] || { echo "error: --manifest <path> is required" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "error: manifest not found: $MANIFEST" >&2; exit 1; }
MANIFEST="$(cd -P "$(dirname "$MANIFEST")" && pwd -P)/$(basename "$MANIFEST")"
[ -n "$RULES" ] || { echo "error: --rules <repository-relative path> is required" >&2; exit 1; }
[ ${#ARMS[@]} -gt 0 ] || { echo "error: at least one --arm <name>=<git-ref> is required" >&2; exit 1; }

mkdir -p "$OUT_DIR"
RESULTS="$OUT_DIR/results.jsonl"
FAILURES="$OUT_DIR/failures.txt"
: > "$RESULTS"
: > "$FAILURES"

run_one() {
  local arm="$1" ref="$2" pr="$3" head="$4" sample="$5"
  local log="$OUT_DIR/$arm-pr$pr-${head:0:8}-s$sample.log"
  echo "[$(date -u +%FT%TZ)] arm=$arm ref=$ref pr=$pr head=$head sample=$sample" >&2
  if ! "$ENGINE_DIR/run-local.sh" --pr "$pr" --head-sha "$head" \
        --rules "$RULES" --rules-ref "$ref" --withhold-discussion > "$log" 2>&1; then
    echo "[$(date -u +%FT%TZ)] FAILED arm=$arm pr=$pr (see $log)" >&2
    echo "$arm $pr $log" >> "$FAILURES"
    return 0
  fi
  local run_dir
  run_dir="$(grep -m1 '^Run dir: ' "$log" | sed 's/^Run dir: //')"
  printf '{"arm":"%s","ref":"%s","pr":%s,"head":"%s","sample":%s,"outputPath":"%s/codex-review-output.json"}\n' \
    "$arm" "$ref" "$pr" "$head" "$sample" "$run_dir" >> "$RESULTS"
}
export -f run_one
export ROOT ENGINE_DIR RULES OUT_DIR RESULTS FAILURES

# Resolve every arm to an immutable commit once, so a symbolic ref that advances
# mid-run (origin/main) cannot split one arm across rule-pack versions.
ARM_NAMES=(); ARM_SHAS=()
for arm_spec in "${ARMS[@]}"; do
  arm="${arm_spec%%=*}"; ref="${arm_spec#*=}"
  for existing in "${ARM_NAMES[@]:-}"; do
    [ "$existing" = "$arm" ] && { echo "error: duplicate arm name: $arm (the scorer keys results by arm name)" >&2; exit 1; }
  done
  sha="$(git -C "$ROOT" rev-parse --verify --quiet "$ref^{commit}")" || { echo "error: unknown ref for arm $arm: $ref" >&2; exit 1; }
  git -C "$ROOT" cat-file -e "$sha:$RULES" 2>/dev/null || { echo "error: arm $arm ($ref) has no rule pack at $RULES" >&2; exit 1; }
  ARM_NAMES+=("$arm"); ARM_SHAS+=("$sha")
  echo "arm $arm = $ref @ ${sha:0:12}"
done

# Case-first ordering: every arm reviews a case back to back, so service drift
# over a long run lands on all arms alike rather than on the last arm.
JOBS="$OUT_DIR/jobs.txt"
: > "$JOBS"
jq -r --arg f "$CASE_FILTER" '.cases[] | select($f == "" or (.pr|tostring) == $f) | "\(.pr) \(.head)"' "$MANIFEST" \
  | while read -r pr head; do
      for sample in $(seq 1 "$SAMPLES"); do
        for i in "${!ARM_NAMES[@]}"; do echo "${ARM_NAMES[$i]} ${ARM_SHAS[$i]} $pr $head $sample"; done
      done
    done >> "$JOBS"

echo "Recall run: $(wc -l < "$JOBS") review(s), parallel=$PARALLEL, out=$OUT_DIR"
# Stagger starts so concurrent worktree/fetch setup does not collide.
xargs -P "$PARALLEL" -L 1 bash -c 'sleep $((RANDOM % 20)); run_one "$0" "$1" "$2" "$3" "$4"' < "$JOBS"

echo
node "$EVAL_DIR/score-recall.cjs" "$MANIFEST" "$RESULTS" | tee "$OUT_DIR/score.md"
echo
echo "Results: $RESULTS"
if [ -s "$FAILURES" ]; then
  echo "INCOMPLETE: $(wc -l < "$FAILURES") review(s) failed and are missing from the table:" >&2
  sed 's/^/  /' "$FAILURES" >&2
  exit 1
fi
