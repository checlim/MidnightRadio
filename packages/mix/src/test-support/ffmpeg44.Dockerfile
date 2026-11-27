# FFmpeg 4.4.2 (Ubuntu 22.04, as on the production server) + Node 24 + pnpm + uv, for run-ffmpeg44.sh.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq ffmpeg curl ca-certificates xz-utils python3 make g++ >/dev/null \
 && ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') \
 && V=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o "node-v24[0-9.]*-linux-$ARCH.tar.xz" | head -1) \
 && curl -fsSL https://nodejs.org/dist/latest-v24.x/$V | tar -xJ -C /usr/local --strip-components=1 \
 && npm i -g pnpm >/dev/null 2>&1 \
 && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null 2>&1; ffmpeg -version | head -1; node -v; pnpm -v
