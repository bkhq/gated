import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import {
  wgClientEd25519PubkeyPath,
  readPubkey,
  OTP_KEY_BASE32,
  OTP_KEY_BASE64,
} from "../helpers/gated-helpers";
import { resolve } from "path";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import * as OTPAuth from "otpauth";
import { Subprocess } from "bun";

const TESTS_DIR = resolve(import.meta.dir, "..");

describe("SSH User Auth OTP", () => {
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

  test("otp success and failure", async () => {
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
      openssh_public_key: readFileSync(`${TESTS_DIR}/ssh-keys/id_ed25519.pub`, "utf-8").trim(),
    });
    const keyBytes = Array.from(Buffer.from(OTP_KEY_BASE64, "base64"));
    await api.createOtpCredential(user.id, { secret_key: keyBytes });
    await api.updateUser(user.id, {
      username: user.username,
      credential_policy: { ssh: ["PublicKey", "Totp"] },
    });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `ssh-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: sshPort, username: "root", auth: { kind: "PublicKey" } },
    });
    await api.addTargetRole(target.id, role.id);

    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(OTP_KEY_BASE32),
      digits: 6,
      period: 30,
    });

    // Correct OTP
    let script = `
set timeout ${timeout - 5}

spawn ssh ${user.username}:${target.name}@localhost -p ${wg.sshPort} -o StrictHostKeychecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519 -o PreferredAuthentications=publickey,keyboard-interactive ls /bin/sh

expect "Two-factor authentication"
sleep 0.5
send "${totp.generate()}\\r"

expect {
    "/bin/sh"  { exit 0; }
    eof { exit 1; }
}
`;

    let proc = processes.start(["expect"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(script);
    proc.stdin.end();
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    // Wrong OTP
    script = `
set timeout ${timeout - 5}

spawn ssh ${user.username}:${target.name}@localhost -p ${wg.sshPort} -o StrictHostKeychecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519 -o PreferredAuthentications=publickey,keyboard-interactive ls /bin/sh

expect "Two-factor authentication"
sleep 0.5
send "12345678\\r"

expect {
    "/bin/sh"  { exit 0; }
    "Two-factor authentication" { exit 1; }
    eof { exit 1; }
}
`;

    proc = processes.start(["expect"], { stdin: "pipe", stdout: "pipe" });
    proc.stdin.write(script);
    proc.stdin.end();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });
});
