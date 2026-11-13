FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f

RUN apk add --no-cache xvfb x11vnc xsetroot xdotool xclip

# An 800x600 X display with a solid background, served over RFB with the
# classic VNC password scheme. VNC_PASSWORD="" serves it without authentication.
ENV VNC_PASSWORD=vnc-pass
EXPOSE 5900
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
