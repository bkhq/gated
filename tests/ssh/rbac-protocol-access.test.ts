import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { wgClientEd25519PubkeyPath, readPubkey } from "../helpers/gated-helpers";
import { createConnection } from "net";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

const TESTS_DIR = resolve(import.meta.dir, "..");
// Bind mounts resolve against the docker host's filesystem; only the repo tree
// is shared with the host (the container's /tmp is not), so the upstream's
// config/keys must live under the worktree, not os.tmpdir().
const SCRATCH_ROOT = join(TESTS_DIR, ".rbac-ssh-tmp");

// We run inside a dev container on the `traefik` bridge network. Docker port
// publishing from a sibling container does NOT reach us (proven separately),
// so `ProcessManager.startSshServer` (which `-p`-publishes on the host) is not
// usable for the gated->upstream hop here. We start the SSH upstream on the
// same `traefik` network and point the gated target at its container IP, the
// same strategy `db/sql-console.test.ts` uses for databases.
function startSshServerInNetwork(
  containers: string[],
  trustedKeys: string[]
): { host: string; name: string; dataDir: string } {
  const name = `gated-rbac-ssh-${randomUUID()}`;
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dataDir = mkdtempSync(join(SCRATCH_ROOT, "sshd-"));

  const authorizedKeysPath = join(dataDir, "authorized_keys");
  writeFileSync(authorizedKeysPath, trustedKeys.join("\n"));
  chmodSync(authorizedKeysPath, 0o600);

  const configPath = join(dataDir, "sshd_config");
  writeFileSync(
    configPath,
    `Port 22
AuthorizedKeysFile ${authorizedKeysPath}
UseDNS no
StrictModes no
PermitRootLogin yes
HostKey /ssh-keys/id_ed25519
Subsystem\tsftp\t/usr/lib/ssh/sftp-server
LogLevel DEBUG3
`
  );
  chmodSync(configPath, 0o600);
  chmodSync(dataDir, 0o700);

  const spawnProc = Bun.spawnSync([
    "docker", "run", "--label", "ai-agent=true", "--rm", "-d",
    "--name", name,
    "--network", "traefik",
    "-v", `${dataDir}:${dataDir}`,
    "-v", `${join(TESTS_DIR, "ssh-keys")}:/ssh-keys`,
    "gated-e2e-ssh-server",
    "-f", configPath,
  ]);
  if (spawnProc.exitCode !== 0) {
    throw new Error(`docker run ssh server failed: ${spawnProc.stderr.toString()}`);
  }
  containers.push(name);

  const inspect = Bun.spawnSync([
    "docker", "inspect", name,
    "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
  ]);
  const host = inspect.stdout.toString().trim();
  if (host === "") throw new Error("no container IP for ssh upstream");
  return { host, name, dataDir };
}

function waitTcp(host: string, port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveFn, rejectFn) => {
    const attempt = () => {
      const sock = createConnection({ host, port }, () => {
        sock.destroy();
        resolveFn();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) rejectFn(new Error(`tcp ${host}:${port} not up`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

// gated binds its listeners on deterministic ports; across back-to-back runs a
// port can still be in TIME_WAIT from a just-killed instance, making the next
// gated abort at startup ("Address already in use"). Retry until it comes up —
// startWg hands out fresh, higher ports on each call.
async function startWgReady(processes: ProcessManager): Promise<GatedProcess> {
  for (let attempt = 0; ; attempt++) {
    const wg = await processes.startWg();
    try {
      await waitPort(wg.httpPort, { recv: false, process: wg.process });
      await waitPort(wg.sshPort, { process: wg.process });
      await waitPort(wg.mysqlPort, { recv: false, process: wg.process });
      await waitPort(wg.postgresPort, { recv: false, process: wg.process });
      await waitPort(wg.kubernetesPort, { recv: false, process: wg.process });
      return wg;
    } catch (e) {
      try { wg.process.kill("SIGINT"); } catch {}
      await wg.process.exited.catch(() => {});
      if (attempt >= 7) throw e;
      await Bun.sleep(500);
    }
  }
}

// Run an `ls /bin/sh` over an SSH connection brokered by gated, authenticating
// the end user to gated with a public key (sshpass/password auth is not
// available in this environment). Returns the child exit code and stdout.
async function sshExec(
  processes: ProcessManager,
  wg: GatedProcess,
  username: string,
  targetName: string,
  identityFile: string,
  rsa = false
): Promise<{ exitCode: number | null; stdout: string }> {
  const proc = processes.startSshClient(
    `${username}:${targetName}@localhost`,
    "-p", String(wg.sshPort),
    "-o", `IdentityFile=${identityFile}`,
    "-o", "PreferredAuthentications=publickey",
    ...(rsa ? ["-o", "PubkeyAcceptedKeyTypes=+ssh-rsa"] : []),
    "ls", "/bin/sh"
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { exitCode: proc.exitCode, stdout };
}

const ED25519_KEY = `${TESTS_DIR}/ssh-keys/id_ed25519`;
const RSA_KEY = `${TESTS_DIR}/ssh-keys/id_rsa`;

describe("RBAC SSH protocol access (allow/deny, revocation)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  const containers: string[] = [];
  const scratchDirs: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 20);

  let sshHost: string;
  let allowedUser: string;
  let deniedUser: string;
  let targetName: string;
  let roleId: string;
  let targetId: string;

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await startWgReady(processes);
    url = `https://localhost:${wg.httpPort}`;

    const upstream = startSshServerInNetwork(containers, [
      readPubkey(wgClientEd25519PubkeyPath()),
    ]);
    scratchDirs.push(upstream.dataDir);
    sshHost = upstream.host;
    await waitTcp(sshHost, 22);

    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    roleId = role.id;

    const target = await api.createTarget({
      name: `ssh-${randomUUID()}`,
      options: {
        kind: "Ssh",
        host: sshHost,
        port: 22,
        username: "root",
        auth: { kind: "PublicKey" },
      },
    });
    targetId = target.id;
    targetName = target.name;
    await api.addTargetRole(target.id, role.id);

    // Both users authenticate to gated successfully (distinct public keys);
    // they differ only in role membership, so the deny path is exercised at
    // target authorization, not at user authentication.
    const allowed = await api.createUser({ username: `allowed-${randomUUID()}` });
    await api.createPublicKeyCredential(allowed.id, {
      label: "ed25519",
      openssh_public_key: readFileSync(`${ED25519_KEY}.pub`, "utf-8").trim(),
    });
    await api.addUserRole(allowed.id, role.id);
    allowedUser = allowed.username;

    const denied = await api.createUser({ username: `denied-${randomUUID()}` });
    await api.createPublicKeyCredential(denied.id, {
      label: "rsa",
      openssh_public_key: readFileSync(`${RSA_KEY}.pub`, "utf-8").trim(),
    });
    // intentionally NOT granted the role
    deniedUser = denied.username;
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) {
      Bun.spawnSync(["docker", "rm", "-f", name]);
    }
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("user WITH the granting role connects and runs a command", async () => {
    const res = await sshExec(processes, wg, allowedUser, targetName, ED25519_KEY);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("/bin/sh\n");
  }, 90_000);

  test("user WITHOUT the role is denied at connect time", async () => {
    // Authenticated to gated, but no role binding for the target -> gated
    // refuses to broker the session, so ssh exits non-zero.
    const res = await sshExec(processes, wg, deniedUser, targetName, RSA_KEY, true);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout).not.toBe("/bin/sh\n");
  }, 90_000);

  test("revoking the target<->role binding denies a previously-working user", async () => {
    const api = adminClient(url);

    // Sanity: still allowed before revocation.
    const before = await sshExec(processes, wg, allowedUser, targetName, ED25519_KEY);
    expect(before.exitCode).toBe(0);

    await api.removeTargetRole(targetId, roleId);

    const after = await sshExec(processes, wg, allowedUser, targetName, ED25519_KEY);
    expect(after.exitCode).not.toBe(0);
    expect(after.stdout).not.toBe("/bin/sh\n");

    // Restore so this test leaves no cross-test residue.
    await api.addTargetRole(targetId, roleId);
  }, 120_000);
});
