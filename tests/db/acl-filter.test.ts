import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

// Command-ACL enforcement on the MySQL + PostgreSQL proxies
// (crates/gated-protocol-{mysql,postgres}/src/session.rs).
//
// A `deny` rule in the `command_acl_rule` table must block a matching SQL
// statement BEFORE it is forwarded upstream — the client sees a protocol-level
// error ("command blocked by policy") and an audit (sql_audit) recording is
// written. A non-matching statement passes through unchanged, and with no
// rules at all the proxies behave exactly as before (covered by the sibling
// mysql-native / postgres-auth-password suites).
//
// Like the other tests/db suites we run inside a dev container on the `traefik`
// bridge network: docker host port-publishing from a child container does not
// reach us, so the upstream is started on the same network and gated connects
// to it by container IP. Native `mysql` / `psql` clients drive the proxies via
// the simple-query protocol, which is what the enforcement path gates.

const ADMIN_TOKEN = "token-value";

async function adminReq(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/admin/api${path}`, {
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

// A deny rule scoped to one target + protocol. Returns the created rule id.
async function createDenyRule(
  url: string,
  protocol: "mysql" | "postgres",
  targetId: string,
  pattern: string,
): Promise<number> {
  const { status, body } = await adminReq(url, "POST", "/command-acl-rules", {
    name: `deny-${protocol}-${randomUUID()}`,
    enabled: true,
    priority: 10,
    protocol,
    match_type: "regex",
    pattern,
    action: "deny",
    target_id: targetId,
    description: "DB-FILTER acl-filter integration test",
  });
  if (status !== 201) throw new Error(`create rule failed: ${status} ${JSON.stringify(body)}`);
  return body.id;
}

// Find the proxy session for `targetName` and assert a sql_audit recording was
// written (the block path persists one via the existing SqlAuditRecorder).
async function expectBlockAuditRecording(url: string, targetName: string): Promise<void> {
  // Sessions are created per proxy connection; give the async close a moment.
  let recordings: any[] = [];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { body } = await adminReq(url, "GET", "/sessions?limit=500");
    const sessions: any[] = body?.items ?? [];
    const mine = sessions.filter((s) => s?.target?.name === targetName);
    for (const s of mine) {
      const { body: recs } = await adminReq(url, "GET", `/sessions/${s.id}/recordings`);
      const list: any[] = Array.isArray(recs) ? recs : [];
      // The admin API serializes RecordingKind as its enum variant name.
      const sqlAudit = list.filter((r) => String(r.kind) === "SqlAudit");
      if (sqlAudit.length > 0) {
        recordings = sqlAudit;
        break;
      }
    }
    if (recordings.length > 0) break;
    await Bun.sleep(300);
  }
  expect(recordings.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

async function startMysqlInNetwork(): Promise<{ host: string; name: string }> {
  const name = `gated-acl-mysql-${randomUUID()}`;
  const spawnProc = Bun.spawnSync([
    "docker", "run", "--label", "ai-agent=true", "--rm", "-d",
    "--name", name,
    "--network", "traefik",
    "gated-e2e-mysql-server",
  ]);
  if (spawnProc.exitCode !== 0) {
    throw new Error(`docker run failed: ${spawnProc.stderr.toString()}`);
  }
  const inspect = Bun.spawnSync([
    "docker", "inspect", name,
    "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
  ]);
  const host = inspect.stdout.toString().trim();
  if (host === "") throw new Error("no container IP");

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const check = Bun.spawnSync([
      "docker", "exec", name, "mariadb", "-h127.0.0.1", "--protocol=TCP", "-uroot", "-p123", "-e", "SELECT 1",
    ]);
    if (check.exitCode === 0) return { host, name };
    await Bun.sleep(500);
  }
  throw new Error("MariaDB upstream did not start in time");
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runMysql(
  wg: GatedProcess,
  selector: string,
  password: string,
  sql: string,
): Promise<CliRun> {
  // The MySQL proxy's --ssl upgrade is intermittently racy (documented in
  // mysql-native.test.ts). Retry the whole invocation a few times on the known
  // transient TLS transport fault so the deterministic assertions below hold.
  for (let attempt = 0; ; attempt++) {
    const proc = Bun.spawn(
      [
        "mysql",
        "-h", "127.0.0.1",
        "-P", String(wg.mysqlPort),
        "-u", selector,
        `--password=${password}`,
        "--connect-timeout=10",
        "--ssl", "--ssl-verify-server-cert=FALSE",
        "-e", sql,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const combined = `${stderr}\n${stdout}`;
    const transientTls =
      code !== 0 &&
      /tlsv1 alert|InvalidContentType|corrupt message|2026/i.test(combined);
    if (!transientTls || attempt >= 5) return { code, stdout, stderr };
    await Bun.sleep(300);
  }
}

describe("MySQL command-ACL filtering", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const containers: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    // Recordings must be enabled for the block audit to persist.
    wg = await processes.startWg({ configPatch: { recordings: { enable: true } } });
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.mysqlPort, { recv: false });
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) Bun.spawnSync(["docker", "rm", "-f", name]);
  });

  test("deny rule blocks matching query; non-matching passes; audit written", async () => {
    const db = await startMysqlInNetwork();
    containers.push(db.name);
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "gated-pw" });
    await api.addUserRole(user.id, role.id);

    const target = await api.createTarget({
      name: `mysql-${randomUUID()}`,
      options: {
        kind: "MySql",
        host: db.host,
        port: 3306,
        username: "root",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
    });
    await api.addTargetRole(target.id, role.id);

    // Deny any statement mentioning the sentinel token.
    await createDenyRule(url, "mysql", target.id, "acl_blocked_sentinel");

    const selector = `${user.username}:${target.name}`;

    // Blocked: the proxy rejects before the upstream sees it.
    const denied = await runMysql(
      wg, selector, "gated-pw",
      "SELECT 'acl_blocked_sentinel' AS s",
    );
    expect(denied.code).not.toBe(0);
    expect(`${denied.stderr}\n${denied.stdout}`).toContain("blocked by policy");

    // The blocked statement never reached the upstream, so the only way this
    // session has a sql_audit recording is the block-path audit write.
    await expectBlockAuditRecording(url, target.name);

    // Allowed: a non-matching query still reaches the upstream.
    const allowed = await runMysql(wg, selector, "gated-pw", "SELECT 1 AS n");
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("1");
    expect(`${allowed.stderr}\n${allowed.stdout}`).not.toContain("blocked by policy");
  }, 180_000);
});

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

async function startPostgresInNetwork(): Promise<{ host: string; name: string }> {
  const name = `gated-acl-pg-${randomUUID()}`;
  const spawnProc = Bun.spawnSync([
    "docker", "run", "--label", "ai-agent=true", "--rm", "-d",
    "--name", name,
    "--network", "traefik",
    "gated-e2e-postgres-server",
  ]);
  if (spawnProc.exitCode !== 0) {
    throw new Error(`docker run failed: ${spawnProc.stderr.toString()}`);
  }
  const inspect = Bun.spawnSync([
    "docker", "inspect", name,
    "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
  ]);
  const host = inspect.stdout.toString().trim();
  if (host === "") throw new Error("no container IP");

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const check = Bun.spawnSync([
      "docker", "exec", name, "pg_isready", "-h", "localhost", "-U", "user",
    ]);
    if (check.exitCode === 0) return { host, name };
    await Bun.sleep(500);
  }
  throw new Error("Postgres upstream did not start in time");
}

async function runPsql(
  wg: GatedProcess,
  selector: string,
  password: string,
  sql: string,
): Promise<CliRun> {
  const proc = Bun.spawn(
    [
      "psql",
      "--user", selector,
      "--host", "127.0.0.1",
      "--port", String(wg.postgresPort),
      "-v", "ON_ERROR_STOP=1",
      "-c", sql,
      "db",
    ],
    {
      env: { ...process.env, PGPASSWORD: password },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("PostgreSQL command-ACL filtering", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const containers: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg({ configPatch: { recordings: { enable: true } } });
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.postgresPort, { recv: false });
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) Bun.spawnSync(["docker", "rm", "-f", name]);
  });

  test("deny rule blocks matching query; non-matching passes; audit written", async () => {
    const db = await startPostgresInNetwork();
    containers.push(db.name);
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    const target = await api.createTarget({
      name: `postgres-${randomUUID()}`,
      options: {
        kind: "Postgres",
        host: db.host,
        port: 5432,
        username: "user",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
    });
    await api.addTargetRole(target.id, role.id);

    await createDenyRule(url, "postgres", target.id, "acl_blocked_sentinel");

    const selector = `${user.username}#${target.name}`;

    // Blocked: the proxy returns an ErrorResponse before forwarding.
    const denied = await runPsql(
      wg, selector, "123",
      "SELECT 'acl_blocked_sentinel' AS s",
    );
    expect(denied.code).not.toBe(0);
    expect(`${denied.stderr}\n${denied.stdout}`).toContain("blocked by policy");

    // The blocked statement never reached the upstream, so the only way this
    // session has a sql_audit recording is the block-path audit write.
    await expectBlockAuditRecording(url, target.name);

    // Allowed: a non-matching query reaches the upstream (proves the empty/
    // non-matching path still forwards, and the proxy stays usable).
    const allowed = await runPsql(wg, selector, "123", "SELECT 1 AS n");
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain("1");
    expect(`${allowed.stderr}\n${allowed.stdout}`).not.toContain("blocked by policy");
  }, 180_000);
});
