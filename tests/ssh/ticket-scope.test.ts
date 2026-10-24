import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort, allocPort } from "../helpers/util";
import { wgClientEd25519PubkeyPath, readPubkey } from "../helpers/gated-helpers";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join, resolve } from "path";
import { createConnection } from "net";

// Scope enforcement: a ticket scoped to target X must only ever reach X,
// and can never be coerced to a different target Y. The ticket itself dictates
// the target (the SSH username carries only the ticket secret, never a target
// selector), so scope is proven two ways:
//   1. The session opened by `ticket-<secret>` lands on X (its bound target),
//      never Y — verified via the admin sessions API.
//   2. Appending a target selector to the ticket username cannot widen scope:
//      the modified string is not a valid ticket secret, so auth is rejected.
//
// This suite starts its own sshd container rather than `startSshServer` because
// that helper bind-mounts the sshd config from `os.tmpdir()` (`/tmp`), and on
// this host the docker daemon only shares paths under the repo tree (a `/tmp`
// bind mount is empty inside the container). The config dir therefore lives
// under the repo. The gated binary runs on the host and reaches the dockerised
// sshd through the docker bridge gateway, so the SSH target points there.

const TESTS_DIR = resolve(import.meta.dir, "..");

function dockerGatewayHost(): string {
  const r = Bun.spawnSync([
    "docker", "network", "inspect", "bridge",
    "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
  ]);
  const gw = r.stdout.toString().trim();
  return gw || "127.0.0.1";
}

async function waitTcp(host: string, port: number, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host, port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
      sock.setTimeout(2000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await Bun.sleep(500);
  }
  throw new Error(`tcp ${host}:${port} not up after ${timeoutMs}ms`);
}

function sshTargetOpts(host: string, port: number): any {
  return {
    kind: "Ssh",
    host,
    port,
    username: "root",
    auth: { kind: "PublicKey" },
  };
}

// gated's own listener bind can lose the port race against the concurrent
// fleet; retry the whole bring-up on fresh ports.
async function startWgWithRetry(processes: ProcessManager, attempts = 12): Promise<GatedProcess> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const wg = await processes.startWg();
      await waitPort(wg.httpPort, { recv: false, process: wg.process });
      await waitPort(wg.sshPort, { process: wg.process });
      return wg;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(800 + i * 400);
    }
  }
  throw new Error(`gated failed to start after ${attempts} attempts: ${lastErr}`);
}

describe("SSH Ticket Scope", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let api: AdminClient;
  let dockerHost: string;
  let askpassPath: string;
  const dataDirs: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 30);

  // `sshpass` is not installed on this host, so feed the (ticket-ignored)
  // password to ssh via SSH_ASKPASS instead of `startSshClient`'s sshpass path.
  function sshTicket(selector: string, extraOpts: string[], command = ["ls", "/bin/sh"]) {
    return processes.start(
      [
        "ssh",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeychecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "PreferredAuthentications=password",
        ...extraOpts,
        `${selector}@localhost`,
        "-p", String(wg.sshPort),
        "-i", "/dev/null",
        ...command,
      ],
      {
        env: {
          ...process.env,
          SSH_ASKPASS: askpassPath,
          SSH_ASKPASS_REQUIRE: "force",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
  }

  // Start an sshd container from a repo-local config dir (see file header).
  // This host runs a large fleet of concurrent e2e suites that all allocate
  // docker host ports from the same low range, so `docker run -p <port>` can
  // lose the race and never publish; retry on a fresh port.
  async function startSshd(trustedKey: string, attempts = 8): Promise<number> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      const port = allocPort();
      const dataDir = join(TESTS_DIR, `.tmp-sshd-${randomUUID()}`);
      mkdirSync(dataDir, { recursive: true });
      dataDirs.push(dataDir);

      const authorizedKeysPath = join(dataDir, "authorized_keys");
      writeFileSync(authorizedKeysPath, trustedKey);
      chmodSync(authorizedKeysPath, 0o600);

      const configPath = join(dataDir, "sshd_config");
      writeFileSync(
        configPath,
        `Port 22
AuthorizedKeysFile ${authorizedKeysPath}
UseDNS no
PermitRootLogin yes
StrictModes no
HostKey /ssh-keys/id_ed25519
Subsystem\tsftp\t/usr/lib/ssh/sftp-server
LogLevel DEBUG3
`
      );
      chmodSync(configPath, 0o600);

      processes.start([
        "docker", "run", "--label", "ai-agent=true", "--rm",
        "-p", `${port}:22`,
        "-v", `${dataDir}:${dataDir}`,
        "-v", `${join(TESTS_DIR, "ssh-keys")}:/ssh-keys`,
        "gated-e2e-ssh-server",
        "-f", configPath,
      ]);

      try {
        await waitTcp(dockerHost, port, 20000);
        return port;
      } catch (e) {
        lastErr = e;
        await Bun.sleep(500 + i * 300);
      }
    }
    throw new Error(`sshd never came up after ${attempts} attempts: ${lastErr}`);
  }

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    dockerHost = dockerGatewayHost();

    askpassPath = join(TESTS_DIR, `.tmp-askpass-${randomUUID()}.sh`);
    writeFileSync(askpassPath, "#!/bin/sh\necho 123\n");
    chmodSync(askpassPath, 0o755);
    dataDirs.push(askpassPath);

    wg = await startWgWithRetry(processes);
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
  });

  afterAll(async () => {
    await processes.stop();
    for (const d of dataDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  async function findSessionByUser(username: string) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const sessions = await api.getSessions();
      const s = sessions.find((x: any) => x.username === username);
      if (s) return s;
      await Bun.sleep(100);
    }
    return null;
  }

  test("ticket scoped to X reaches X (not Y) and cannot be redirected to Y", async () => {
    const sshPort = await startSshd(readPubkey(wgClientEd25519PubkeyPath()));

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    // Two distinct, individually-authorized SSH targets sharing one upstream
    // sshd. The user is allowed to reach BOTH interactively, so any scoping we
    // observe must come from the ticket, not from RBAC.
    const targetX = await api.createTarget({
      name: `ssh-x-${randomUUID()}`,
      options: sshTargetOpts(dockerHost, sshPort),
    });
    const targetY = await api.createTarget({
      name: `ssh-y-${randomUUID()}`,
      options: sshTargetOpts(dockerHost, sshPort),
    });
    await api.addTargetRole(targetX.id, role.id);
    await api.addTargetRole(targetY.id, role.id);

    // Ticket scoped to X only.
    const ticket = await api.createTicket({
      target_name: targetX.name,
      username: user.username,
    });

    // 1. The ticket reaches its bound target X.
    const proc = sshTicket(`ticket-${ticket.secret}`, ["-o", "NumberOfPasswordPrompts=1"]);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toBe("/bin/sh\n");

    // The resulting session is bound to X, never Y.
    const session = await findSessionByUser(user.username);
    expect(session).not.toBeNull();
    expect(session.target?.name).toBe(targetX.name);
    expect(session.target?.name).not.toBe(targetY.name);

    // Exercise normal and extended data across SSH packet boundaries.
    const dataTicket = await api.createTicket({ target_name: targetX.name, username: user.username });
    const data = sshTicket(`ticket-${dataTicket.secret}`, [], [
      "sh", "-c", "\"printf '%70000s' x; printf extended-data >&2\"",
    ]);
    const [output, errors] = await Promise.all([
      new Response(data.stdout).text(), new Response(data.stderr).text(),
    ]);
    expect(await data.exited).toBe(0);
    expect(output).toBe(" ".repeat(69999) + "x");
    expect(errors).toContain("extended-data");

    // A direct channel must explicitly confirm opening after the russh upgrade.
    const forwardTicket = await api.createTicket({ target_name: targetX.name, username: user.username });
    const forward = sshTicket(`ticket-${forwardTicket.secret}`, ["-W", "127.0.0.1:22"], []);
    const reader = forward.stdout.getReader();
    try {
      const first = await Promise.race([
        reader.read(),
        Bun.sleep(15000).then(() => { throw new Error("Forwarded channel did not return an SSH banner"); }),
      ]);
      expect(new TextDecoder().decode(first.value)).toContain("SSH-2.0-");
    } finally {
      forward.kill("SIGTERM");
      await reader.cancel();
      await forward.exited;
    }

    // A failed upstream channel must reject the request instead of hanging.
    const rejectedTicket = await api.createTicket({ target_name: targetX.name, username: user.username });
    const rejected = sshTicket(`ticket-${rejectedTicket.secret}`, ["-W", "127.0.0.1:1"], []);
    expect(await rejected.exited).not.toBe(0);

    // Remote forwarding exercises the client's incoming-channel confirmation.
    const echo = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data(socket, chunk) { socket.end(chunk); } },
    });
    try {
      const remotePort = allocPort();
      const reverseTicket = await api.createTicket({ target_name: targetX.name, username: user.username });
      const reverse = sshTicket(`ticket-${reverseTicket.secret}`, [
        "-o", "ExitOnForwardFailure=yes",
        "-R", `${remotePort}:127.0.0.1:${echo.port}`,
      ], ["sh", "-c", `"printf reverse-data | nc -w 5 127.0.0.1 ${remotePort}"`]);
      const output = await new Response(reverse.stdout).text();
      expect(await reverse.exited).toBe(0);
      expect(output).toBe("reverse-data");
    } finally {
      echo.stop(true);
    }

    // 2. Scope cannot be widened: appending a `#Y` target selector to the
    // ticket username breaks the secret, so auth is rejected (no shell on Y).
    const bypass = sshTicket(`ticket-${ticket.secret}#${targetY.name}`, [
      "-o", "NumberOfPasswordPrompts=1",
    ]);
    const bypassOut = await new Response(bypass.stdout).text();
    await bypass.exited;
    expect(bypass.exitCode).not.toBe(0);
    expect(bypassOut).not.toContain("/bin/sh");
  });
});
