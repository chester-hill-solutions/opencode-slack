# Container image for the Workers OpenCode runtime.
#
# Pins:
#   OPENCODE_VERSION — must match the client contract the Worker is built against
#   STOW_VERSION     — native stow-s3 release used for workspace checkpoints
#
# NOTE: the OpenCode installer and the stow-s3 release asset names are pinned
# here as build args; update them together with the Worker's package versions.

FROM oven/bun:1.3

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep sqlite3 tar \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=2.2.1
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}" \
    && mv /root/.opencode/bin/opencode /usr/local/bin/opencode

ARG STOW_VERSION=0.3.3
RUN curl -fsSL -o /usr/local/bin/stow-s3 \
      "https://github.com/chester-hill-solutions/stow-s3/releases/download/v${STOW_VERSION}/stow-s3-linux-amd64" \
    && chmod +x /usr/local/bin/stow-s3

WORKDIR /app
COPY control-server.ts entrypoint.sh ./
RUN chmod +x entrypoint.sh

ENV HOME=/workspace/.state \
    XDG_DATA_HOME=/workspace/.state/data \
    XDG_CONFIG_HOME=/workspace/.state/config \
    XDG_CACHE_HOME=/workspace/.state/cache

EXPOSE 4000 4001
CMD ["./entrypoint.sh"]
