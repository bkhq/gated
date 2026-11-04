import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";

describe("API SSH - Known Hosts", () => {
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

  test("get known hosts returns array", async () => {
    const api = adminClient(url);
    const hosts = await api.getSshKnownHosts();
    expect(Array.isArray(hosts)).toBe(true);
  });

  test("adds a host key and explains an invalid one", async () => {
    const api = adminClient(url);
    const post = async (body: unknown) => fetch(`${url}/admin/api/ssh/known-hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gated-Token": "token-value" },
      body: JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);

    const invalid = await post({ host: "10.9.8.7", port: 22, key_type: "ssh-ed25519", key_base64: "not-base64" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toStartWith("invalid host key");

    const key_base64 = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    const added = await post({ host: "10.9.8.7", port: 22, key_type: "ssh-ed25519", key_base64 });
    expect(added.status).toBe(200);
    const again = await post({ host: "10.9.8.7", port: 22, key_type: "ssh-ed25519", key_base64 });
    expect((await again.json()).id).toBe((await added.json()).id);
    const hosts = await api.getSshKnownHosts();
    expect(hosts.filter((h: any) => h.host === "10.9.8.7" && h.key_base64 === key_base64)).toHaveLength(1);
  });
});
