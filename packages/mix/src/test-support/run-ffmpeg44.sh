#!/usr/bin/env bash
# Run the @midnight-radio/mix tests against FFmpeg 4.4.2 (Ubuntu 22.04's package, as in production).
# Usage: packages/mix/src/test-support/run-ffmpeg44.sh [extra vitest args]
# Builds the image `mr-ffmpeg44` once (cached), copies the repo into the container (host files and
# node_modules are not touched), runs `pnpm install` there, then the mix tests with REQUIRE_FFMPEG=1.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
cp "$here/ffmpeg44.Dockerfile" "$ctx/Dockerfile"
docker build -q -t mr-ffmpeg44 "$ctx" >/dev/null
docker run --rm -v "$repo":/src:ro mr-ffmpeg44 bash -c '
  set -euo pipefail
  mkdir /work && cd /src && tar --exclude=node_modules --exclude=.git --exclude=.next --exclude="*/public/episodes" --exclude=data -cf - . | tar -xf - -C /work
  cd /work && ffmpeg -version | head -1
  pnpm install --frozen-lockfile --ignore-scripts >/dev/null 2>&1 || pnpm install --no-frozen-lockfile --ignore-scripts >/dev/null
  cd packages/mix
  REQUIRE_FFMPEG=1 pnpm exec vitest run "$@"
' bash "$@"
