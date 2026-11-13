#!/bin/sh
set -eu

# -noreset: the background set below must survive xsetroot disconnecting.
Xvfb :0 -screen 0 800x600x24 -nolisten tcp -noreset &
for _ in $(seq 1 50); do
  xsetroot -display :0 -solid "#336699" 2>/dev/null && break
  sleep 0.1
done

if [ -n "$VNC_PASSWORD" ]; then
  set -- -passwd "$VNC_PASSWORD"
else
  set -- -nopw
fi
exec x11vnc -display :0 -forever -shared -rfbport 5900 -quiet "$@"
