import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { allocPort, waitPort } from "../helpers/util";
import {
  wgClientEd25519PubkeyPath,
  wgClientRsaPubkeyPath,
  readPubkey,
  setupUserAndSshTarget,
} from "../helpers/gated-helpers";
import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";

const TESTS_DIR = resolve(import.meta.dir, "..");

const commonArgs = [
  "-i", "/dev/null",
  "-o", "PreferredAuthentications=password",
];

async function setupSshTest(
  processes: ProcessManager,
  wg: GatedProcess,
  pubkeyPath: string,
  extraConfig = ""
) {
  const sshPort = processes.startSshServer({
    trustedKeys: [readPubkey(pubkeyPath)],
    extraConfig,
  });
  await waitPort(sshPort);

  const url = `https://localhost:${wg.httpPort}`;
  const api = adminClient(url);
  const { user, target } = await setupUserAndSshTarget(api, sshPort, { addPubkey: true });
  return { user, target, sshPort };
}

describe("SSH Proto", () => {
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

  test("stdout stderr", async () => {
    const { user, target } = await setupSshTest(processes, wg, wgClientEd25519PubkeyPath());

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      ...commonArgs,
      "sh", "-c", '"echo -n stdout; echo -n stderr >&2"',
      { password: "123", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    expect(stdout).toBe("stdout");
    expect(stderr.endsWith("stderr")).toBe(true);
  });

  test("pty", async () => {
    const { user, target } = await setupSshTest(processes, wg, wgClientEd25519PubkeyPath());

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-tt",
      ...commonArgs,
      "echo", "hello",
      { password: "123" }
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    expect(output).toContain("Gated");
    expect(output).toContain("Selected target:");
    expect(output).toContain("hello\r\n");
  });

  test("signals", async () => {
    const { user, target } = await setupSshTest(processes, wg, wgClientEd25519PubkeyPath());

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-v",
      ...commonArgs,
      "sh", "-c", '"pkill -9 sh"',
      { password: "123" }
    );
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("direct tcpip", async () => {
    const { user, target } = await setupSshTest(processes, wg, wgClientEd25519PubkeyPath());
    const localPort = allocPort();

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-v",
      ...commonArgs,
      "-L", `${localPort}:github.com:443`,
      "-N",
      { password: "123" }
    );

    await Bun.sleep(10000);
    await waitPort(localPort, { recv: false });

    const resp = await fetch(`https://localhost:${localPort}`, {
      tls: { rejectUnauthorized: false },
    } as any);
    expect(resp.status).toBe(200);
    proc.kill();
  });

  test("tcpip forward", async () => {
    const { user, target } = await setupSshTest(processes, wg, wgClientEd25519PubkeyPath());
    const fwPort = allocPort();

    const pfClient = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-v",
      ...commonArgs,
      "-R", `${fwPort}:www.google.com:443`,
      "-N",
      { password: "123" }
    );

    const sshClient = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-v",
      ...commonArgs,
      "curl", "-vk", "--http1.1",
      "-H", "Host: www.google.com",
      `https://localhost:${fwPort}`,
      { password: "123" }
    );

    const output = await new Response(sshClient.stdout).text();
    await sshClient.exited;
    expect(sshClient.exitCode).toBe(0);
    expect(output).toContain("</html>");
    pfClient.kill();
  });

  test("shell", async () => {
    const { user, target } = await setupSshTest(processes, wg, wgClientEd25519PubkeyPath());

    const script = `
set timeout ${timeout - 5}

spawn ssh -tt ${user.username}:${target.name}@localhost -p ${wg.sshPort} -o StrictHostKeychecking=no -o UserKnownHostsFile=/dev/null -o PreferredAuthentications=password

expect "password:"
sleep 0.5
send "123\\r"

expect "#"
sleep 0.5
send "ls /bin/sh\\r"
send "exit\\r"

expect {
    "/bin/sh"  { exit 0; }
    eof { exit 1; }
}

exit 1
`;

    const proc = processes.start(["expect", "-d"], {
      stdin: "pipe",
      stdout: "pipe",
    });
    proc.stdin.write(script);
    proc.stdin.end();

    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
  });

  test("connection error", async () => {
    const { user, target } = await setupSshTest(processes, wg, wgClientEd25519PubkeyPath());

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-tt",
      "user:ssh-bad-domain@localhost",
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      { password: "123" }
    );
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("sftp", async () => {
    const { user, target } = await setupSshTest(processes, wg, wgClientEd25519PubkeyPath());
    const tmpDir = `${processes.ctx.tmpdir}/sftp-${randomUUID()}`;
    Bun.spawnSync(["mkdir", "-p", tmpDir]);

    const proc = Bun.spawnSync([
      "sftp",
      "-P", String(wg.sshPort),
      "-o", `User=${user.username}:${target.name}`,
      "-o", "IdentitiesOnly=yes",
      "-o", `IdentityFile=${TESTS_DIR}/ssh-keys/id_ed25519`,
      "-o", "PreferredAuthentications=publickey",
      "-o", "StrictHostKeychecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "localhost:/etc/passwd",
      tmpDir,
    ]);

    const content = readFileSync(`${tmpDir}/passwd`, "utf-8");
    expect(content).toContain("root:x:0:0:root");
  });

  test("insecure protos", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientRsaPubkeyPath())],
      extraConfig: "PubkeyAcceptedKeyTypes=ssh-rsa",
    });
    await waitPort(sshPort);

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const { user, target } = await setupUserAndSshTarget(api, sshPort, { addPubkey: true });

    // Should fail without allow_insecure_algos
    let proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      ...commonArgs,
      "echo", "123",
      { password: "123", stderr: "pipe" }
    );
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);

    // Enable insecure algos
    target.options.allow_insecure_algos = true;
    await api.updateTarget(target.id, {
      name: target.name,
      options: target.options,
    });

    proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      ...commonArgs,
      "echo", "123",
      { password: "123" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("123\n");
  });
});
