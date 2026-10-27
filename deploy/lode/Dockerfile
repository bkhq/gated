# gated under lode, with the database clients the web MySQL/PostgreSQL
# terminals spawn (`mysql` or `mycli`, `psql`). lode downloads and verifies the
# gated release itself, so this image carries only lode and those tools.
#
#   docker build -t gated-lode deploy/lode
#   docker run -d --name gated \
#     -v gated-lode:/srv/gated-lode \
#     -v "$PWD/deploy/lode/lode.toml:/srv/gated-lode/lode.toml:ro" \
#     -p 127.0.0.1:8888:8888 -p 127.0.0.1:2222:2222 gated-lode
#
# First start: run `unattended-setup` once (see lode.toml) with
# `docker run --rm ... gated-lode unattended-setup ...` before the service.
#
# Base: the lode slim image (debian:13-slim). Pinned by the multi-arch index
# digest; re-resolve it when bumping the tag.
FROM docker.io/bkhq/lode:v0.4.0-slim@sha256:b4147dcf3ade9165743720d90998005b37dda4ac35df9bebff2db59b2ee76feb

# mycli gives the MySQL terminal working arrow keys and history; without it
# gated falls back to the MariaDB `mysql` client.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates mariadb-client postgresql-client mycli \
    && rm -rf /var/lib/apt/lists/*

# Matches lode.toml's `dir`; DOCKER makes `unattended-setup` listen on all
# interfaces, as in the main image.
ENV LODE_DIR=/srv/gated-lode DOCKER=1
VOLUME /srv/gated-lode
