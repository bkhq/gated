#!/bin/sh
set -e

mkdir -p /var/run/xrdp
rm -f /var/run/xrdp/*.pid

xrdp-sesman -n &
# xrdp dials the session manager's socket as soon as a client logs in.
sleep 1
exec xrdp -n
