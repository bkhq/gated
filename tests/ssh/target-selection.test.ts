import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { wgClientEd25519PubkeyPath, readPubkey, setupUserAndSshTarget } from "../helpers/gated-helpers";

describe("SSH Target Selection", () => {
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

  test("bad target returns permission denied", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    const proc = processes.startSshClient(
      "-t",
      `${user.username}:badtarget@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "echo", "hello",
      { password: "123", stderr: "pipe" }
    );
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
    expect(stderr).toContain("Permission denied");
  });
});
