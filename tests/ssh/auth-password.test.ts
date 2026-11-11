import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { wgClientEd25519PubkeyPath, readPubkey, setupUserAndSshTarget } from "../helpers/gated-helpers";

describe("SSH User Auth Password", () => {
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

  test("password auth success and failure", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    // Correct password
    let proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-v", "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "ls", "/bin/sh",
      { password: "123" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("/bin/sh\n");
    expect(proc.exitCode).toBe(0);

    // Wrong password
    proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "ls", "/bin/sh",
      { password: "321" }
    );
    await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });

  test("repeated wrong passwords lock the user out from this address", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);
    const api = adminClient(`https://localhost:${wg.httpPort}`);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    const login = async (password: string) => {
      const proc = processes.startSshClient(
        `${user.username}:${target.name}@localhost`,
        "-p", String(wg.sshPort),
        "-i", "/dev/null",
        "-o", "PreferredAuthentications=password",
        "-o", "NumberOfPasswordPrompts=1",
        "ls", "/bin/sh",
        { password }
      );
      await new Response(proc.stdout).text();
      await proc.exited;
      return proc.exitCode;
    };

    expect(await login("123")).toBe(0);
    for (let i = 0; i < 10; i++) expect(await login("321")).not.toBe(0);
    expect(await login("123")).not.toBe(0);
  }, 120_000);
});
