import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, ADMIN_TOKEN, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import {
  OTP_KEY_BASE64,
  readPubkey,
  setupUserAndSshTarget,
  wgClientEd25519PubkeyPath,
} from "../helpers/gated-helpers";
import { resolve } from "path";

// With `mfa_required` on, SSH is closed to a user without an OTP device.
describe("SSH MFA enforcement", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let api: AdminClient;

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
  });

  afterAll(async () => {
    await processes.stop();
  });

  const setParameters = async (patch: Record<string, unknown>) => {
    const call = (method: string, body?: unknown) =>
      fetch(`${url}/admin/api/parameters`, {
        method,
        headers: { "X-Gated-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        tls: { rejectUnauthorized: false },
      } as any);
    const current = await (await call("GET")).json();
    expect((await call("PUT", { ...current, ...patch })).status).toBe(201);
  };

  test("SSH refuses a user until an OTP device is enrolled", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);
    const { user, target } = await setupUserAndSshTarget(api, sshPort, {
      addPassword: false,
      addPubkey: true,
    });
    const connect = async () => {
      const proc = processes.startSshClient(
        `${user.username}:${target.name}@localhost`,
        "-p", String(wg.sshPort),
        "-o", `IdentityFile=${resolve(import.meta.dir, "../ssh-keys/id_ed25519")}`,
        "-o", "PreferredAuthentications=publickey",
        "ls", "/bin/sh",
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { stdout, exitCode: proc.exitCode };
    };

    await setParameters({ mfa_required: true });
    try {
      expect((await connect()).exitCode).not.toBe(0);

      await api.createOtpCredential(user.id, {
        secret_key: Array.from(Buffer.from(OTP_KEY_BASE64, "base64")),
      });
      const allowed = await connect();
      expect(allowed.stdout).toBe("/bin/sh\n");
      expect(allowed.exitCode).toBe(0);
    } finally {
      await setParameters({ mfa_required: false });
    }
  }, 60_000);
});
