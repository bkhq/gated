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
});
