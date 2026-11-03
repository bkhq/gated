import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { X509Certificate } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { connect } from "tls";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { allocPort, waitPort } from "../helpers/util";

// Pebble: Let's Encrypt's ACME test server. Validation is switched off, so
// the test checks what gated sends to the DNS provider instead.
const PEBBLE_IMAGE = "ghcr.io/letsencrypt/pebble:2.10.1";
const PEBBLE_CA = readFileSync(join(import.meta.dir, "../certs/pebble.minica.pem"), "utf-8");
const TOKEN = "token-value";

function servedFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate().fingerprint256);
      socket.end();
    });
    socket.on("error", reject);
  });
}

describe("ACME listener certificates", () => {
  const processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
  const dnsCalls: { path: string; auth: string | null; body: { fqdn: string; value: string } }[] = [];
  let dns: ReturnType<typeof Bun.serve>;
  let pebblePort: number;
  let gated: GatedProcess;

  async function admin(method: string, path: string, body?: unknown) {
    return fetch(`https://localhost:${gated.httpPort}/admin/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Gated-Token": TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);
  }

  beforeAll(async () => {
    dns = Bun.serve({
      port: 0,
      async fetch(req) {
        dnsCalls.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
          body: await req.json(),
        });
        return new Response("ok");
      },
    });

    pebblePort = allocPort();
    processes.start([
      "docker", "run", "--rm",
      "-p", `${pebblePort}:14000`,
      "-e", "PEBBLE_VA_ALWAYS_VALID=1",
      "-e", "PEBBLE_WFE_NONCEREJECT=0",
      PEBBLE_IMAGE,
    ]);
    await waitPort(pebblePort, { recv: false, timeout: 60000 });

    gated = await processes.startWg({});
  });

  afterAll(async () => {
    dns?.stop(true);
    await processes.stop();
  });

  test("issues, serves and records certificates through the httpreq provider", async () => {
    const settings = await admin("PUT", "/tls/acme", {
      directory_url: `https://localhost:${pebblePort}/dir`,
      contact_email: "ops@example.com",
      ca_certificate_pem: PEBBLE_CA,
      dns_provider: "httpreq",
      dns_endpoint: `http://127.0.0.1:${dns.port}`,
      dns_username: "dns-user",
      dns_password: "dns-key",
      propagation_delay_secs: 0,
    });
    expect(settings.status).toBe(200);
    expect((await settings.json()).dns_password_set).toBe(true);

    const issued = await admin("PUT", "/tls/certificates/http/acme", {
      domains: ["proxy.example.com", "*.proxy.example.com"],
    });
    const body = await issued.json();
    expect(issued.status, JSON.stringify(body)).toBe(200);
    expect(body.acme.domains).toEqual(["proxy.example.com", "*.proxy.example.com"]);
    expect(body.acme.last_error).toBeNull();
    expect(body.chain[0].issuer).toContain("Pebble");
    expect([...body.chain[0].subject_alt_names].sort()).toEqual(["*.proxy.example.com", "proxy.example.com"]);

    // Both challenges share one record name; each was published and removed.
    const auth = `Basic ${btoa("dns-user:dns-key")}`;
    const presents = dnsCalls.filter((c) => c.path === "/present");
    expect(presents.length).toBe(2);
    for (const call of presents) {
      expect(call.auth).toBe(auth);
      expect(call.body.fqdn).toBe("_acme-challenge.proxy.example.com.");
    }
    const cleanups = dnsCalls.filter((c) => c.path === "/cleanup");
    expect(cleanups.map((c) => c.body.value).sort()).toEqual(presents.map((c) => c.body.value).sort());

    // Served without a restart.
    expect(await servedFingerprint(gated.kubernetesPort)).toBe(body.chain[0].sha256_fingerprint);
  });

  test("the admin listener's ACME certificate is written to its files and served", async () => {
    const before = await servedFingerprint(gated.httpPort);
    const issued = await admin("PUT", "/tls/certificates/admin/acme", { domains: ["admin.example.com"] });
    const body = await issued.json();
    expect(issued.status, JSON.stringify(body)).toBe(200);
    const fingerprint = body.chain[0].sha256_fingerprint;
    expect(fingerprint).not.toBe(before);
    expect(await servedFingerprint(gated.httpPort)).toBe(fingerprint);

    const certFile = readFileSync(join(dirname(gated.configPath), "tls.certificate.pem"), "utf-8");
    expect(new X509Certificate(certFile).fingerprint256).toBe(fingerprint);
    const list = await (await admin("GET", "/tls/certificates")).json();
    const adminCert = list.find((c: { listener: string }) => c.listener === "admin");
    expect(adminCert.chain[0].sha256_fingerprint).toBe(fingerprint);
    expect(adminCert.acme.domains).toEqual(["admin.example.com"]);

    // Turning ACME off keeps the certificate.
    expect((await admin("DELETE", "/tls/certificates/admin/acme")).status).toBe(204);
    expect(await servedFingerprint(gated.httpPort)).toBe(fingerprint);
  });
});
