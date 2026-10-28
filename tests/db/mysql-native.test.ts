import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

// Drive the native `mysql` (MariaDB) client through gated's MySQL proxy
// against a REAL MySQL/MariaDB upstream (gated-e2e-mysql-server, root/123,
// database `db`).
//
// We run inside a dev container on the `traefik` bridge network. Docker host
// port-publishing from a child container does NOT reach us (different docker
// subnets), so `ProcessManager.startMysqlServer()` + `waitMysqlPort` (both
// host-published, 127.0.0.1) are unreachable here. This is the same
// constraint documented in tests/db/sql-console.test.ts, so — like that
// sibling suite — we start the upstream on the `traefik` network and connect
// gated to it by its container IP instead.
//
// Three behaviours are asserted:
//  1. Password auth: a gated user with a password credential authenticates
//     through the proxy and runs a query against the real upstream.
//  2. TLS enforcement: a non-TLS client connection is REJECTED by gated
//     (mirrors the `if !SSL { send_error(1002, "Gated requires TLS") }` gate
//     in crates/gated-protocol-mysql/src/session.rs). The MariaDB 10.6 client
//     here has `ssl=FALSE` by default; `--skip-ssl` forces plaintext (the
//     MySQL-8 spelling would be `--ssl-mode=DISABLED`).
//  3. Bound-account credential injection: a target with a WRONG inline
//     upstream credential but a bound db-password account still connects,
//     because gated injects the stored account credential upstream — the
//     bun-suite mirror of e2e-docker/probe-mysql.sh.

const ADMIN_TOKEN = "token-value";

// Start the MariaDB upstream on the `traefik` network and return its
// container IP — mirrors tests/db/sql-console.test.ts's startDbInNetwork.
async function startMysqlInNetwork(): Promise<{ host: string; name: string }> {
  const name = `gated-mysql-native-${randomUUID()}`;
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

async function adminReq(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
) {
  const res = await fetch(`${baseUrl}/admin/api${path}`, {
    method,
    headers: {
      "X-Gated-Token": ADMIN_TOKEN,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    tls: { rejectUnauthorized: false },
  } as any);
  if (!res.ok)
    throw new Error(`admin ${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

interface MysqlRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runMysql(
  wg: GatedProcess,
  selector: string,
  password: string,
  sql: string,
  ssl: boolean
): Promise<MysqlRun> {
  const sslArgs = ssl
    ? ["--ssl", "--ssl-verify-server-cert=FALSE"]
    : ["--skip-ssl"];
  const proc = Bun.spawn(
    [
      "mysql",
      "-h",
      "127.0.0.1",
      "-P",
      String(wg.mysqlPort),
      "-u",
      selector,
      `--password=${password}`,
      "--connect-timeout=10",
      ...sslArgs,
      "-e",
      sql,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

// Success-path helper: retries only transient TLS-transport failures
// ("tlsv1 alert decode error" / "received corrupt message", ERROR 2026), never
// auth or credential decisions; any other non-zero exit is surfaced
// immediately. The TLS-rejection test below intentionally does NOT use it.
const TRANSIENT_TLS = /alert decode error|received corrupt message|TLS\/SSL error/i;

async function runMysqlResilient(
  wg: GatedProcess,
  selector: string,
  password: string,
  sql: string
): Promise<MysqlRun> {
  let last: MysqlRun = { code: null, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < 10; attempt++) {
    last = await runMysql(wg, selector, password, sql, true);
    if (last.code === 0) return last;
    if (!TRANSIENT_TLS.test(last.stderr)) return last;
  }
  return last;
}

describe("MySQL native client through proxy", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let dbHost: string;
  let url: string;
  const containers: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 20);

  beforeAll(async () => {
    if (!Bun.which("mysql")) {
      throw new Error("`mysql` client binary unavailable — cannot run I3 suite");
    }
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    url = `https://localhost:${wg.httpPort}`;
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.mysqlPort, { recv: false, process: wg.process });

    const db = await startMysqlInNetwork();
    containers.push(db.name);
    dbHost = db.host;
  }, 180_000);

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) {
      Bun.spawnSync(["docker", "rm", "-f", name]);
    }
  });

  test("password auth: gated user queries the real upstream", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "gated-pw" });
    await api.addUserRole(user.id, role.id);

    const target = await api.createTarget({
      name: `mysql-${randomUUID()}`,
      options: {
        kind: "MySql",
        host: dbHost,
        port: 3306,
        username: "root",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
    });
    await api.addTargetRole(target.id, role.id);

    const run = await runMysqlResilient(
      wg,
      `${user.username}:${target.name}`,
      "gated-pw",
      "SELECT 1 AS n"
    );
    expect(`${run.stderr}\n${run.stdout}`).not.toContain("denied");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("1");
  }, 120_000);

  test("TLS enforcement: plaintext client is rejected", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "gated-pw" });
    await api.addUserRole(user.id, role.id);

    const target = await api.createTarget({
      name: `mysql-${randomUUID()}`,
      options: {
        kind: "MySql",
        host: dbHost,
        port: 3306,
        username: "root",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
    });
    await api.addTargetRole(target.id, role.id);

    const run = await runMysql(
      wg,
      `${user.username}:${target.name}`,
      "gated-pw",
      "SELECT 1 AS n",
      false
    );
    // gated refuses the plaintext handshake with ErrPacket 1002 before any
    // upstream connection happens.
    expect(run.code).not.toBe(0);
    expect(`${run.stderr}\n${run.stdout}`).toMatch(/TLS|1002/i);
  }, 120_000);

  test("bound account wins over a WRONG inline upstream credential", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "gated-pw" });
    await api.addUserRole(user.id, role.id);

    // Bound db-password account holding the CORRECT upstream credentials.
    const account = await adminReq(url, "POST", "/accounts", {
      kind: "db-password",
      name: `mysql-root-${randomUUID()}`,
      description: "correct upstream creds for I3 bound-account test",
      credentials: {
        kind: "db-password",
        engine: "mysql",
        username: "root",
        password: "123",
      },
      tags: ["i3"],
    });

    // Target carries a DELIBERATELY WRONG inline upstream user; the inline
    // secret must be empty when an account is bound (backend rejects 422 if
    // both are present). A successful connection therefore proves gated
    // injected the bound account's root/123 rather than the inline creds.
    const target = await adminReq(url, "POST", "/targets", {
      name: `mysql-bound-${randomUUID()}`,
      description: "mysql upstream — proof of account binding",
      options: {
        kind: "MySql",
        host: dbHost,
        port: 3306,
        username: "WRONG-INLINE-USER",
        password: "",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
      accounts: [{ account_id: account.id, role: "primary" }],
    });
    await adminReq(url, "POST", `/targets/${target.id}/roles/${role.id}`);

    const run = await runMysqlResilient(
      wg,
      `${user.username}:${target.name}`,
      "gated-pw",
      "SELECT CURRENT_USER() AS who"
    );
    expect(`${run.stderr}\n${run.stdout}`).not.toContain("denied");
    expect(run.code).toBe(0);
    // The bound account authenticated as root upstream.
    expect(run.stdout).toContain("root");
  }, 120_000);
});
