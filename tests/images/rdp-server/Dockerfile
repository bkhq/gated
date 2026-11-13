FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        xrdp xorgxrdp x11-xserver-utils xdotool \
    && rm -rf /var/lib/apt/lists/*

# xrdp with the Xorg backend and no desktop environment: a session is a
# solid background. The login the tests use is user / rdp-pass. xrdp makes
# its own self-signed certificate, so targets pointing here turn certificate
# verification off. xrdp has no network level authentication; the session
# is TLS with the credentials sent inside it.
RUN useradd -m -s /bin/bash user && echo 'user:rdp-pass' | chpasswd
COPY startwm.sh /etc/xrdp/startwm.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /etc/xrdp/startwm.sh /entrypoint.sh
EXPOSE 3389
ENTRYPOINT ["/entrypoint.sh"]
