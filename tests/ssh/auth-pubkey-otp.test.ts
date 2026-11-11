import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { OTP_KEY_BASE64, wgClientEd25519PubkeyPath, readPubkey, sshPublicKeyAuth } from "../helpers/gated-helpers";
import { resolve } from "path";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";

const TESTS_DIR = resolve(import.meta.dir, "..");

// Enrolling OTP in the web UI turns the SSH policy into `[Password, Totp]`.
// A registered key must still sign in on its own: the key is a factor the
// user holds, and asking a key user for a password and an OTP on every
// connection is what the policy upgrade used to do.
describe("SSH User Auth PublicKey with OTP enrolled", () => {
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

  test("a registered key signs in without a password or OTP prompt", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPublicKeyCredential(user.id, {
      label: "Public Key",
      // Keys pasted with a comment must match as well.
      openssh_public_key: `${readFileSync(`${TESTS_DIR}/ssh-keys/id_ed25519.pub`, "utf-8").trim()} alice@laptop`,
    });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.createOtpCredential(user.id, { secret_key: Array.from(Buffer.from(OTP_KEY_BASE64, "base64")) });
    await api.updateUser(user.id, {
      username: user.username,
      credential_policy: { ssh: ["Password", "Totp"] },
    });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `ssh-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: sshPort, username: "root", auth: sshPublicKeyAuth() },
    });
    await api.addTargetRole(target.id, role.id);

    // BatchMode fails instead of prompting, so a password or OTP prompt
    // would fail the test.
    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519`,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "ls", "/bin/sh"
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("/bin/sh\n");
    expect(proc.exitCode).toBe(0);
  });
});
