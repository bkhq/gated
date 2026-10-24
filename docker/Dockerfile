# syntax=docker/dockerfile:1.3-labs
# hadolint global ignore=DL3008
FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS build

ENV DEBIAN_FRONTEND=noninteractive

# Pinned, checksum-verified Bun (no blind curl|bash). Checksums are from the
# upstream SHASUMS256.txt for the pinned release.
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256_X64=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
ARG BUN_SHA256_AARCH64=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates-java openjdk-17-jdk unzip \
    && rm -rf /var/lib/apt/lists/* \
    && case "$(dpkg --print-architecture)" in \
         amd64) bun_arch=x64; bun_sha="${BUN_SHA256_X64}" ;; \
         arm64) bun_arch=aarch64; bun_sha="${BUN_SHA256_AARCH64}" ;; \
         *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip" \
    && echo "${bun_sha}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /tmp/bun \
    && mkdir -p /root/.bun/bin \
    && mv "/tmp/bun/bun-linux-${bun_arch}/bun" /root/.bun/bin/bun \
    && chmod +x /root/.bun/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun \
    && cargo install just

ENV PATH="/root/.bun/bin:${PATH}"

COPY . /opt/gated

# for rust-embed determinism
ENV SOURCE_DATE_EPOCH=0

WORKDIR /opt/gated

# .cargo/config.toml defaults to a musl target; build for the image's glibc.
RUN export CARGO_BUILD_TARGET="$(uname -m)-unknown-linux-gnu" \
    && just bun install --frozen-lockfile \
    && mkdir -p web/dist \
    && just openapi \
    && just bun run build \
    && cargo build --locked --features mysql,postgres --release \
    && cp "target/${CARGO_BUILD_TARGET}/release/gated" /opt/gated/gated

FROM debian:bookworm-slim@sha256:f06537653ac770703bc45b4b113475bd402f451e85223f0f2837acbf89ab020a
LABEL maintainer=bkhq
ARG USER_ID=1000

ENV DEBIAN_FRONTEND=noninteractive
RUN <<EOF
  set -xe
  apt-get -y update -qq
  apt-get install --no-install-recommends --no-install-suggests -y \
    ca-certificates wget
  apt-get clean
  rm -rf /var/lib/apt/lists/*
EOF

RUN adduser gated --disabled-password --gecos "" --uid ${USER_ID} --home /data --shell /usr/sbin/nologin

COPY --from=build /opt/gated/gated /usr/local/bin/gated

VOLUME /data

ENV GATED_CONFIG=/data/gated.yaml

HEALTHCHECK CMD gated healthcheck

ENV DOCKER=1
USER gated
ENTRYPOINT ["gated"]
CMD ["run"]
