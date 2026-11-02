import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { wgClientEd25519PubkeyPath, readPubkey } from "../helpers/gated-helpers";
import { resolve } from "path";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";

const TESTS_DIR = resolve(import.meta.dir, "..");

describe("SSH User Auth PublicKey", () => {
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

  test("ed25519 pubkey auth", async () => {
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
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `ssh-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: sshPort, username: "root", auth: { kind: "PublicKey" } },
    });
    await api.addTargetRole(target.id, role.id);

    // Correct key
    let proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519`,
      "-o", "PreferredAuthentications=publickey",
      "ls", "/bin/sh"
    );
    let stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("/bin/sh\n");
    expect(proc.exitCode).toBe(0);

    // Wrong key
    proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_rsa`,
      "-o", "PreferredAuthentications=publickey",
      "ls", "/bin/sh"
    );
    stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("");
    expect(proc.exitCode).not.toBe(0);
  });

  test("rsa pubkey auth", async () => {
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
      openssh_public_key: readFileSync(`${TESTS_DIR}/ssh-keys/id_rsa.pub`, "utf-8").trim(),
    });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `ssh-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: sshPort, username: "root", auth: { kind: "PublicKey" } },
    });
    await api.addTargetRole(target.id, role.id);

    // Correct RSA key
    let proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-v", "-p", String(wg.sshPort),
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_rsa`,
      "-o", "PreferredAuthentications=publickey",
      "-o", "PubkeyAcceptedKeyTypes=+ssh-rsa",
      "ls", "/bin/sh"
    );
    let stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("/bin/sh\n");
    expect(proc.exitCode).toBe(0);

    // Wrong key (ed25519 instead of rsa)
    proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519`,
      "-o", "PreferredAuthentications=publickey",
      "-o", "PubkeyAcceptedKeyTypes=+ssh-rsa",
      "ls", "/bin/sh"
    );
    stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("");
    expect(proc.exitCode).not.toBe(0);
  });
});
