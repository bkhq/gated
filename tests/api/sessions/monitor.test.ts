import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import {
  readPubkey,
  wgClientEd25519PubkeyPath,
  wgClientRsaPubkeyPath,
} from "../../helpers/gated-helpers";
import { randomUUID } from "crypto";
import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  chmodSync,
} from "fs";
import { resolve, join } from "path";
import { createConnection } from "net";
import type { Subprocess } from "bun";

const TESTS_DIR = resolve(import.meta.dir, "..", "..");
const ADMIN_TOKEN = "token-value";

// --- SSH upstream on the docker `traefik` network (gated reaches it by
// container IP; the published-port-on-localhost path is not routable here).
// Same approach as tests/api/sessions/bulk.test.ts. -------------------------

interface SshUpstream {
  host: string;
  name: string;
  dir: string;
}

function startSshUpstream(): SshUpstream {
  const id = randomUUID();
  const dir = join(TESTS_DIR, `.tmp-monitor-${id}`);
  mkdirSync(dir, { recursive: true });

  const authKeys = join(dir, "authorized_keys");
  writeFileSync(
    authKeys,
    [readPubkey(wgClientEd25519PubkeyPath()), readPubkey(wgClientRsaPubkeyPath())].join("\n") +
      "\n"
  );
  chmodSync(authKeys, 0o600);

  const hostKey = join(dir, "host_ed25519");
  copyFileSync(join(TESTS_DIR, "ssh-keys/id_ed25519"), hostKey);
  chmodSync(hostKey, 0o600);

  const cfg = join(dir, "sshd_config");
  writeFileSync(
    cfg,
    `Port 22
AuthorizedKeysFile ${authKeys}
HostKey ${hostKey}
PermitRootLogin yes
PubkeyAuthentication yes
PasswordAuthentication no
UseDNS no
StrictModes no
Subsystem sftp /usr/lib/ssh/sftp-server
`
  );
  chmodSync(cfg, 0o600);

  const name = `gated-monitor-ssh-${id}`;
  const run = Bun.spawnSync([
    "docker", "run", "--label", "ai-agent=true", "-d", "--rm",
    "--name", name,
    "--network", "traefik",
    "-v", `${dir}:${dir}`,
    "gated-e2e-ssh-server",
    "-f", cfg,
  ]);
  if (run.exitCode !== 0) {
    throw new Error(`ssh upstream run failed: ${run.stderr.toString()}`);
  }
  const insp = Bun.spawnSync([
    "docker", "inspect", name,
    "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
  ]);
  const host = insp.stdout.toString().trim();
  if (!host) throw new Error("no container IP for ssh upstream");
  return { host, name, dir };
}

function stopSshUpstream(up: SshUpstream): void {
  Bun.spawnSync(["docker", "rm", "-f", up.name]);
  try {
    rmSync(up.dir, { recursive: true, force: true });
  } catch {}
}

async function waitTcp(host: string, port: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((res) => {
      const s = createConnection({ host, port }, () => {
        s.destroy();
        res(true);
      });
      s.once("error", () => {
        s.destroy();
        res(false);
      });
      s.setTimeout(2000, () => {
        s.destroy();
        res(false);
      });
    });
    if (ok) return;
    await Bun.sleep(200);
  }
  throw new Error(`tcp ${host}:${port} not up after ${timeoutMs}ms`);
}

async function provisionSshUser(
  url: string,
  upstreamHost: string
): Promise<{ username: string; targetName: string }> {
  const api = adminClient(url);
  const role = await api.createRole({ name: `role-${randomUUID()}` });
  const user = await api.createUser({ username: `user-${randomUUID()}` });
  await api.createPublicKeyCredential(user.id, {
    label: "pk",
    openssh_public_key: readPubkey(join(TESTS_DIR, "ssh-keys/id_ed25519.pub")),
  });
  await api.addUserRole(user.id, role.id);
  const target = await api.createTarget({
    name: `ssh-${randomUUID()}`,
    options: {
      kind: "Ssh",
      host: upstreamHost,
      port: 22,
      username: "root",
      auth: { kind: "PublicKey" },
    },
  });
  await api.addTargetRole(target.id, role.id);
  return { username: user.username, targetName: target.name };
}

function openLiveShell(
  processes: ProcessManager,
  wg: GatedProcess,
  username: string,
  targetName: string
): Subprocess {
  return processes.startSshClient(
    `${username}:${targetName}@localhost`,
    "-tt",
    "-p", String(wg.sshPort),
    "-i", join(TESTS_DIR, "ssh-keys/id_ed25519"),
    "-o", "PreferredAuthentications=publickey",
    { stderr: "pipe" }
  );
}

// --- WebSocket helper --------------------------------------------------------

interface WsResult {
  opened: boolean;
  messages: string[];
}

/**
 * Attempt the monitor WebSocket handshake with the given auth headers and
 * collect any text frames for `waitMs`. A refused handshake (403 from the
 * blanket admin gate) never fires `open`, so `opened` stays false.
 */
function monitorWs(
  wsUrl: string,
  headers: Record<string, string>,
  waitMs = 4000
): Promise<WsResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers,
      tls: { rejectUnauthorized: false },
    } as any);

    const messages: string[] = [];
    let opened = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve({ opened, messages });
    };

    ws.addEventListener("open", () => {
      opened = true;
    });
    ws.addEventListener("message", (ev: any) => {
      messages.push(typeof ev.data === "string" ? ev.data : "");
    });
    ws.addEventListener("error", () => finish());
    ws.addEventListener("close", () => finish());
    setTimeout(finish, waitMs);
  });
}

async function rawAdminPost(
  url: string,
  path: string,
  token: string
): Promise<number> {
  const resp = await fetch(`${url}/admin/api${path}`, {
    method: "POST",
    headers: { "X-Gated-Token": token },
    tls: { rejectUnauthorized: false },
  } as any);
  return resp.status;
}

describe("API Sessions - Live Monitor + RBAC", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let wsBase: string;
  let nonAdminToken: string;
  const timeout = Number(process.env.TIMEOUT || 20);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    // Recordings must be enabled for the live monitor to have a feed.
    wg = await processes.startWg({
      configPatch: { recordings: { enable: true } },
    });
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    wsBase = `wss://localhost:${wg.httpPort}`;

    // A non-admin user with an API token (no admin role).
    const api = adminClient(url);
    const user = await api.createUser({ username: `nonadmin-${randomUUID()}` });
    const { secret } = await api.createApiToken(user.id, {
      label: "monitor-test",
      expiry: "2099-01-01T00:00:00Z",
    });
    nonAdminToken = secret;
  }, 60_000);

  afterAll(async () => {
    await processes.stop();
  }, 30_000);

  test("non-admin is denied on close / terminate (403)", async () => {
    const id = randomUUID();
    expect(await rawAdminPost(url, `/sessions/${id}/close`, nonAdminToken)).toBe(403);
    expect(await rawAdminPost(url, `/sessions/${id}/terminate`, nonAdminToken)).toBe(403);
  });

  test("non-admin is denied on close-all (403)", async () => {
    const resp = await fetch(`${url}/admin/api/sessions`, {
      method: "DELETE",
      headers: { "X-Gated-Token": nonAdminToken },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(resp.status).toBe(403);
  });

  test("admin passes the gate on close / terminate (404 for unknown id)", async () => {
    const id = randomUUID();
    // 404 (not 401/403) proves the admin cleared RBAC and reached the handler.
    expect(await rawAdminPost(url, `/sessions/${id}/close`, ADMIN_TOKEN)).toBe(404);
    expect(await rawAdminPost(url, `/sessions/${id}/terminate`, ADMIN_TOKEN)).toBe(404);
  });

  test("non-admin is denied on the monitor WS (handshake refused)", async () => {
    const { opened } = await monitorWs(
      `${wsBase}/admin/api/sessions/${randomUUID()}/monitor`,
      { "X-Gated-Token": nonAdminToken },
      3000
    );
    expect(opened).toBe(false);
  });

  test("admin can open the monitor WS; unknown session reports not-live", async () => {
    const { opened, messages } = await monitorWs(
      `${wsBase}/admin/api/sessions/${randomUUID()}/monitor`,
      { "X-Gated-Token": ADMIN_TOKEN },
      3000
    );
    expect(opened).toBe(true);
    const start = messages
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .find((m) => m && m.start === true);
    expect(start).toBeTruthy();
    expect(start.live).toBe(false);
  });

  test("admin monitor streams live output from an active session", async () => {
    const upstream = startSshUpstream();
    let ssh: Subprocess | undefined;
    try {
      await waitTcp(upstream.host, 22);

      const api = adminClient(url);
      const { username, targetName } = await provisionSshUser(url, upstream.host);
      ssh = openLiveShell(processes, wg, username, targetName);

      // Wait for the interactive session to register as active.
      let sessionId: string | undefined;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !sessionId) {
        const sessions = await api.getSessions();
        const active = sessions.find(
          (s: any) => !s.ended && s.username === username
        );
        if (active) sessionId = active.id;
        else await Bun.sleep(300);
      }
      expect(sessionId).toBeTruthy();

      const wsUrl = `${wsBase}/admin/api/sessions/${sessionId}/monitor`;
      const monitorPromise = monitorWs(wsUrl, { "X-Gated-Token": ADMIN_TOKEN }, 6000);

      // Give the monitor a moment to subscribe, then produce fresh output.
      await Bun.sleep(1000);
      ssh.stdin!.write("echo MONITOR_MARKER_9f3a\r\n");

      const { opened, messages } = await monitorPromise;
      expect(opened).toBe(true);

      const parsed = messages
        .map((m) => {
          try {
            return JSON.parse(m);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const start = parsed.find((m) => m.start === true);
      expect(start).toBeTruthy();
      expect(start.live).toBe(true);

      const dataFrames = parsed.filter((m) => m.data !== undefined);
      expect(dataFrames.length).toBeGreaterThan(0);
    } finally {
      try {
        ssh?.stdin?.write("exit\r\n");
      } catch {
        // ignore
      }
      ssh?.kill();
      await ssh?.exited.catch(() => {});
      stopSshUpstream(upstream);
    }
  }, 90_000);
});
