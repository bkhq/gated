# SSH Protocol Proxy (`crates/gated-protocol-ssh`)

English | [简体中文](protocol-ssh.zh-CN.md)

The SSH proxy is built on the `russh` crate and acts as a full SSH server
toward the client and a full SSH client toward the target. Channels are
bridged one-to-one between the two connections.

## Listener

`SSHProtocolServer` (`crates/gated-protocol-ssh/src/lib.rs`) implements the
`ProtocolServer` trait (`lib.rs`); its `run()` delegates to `run_server()`
(`crates/gated-protocol-ssh/src/server/mod.rs`), which:

- generates or loads two key sets on startup via `generate_keys()` /
  `load_keys()` (`crates/gated-protocol-ssh/src/keys.rs`): **host keys**
  (presented to inbound clients) and **client keys** (used to authenticate to
  targets), in Ed25519 and RSA variants, stored as PEM under the configured
  `ssh.keys` directory (default `data/keys`);
- accepts TCP connections and spawns a per-connection task that registers the
  session in the core registry (`State::register_session`) and then runs the
  russh server state machine (`russh::server::run_stream`);
- configures russh with the preferred host key algorithms (Ed25519 first,
  then RSA-SHA2), a 1-second delay after failed auth attempts, the
  `ssh.inactivity_timeout` (default 5 minutes), and the optional
  `ssh.keepalive_interval` (`server/mod.rs`, russh `Config` construction).

## Inbound authentication

### Target selection via username

The SSH username encodes both identity and target. It is parsed by
`AuthSelector` (`crates/gated-common/src/auth/selector.rs`):

- `ticket-<secret>` selects ticket authentication (prefix constant in
  `crates/gated-common/src/consts.rs`);
- otherwise the username is split on `#` or `:` into
  `username` + `target_name`, e.g. `ssh alice:prod-box@gated -p 2222`.

### Methods

The advertised methods are driven by database-stored parameters
(`ssh_client_auth_publickey`, `ssh_client_auth_password`,
`ssh_client_auth_keyboard_interactive`) and map onto the core credential
system (`crates/gated-protocol-ssh/src/server/mod.rs`):

- **Public key** — the offered key is validated against the user's stored
  OpenSSH public keys; accepted keys update a `last_used` timestamp
  (`server/session.rs`, `_auth_publickey*` handlers).
- **Password** — submitted as `AuthCredential::Password` and checked against
  the Argon2 hash via `ConfigProvider::validate_credential`
  (`crates/gated-core/src/config_providers/db.rs`).
- **Keyboard-interactive** — used for second factors: it prompts for a TOTP
  code (`AuthCredential::Otp`) or, when the policy requires in-browser
  approval, prints a login URL and waits on the auth-state store's broadcast
  channel until the user approves the attempt in the web UI
  (`server/session.rs`, `_auth_keyboard_interactive`).

Each attempt goes through `try_auth_lazy` (`server/session.rs`), which creates
or reuses an `AuthState` in the shared `AuthStateStore` and calls
`AuthState::verify()` until the credential policy is satisfied (see
[auth.md](auth.md)). Successful ticket secrets are memoized within the
connection so russh's repeated auth callbacks do not consume extra ticket
uses.

### Authorization

After the state machine reports `Accepted`, the session resolves the target
by name and checks `ConfigProvider::authorize_target`
(`crates/gated-core/src/config_providers/db.rs`) — the user must share at
least one role with the target. Only then is `TargetSelection::Found` set.

## Target connection

The outbound leg is owned by `RemoteClient`
(`crates/gated-protocol-ssh/src/client/mod.rs`), driven over an
`RCCommand`/`RCEvent` channel pair. Connection is **lazy**: it is triggered by
the first channel-level request (shell/exec/forward), not at auth time
(`server/session.rs`, `maybe_connect_remote`).

- **Credentials to the target** come from the target's `TargetSSHOptions`:
  password auth, or public-key auth using either a per-target private key or
  gated's own client keys (`client/mod.rs`, `ssh_auth_keys()`); per-target
  bound accounts are resolved through
  `ssh_options_with_account` (`crates/gated-core/src/account_credentials.rs`).
  RSA targets get SHA-2 first with a SHA-1 retry for legacy servers.
- **Host key verification** uses the known-hosts table with three modes
  (`SshHostKeyVerificationMode`): auto-accept, auto-reject, or interactive
  prompt rendered into the user's PTY (`server/session.rs`,
  `handle_unknown_host_key`). Mismatches abort with a detailed message.

## Channel and stream model

A `BiMap<ServerChannelId, Uuid>` correlates inbound russh channels with
outbound channel UUIDs (`server/session.rs`). The session runs an event loop
fed by multiple sources (russh handler events, remote client events, admin
session-control commands, console input, service output), serialized through
an internal event hub; writes back to the client are sequenced by a dedicated
`ChannelWriter` task (`server/channel_writer.rs`).

Supported operations (`ChannelOperation`,
`crates/gated-protocol-ssh/src/common.rs`): shell, exec, PTY request/resize,
environment variables, subsystems (SFTP), direct-tcpip (local forwarding),
direct-streamlocal (UNIX sockets), remote forwarding (tcpip-forward and
streamlocal-forward, including server-initiated channels back to the client),
SSH agent forwarding, X11 forwarding, signals, EOF/close.

## Recording hooks

Two recorder families are wired into the session (see
[sessions-recordings-audit.md](sessions-recordings-audit.md) for formats):

- **TerminalRecorder** — one per shell/exec channel, started when recordings
  are enabled; records client input, target stdout/stderr, and PTY resizes
  with timestamps (`server/session.rs`, `start_terminal_recording` and the
  data handlers).
- **TrafficRecorder / ConnectionRecorder** — one per forwarded (host, port)
  or socket path; captures both directions of forwarded TCP/UNIX traffic into
  PCAP files (`server/session.rs`, `traffic_recorder_for`).

Recorder write failures detach the recorder but do not kill the session.

## Lifecycle

- Sessions register in `State` on accept; the DB row is written once the
  user authenticates, and the session is removed (and its row closed) when
  the handle drops (`crates/gated-core/src/state.rs`). A connection whose
  authentication fails writes one `auth_login_rejected` audit entry listing
  the methods tried, and no session row.
- Admins can close a live session from the web UI; the session receives
  `SessionHandleCommand::Close`, emits a service message, and disconnects
  both legs (`server/session.rs`, `handle_session_control`).
- Inactivity timeout and keepalives are enforced by russh using the values
  from the `ssh` config section.
