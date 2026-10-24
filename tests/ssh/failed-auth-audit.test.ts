import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { wgClientEd25519PubkeyPath, readPubkey, setupUserAndSshTarget } from "../helpers/gated-helpers";

describe("SSH failed authentication", () => {
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

  async function adminPost(path: string, body: unknown) {
    const res = await fetch(`${url}/admin/api${path}`, {
      method: "POST",
      headers: { "X-Gated-Token": "token-value", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);
    return res.json();
  }

  async function ssh(login: string, password: string) {
    const proc = processes.startSshClient(
      login,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "ls", "/bin/sh",
      { password }
    );
    await new Response(proc.stdout).text();
    await proc.exited;
    return proc.exitCode;
  }

  test("a failed login is audited and not recorded as a session", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);
    const api = adminClient(url);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);
    const login = `${user.username}:${target.name}@localhost`;

    expect(await ssh(login, "321")).not.toBe(0);
    expect(await ssh(login, "123")).toBe(0);

    // Session rows and audit entries are written asynchronously.
    let sessions: any[] = [];
    let rejected: any[] = [];
    for (let i = 0; i < 50; i++) {
      sessions = (await api.getSessions()).filter((s) => s.username === user.username || s.target?.name === target.name);
      const logs = await adminPost("/logs", { username: user.username });
      rejected = logs.filter((l: any) => l.text === "auth_login_rejected");
      if (sessions.length >= 1 && sessions.every((s) => s.ended) && rejected.length >= 1) break;
      await Bun.sleep(100);
    }

    expect(sessions).toHaveLength(1);
    expect(sessions[0].username).toBe(user.username);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].values.protocol).toBe("ssh");
    expect(rejected[0].values.methods).toBe("password");
    expect(rejected[0].values.target).toBe(target.name);

    // No session without a user is left behind by the failed attempt.
    const anonymous = (await api.getSessions()).filter((s) => !s.username);
    expect(anonymous).toHaveLength(0);
  });
});
