import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";
import { sshPublicKeyAuth } from "../../helpers/gated-helpers";

describe("API Targets - Update", () => {
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

  test("update target name and options", async () => {
    const api = adminClient(url);
    const target = await api.createTarget({
      name: `target-${randomUUID()}`,
      options: {
        kind: "Http",
        url: "https://httpbin.org/get",
        tls: { mode: "Preferred", verify: true },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });

    const newName = `updated-${randomUUID()}`;
    const updated = await api.updateTarget(target.id, {
      name: newName,
      options: {
        kind: "Http",
        url: "https://httpbin.org/get",
        tls: { mode: "Preferred", verify: true },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });
    expect(updated.name).toBe(newName);

    const fetched = await api.getTarget(target.id);
    expect(fetched.name).toBe(newName);
  });

  test("trims the name and address on create and update", async () => {
    const api = adminClient(url);
    const ssh = (host: string) => ({ kind: "Ssh", host, port: 22, username: "root", auth: sshPublicKeyAuth() });
    const name = `target-${randomUUID()}`;
    const target = await api.createTarget({ name: `  ${name}\t`, options: ssh(" 10.0.0.1  ") });
    expect(target.name).toBe(name);
    expect((target.options as any).host).toBe("10.0.0.1");

    const renamed = `updated-${randomUUID()}`;
    const updated = await api.updateTarget(target.id, { name: ` ${renamed} `, options: ssh("\t10.0.0.2 ") });
    expect(updated.name).toBe(renamed);
    expect((updated.options as any).host).toBe("10.0.0.2");

    const http = await api.createTarget({
      name: `target-${randomUUID()}`,
      options: {
        kind: "Http",
        url: " http://10.0.0.3:8080 ",
        tls: { mode: "Preferred", verify: true },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });
    expect((http.options as any).url).toBe("http://10.0.0.3:8080");
  });

  test("rejects a name of only whitespace", async () => {
    const response = await fetch(`${url}/admin/api/targets`, {
      method: "POST",
      headers: { "X-Gated-Token": "token-value", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "   ",
        options: { kind: "Ssh", host: "10.0.0.1", port: 22, username: "root", auth: sshPublicKeyAuth() },
      }),
      tls: { rejectUnauthorized: false },
    } as any);
    expect(response.status).toBe(400);
  });
});
