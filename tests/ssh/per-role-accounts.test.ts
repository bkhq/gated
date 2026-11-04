import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";

describe("SSH per-role target accounts", () => {
  const processes = new ProcessManager(60);
  let gateway: GatedProcess;
  beforeAll(async () => {
    gateway = await processes.startWg();
    await waitPort(gateway.httpPort, { recv: false, process: gateway.process });
  });
  afterAll(async () => { await processes.stop(); });

  test("a user in two roles picks the account; each choice signs in with its own credentials", async () => {
    const keyPath = resolve(import.meta.dir, "../ssh-keys/id_ed25519");
    const port = processes.startSshServer({ trustedKeys: [readFileSync(`${keyPath}.pub`, "utf8").trim()] });
    await waitPort(port);
    const base = `https://localhost:${gateway.httpPort}`;
    const admin = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}/admin/api${path}`, {
        method, headers: { "X-Gated-Token": "token-value", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), tls: { rejectUnauthorized: false },
      } as any);
      expect(response.ok).toBe(true);
      return response.status === 204 ? undefined : response.json() as Promise<any>;
    };
    const api = adminClient(base);
    const suffix = randomUUID().slice(0, 8);
    const trusted = await admin("POST", "/accounts", {
      name: `a-trusted-${suffix}`, kind: "ssh-key",
      credentials: { kind: "ssh-key", username: "root", private_key_pem: readFileSync(keyPath, "utf8") },
    });
    const untrusted = await admin("POST", "/accounts", {
      name: `b-untrusted-${suffix}`, kind: "ssh-key",
      credentials: { kind: "ssh-key", username: "root", generate: "ed25519" },
    });
    const target = await admin("POST", "/targets", {
      name: `per-role-${suffix}`,
      options: { kind: "Ssh", host: "localhost", port, username: "root", auth: { kind: "PublicKey" } },
      accounts: [{ account_id: untrusted.id, role: "primary" }, { account_id: trusted.id, role: "fallback" }],
    });
    const dev = await api.createRole({ name: `dev-${suffix}` });
    const ops = await api.createRole({ name: `ops-${suffix}` });
    const user = await api.createUser({ username: `per-role-${suffix}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, dev.id);
    await api.addTargetRole(target.id, dev.id);
    await api.addTargetRole(target.id, ops.id);
    await admin("PUT", `/targets/${target.id}/roles/${dev.id}/account`, { account_id: trusted.id });

    const ssh = (login: string) => processes.startSshClient(`${login}@localhost`,
      "-p", String(gateway.sshPort), "-i", "/dev/null", "-o", "PreferredAuthentications=password",
      "whoami", { password: "123" });

    // Only `dev` applies: its account is used without asking.
    let client = ssh(`${user.username}:${target.name}`);
    expect((await new Response(client.stdout).text()).trim()).toBe("root");
    expect(await client.exited).toBe(0);
    const roleAccounts = await admin("GET", `/targets/${target.id}/role-accounts`);
    expect(roleAccounts).toContainEqual({ role_id: dev.id, account_id: trusted.id });
    expect(roleAccounts).toContainEqual({ role_id: ops.id, account_id: null });

    // With `ops` too, the default (primary, untrusted) login is a second choice.
    await api.addUserRole(user.id, ops.id);
    client = ssh(`${user.username}:${target.name}`);
    expect((await new Response(client.stdout).text()).trim()).not.toBe("root");
    expect(await client.exited).not.toBe(0);
    client = ssh(`${user.username}:${target.name}:${trusted.name}`);
    expect((await new Response(client.stdout).text()).trim()).toBe("root");
    expect(await client.exited).toBe(0);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "123" }), tls: { rejectUnauthorized: false },
    } as any);
    expect(login.status).toBe(201);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const choices = await fetch(`${base}/api/targets/${target.name}/accounts`, {
      headers: { Cookie: cookie }, tls: { rejectUnauthorized: false },
    } as any);
    expect(await choices.json()).toEqual([trusted.name, untrusted.name]);

    const webStatus = (account?: string) => new Promise<{ status: string, message: string }>((resolveFn, reject) => {
      const query = account ? `?account=${encodeURIComponent(account)}` : "";
      const socket = new WebSocket(`wss://localhost:${gateway.httpPort}/api/ssh/terminal/${target.name}${query}`, {
        headers: { Cookie: cookie, Origin: base }, rejectUnauthorized: false,
      });
      const timer = setTimeout(() => { socket.close(); reject(new Error("no status frame")); }, 15000);
      socket.on("error", error => { clearTimeout(timer); reject(error); });
      socket.on("message", (data) => {
        const frame = Buffer.from(data as Buffer);
        if (frame[0] !== 2) return;
        const status = JSON.parse(frame.subarray(1).toString());
        if (status.status === "connected" || status.status === "error") {
          clearTimeout(timer);
          socket.close();
          resolveFn(status);
        }
      });
    });
    const ambiguous = await webStatus();
    expect(ambiguous.status).toBe("error");
    expect(ambiguous.message).toContain(trusted.name);
    expect((await webStatus(trusted.name)).status).toBe("connected");

    let logs: any[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      logs = await admin("POST", "/logs", { search: trusted.name, limit: 200 });
      if (logs.some(entry => entry.text === "Target account selected")) break;
      await Bun.sleep(100);
    }
    expect(logs.some(entry => entry.text === "Target account selected" && entry.values.account === trusted.name)).toBe(true);
  }, 180000);
});
