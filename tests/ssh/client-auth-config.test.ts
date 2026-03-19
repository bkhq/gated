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

const TESTS_DIR = resolve(import.meta.dir, "..");

describe("SSH Client Auth Config API", () => {
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

  test("get ssh auth parameters", async () => {
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const params = await api.getParameters();
    expect(params.ssh_client_auth_publickey).toBe(true);
    expect(params.ssh_client_auth_password).toBe(true);
    expect(params.ssh_client_auth_keyboard_interactive).toBe(true);
  });

  test("update ssh auth parameters", async () => {
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const params = await api.getParameters();

    await api.updateParameters({
      allow_own_credential_management: params.allow_own_credential_management,
      rate_limit_bytes_per_second: params.rate_limit_bytes_per_second,
      ssh_client_auth_publickey: true,
      ssh_client_auth_password: false,
      ssh_client_auth_keyboard_interactive: true,
    });

    const updated = await api.getParameters();
    expect(updated.ssh_client_auth_password).toBe(false);
    expect(updated.ssh_client_auth_publickey).toBe(true);

    // Restore
    await api.updateParameters({
      allow_own_credential_management: params.allow_own_credential_management,
      rate_limit_bytes_per_second: params.rate_limit_bytes_per_second,
      ssh_client_auth_publickey: true,
      ssh_client_auth_password: true,
      ssh_client_auth_keyboard_interactive: true,
    });
  });
});

describe("SSH Client Auth Config E2E", () => {
  let processes: ProcessManager;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(() => {
    processes = new ProcessManager(timeout);
  });

  afterAll(async () => {
    await processes.stop();
  });

  function startSshServer() {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    return sshPort;
  }

  async function setupUserAndTarget(api: ReturnType<typeof adminClient>, sshPort: number) {
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "testpass123" });
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
    return { user, target };
  }

  async function updateSshAuthParams(
    api: ReturnType<typeof adminClient>,
    opts: { pubkey?: boolean; password?: boolean; keyboardInteractive?: boolean }
  ) {
    const params = await api.getParameters();
    await api.updateParameters({
      allow_own_credential_management: params.allow_own_credential_management,
      rate_limit_bytes_per_second: params.rate_limit_bytes_per_second,
      ssh_client_auth_publickey: opts.pubkey ?? true,
      ssh_client_auth_password: opts.password ?? true,
      ssh_client_auth_keyboard_interactive: opts.keyboardInteractive ?? true,
    });
  }

  test("password auth disabled", async () => {
    const sshPort = startSshServer();
    await Bun.sleep(3000);
    await waitPort(sshPort);

    const wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const { user, target } = await setupUserAndTarget(api, sshPort);
    await updateSshAuthParams(api, { pubkey: true, password: false, keyboardInteractive: false });

    wg.process.kill("SIGTERM");
    await wg.process.exited;

    const wg2 = await processes.startWg({ shareWith: wg });
    await waitPort(wg2.httpPort, { recv: false, process: wg2.process });
    await waitPort(wg2.sshPort, { process: wg2.process });

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg2.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "-o", "NumberOfPasswordPrompts=1",
      "ls", "/bin/sh",
      { password: "testpass123" }
    );
    await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("pubkey auth disabled", async () => {
    const sshPort = startSshServer();
    await Bun.sleep(3000);
    await waitPort(sshPort);

    const wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const { user, target } = await setupUserAndTarget(api, sshPort);
    await updateSshAuthParams(api, { pubkey: false, password: true, keyboardInteractive: false });

    wg.process.kill("SIGTERM");
    await wg.process.exited;

    const wg2 = await processes.startWg({ shareWith: wg });
    await waitPort(wg2.httpPort, { recv: false, process: wg2.process });
    await waitPort(wg2.sshPort, { process: wg2.process });

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg2.sshPort),
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519`,
      "-o", "PreferredAuthentications=publickey",
      "ls", "/bin/sh"
    );
    await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("pubkey auth enabled works", async () => {
    const sshPort = startSshServer();
    await Bun.sleep(3000);
    await waitPort(sshPort);

    const wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const { user, target } = await setupUserAndTarget(api, sshPort);
    await updateSshAuthParams(api, { pubkey: true, password: false, keyboardInteractive: false });

    wg.process.kill("SIGTERM");
    await wg.process.exited;

    const wg2 = await processes.startWg({ shareWith: wg });
    await waitPort(wg2.httpPort, { recv: false, process: wg2.process });
    await waitPort(wg2.sshPort, { process: wg2.process });

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg2.sshPort),
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519`,
      "-o", "PreferredAuthentications=publickey",
      "ls", "/bin/sh"
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("/bin/sh\n");
    expect(proc.exitCode).toBe(0);
  });

  test("password auth enabled works", async () => {
    const sshPort = startSshServer();
    await Bun.sleep(3000);
    await waitPort(sshPort);

    const wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const { user, target } = await setupUserAndTarget(api, sshPort);
    await updateSshAuthParams(api, { pubkey: false, password: true, keyboardInteractive: false });

    wg.process.kill("SIGTERM");
    await wg.process.exited;

    const wg2 = await processes.startWg({ shareWith: wg });
    await waitPort(wg2.httpPort, { recv: false, process: wg2.process });
    await waitPort(wg2.sshPort, { process: wg2.process });

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg2.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "ls", "/bin/sh",
      { password: "testpass123" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("/bin/sh\n");
    expect(proc.exitCode).toBe(0);
  });
});
