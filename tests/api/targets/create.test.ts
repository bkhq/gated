import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";
import { sshPublicKeyAuth } from "../../helpers/gated-helpers";

describe("API Targets - Create", () => {
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

  test("create API target", async () => {
    const api = adminClient(url);
    const name = `target-${randomUUID()}`;
    const target = await api.createTarget({
      name,
      options: {
        kind: "Http",
        url: "https://httpbin.org/get",
        tls: { mode: "Preferred", verify: true },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });

    expect(target.id).toBeTruthy();
    expect(target.name).toBe(name);
  });

  test("create SSH target", async () => {
    const api = adminClient(url);
    const name = `ssh-target-${randomUUID()}`;
    const target = await api.createTarget({
      name,
      options: {
        kind: "Ssh",
        host: "localhost",
        port: 22,
        username: "root",
        auth: sshPublicKeyAuth(),
      },
    });

    expect(target.id).toBeTruthy();
    expect(target.name).toBe(name);
  });

  test("rejects SSH public-key auth without a key or bound account", async () => {
    const api = adminClient(url);
    await expect(api.createTarget({
      name: `ssh-target-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: 22, username: "root", auth: { kind: "PublicKey" } },
    })).rejects.toMatchObject({ status: 422 });
  });
});
