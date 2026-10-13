import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { waitPort } from "../helpers/util";
import { adminClient } from "../helpers/api-client";
import { cpSync, existsSync, readFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";

// At-rest encryption lifecycle (security audit §240: Argon2id KEK +
// ChaCha20-Poly1305 DEK-wrap + SQLCipher-4 data DB).
//
// Flow exercised here (see crates/gated/src/commands/run.rs):
//   * `encryption.enable = true` -> on first boot the runtime is Uninitialized
//     and `run` serves a *plaintext* minimal HTTP server on the http port
//     (poem_listener has no TLS) mounting /api/admin/encryption/*. A bootstrap
//     token is written to <data>/db/bootstrap-token.txt (the /dev/tty path is
//     unavailable under a non-interactive test runner).
//   * POST /api/admin/encryption/init {bootstrap_token, master_password}
//     migrates the plaintext setup DB to SQLCipher, unlocks, and the full
//     HTTPS server takes over the same port.
//   * On restart the runtime is Locked; POST /unlock {master_password} is
//     required. A wrong/absent secret fails closed (DB stays closed, the full
//     HTTPS API never comes up).

const MASTER_PASSWORD = "correct-horse-battery-staple-" + randomUUID();

function dataDirOf(configPath: string): string {
  // GlobalParams.paths_relative_to == config file's parent dir.
  return dirname(configPath);
}

function bootstrapTokenPath(configPath: string): string {
  // generate_bootstrap_token(paths_relative_to/data) -> <data>/data/db/bootstrap-token.txt
  return join(dataDirOf(configPath), "data", "db", "bootstrap-token.txt");
}

function dbFilePath(configPath: string): string {
  // database_url = sqlite:<data>/db ; sqlite_database_path appends db.sqlite3
  return join(dataDirOf(configPath), "db", "db.sqlite3");
}

interface EncStatus {
  status: string;
  db_ready: boolean;
  retry_after: number | null;
}

async function getEncStatus(httpPort: number): Promise<EncStatus> {
  // Pre-unlock server is plaintext HTTP (no TLS).
  const r = await fetch(`http://127.0.0.1:${httpPort}/api/admin/encryption/status`, {
    signal: AbortSignal.timeout(4000),
  });
  if (r.status !== 200) {
    throw new Error(`encryption status returned ${r.status}`);
  }
  return (await r.json()) as EncStatus;
}

// init/unlock derive the Argon2id KEK (m=256MiB, t=3) and init also migrates
// the plaintext setup DB to SQLCipher; in a debug build this is slow, so the
// request timeout must be generous.
async function postEnc(
  httpPort: number,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 180_000
): Promise<Response> {
  return fetch(`http://127.0.0.1:${httpPort}/api/admin/encryption/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function waitEncStatus(
  httpPort: number,
  want: string,
  proc: GatedProcess,
  timeoutMs: number
): Promise<EncStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: EncStatus | undefined;
  while (Date.now() < deadline) {
    if (proc.process.exitCode !== null) {
      throw new Error(`gated exited (code ${proc.process.exitCode}) while waiting for status=${want}`);
    }
    try {
      last = await getEncStatus(httpPort);
      if (last.status === want) return last;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error(`encryption status did not reach ${want} within ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

function waitForBootstrapToken(configPath: string, timeoutMs: number): Promise<string> {
  const path = bootstrapTokenPath(configPath);
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (existsSync(path)) {
        const token = readFileSync(path, "utf-8").trim();
        if (token) return token;
      }
      await Bun.sleep(100);
    }
    throw new Error(
      `bootstrap token file never appeared at ${path} ` +
        `(if the runner has a controlling TTY the token may have gone to /dev/tty)`
    );
  })();
}

// The full HTTPS admin API only comes up *after* unlock. Polling it (over TLS)
// is what distinguishes the real server from the plaintext pre-unlock server.
async function waitFullAdminApi(
  httpPort: number,
  proc: GatedProcess,
  timeoutMs: number
): Promise<ReturnType<typeof adminClient>> {
  const api = adminClient(`https://127.0.0.1:${httpPort}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.process.exitCode !== null) {
      throw new Error(`gated exited (code ${proc.process.exitCode}) while waiting for full admin API`);
    }
    try {
      await api.getUsers();
      return api;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error(`full admin API did not come up within ${timeoutMs}ms`);
}

// Confirm the full HTTPS admin API does NOT serve within the window (fail-closed).
async function assertFullAdminApiDown(httpPort: number, windowMs: number): Promise<void> {
  const api = adminClient(`https://127.0.0.1:${httpPort}`);
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    try {
      await api.getUsers();
      throw new Error("full admin API became reachable while encryption was still locked");
    } catch (e) {
      if (e instanceof Error && e.message.includes("became reachable")) throw e;
      // TLS/connection failure is expected (only the plaintext minimal server is up).
    }
    await Bun.sleep(250);
  }
}

async function stopProcess(proc: GatedProcess): Promise<void> {
  proc.process.kill("SIGINT");
  try {
    await Promise.race([proc.process.exited, Bun.sleep(8000)]);
  } catch {}
  if (proc.process.exitCode === null) {
    proc.process.kill("SIGKILL");
    try {
      await proc.process.exited;
    } catch {}
  }
}

describe("at-rest encryption lifecycle (bootstrap, unlock/fail-closed)", () => {
  let processes: ProcessManager;
  // Generous because Argon2id (m=256MiB, t=3) runs in a debug build.
  const timeout = Number(process.env.TIMEOUT || 90);
  let wg: GatedProcess;
  let roleName: string;
  let snapshotDir: string;
  let postSnapshotRole: string;

  beforeAll(() => {
    processes = new ProcessManager(timeout);
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("a fresh encrypted instance bootstraps the DEK/KEK and serves", async () => {
    wg = await processes.startWg({
      // Optional previous release binary creates the database for upgrade checks.
      binaryPath: process.env.GATED_PREVIOUS_BINARY,
      configPatch: { encryption: { enable: true } },
    });

    // The plaintext pre-unlock minimal server binds the http port.
    await waitPort(wg.httpPort, { recv: false, process: wg.process, timeout: timeout * 1000 });

    // Before init the runtime must be Uninitialized and the DB closed.
    const before = await waitEncStatus(wg.httpPort, "uninitialized", wg, timeout * 1000);
    expect(before.db_ready).toBe(false);

    const token = await waitForBootstrapToken(wg.configPath, timeout * 1000);
    expect(token.length).toBeGreaterThan(0);

    // Wrong bootstrap token must be rejected (forbidden), without initializing.
    const badInit = await postEnc(wg.httpPort, "init", {
      bootstrap_token: "0".repeat(64),
      master_password: MASTER_PASSWORD,
    });
    expect(badInit.status).toBe(403);
    expect((await getEncStatus(wg.httpPort)).status).toBe("uninitialized");

    // Correct bootstrap token initializes and unlocks.
    const init = await postEnc(wg.httpPort, "init", {
      bootstrap_token: token,
      master_password: MASTER_PASSWORD,
    });
    expect(init.status).toBe(201);
    expect((await init.json()).status).toBe("unlocked");

    // The full HTTPS admin API takes over the port: write + read round-trip.
    const api = await waitFullAdminApi(wg.httpPort, wg, timeout * 1000);
    roleName = `enc-role-${randomUUID()}`;
    const created = await api.createRole({ name: roleName });
    expect(created.name).toBe(roleName);
    const found = await api.getRoles(roleName);
    expect(found.some((r) => r.name === roleName)).toBe(true);

    // The bootstrap token is single-use: the file is deleted after init.
    expect(existsSync(bootstrapTokenPath(wg.configPath))).toBe(false);

    // The live on-disk DB must be SQLCipher-encrypted (no plaintext header).
    const header = readFileSync(dbFilePath(wg.configPath)).subarray(0, 16);
    const sqliteMagic = Buffer.from("SQLite format 3\0", "latin1");
    expect(header.equals(sqliteMagic)).toBe(false);

    // Sanity: the plaintext setup DB was migrated, leaving a plaintext .bak
    // (auto_delete_plaintext=false). Its header proves our magic check works.
    const bak = dbFilePath(wg.configPath) + ".plain.bak";
    if (existsSync(bak)) {
      const bakHeader = readFileSync(bak).subarray(0, 16);
      expect(bakHeader.equals(sqliteMagic)).toBe(true);
    }
  }, 300_000);

  test("restart needs the correct unlock secret; wrong/absent fails closed", async () => {
    // --- restart with the CORRECT secret: it must unlock and serve ---
    await stopProcess(wg);
    snapshotDir = dataDirOf(wg.configPath) + "-snapshot";
    cpSync(dataDirOf(wg.configPath), snapshotDir, { recursive: true });

    const wgOk = await processes.startWg({
      shareWith: wg,
      args: ["run", "--enable-admin-token"],
    });
    await waitPort(wgOk.httpPort, { recv: false, process: wgOk.process, timeout: timeout * 1000 });

    // An initialized-but-not-unlocked instance is Locked with the DB closed.
    const locked = await waitEncStatus(wgOk.httpPort, "locked", wgOk, timeout * 1000);
    expect(locked.db_ready).toBe(false);

    const unlock = await postEnc(wgOk.httpPort, "unlock", {
      master_password: MASTER_PASSWORD,
    });
    expect(unlock.status).toBe(200);
    expect((await unlock.json()).status).toBe("unlocked");

    // Data persisted across the restart proves the DEK round-trips the DB.
    const api = await waitFullAdminApi(wgOk.httpPort, wgOk, timeout * 1000);
    const roles = await api.getRoles(roleName);
    expect(roles.some((r) => r.name === roleName)).toBe(true);
    postSnapshotRole = `after-snapshot-${randomUUID()}`;
    await api.createRole({ name: postSnapshotRole });

    // --- restart with a WRONG/ABSENT secret: it must fail closed ---
    await stopProcess(wgOk);

    const wgBad = await processes.startWg({
      shareWith: wg,
      args: ["run", "--enable-admin-token"],
    });
    await waitPort(wgBad.httpPort, { recv: false, process: wgBad.process, timeout: timeout * 1000 });
    await waitEncStatus(wgBad.httpPort, "locked", wgBad, timeout * 1000);

    // Wrong password -> 401, stays Locked.
    const wrong = await postEnc(wgBad.httpPort, "unlock", {
      master_password: "definitely-not-the-master-password",
    });
    expect(wrong.status).toBe(401);

    // Absent password -> rejected (bad request), never unlocks.
    const absent = await postEnc(wgBad.httpPort, "unlock", {});
    expect(absent.status).toBeGreaterThanOrEqual(400);
    expect(absent.status).not.toBe(200);

    // DB remains closed and the full HTTPS API never comes up (fail-closed).
    const stillLocked = await getEncStatus(wgBad.httpPort);
    expect(stillLocked.status).toBe("locked");
    expect(stillLocked.db_ready).toBe(false);
    await assertFullAdminApiDown(wgBad.httpPort, 6000);

    await stopProcess(wgBad);
  }, 300_000);

  test("an offline encrypted snapshot restores with its original key metadata", async () => {
    const dataDir = dataDirOf(wg.configPath);
    renameSync(dataDir, dataDir + "-before-restore");
    cpSync(snapshotDir, dataDir, { recursive: true });

    const restored = await processes.startWg({ shareWith: wg });
    await waitEncStatus(restored.httpPort, "locked", restored, timeout * 1000);
    const unlock = await postEnc(restored.httpPort, "unlock", { master_password: MASTER_PASSWORD });
    expect(unlock.status).toBe(200);
    const api = await waitFullAdminApi(restored.httpPort, restored, timeout * 1000);
    expect((await api.getRoles(roleName)).some((r) => r.name === roleName)).toBe(true);
    expect((await api.getRoles(postSnapshotRole)).some((r) => r.name === postSnapshotRole)).toBe(false);
    await stopProcess(restored);
  }, 300_000);
});
