FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap git \
  && rm -rf /var/lib/apt/lists/*

# The classic builder creates WORKDIR as root, so create it for node first.
RUN mkdir /app && chown node:node /app

USER node
WORKDIR /app

# The host's node_modules hold darwin-only binaries, so the image installs its own.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node . .

# tests/harness.mjs loads Pi from <root>/releases/<version>/node_modules.
ENV PI_MANAGED_INSTALL_ROOT=/home/node/pi-install
RUN version="$(node -p 'require("./node_modules/@earendil-works/pi-coding-agent/package.json").version')" \
  && mkdir -p "$PI_MANAGED_INSTALL_ROOT/releases/$version" \
  && ln -s /app/node_modules "$PI_MANAGED_INSTALL_ROOT/releases/$version/node_modules" \
  && printf '%s' "$version" > "$PI_MANAGED_INSTALL_ROOT/current-version"
