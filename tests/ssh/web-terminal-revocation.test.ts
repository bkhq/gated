import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";

// Web terminals and browser sessions must end when the gateway revokes them:
// an admin close, a removed role binding, or an admin revoking the browser
// session.
describe("Web terminal and browser session revocation", () => {
  const processes = new ProcessManager(60);
  let gateway: GatedProcess;
  let base: string;
  let api: AdminClient;
  let sshPort: number;
  const keyPath = resolve(import.meta.dir, "../ssh-keys/id_ed25519");

  beforeAll(async () => {
    gateway = await processes.startWg();
    await waitPort(gateway.httpPort, { recv: false, process: gateway.process });
    sshPort = processes.startSshServer({ trustedKeys: [readFileSync(`${keyPath}.pub`, "utf8").trim()] });
    await waitPort(sshPort);
    base = `https://localhost:${gateway.httpPort}`;
    api = adminClient(base);
  });
  afterAll(async () => { await processes.stop(); });

  async function admin(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}/admin/api${path}`, {
      method,
      headers: { "X-Gated-Token": "token-value", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);
  }

  async function setup() {
    const role = await api.createRole({ name: `revoke-${randomUUID()}` });
    const user = await api.createUser({ username: `revoke-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);
    const account = await (await admin("POST", "/accounts", {
      name: `revoke-${randomUUID()}`, kind: "ssh-key",
      credentials: { kind: "ssh-key", username: "root", private_key_pem: readFileSync(keyPath, "utf8") },
    })).json() as { id: number };
    const target = await (await admin("POST", "/targets", {
      name: `revoke-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: sshPort, username: "root", auth: { kind: "PublicKey" } },
      accounts: [{ account_id: account.id, role: "primary" }],
    })).json() as { id: string, name: string };
    await api.addTargetRole(target.id, role.id);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "123" }), tls: { rejectUnauthorized: false },
    } as any);
    expect(login.status).toBe(201);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return { role, user, target, cookie };
  }

  // Opens a web SSH terminal and resolves once the shell answers. The returned
  // promise `ended` settles with the final status frame and socket close.
  async function openTerminal(targetName: string, cookie: string) {
    const socket = new WebSocket(`wss://localhost:${gateway.httpPort}/api/ssh/terminal/${targetName}`, {
      headers: { Cookie: cookie, Origin: base }, rejectUnauthorized: false,
    });
    let lastStatus: { status: string, message: string } | null = null;
    const ended = new Promise<{ status: string, message: string } | null>((resolve) => {
      socket.on("close", () => resolve(lastStatus));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Web SSH output timed out")), 15000);
      let output = "";
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
      socket.on("message", (data) => {
        const frame = Buffer.from(data as Buffer);
        if (frame[0] === 2) {
          lastStatus = JSON.parse(frame.subarray(1).toString());
          if (lastStatus!.status === "connected")
            socket.send(Buffer.concat([Buffer.from([0]), Buffer.from("printf '__WEB_%s__\\n' READY\n")]));
          if (lastStatus!.status === "error") { clearTimeout(timer); reject(new Error(lastStatus!.message)); }
        }
        if (frame[0] === 0) output += frame.subarray(1).toString();
        if (output.includes("__WEB_READY__")) { clearTimeout(timer); resolve(); }
      });
    });
    return { socket, ended };
  }

  async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error(`${what} timed out`); })]);
  }

  test("removing the target-role binding closes an open web terminal", async () => {
    const { role, target, cookie } = await setup();
    const { socket, ended } = await openTerminal(target.name, cookie);
    try {
      await api.removeTargetRole(target.id, role.id);
      const status = await withTimeout(ended, 10000, "terminal close after revocation");
      expect(status?.status).toBe("closed");
      expect(status?.message).toContain("closed by the gateway");
    } finally { socket.close(); }
  }, 120000);

  test("admin close ends an open web terminal", async () => {
    const { user, target, cookie } = await setup();
    const { socket, ended } = await openTerminal(target.name, cookie);
    try {
      const { items } = await (await admin("GET", "/sessions?active_only=true")).json() as
        { items: { id: string, username: string | null, protocol: string }[] };
      const session = items.find(item => item.protocol === "WebSSH" && item.username === user.username);
      expect(session).toBeDefined();
      await api.closeSession(session!.id);
      const status = await withTimeout(ended, 10000, "terminal close after admin close");
      expect(status?.status).toBe("closed");
    } finally { socket.close(); }
  }, 120000);

  test("an admin can list and revoke a browser session", async () => {
    const { user, cookie } = await setup();
    const me = async () => fetch(`${base}/api/profile/sessions`, {
      headers: { Cookie: cookie }, tls: { rejectUnauthorized: false },
    } as any);
    expect((await me()).status).toBe(200);

    const sessions = await (await admin("GET", "/management-sessions")).json() as
      { id: string, username: string, current: boolean }[];
    const session = sessions.find(item => item.username === user.username);
    expect(session).toBeDefined();
    expect(session!.current).toBe(false);

    expect((await admin("DELETE", `/management-sessions/${session!.id}`)).status).toBe(204);
    expect((await admin("DELETE", `/management-sessions/${session!.id}`)).status).toBe(404);
    expect((await me()).status).toBe(401);
  }, 120000);
});
