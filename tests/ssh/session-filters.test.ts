import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { wgClientEd25519PubkeyPath, readPubkey, setupUserAndSshTarget } from "../helpers/gated-helpers";

describe("Session list filters", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
  });

  async function sessions(query: string) {
    const res = await fetch(`${url}/admin/api/sessions?${query}`, {
      headers: { "X-Gated-Token": "token-value" },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(res.status).toBe(200);
    return (await res.json()) as { items: any[]; total: number; offset: number };
  }

  test("filters by protocol, user, target, search and start time, and pages", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);
    const api = adminClient(url);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    for (let i = 0; i < 2; i++) {
      const proc = processes.startSshClient(
        `${user.username}:${target.name}@localhost`,
        "-p", String(wg.sshPort),
        "-i", "/dev/null",
        "-o", "PreferredAuthentications=password",
        "ls", "/bin/sh",
        { password: "123" }
      );
      await new Response(proc.stdout).text();
      await proc.exited;
      expect(proc.exitCode).toBe(0);
    }

    const byUser = `username=${encodeURIComponent(user.username)}`;
    for (let i = 0; i < 50 && (await sessions(byUser)).total < 2; i++) await Bun.sleep(100);

    expect((await sessions(byUser)).total).toBe(2);
    expect((await sessions(`${byUser}&protocol=ssh`)).total).toBe(2);
    for (let i = 0; i < 50 && (await sessions(`${byUser}&closed_only=true`)).total < 2; i++) await Bun.sleep(100);
    expect((await sessions(`${byUser}&closed_only=true`)).total).toBe(2);
    expect((await sessions(`${byUser}&active_only=true`)).total).toBe(0);
    expect((await sessions(`${byUser}&protocol=mysql`)).total).toBe(0);
    expect((await sessions(`${byUser}&protocol=bogus`)).total).toBe(0);
    expect((await sessions(`target_id=${target.id}`)).total).toBe(2);
    expect((await sessions(`search=${encodeURIComponent(target.name.slice(4, 16))}`)).total).toBe(2);
    expect((await sessions(`search=no-such-thing`)).total).toBe(0);
    expect((await sessions(`${byUser}&since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).total).toBe(0);

    const page = await sessions(`${byUser}&limit=1&offset=1`);
    expect(page.total).toBe(2);
    expect(page.offset).toBe(1);
    expect(page.items).toHaveLength(1);
  });
});
