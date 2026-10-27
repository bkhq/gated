# TLS and the Built-in CA

Two crates handle X.509 concerns: `gated-tls` (rustls plumbing shared by all
listeners and outbound connections) and `gated-ca` (a minimal certificate
authority that issues client certificates for mTLS proof-of-possession).

## `gated-tls`

- **Loading**: `TlsCertificateBundle` and `TlsPrivateKey`
  (`crates/gated-tls/src/cert.rs`) load PEM chains/keys from files and
  convert to rustls `CertifiedKey`; the bundle can
  enumerate its SNI names for multi-certificate listeners.
- **`TlsMode`** (`crates/gated-tls/src/mode.rs`): `Disabled` / `Preferred`
  (default) / `Required` — used by database targets for the outbound leg.
- **`MaybeTlsStream`** (`crates/gated-tls/src/maybe_tls_stream.rs`): an enum
  over a raw and a TLS stream supporting in-place upgrade, used by the
  MySQL/PostgreSQL proxies whose protocols negotiate TLS mid-handshake.
- **Outbound verification**: `configure_tls_connector`
  (`crates/gated-tls/src/rustls_helpers.rs`) builds a client config with
  three verification levels — full WebPKI against the native root store
  (with optional extra root), chain-valid-but-ignore-hostname, or
  accept-everything — selected by the target's `tls.verify` and
  related flags.
- ALPN is not used anywhere in the codebase.

### Listener certificates

Every listener loads its certificate/key from its own config section
(`http`, `proxy`, `mysql`, `postgres`). `gated setup` generates one
self-signed certificate (SANs `gated.local`, `localhost`, via `rcgen`) at
`<data>/tls.certificate.pem` / `tls.key.pem` and points all four sections at
it (`crates/gated/src/commands/setup.rs`); production deployments replace
these paths with real certificates. The admin HTTP listener additionally
supports extra SNI certificates (`admin.sni_certificates`). The database
listeners use plain server TLS (no client-cert request); only the HTTP
reverse proxy listener requests client certificates.

## `gated-ca`

A deliberately small CA — no chains, no CRL distribution; revocation is a
database lookup.

- **Root**: `generate_root_certificate_rcgen`
  (`crates/gated-ca/src/lib.rs`) creates a self-signed ECDSA P-384 root
  named "Gated Instance CA" (`lib.rs`) valid for 99 years (`lib.rs`).
  It is generated at first database bootstrap and stored in the `Parameters`
  row (`ca_certificate_pem` / `ca_private_key_pem`,
  `crates/gated-db-entities/src/Parameters.rs`).
- **Issuance**: `issue_client_certificate` (`lib.rs`) signs a
  user-supplied public key into a client certificate valid for 365 days
  (`lib.rs`), embedding the user id in the subject and deriving the
  serial from a hash of subject + time. The private key never leaves the
  user: they generate the key pair and submit only the public key.
- **Endpoints**: self-service
  `POST /api/profile/credentials/certificates`
  (`crates/gated-admin/src/http_service/api/credentials.rs`) and the admin
  variant under `/admin/api/users/:id/credentials/certificates`
  (`crates/gated-admin/src/api/certificate_credentials.rs`). The signed PEM
  is stored as a `CertificateCredential` row and returned to the caller.
- **Revocation**: deleting/revoking inserts the certificate serial (base64)
  into `certificate_revocations`
  (`crates/gated-db-entities/src/CertificateRevocation.rs`); validation
  checks this table first.

## mTLS proof-of-possession

Used by the HTTP reverse proxy, primarily for Kubernetes targets where
kubectl is configured with the issued client certificate:

1. The proxy listener's rustls config uses the verifier from
   `build_client_cert_verifier`
   (`crates/gated-protocol-http/src/kubernetes/client_certs.rs`). Client
   certificates are optional, but a presented one must chain to the instance
   CA, and the handshake's `CertificateVerify` proves possession of the
   matching private key.
2. The shared HTTP server (`crates/gated-common/src/web/server.rs`) puts the
   verified peer certificate into the `ConnectionInfo` request extension.
3. `validate_client_certificate`
   (`crates/gated-protocol-http/src/kubernetes/auth.rs`) rejects revoked
   serials, then finds the stored `CertificateCredential` with the same
   CA-issued serial number; a match authenticates the request as that user
   and updates the credential's `last_used`.

There is no kubeconfig generator; users plug the issued certificate and
their key into kubectl or other clients manually. Client certificates also
count as a `Certificate` credential kind in the auth policy system (see
[auth.md](auth.md)).
