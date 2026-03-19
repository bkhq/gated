# syntax=docker/dockerfile:1.3-labs
# hadolint global ignore=DL3008
FROM rust:1.93.1-bookworm@sha256:f7c04ebd7e4a09e95700aeab38ca54d1a21ce323ff48abed703a0f0cbb22bc0e AS build

ENV DEBIAN_FRONTEND=noninteractive

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN curl -fsSL https://bun.sh/install | bash \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates-java openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/* \
    && cargo install just

ENV PATH="/root/.bun/bin:${PATH}"

COPY . /opt/gated

# for rust-embed determinism
ENV SOURCE_DATE_EPOCH=0

WORKDIR /opt/gated

RUN just bun install --frozen-lockfile \
    && just openapi \
    && just bun run build \
    && cargo build --features mysql,postgres --release

FROM debian:bookworm-slim
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

COPY --from=build /opt/gated/target/release/gated /usr/local/bin/gated

VOLUME /data

ENV GATED_CONFIG=/data/gated.yaml

HEALTHCHECK CMD gated healthcheck

ENV DOCKER=1
USER gated
ENTRYPOINT ["gated"]
CMD ["run"]
