# Remote Desktops (RDP and VNC)

English | [简体中文](protocol-desktop.zh-CN.md)

Desktop targets are reached from the browser only. There is no RDP or VNC
listener: a native client (`mstsc`, a VNC viewer) cannot connect to gated.
The browser opens a WebSocket, gated connects to the target as an RDP or VNC
client with credentials the user never sees, and relays the screen one way
and the input the other.

```
browser canvas  <-- WebSocket: JSON control + binary images -->  bridge
                                                                   |
                                         DesktopEvent / DesktopInput (channels)
                                                                   |
                              gated-protocol-rdp (IronRDP)   gated-protocol-vnc (vnc-rs)
                                                                   |
                                                              the target
```

## Targets, accounts and roles

- `TargetOptions::Rdp { host, port=3389, username, domain?, password?, verify_tls=true, record_keystrokes=false }`
  and `TargetOptions::Vnc { host, port=5900, password?, record_keystrokes=false }`
  (`crates/gated-common/src/config/target.rs`).
- Credentials come from a bound account of kind `desktop-password`
  (`username`, optional `domain`, `password`; VNC uses the password only), or
  from the target's inline fields. `account_credentials::desktop_login`
  (`crates/gated-core/src/account_credentials.rs`) picks them.
- `roles.allow_clipboard` (default off) opens the clipboard, in both
  directions, on the targets the role grants.
  `ConfigProvider::authorize_clipboard` answers for a user and a target.

## The bridge (`crates/gated-admin/src/http_service/api/desktop`)

`GET /api/desktop/{target}` upgrades to a WebSocket. Query: `account` (which
bound account to sign in with), `width` and `height` (the viewer's window; an
RDP target is asked for a desktop of that size).

Gate, the same as the web terminal: a login session, a user API token or a
ticket scoped to the target; the `Origin` guard; a role that grants the
target. Tickets and the clipboard permission are checked again every 10
seconds, and a session whose authorization is withdrawn is closed. Limits: 4
desktop sessions per user, 32 in total, 4 MiB per viewer message, clipboard
text cut to 1 MiB.

The session is registered as `WebRDP` or `WebVNC`, so the session monitor
lists it and an administrator can close it.

### Screen path

Protocol clients send `DesktopEvent`s (`crates/gated-core/src/protocols/desktop.rs`):
resize, raw BGRA / JPEG / PNG rectangles, copy-rect, cursor shape, clipboard
text, bell. The bridge applies them to a framebuffer on the gateway and marks
64-pixel tiles as changed. When the socket can take more, the sender collects
the changed area and sends it as JPEG (quality 90, no chroma subsampling) or,
under 4 KiB of pixels, as raw RGBA. A slow viewer therefore gets fewer and
larger updates; nothing queues behind it.

### Wire format

Text frames are JSON with a `type` field.

| Direction | Messages |
|---|---|
| gateway to viewer | `state` (`connecting`, `connected` with `details { session_id, address, username, clipboard }`, `closed` with `message`), `resize { width, height }`, `clipboard { text }`, `bell`, `error { message }`, `cursor_default`, `cursor_hidden` |
| viewer to gateway | `pointer_event { x, y, buttons }`, `key_event { keysym?, scancode?, extended?, down }`, `wheel_event { x, y, vertical, delta }`, `clipboard { text }`, `refresh`, `resize { width, height }` |

Binary frames go to the viewer only: `[kind u8][x u16][y u16][width u16][height u16][data]`,
little-endian. Kind 1 is raw RGBA, 2 is JPEG, 3 is a cursor shape in RGBA
whose `x`, `y` are the hotspot.

A key is sent in both forms the browser knows: the keysym of the character
under the viewer's layout and the PC/AT set-1 scancode of the physical key.
VNC uses the keysym, RDP the scancode, so on RDP the target's keyboard layout
decides the character.

Errors shown to the viewer are fixed sentences ("Target rejected the
credentials", "TLS negotiation with the target failed", ...). Addresses and
protocol detail stay in the gateway log.

## RDP client (`crates/gated-protocol-rdp`)

Built on the released IronRDP crates; nothing is vendored.

- **Security**: TLS always, with network level authentication (CredSSP,
  NTLM) when the target offers it. Plain RDP security is not offered. A
  target without NLA (xrdp) gets the credentials inside the TLS session.
  Kerberos is not supported: the client refuses any authentication step that
  would need a network request of its own.
- **Certificate**: `verify_tls` (default on) checks the target's certificate
  against the system roots and the host name. Most Windows hosts present a
  self-signed certificate, so the switch has to be turned off for them; the
  TLS session is then open to an active attacker between gateway and target.
  The target's Security tab shows the certificate the target presents
  (`GET /admin/api/targets/{id}/upstream-certificate`,
  `gated_protocol_rdp::inspect_certificate`): the gateway runs the RDP
  negotiation and the TLS handshake and stops there.
- **Logon**: automatic, with the account's user name, domain and password.
- **Graphics**: bitmap updates and RemoteFX, decoded by IronRDP into an image
  on the gateway. The graphics pipeline channel (EGFX, H.264) is not enabled.
- **Size**: the viewer's window size at connect time, bounded to 200..8192
  per edge and 64 MiB of RGBA pixels; later window changes are sent over the
  display control channel and the target answers with a reactivation. A
  target without that channel keeps its first size. A size the target
  reports by itself is held to the same limits, at connect time and on every
  reactivation; a larger one ends the session.
- **Clipboard**: text only (`CF_UNICODETEXT`, falling back to ANSI text when
  reading). Without `allow_clipboard` the clipboard channel is not opened at
  all. Files and images are neither offered nor accepted.
- **Not carried**: audio, drives, printers, smart cards, multiple monitors.

## VNC client (`crates/gated-protocol-vnc`)

Built on `vnc-rs`.

- **Security**: VNC authentication (a DES challenge keyed by the first eight
  characters of the password) or none. RFB has no transport encryption: the
  screen, the keys and the challenge cross the network between gateway and
  target in the clear. VNC targets belong on a trusted network segment.
- **Encodings**: Tight, ZRLE, CopyRect, Raw, cursor and desktop-size
  pseudo-encodings. Updates are requested 25 times a second.
- **Size**: the target's; a viewer resize is ignored.
- **Clipboard**: text, dropped in both directions without `allow_clipboard`.

## Recording and playback

Every desktop session is recorded when recordings are enabled
(`crates/gated-core/src/recordings/desktop.rs`): one JSON item per line with
a `time` in seconds: `resize`, `png_image` (a `keyframe` flag marks a
snapshot of the whole screen, written at least every 10 seconds or 2 MB),
`jpeg_image`, `copy_rect`, `pointer_input`, `wheel_input`, and, only when the
target has `record_keystrokes`, `key_input`, `scancode_input` and
`clipboard_input`. Keystroke recording is off by default because typed
passwords would end up in the recording.

`GET /admin/api/recordings/{id}/desktop` streams the file. The recording page
plays it on a canvas: play and pause, seek (drawing restarts from the last
keyframe), 1x to 8x speed, a marker at the recorded pointer and the recorded
keys and pastes.

## Tests

- Unit tests in both protocol crates and in the bridge.
- `tests/desktop/vnc.test.ts` against `x11vnc`, `tests/desktop/rdp.test.ts`
  against `xrdp` (`tests/images/`).
- Not covered by automated tests: NLA and dynamic resize, which `xrdp` does
  not implement. They need a Windows target.
