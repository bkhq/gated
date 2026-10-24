import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";

describe("SSH bound account", () => {
  const processes = new ProcessManager(60);
  let gateway: GatedProcess;
  beforeAll(async () => {
    gateway = await processes.startWg();
    await waitPort(gateway.httpPort, { recv: false, process: gateway.process });
  });
  afterAll(async () => { await processes.stop(); });

  test("uses the bound private key and username for a real upstream session", async () => {
    const keyPath = resolve(import.meta.dir, "../ssh-keys/id_ed25519");
    const port = processes.startSshServer({ trustedKeys: [readFileSync(`${keyPath}.pub`, "utf8").trim()] });
    await waitPort(port);
    const base = `https://localhost:${gateway.httpPort}`;
    const request = async (path: string, body: unknown) => {
      const response = await fetch(`${base}/admin/api${path}`, {
        method: "POST", headers: { "X-Gated-Token": "token-value", "Content-Type": "application/json" },
        body: JSON.stringify(body), tls: { rejectUnauthorized: false },
      } as any);
      expect(response.ok).toBe(true);
      return response.json() as Promise<any>;
    };
    const api = adminClient(base);
    const role = await api.createRole({ name: `bound-${randomUUID()}` });
    const user = await api.createUser({ username: `bound-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);
    const account = await request("/accounts", {
      name: `bound-${randomUUID()}`, kind: "ssh-key",
      credentials: { kind: "ssh-key", username: "root", private_key_pem: readFileSync(keyPath, "utf8") },
    });
    const target = await request("/targets", {
      name: `bound-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port, username: "wrong-inline-user", auth: { kind: "PublicKey" } },
      accounts: [{ account_id: account.id, role: "primary" }],
    });
    await api.addTargetRole(target.id, role.id);
    const client = processes.startSshClient(`${user.username}:${target.name}@localhost`,
      "-p", String(gateway.sshPort), "-i", "/dev/null", "-o", "PreferredAuthentications=password",
      "whoami", { password: "123" });
    const output = await new Response(client.stdout).text();
    expect(await client.exited).toBe(0);
    expect(output.trim()).toBe("root");
    let logs: any[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      logs = await request("/logs", { username: user.username, limit: 100 });
      if (logs.some(entry => entry.values.event === "target_connected")) break;
      await Bun.sleep(100);
    }
    const connections = logs.filter(entry => entry.values.event === "target_connected");
    expect(connections).toHaveLength(1);
    expect(connections[0].values.target).toBe(target.name);
    expect(connections[0].values.protocol).toBe("SSH");
    expect(logs.some(entry => /Request completed|Channel opened/.test(entry.text))).toBe(false);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "123" }), tls: { rejectUnauthorized: false },
    } as any);
    expect(login.status).toBe(201);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const socket = new WebSocket(`wss://localhost:${gateway.httpPort}/api/ssh/terminal/${target.name}`, {
      headers: { Cookie: cookie, Origin: base }, rejectUnauthorized: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Web SSH output timed out")), 15000);
        let output = "";
        socket.on("error", error => { clearTimeout(timer); reject(error); });
        socket.on("message", (data) => {
          const frame = Buffer.from(data as Buffer);
          if (frame[0] === 2) {
            const status = JSON.parse(frame.subarray(1).toString());
            if (status.status === "connected") socket.send(Buffer.concat([Buffer.from([0]), Buffer.from("printf '__WEB_%s__\\n' READY\n")]));
            if (status.status === "error") { clearTimeout(timer); reject(new Error(status.message)); }
          }
          if (frame[0] === 0) output += frame.subarray(1).toString();
          if (output.includes("__WEB_READY__")) { clearTimeout(timer); resolve(); }
        });
      });
      const response = await fetch(`${base}/admin/api/sessions`, {
        headers: { "X-Gated-Token": "token-value" }, tls: { rejectUnauthorized: false },
      } as any);
      const { items } = await response.json() as { items: { protocol: string }[] };
      expect(items.some(item => item.protocol === "WebSSH")).toBe(true);
      expect(items.some(item => item.protocol === "ManagementHTTP")).toBe(false);
    } finally { socket.close(); }
  }, 120000);
});
