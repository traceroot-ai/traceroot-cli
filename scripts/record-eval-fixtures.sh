#!/usr/bin/env bash
# Rebuilds tests/fixtures/eval from real runs of the released eval runners.
#
#   scripts/record-eval-fixtures.sh [work dir]
#
# Installs each SDK release into the work dir (a new temporary directory when none is given), runs
# every scenario in scripts/eval-fixtures through that release's own runner, and replaces the
# recorded fixtures with what the runners wrote. Run ids, timestamps, durations and absolute paths
# are replaced with fixed values, so recording twice gives the same files byte for byte.
#
# Every runner starts from an empty environment: no API key, TRACEROOT_ENABLED=false, and a
# TraceRoot host that refuses connections. The one upload scenario adds a fake key, so nothing
# leaves the machine.
#
# The work dir is kept. Each scenario runs in its own project directory there, and the runner's
# output goes to runner.log in that directory.
#
# Needs uv, node 20.6 or later, and npm. Installing the SDKs needs network access.
set -euo pipefail

# The interpreter is pinned to the patch release: a recorded traceback includes standard library
# line numbers.
PYTHON_VERSION=3.12.13
TSX_VERSION=4.23.15
# Oldest first.
PYTHON_SDK_VERSIONS="0.3.0 0.5.1"
TYPESCRIPT_SDK_VERSIONS="0.8.0 0.8.1"

# Every scenario is recorded on the newest release of each SDK. The eval code of the oldest
# supported release is the same, so it records only enough to show that its output parses.
SCENARIOS="all-pass one-fails task-error scorer-error-unversioned scorer-error-versioned
  numeric-no-threshold sampled interrupted import-error no-evaluations inline-rows-a inline-rows-b
  upload-plain-list"
OLDEST_RELEASE_SCENARIOS="all-pass import-error"

DEAD_HOST=http://127.0.0.1:9
FAKE_KEY=tr-fake-0000

for tool in uv node npm; do
  if ! command -v "$tool" >/dev/null; then
    printf 'record-eval-fixtures: %s is required\n' "$tool" >&2
    exit 1
  fi
done

repo=$(cd "$(dirname "$0")/.." && pwd -P)
sources="$repo/scripts/eval-fixtures"
fixtures="$repo/tests/fixtures/eval"
normalize="$repo/scripts/normalize-eval-fixture.mjs"

if [ $# -gt 0 ]; then
  mkdir -p "$1"
  work=$(cd "$1" && pwd -P)
else
  work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/eval-fixtures.XXXXXX")" && pwd -P)
fi
recorded="$work/fixtures"
rm -rf "$recorded"
mkdir -p "$work/home" "$recorded"

node=$(command -v node)

say() {
  printf '%s\n' "$*" >&2
}

die() {
  say "record-eval-fixtures: $*"
  exit 1
}

# The last version in a space-separated list.
newest() {
  echo "${1##* }"
}

# The source file a scenario runs, from scripts/eval-fixtures, without its extension.
scenario_source() {
  case "$1" in
    sampled) echo all-pass ;;
    upload-plain-list) echo inline-rows-a ;;
    *) echo "$1" ;;
  esac
}

# The TRACEROOT_EVAL_OPTIONS a scenario runs with. One case at a time, so cases finish in a fixed
# order.
scenario_options() {
  case "$1" in
    sampled) echo '{"max_concurrency": 1, "sample": 1}' ;;
    upload-plain-list) echo '{"max_concurrency": 1, "reporting": true}' ;;
    *) echo '{"max_concurrency": 1}' ;;
  esac
}

# Starts a runner in the background and sends it SIGINT once the second case has started. By then
# the first case is recorded, and the second one is waiting for a marker file. Returns the runner's
# exit status.
run_interrupted() {
  local project=$1 pid started=0 status=0
  shift
  # A background job started without job control has SIGINT ignored, and the runner would never
  # see the signal.
  set -m
  (cd "$project" && exec "$@") >"$project/runner.log" 2>&1 &
  pid=$!
  set +m
  for _ in $(seq 1 600); do
    started=$(grep -c case_started "$project/events.jsonl" 2>/dev/null || true)
    if [ "${started:-0}" -ge 2 ]; then
      break
    fi
    sleep 0.1
  done
  if [ "${started:-0}" -lt 2 ]; then
    kill -KILL "$pid" 2>/dev/null || true
    die "$project: the second case never started (see runner.log)"
  fi
  kill -INT "$pid"
  wait "$pid" || status=$?
  return "$status"
}

# record LANGUAGE VERSION SCENARIO EXTENSION PLACEHOLDERS RUNNER...
#
# Runs one scenario in a fresh project directory and writes its fixture. PLACEHOLDERS is a
# newline-separated list of placeholder=path pairs for the SDK's own absolute paths.
record() {
  local language=$1 version=$2 scenario=$3 ext=$4 placeholders=$5
  shift 5
  local project="$work/$language-$version/$scenario"
  local fixture="$recorded/$language-$version/$scenario"
  local status=0
  local env=(
    env -i
    "HOME=$work/home"
    "PATH=/usr/bin:/bin"
    "TRACEROOT_HOST_URL=$DEAD_HOST"
    "TRACEROOT_ENABLED=false"
    "TRACEROOT_EVAL_OPTIONS=$(scenario_options "$scenario")"
    "TRACEROOT_EVAL_EVENT_FILE=$project/events.jsonl"
  )
  if [ "$scenario" = upload-plain-list ]; then
    env+=("TRACEROOT_API_KEY=$FAKE_KEY")
  fi

  say "  $scenario"
  rm -rf "$project"
  mkdir -p "$project" "$fixture"
  cp "$sources/$(scenario_source "$scenario").$ext" "$project/eval.$ext"

  if [ "$scenario" = interrupted ]; then
    run_interrupted "$project" "${env[@]}" "$@" "eval.$ext" || status=$?
  else
    (cd "$project" && exec "${env[@]}" "$@" "eval.$ext") >"$project/runner.log" 2>&1 || status=$?
  fi
  if [ ! -s "$project/events.jsonl" ]; then
    die "$project: the runner wrote no events (exit status $status, see runner.log)"
  fi

  printf '%s\n' "$status" >"$fixture/exit-status"
  local pairs=()
  while IFS= read -r pair; do
    pairs+=("$pair")
  done <<<"$placeholders"
  "$node" "$normalize" "$project" "$fixture" "<project>=$project" "${pairs[@]}"
}

record_python() {
  local version=$1 scenarios=$2
  local install="$work/python-$version"
  local python="$install/.venv/bin/python"
  say "traceroot $version (Python $PYTHON_VERSION)"
  rm -rf "$install/.venv"
  uv venv --quiet --python "$PYTHON_VERSION" "$install/.venv"
  uv pip install --quiet --python "$python" "traceroot==$version"

  local placeholders
  placeholders=$(
    "$python" -c '
import os, sysconfig
for name, key in (("<site-packages>", "purelib"), ("<stdlib>", "stdlib")):
    path = sysconfig.get_paths()[key]
    for variant in sorted({path, os.path.realpath(path)}):
        print(f"{name}={variant}")
'
  )
  for scenario in $scenarios; do
    record python "$version" "$scenario" py "$placeholders" \
      "$python" -m traceroot.eval.runner
  done
}

record_typescript() {
  local version=$1 scenarios=$2
  local install="$work/typescript-$version"
  say "@traceroot-ai/traceroot $version (Node $("$node" --version), tsx $TSX_VERSION)"
  mkdir -p "$install"
  if [ ! -f "$install/package.json" ]; then
    printf '{ "private": true }\n' >"$install/package.json"
  fi
  (cd "$install" && npm install --silent --no-audit --no-fund --ignore-scripts --save-exact \
    "@traceroot-ai/traceroot@$version" "tsx@$TSX_VERSION")

  # The runner loads eval files through tsx, passed by its file URL.
  local tsx
  tsx=$("$node" -p \
    'require("node:url").pathToFileURL(require.resolve("tsx", { paths: [process.argv[1]] })).href' \
    "$install")
  for scenario in $scenarios; do
    record typescript "$version" "$scenario" ts "<node_modules>=$install/node_modules" \
      "$node" --import "$tsx" "$install/node_modules/@traceroot-ai/traceroot/dist/eval/runner.js"
  done
}

for version in $PYTHON_SDK_VERSIONS; do
  if [ "$version" = "$(newest "$PYTHON_SDK_VERSIONS")" ]; then
    record_python "$version" "$SCENARIOS"
  else
    record_python "$version" "$OLDEST_RELEASE_SCENARIOS"
  fi
done
for version in $TYPESCRIPT_SDK_VERSIONS; do
  if [ "$version" = "$(newest "$TYPESCRIPT_SDK_VERSIONS")" ]; then
    record_typescript "$version" "$SCENARIOS"
  else
    record_typescript "$version" "$OLDEST_RELEASE_SCENARIOS"
  fi
done

rm -rf "$fixtures"/python-* "$fixtures"/typescript-*
mkdir -p "$fixtures"
cp -R "$recorded"/. "$fixtures"/
say "Recorded into ${fixtures#"$repo"/}. Work dir: $work"
