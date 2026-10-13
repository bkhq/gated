import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import {
  readPubkey,
  wgClientEd25519PubkeyPath,
  wgClientRsaPubkeyPath,
} from "../helpers/gated-helpers";
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

// Recordings are produced and replayable, and deleting a session writes a
// tamper-resistant audit entry.
//
// We run inside a dev container on the `traefik` bridge network. Docker port
// publishing from a child container doesn't reach us, so the SSH upstream is
// started on the same network and gated reaches it by container IP (mirrors
// tests/db/sql-console.test.ts). Bind-mounted config/keys must live under the
// repo tree because the container's /tmp is not host-shared.

const TESTS_DIR = resolve(import.meta.dir, "..");
const ADMIN_TOKEN = "token-value";
const NIL_SESSION_ID = "00000000-0000-0000-0000-000000000000";

interface SshUpstream {
  host: string;
  name: string;
  dir: string;
}

function startSshUpstream(): SshUpstream {
  const id = randomUUID();
  const dir = join(TESTS_DIR, `.tmp-rec-${id}`);
  mkdirSync(dir, { recursive: true });

  const authKeys = join(dir, "authorized_keys");
  writeFileSync(
    authKeys,
    [readPubkey(wgClientEd25519PubkeyPath()), readPubkey(wgClientRsaPubkeyPath())].join("\n") + "\n",
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
`,
  );
  chmodSync(cfg, 0o600);

  const name = `gated-rec-ssh-${id}`;
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

async function adminReq(
  url: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/admin/api${path}`, {
    method,
    headers: {
      "X-Gated-Token": ADMIN_TOKEN,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    tls: { rejectUnauthorized: false },
  } as any);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function listSessions(url: string): Promise<any[]> {
  const { body } = await adminReq(url, "GET", "/sessions?limit=500");
  return body.items || [];
}

// Drive a real SSH exec session through gated to the in-network upstream using
// public-key end-user auth (password auth / sshpass is unavailable in this
// container, so allow/deny is differentiated by role). Returns the persisted
// session row once it is closed (ended).
async function runSshSession(
  processes: ProcessManager,
  wg: GatedProcess,
  url: string,
  upstreamHost: string,
): Promise<{ session: any; username: string; targetName: string }> {
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

  const proc = processes.startSshClient(
    `${user.username}:${target.name}@localhost`,
    "-p", String(wg.sshPort),
    "-i", join(TESTS_DIR, "ssh-keys/id_ed25519"),
    "-o", "PreferredAuthentications=publickey",
    "echo recorded-output-marker; ls /bin/sh",
    { stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  expect(proc.exitCode).toBe(0);
  expect(stdout).toContain("recorded-output-marker");

  // Wait for the closed session to be persisted with username + ended set.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const sessions = await listSessions(url);
    const s = sessions.find((x) => x.username === user.username && x.ended);
    if (s) return { session: s, username: user.username, targetName: target.name };
    await Bun.sleep(250);
  }
  throw new Error(`session for ${user.username} not found / not ended`);
}

describe("API Recordings (produced+replayable, deletion audit)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let upstream: SshUpstream;
  const timeout = Number(process.env.TIMEOUT || 20);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg({ configPatch: { recordings: { enable: true } } });
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    upstream = startSshUpstream();
    await waitTcp(upstream.host, 22);
  });

  afterAll(async () => {
    await processes.stop();
    if (upstream) stopSshUpstream(upstream);
  });

  test("SSH session produces a replayable .cast recording", async () => {
    const { session } = await runSshSession(processes, wg, url, upstream.host);

    // The recording row(s) for the session must be retrievable.
    let recordings: any[] = [];
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const { status, body } = await adminReq(url, "GET", `/sessions/${session.id}/recordings`);
      expect(status).toBe(200);
      recordings = body;
      if (recordings.length > 0) break;
      await Bun.sleep(250);
    }
    expect(recordings.length).toBeGreaterThan(0);

    // Pick a terminal recording (SSH exec produces a terminal recording).
    const terminal =
      recordings.find((r) => String(r.kind).toLowerCase().includes("terminal")) ?? recordings[0];
    expect(terminal.id).toBeTruthy();
    expect(terminal.session_id).toBe(session.id);

    // Retrieve and parse the recording as an asciinema v2 .cast: the first line
    // is the JSON header, every subsequent non-empty line is a JSON event.
    const res = await fetch(`${url}/admin/api/recordings/${terminal.id}/cast`, {
      headers: { "X-Gated-Token": ADMIN_TOKEN },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(res.status).toBe(200);
    const castText = await res.text();
    expect(castText.length).toBeGreaterThan(0);

    const lines = castText.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const header = JSON.parse(lines[0]);
    expect(header.version).toBe(2);
    expect(typeof header.width).toBe("number");
    expect(typeof header.height).toBe("number");
    // Every line must be valid JSON (header object or [time, "o", data] event).
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 120_000);

  test("deleting a session writes a durable, non-self-deletable audit entry", async () => {
    // Produce a session with a recording, then delete it (single delete).
    const { session } = await runSshSession(processes, wg, url, upstream.host);

    // Confirm a recording exists so recordings_deleted is meaningful.
    let recCount = 0;
    const recDeadline = Date.now() + 30000;
    while (Date.now() < recDeadline) {
      const { body } = await adminReq(url, "GET", `/sessions/${session.id}/recordings`);
      recCount = body.length;
      if (recCount > 0) break;
      await Bun.sleep(250);
    }
    expect(recCount).toBeGreaterThan(0);

    const del = await adminReq(url, "DELETE", `/sessions/${session.id}`);
    expect(del.status).toBe(200);

    // Session and its recordings are gone.
    const after = await adminReq(url, "GET", `/sessions/${session.id}`);
    expect(after.status).toBe(404);
    const recAfter = await adminReq(url, "GET", `/sessions/${session.id}/recordings`);
    expect(recAfter.status).toBe(200);
    expect(recAfter.body.length).toBe(0);

    // The audit LogEntry is stored under the nil session id so the very
    // deletion it documents cannot erase it. Find the entry for this session.
    const auditQuery = async () =>
      (await adminReq(url, "POST", "/management-audit", { session_id: NIL_SESSION_ID, limit: 200 })).body as any[];

    const logs = await auditQuery();
    const entry = logs.find(
      (e) => e.values?.event === "session.delete" && e.values?.session_ids?.includes(session.id),
    );
    expect(entry).toBeTruthy();
    expect(entry.values.actor).toBe("admin-token");
    expect(entry.username).toBe("admin-token");
    expect(entry.values.sessions_deleted).toBe(1);
    expect(entry.values.recordings_deleted).toBeGreaterThanOrEqual(1);
    expect(typeof entry.values.log_entries_deleted).toBe("number");
    expect(entry.session_id).toBe(NIL_SESSION_ID);

    // Non-self-deletable: produce another closed session and run the bulk
    // delete-closed wipe. The wipe writes its own audit entry AND must leave the
    // earlier audit entry intact (it lives under the nil session id, untouched
    // by the per-session log purge).
    await runSshSession(processes, wg, url, upstream.host);
    const bulk = await adminReq(url, "DELETE", "/sessions/closed");
    expect(bulk.status).toBe(200);
    expect(typeof bulk.body).toBe("number");
    expect(bulk.body).toBeGreaterThanOrEqual(1);

    const logsAfter = await auditQuery();
    const survivor = logsAfter.find(
      (e) => e.values?.event === "session.delete" && e.values?.session_ids?.includes(session.id),
    );
    expect(survivor).toBeTruthy();
    // The bulk wipe also recorded its own deletion audit entry.
    const bulkEntries = logsAfter.filter((e) => e.values?.event === "session.delete");
    expect(bulkEntries.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
