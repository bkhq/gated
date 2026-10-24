import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Targets - Upstream certificate", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
  });

  async function httpTarget(upstream: string) {
    return adminClient(url).createTarget({
      name: `target-${randomUUID()}`,
      options: {
        kind: "Http",
        url: upstream,
        tls: { mode: "Preferred", verify: true },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });
  }

  async function certificate(id: string) {
    const res = await fetch(`${url}/admin/api/targets/${id}/upstream-certificate`, {
      headers: { "X-Gated-Token": "token-value" },
      tls: { rejectUnauthorized: false },
    } as any);
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  }

  test("reports the chain of an https upstream and why it is untrusted", async () => {
    // The gateway's own admin listener serves a self-signed certificate.
    const target = await httpTarget(`https://localhost:${wg.httpPort}`);
    const { status, body } = await certificate(target.id);
    expect(status).toBe(200);
    expect(body.tls).toBe(true);
    expect(body.verify).toBe(true);
    expect(body.error).toBeNull();
    expect(body.chain.length).toBeGreaterThan(0);
    expect(body.chain[0].sha256_fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(body.verify_error).toBeTruthy();
  });

  test("reports no TLS for an http upstream", async () => {
    const target = await httpTarget("http://localhost:1");
    const { status, body } = await certificate(target.id);
    expect(status).toBe(200);
    expect(body.tls).toBe(false);
    expect(body.chain).toEqual([]);
  });

  test("rejects non-HTTP targets", async () => {
    const target = await adminClient(url).createTarget({
      name: `target-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: 22, username: "root", auth: { kind: "PublicKey" } },
    });
    expect((await certificate(target.id)).status).toBe(400);
  });
});
