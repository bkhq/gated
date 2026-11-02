import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { HttpSession } from "../../helpers/session";
import { randomUUID } from "crypto";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";

// Self-service certificate issuance
// (POST /api/profile/credentials/certificates) now requires a PKCS#10 CSR
// whose self-signature is verified (proof-of-possession). The certificate is
// issued over the CSR's public key. The old contract — submitting a bare
// public key — is rejected, as is a CSR with a tampered self-signature.
describe("API Credentials - self-service certificate CSR PoP", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let tmpdir: string;
  const timeout = Number(process.env.TIMEOUT || 10);

  // The shared allocPort starts at a fixed low base, so on a host running other
  // gated suites concurrently a port can already be taken. Retry startup; each
  // attempt draws fresh (higher) ports and dodges the collision.
  async function startWgReady(): Promise<GatedProcess> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const proc = await processes.startWg();
      try {
        await waitPort(proc.httpPort, { recv: false, process: proc.process, timeout: 20000 });
        return proc;
      } catch (e) {
        lastErr = e;
        try { proc.process.kill("SIGKILL"); } catch {}
        await proc.process.exited.catch(() => {});
      }
    }
    throw lastErr;
  }

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await startWgReady();
    url = `https://localhost:${wg.httpPort}`;
    tmpdir = processes.ctx.tmpdir;
  });

  afterAll(async () => {
    await processes.stop();
  });

  // Generate an ECDSA P-256 private key (the issuer accepts EC P-256/P-384
  // keys with their canonical SHA-256/384 signature), a matching PKCS#10 CSR
  // (self-signed → proves possession), and a bare public key PEM, all via the
  // openssl CLI.
  function genKeypairCsr(): { csrPem: string; pubKeyPem: string } {
    const id = randomUUID();
    const keyPath = join(tmpdir, `csr-key-${id}.pem`);
    const csrPath = join(tmpdir, `csr-${id}.pem`);
    const pubPath = join(tmpdir, `pub-${id}.pem`);

    const key = Bun.spawnSync([
      "openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath,
    ]);
    if (key.exitCode !== 0) {
      throw new Error(`openssl EC key generation failed: ${key.stderr.toString()}`);
    }
    const csr = Bun.spawnSync([
      "openssl", "req", "-new", "-key", keyPath, "-out", csrPath,
      "-subj", "/CN=test-user", "-sha256",
    ]);
    if (csr.exitCode !== 0) {
      throw new Error(`openssl CSR generation failed: ${csr.stderr.toString()}`);
    }
    const pub = Bun.spawnSync(["openssl", "ec", "-in", keyPath, "-pubout", "-out", pubPath]);
    if (pub.exitCode !== 0) {
      throw new Error(`openssl pubkey export failed: ${pub.stderr.toString()}`);
    }

    return {
      csrPem: readFileSync(csrPath, "utf-8"),
      pubKeyPem: readFileSync(pubPath, "utf-8"),
    };
  }

  // Corrupt the trailing signature bytes of a valid CSR so it parses as a
  // well-formed PKCS#10 request but fails self-signature (PoP) verification.
  function tamperCsrSignature(csrPem: string): string {
    const m = csrPem.match(
      /-----BEGIN CERTIFICATE REQUEST-----([\s\S]*?)-----END CERTIFICATE REQUEST-----/
    );
    if (!m) throw new Error("could not parse CSR PEM");
    const der = Buffer.from(m[1].replace(/\s/g, ""), "base64");
    // The signature is at the tail of the DER structure; flipping its last
    // byte leaves the requestInfo/structure intact but breaks the signature.
    der[der.length - 1] ^= 0xff;
    const b64 = der.toString("base64").match(/.{1,64}/g)!.join("\n");
    return `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----\n`;
  }

  async function newLoggedInUser(): Promise<HttpSession> {
    const api = adminClient(url);
    const user = await api.createUser({ username: `cert-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "123",
    });
    expect(loginResp.status).toBe(201);
    return session;
  }

  function issueCert(session: HttpSession, body: Record<string, unknown>): Promise<Response> {
    return session.post(`${url}/api/profile/credentials/certificates`, body);
  }

  test("a valid PKCS#10 CSR is accepted and a certificate is issued", async () => {
    const session = await newLoggedInUser();
    const { csrPem } = genKeypairCsr();

    const resp = await issueCert(session, { label: "valid-csr", csr_pem: csrPem });
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as { certificate_pem?: string };
    expect(body.certificate_pem).toContain("BEGIN CERTIFICATE");
  });

  test("the old bare-public-key contract is rejected (no csr_pem)", async () => {
    const session = await newLoggedInUser();
    const { pubKeyPem } = genKeypairCsr();

    // Old contract: a `public_key_pem` field and no CSR. The required `csr_pem`
    // is missing, so the request is rejected with a 4xx.
    const resp = await issueCert(session, { label: "old-contract", public_key_pem: pubKeyPem });
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.status).toBeLessThan(500);
  });

  test("a bare public key supplied as csr_pem (no PoP) is rejected", async () => {
    const session = await newLoggedInUser();
    const { pubKeyPem } = genKeypairCsr();

    // A public key is not a CSR — it carries no self-signature to prove
    // possession, so issuance must fail with 400.
    const resp = await issueCert(session, { label: "pubkey-as-csr", csr_pem: pubKeyPem });
    expect(resp.status).toBe(400);
  });

  test("a CSR with a tampered self-signature (failed PoP) is rejected", async () => {
    const session = await newLoggedInUser();
    const { csrPem } = genKeypairCsr();
    const tampered = tamperCsrSignature(csrPem);

    const resp = await issueCert(session, { label: "tampered-csr", csr_pem: tampered });
    expect(resp.status).toBe(400);
  });
});
