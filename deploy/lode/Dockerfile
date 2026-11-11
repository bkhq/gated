# gated under lode. lode downloads and verifies the gated release itself, so
# this image carries only lode.
#
#   docker build -t gated-lode deploy/lode
#   docker run -d --name gated \
#     -v gated-lode:/srv/gated-lode \
#     -v "$PWD/deploy/lode/lode.toml:/srv/gated-lode/lode.toml:ro" \
#     -p 127.0.0.1:8888:8888 -p 127.0.0.1:2222:2222 \
#     -p 127.0.0.1:8443:8443 gated-lode
#
# First start writes a default config and a one-time bootstrap token
# (`docker logs gated`, or data/db/bootstrap-token.txt without a TTY); create
# the first admin account in the admin UI with it. See lode.toml.
#
# Base: the lode slim image (debian:13-slim). Pinned by the multi-arch index
# digest; re-resolve it when bumping the tag.
FROM docker.io/bkhq/lode:v0.4.0-slim@sha256:b4147dcf3ade9165743720d90998005b37dda4ac35df9bebff2db59b2ee76feb

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Matches lode.toml's `dir`; DOCKER marks the container environment, as in
# the main image.
ENV LODE_DIR=/srv/gated-lode DOCKER=1
VOLUME /srv/gated-lode
