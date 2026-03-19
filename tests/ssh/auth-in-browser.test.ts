import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import {
  wgClientEd25519PubkeyPath,
  readPubkey,
} from "../helpers/gated-helpers";
import { resolve } from "path";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import WebSocket from "ws";

const TESTS_DIR = resolve(import.meta.dir, "..");

describe("SSH User Auth In Browser", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
  });

  test.each([true, false])("web user approval (include_pk=%p)", async (includePk) => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    if (includePk) {
      await api.createPublicKeyCredential(user.id, {
        label: "Public Key",
        openssh_public_key: readFileSync(`${TESTS_DIR}/ssh-keys/id_ed25519.pub`, "utf-8").trim(),
      });
    }
    await api.addUserRole(user.id, role.id);

    const credPolicy = includePk
      ? { ssh: ["PublicKey", "WebUserApproval"] }
      : { ssh: ["WebUserApproval"] };
    await api.updateUser(user.id, {
      username: user.username,
      credential_policy: credPolicy,
    });

    const target = await api.createTarget({
      name: `ssh-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: sshPort, username: "root", auth: { kind: "PublicKey" } },
    });
    await api.addTargetRole(target.id, role.id);

    // Login via HTTP
    const loginResp = await fetch(`${url}/@gated/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "123" }),
      tls: { rejectUnauthorized: false },
    } as any);
    const loginCookies = loginResp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // Connect WebSocket to listen for auth requests
    const wsUrl = `wss://localhost:${wg.httpPort}/@gated/api/auth/web-auth-requests/stream`;
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: loginCookies },
      rejectUnauthorized: false,
    });

    const authIdPromise = new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 10000);
    });

    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Start SSH client
    const sshClient = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519`,
      "ls", "/bin/sh"
    );

    // Wait for auth request
    const authId = await authIdPromise;

    // Verify auth state
    const stateResp = await fetch(`${url}/@gated/api/auth/state/${authId}`, {
      headers: { Cookie: loginCookies },
      tls: { rejectUnauthorized: false },
    } as any);
    const authState = (await stateResp.json()) as any;
    expect(authState.protocol).toBe("SSH");
    expect(authState.state).toBe("WebUserApprovalNeeded");

    // Approve
    const approveResp = await fetch(`${url}/@gated/api/auth/state/${authId}/approve`, {
      method: "POST",
      headers: { Cookie: loginCookies },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(approveResp.status).toBe(200);

    // Send newline to stdin to trigger completion
    sshClient.stdin.write("\r\n");

    const stdout = await new Response(sshClient.stdout).text();
    await sshClient.exited;
    expect(stdout).toBe("/bin/sh\n");
    expect(sshClient.exitCode).toBe(0);

    ws.close();
  });
});
