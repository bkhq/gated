# k8s-client-cert scenario

Proves that gated presents a bound `k8s-client-cert` account's client
certificate to an upstream that requires mTLS, when the inline
`upstream_auth` on the target is `None`.

## Fixture certs (test-only, never used outside this scenario)

- `upstream/ca.crt` — test CA, signs both server and client.
- `upstream/srv.crt`, `upstream/srv.key` — upstream server cert for
  `k8s-cert-upstream:8443`; CN matches the docker network DNS name.
- `client.crt`, `client.key` — client cert bound to the account; CN
  `e2e-client-l3-9` is the unique sentinel the probe greps for.

The CA private key (`ca.key`) is intentionally **not** committed — no
re-signing is needed at test time, and keeping it out of the repo
removes any temptation to repurpose this CA for anything real. Re-run
`openssl` to regenerate the bundle if it
expires (currently 10-year validity).
