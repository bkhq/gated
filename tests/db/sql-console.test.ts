import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

// We run inside a dev container on the `traefik` bridge network. Docker port
// publishing from a child container doesn't reach us (different docker
// subnets), so we start the database image on the same network and connect
// by its container IP instead. `startPostgresServer` in ProcessManager binds
// on the host, which is exactly why we can't use it here.
type DbImage = {
  namePrefix: string;
  image: string;
  port: number;
  readyCmd: string[];
  label: string;
};

const MYSQL_IMAGE: DbImage = {
  namePrefix: "gated-sql",
  image: "gated-e2e-mysql-server",
  port: 3306,
  readyCmd: ["mariadb", "-uroot", "-p123", "-e", "SELECT 1"],
  label: "MariaDB",
};

const POSTGRES_IMAGE: DbImage = {
  namePrefix: "gated-sql-pg",
  image: "gated-e2e-postgres-server",
  port: 5432,
  readyCmd: ["pg_isready", "-h", "localhost", "-U", "user"],
  label: "Postgres",
};

async function startDbInNetwork(
  img: DbImage,
): Promise<{ host: string; port: number; name: string }> {
  const name = `${img.namePrefix}-${randomUUID()}`;
  const spawnProc = Bun.spawnSync([
    "docker", "run", "--label", "ai-agent=true", "--rm", "-d",
    "--name", name,
    "--network", "traefik",
    img.image,
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
    const check = Bun.spawnSync(["docker", "exec", name, ...img.readyCmd]);
    if (check.exitCode === 0) return { host, port: img.port, name };
    await Bun.sleep(500);
  }
  throw new Error(`${img.label} did not start in time`);
}

// SQL Console endpoints live at /api/db/* and authenticate via X-Gated-Token
// (user API token). The shared adminClient helper still uses a stale prefix,
// so we talk to the admin API directly here.
const ADMIN_TOKEN = "token-value";

async function adminReq(baseUrl: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/admin/api${path}`, {
    method,
    headers: {
      "X-Gated-Token": ADMIN_TOKEN,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    tls: { rejectUnauthorized: false },
  } as any);
  if (!res.ok) throw new Error(`admin ${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function createUserToken(
  baseUrl: string,
  userId: string,
  label: string
): Promise<string> {
  const expiry = new Date(Date.now() + 1000 * 60 * 60).toISOString();
  const body = await adminReq(baseUrl, "POST", `/users/${userId}/api-tokens`, {
    label,
    expiry,
  });
  return body.secret as string;
}

async function userFetch(url: string, token: string, init?: RequestInit) {
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      "X-Gated-Token": token,
    },
    tls: { rejectUnauthorized: false },
  } as any);
}

type DbKind = "MySql" | "Postgres";

function makeSharedContainer(img: DbImage, containers: string[]) {
  let shared: { host: string; port: number; name: string } | null = null;
  return async () => {
    if (!shared) {
      shared = await startDbInNetwork(img);
      containers.push(shared.name);
    }
    return shared;
  };
}

async function provisionDbTarget(
  url: string,
  opts: {
    kind: DbKind;
    host: string;
    port: number;
    readonly?: boolean;
    namePrefix: string;
  }
): Promise<{ target: { id: string; name: string }; userToken: string }> {
  const role = await adminReq(url, "POST", "/roles", { name: `role-${randomUUID()}` });
  const user = await adminReq(url, "POST", "/users", { username: `user-${randomUUID()}` });
  await adminReq(url, "POST", `/users/${user.id}/roles/${role.id}`);
  const target = await adminReq(url, "POST", "/targets", {
    name: `${opts.namePrefix}-${randomUUID()}`,
    options: {
      kind: opts.kind,
      host: opts.host,
      port: opts.port,
      username: opts.kind === "MySql" ? "root" : "user",
      password: "123",
      tls: { mode: "Disabled", verify: false },
      default_database_name: "db",
      readonly: opts.readonly ?? false,
    },
  });
  await adminReq(url, "POST", `/targets/${target.id}/roles/${role.id}`);
  const userToken = await createUserToken(url, user.id, `${opts.namePrefix}-tok`);
  return { target, userToken };
}

describe("SQL Console (MySQL)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const containers: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 20);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) {
      Bun.spawnSync(["docker", "rm", "-f", name]);
    }
  });

  test("mysql schemas/tables/columns/query round-trip", async () => {
    const db = await startDbInNetwork(MYSQL_IMAGE);
    containers.push(db.name);
    const url = `https://localhost:${wg.httpPort}`;

    const role = await adminReq(url, "POST", "/roles", { name: `role-${randomUUID()}` });
    const user = await adminReq(url, "POST", "/users", { username: `user-${randomUUID()}` });
    await adminReq(url, "POST", `/users/${user.id}/roles/${role.id}`);
    const target = await adminReq(url, "POST", "/targets", {
      name: `mysql-${randomUUID()}`,
      options: {
        kind: "MySql",
        host: db.host,
        port: db.port,
        username: "root",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        default_database_name: "db",
        readonly: false,
      },
    });
    await adminReq(url, "POST", `/targets/${target.id}/roles/${role.id}`);

    const userToken = await createUserToken(url, user.id, "sql-console-test");

    // Schemas
    let res = await userFetch(
      `${url}/api/db/schemas/${encodeURIComponent(target.name)}`,
      userToken
    );
    expect(res.ok).toBe(true);
    const schemasBody = (await res.json()) as {
      schemas: string[];
      readonly: boolean;
      kind: string;
    };
    expect(schemasBody.kind).toBe("MySql");
    expect(schemasBody.readonly).toBe(false);
    expect(schemasBody.schemas).toContain("db");

    // Tables
    res = await userFetch(
      `${url}/api/db/tables/${encodeURIComponent(target.name)}?schema=db`,
      userToken
    );
    expect(res.ok).toBe(true);
    const tablesBody = (await res.json()) as {
      tables: Array<{ name: string; type: string }>;
    };
    const tableNames = tablesBody.tables.map((t) => t.name);
    expect(tableNames).toContain("table");

    // Columns
    res = await userFetch(
      `${url}/api/db/columns/${encodeURIComponent(target.name)}?schema=db&table=table`,
      userToken
    );
    expect(res.ok).toBe(true);
    const colsBody = (await res.json()) as {
      columns: Array<{ name: string; data_type: string; nullable: boolean; primary_key: boolean }>;
    };
    const colNames = colsBody.columns.map((c) => c.name);
    expect(colNames).toEqual(expect.arrayContaining(["id", "name"]));

    // SELECT
    res = await userFetch(
      `${url}/api/db/query/${encodeURIComponent(target.name)}`,
      userToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1 AS n, 'hi' AS s", limit: 10 }),
      }
    );
    expect(res.ok).toBe(true);
    const queryBody = (await res.json()) as {
      columns: Array<{ name: string; type_name: string }>;
      rows: Array<Array<unknown>>;
      statement_kind: string;
      truncated: boolean;
    };
    expect(queryBody.statement_kind).toBe("SELECT");
    expect(queryBody.truncated).toBe(false);
    expect(queryBody.columns.map((c) => c.name)).toEqual(["n", "s"]);
    expect(queryBody.rows.length).toBe(1);
    expect(queryBody.rows[0][0]).toBe(1);
    expect(queryBody.rows[0][1]).toBe("hi");

    // INSERT on a non-readonly target
    res = await userFetch(
      `${url}/api/db/query/${encodeURIComponent(target.name)}`,
      userToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "INSERT INTO `db`.`table` (id, name) VALUES (1, 'x')" }),
      }
    );
    expect(res.ok).toBe(true);
    const writeBody = (await res.json()) as {
      rows_affected?: number;
      statement_kind: string;
    };
    expect(writeBody.statement_kind).toBe("INSERT");
    expect(writeBody.rows_affected).toBe(1);
  }, 120_000);

  test("readonly target rejects writes", async () => {
    const db = await startDbInNetwork(MYSQL_IMAGE);
    containers.push(db.name);
    const url = `https://localhost:${wg.httpPort}`;

    const role = await adminReq(url, "POST", "/roles", { name: `role-${randomUUID()}` });
    const user = await adminReq(url, "POST", "/users", { username: `user-${randomUUID()}` });
    await adminReq(url, "POST", `/users/${user.id}/roles/${role.id}`);
    const target = await adminReq(url, "POST", "/targets", {
      name: `mysql-ro-${randomUUID()}`,
      options: {
        kind: "MySql",
        host: db.host,
        port: db.port,
        username: "root",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        default_database_name: "db",
        readonly: true,
      },
    });
    await adminReq(url, "POST", `/targets/${target.id}/roles/${role.id}`);

    const userToken = await createUserToken(url, user.id, "sql-ro-test");

    // SELECT is allowed
    let res = await userFetch(
      `${url}/api/db/query/${encodeURIComponent(target.name)}`,
      userToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      }
    );
    expect(res.ok).toBe(true);

    // Leading line-comment + SELECT still passes (comment strip)
    res = await userFetch(
      `${url}/api/db/query/${encodeURIComponent(target.name)}`,
      userToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "-- keep calm\nSELECT 1" }),
      }
    );
    expect(res.ok).toBe(true);

    // DELETE is rejected
    res = await userFetch(
      `${url}/api/db/query/${encodeURIComponent(target.name)}`,
      userToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "DELETE FROM `db`.`table`" }),
      }
    );
    expect(res.status).toBe(403);

    // readonly flag surfaces in /db/schemas
    const schemasRes = await userFetch(
      `${url}/api/db/schemas/${encodeURIComponent(target.name)}`,
      userToken
    );
    expect(schemasRes.ok).toBe(true);
    const schemasBody = (await schemasRes.json()) as { readonly: boolean };
    expect(schemasBody.readonly).toBe(true);
  }, 120_000);

  test("per-user rate limit returns 429 with Retry-After", async () => {
    const db = await startDbInNetwork(MYSQL_IMAGE);
    containers.push(db.name);
    const url = `https://localhost:${wg.httpPort}`;

    const role = await adminReq(url, "POST", "/roles", { name: `role-${randomUUID()}` });
    const user = await adminReq(url, "POST", "/users", { username: `user-${randomUUID()}` });
    await adminReq(url, "POST", `/users/${user.id}/roles/${role.id}`);
    const target = await adminReq(url, "POST", "/targets", {
      name: `mysql-rl-${randomUUID()}`,
      options: {
        kind: "MySql",
        host: db.host,
        port: db.port,
        username: "root",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        default_database_name: "db",
        readonly: false,
      },
    });
    await adminReq(url, "POST", `/targets/${target.id}/roles/${role.id}`);

    // Clamp the per-user quota to 1 request/minute so the second call
    // synchronously trips the limiter.
    await adminReq(url, "PUT", "/parameters", {
      allow_own_credential_management: true,
      sql_console_rate_limit_per_user: 1,
    });

    const userToken = await createUserToken(url, user.id, "sql-rl-test");

    const queryUrl = `${url}/api/db/query/${encodeURIComponent(target.name)}`;
    const queryOpts = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    };

    const first = await userFetch(queryUrl, userToken, queryOpts);
    expect(first.ok).toBe(true);
    await first.text();

    const second = await userFetch(queryUrl, userToken, queryOpts);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("rate limit exceeded");

    // Restore an unlimited quota so later tests in this file are unaffected.
    await adminReq(url, "PUT", "/parameters", {
      allow_own_credential_management: true,
      sql_console_rate_limit_per_user: null,
    });
  }, 120_000);

  test("unauthorized target returns 403", async () => {
    const db = await startDbInNetwork(MYSQL_IMAGE);
    containers.push(db.name);
    const url = `https://localhost:${wg.httpPort}`;

    // user has no role → not authorized for the target
    const user = await adminReq(url, "POST", "/users", { username: `user-${randomUUID()}` });
    const target = await adminReq(url, "POST", "/targets", {
      name: `mysql-deny-${randomUUID()}`,
      options: {
        kind: "MySql",
        host: db.host,
        port: db.port,
        username: "root",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        default_database_name: "db",
        readonly: false,
      },
    });

    const userToken = await createUserToken(url, user.id, "sql-deny-test");

    const res = await userFetch(
      `${url}/api/db/schemas/${encodeURIComponent(target.name)}`,
      userToken
    );
    expect(res.status).toBe(403);
  }, 90_000);

  // The readonly-variants, truncation and SLEEP tests below share one MariaDB
  // container — they only need a reachable DB for pool creation and each still
  // creates its own role/user/target/token. The rate-limit test above keeps
  // its own container because it mutates global `/parameters`; the 401 and
  // SSH tests below don't need a database at all.
  const getSharedMysql = makeSharedContainer(MYSQL_IMAGE, containers);

  test("readonly target rejects UPDATE/DROP/CTE/compound/commented writes", async () => {
    const db = await getSharedMysql();
    const url = `https://localhost:${wg.httpPort}`;
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "MySql",
      host: db.host,
      port: db.port,
      readonly: true,
      namePrefix: "mysql-ro-var",
    });

    const queryUrl = `${url}/api/db/query/${encodeURIComponent(target.name)}`;
    const cases: Array<[string, string]> = [
      ["UPDATE", "UPDATE `db`.`table` SET name = 'x'"],
      ["DROP", "DROP TABLE `db`.`table`"],
      ["writable CTE", "WITH w AS (DELETE FROM `db`.`table` RETURNING *) SELECT * FROM w"],
      ["compound statement", "SELECT 1; UPDATE `db`.`table` SET name = 'x'"],
      ["block-comment-wrapped write", "/* harmless */ DELETE FROM `db`.`table`"],
      ["line-comment-prefixed write", "-- prefix\nINSERT INTO `db`.`table` (id, name) VALUES (1, 'x')"],
    ];

    await Promise.all(
      cases.map(async ([label, sql]) => {
        const res = await userFetch(queryUrl, userToken, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql }),
        });
        expect([label, res.status]).toEqual([label, 403]);
        const body = (await res.json()) as { error: string };
        expect(body.error.toLowerCase()).toContain("read-only");
      }),
    );
  }, 60_000);

  test("result over 5 MiB sets truncated=true", async () => {
    const db = await getSharedMysql();
    const url = `https://localhost:${wg.httpPort}`;
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "MySql",
      host: db.host,
      port: db.port,
      namePrefix: "mysql-trunc",
    });

    const oneMib = 1048576;
    const unions = Array.from(
      { length: 6 },
      () => `SELECT REPEAT('x', ${oneMib})`,
    ).join(" UNION ALL ");

    const res = await userFetch(
      `${url}/api/db/query/${encodeURIComponent(target.name)}`,
      userToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: unions, limit: 10 }),
      },
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { rows: unknown[]; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
  }, 60_000);

  test("SELECT SLEEP(40) aborts before the full 40s", async () => {
    const db = await getSharedMysql();
    const url = `https://localhost:${wg.httpPort}`;
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "MySql",
      host: db.host,
      port: db.port,
      namePrefix: "mysql-to",
    });

    const started = Date.now();
    const res = await userFetch(
      `${url}/api/db/query/${encodeURIComponent(target.name)}`,
      userToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT SLEEP(40) AS slept" }),
      },
    );
    const elapsed = Date.now() - started;
    // Either MAX_EXECUTION_TIME (30s) killed it and sqlx surfaced the error,
    // or the tokio guard fired at ~35s. Either way we never reach 40s.
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(elapsed).toBeLessThan(40_000);
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  }, 60_000);

  test("missing or invalid X-Gated-Token returns 401", async () => {
    // Auth rejection happens before pool resolution, so this test needs
    // neither a running DB nor an actual target/role/user.
    const queryUrl = `https://localhost:${wg.httpPort}/api/db/query/any-valid-name`;
    const queryBody = {
      method: "POST" as const,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    };

    const noAuth = await fetch(queryUrl, {
      ...queryBody,
      tls: { rejectUnauthorized: false },
    } as any);
    expect(noAuth.status).toBe(401);

    const bogus = await userFetch(queryUrl, "not-a-real-token", queryBody);
    expect(bogus.status).toBe(401);
  });

  test("SSH target is rejected as non-database kind", async () => {
    const url = `https://localhost:${wg.httpPort}`;
    const role = await adminReq(url, "POST", "/roles", { name: `role-${randomUUID()}` });
    const user = await adminReq(url, "POST", "/users", { username: `user-${randomUUID()}` });
    await adminReq(url, "POST", `/users/${user.id}/roles/${role.id}`);
    const target = await adminReq(url, "POST", "/targets", {
      name: `ssh-${randomUUID()}`,
      options: {
        kind: "Ssh",
        host: "localhost",
        port: 22,
        username: "root",
        auth: { kind: "PublicKey" },
      },
    });
    await adminReq(url, "POST", `/targets/${target.id}/roles/${role.id}`);
    const userToken = await createUserToken(url, user.id, "sql-ssh");

    const res = await userFetch(
      `${url}/api/db/schemas/${encodeURIComponent(target.name)}`,
      userToken,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("not a database");
  });
});

describe("SQL Console (Postgres)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const containers: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 20);
  const getSharedPg = makeSharedContainer(POSTGRES_IMAGE, containers);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) {
      Bun.spawnSync(["docker", "rm", "-f", name]);
    }
  });

  test("postgres readonly target rejects write variants", async () => {
    const db = await getSharedPg();
    const url = `https://localhost:${wg.httpPort}`;
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "Postgres",
      host: db.host,
      port: db.port,
      readonly: true,
      namePrefix: "pg-ro",
    });

    const queryUrl = `${url}/api/db/query/${encodeURIComponent(target.name)}`;

    const probe = await userFetch(queryUrl, userToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    expect(probe.ok).toBe(true);

    const cases: Array<[string, string]> = [
      ["UPDATE", "UPDATE tbl SET name = 'x'"],
      ["DROP", "DROP TABLE tbl"],
      ["writable CTE", "WITH w AS (DELETE FROM tbl RETURNING *) SELECT * FROM w"],
      ["compound statement", "SELECT 1; UPDATE tbl SET name = 'x'"],
    ];
    await Promise.all(
      cases.map(async ([label, sql]) => {
        const r = await userFetch(queryUrl, userToken, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql }),
        });
        expect([label, r.status]).toEqual([label, 403]);
      }),
    );
  }, 60_000);

  test("pg_sleep(40) aborts before the full 40s", async () => {
    const db = await getSharedPg();
    const url = `https://localhost:${wg.httpPort}`;
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "Postgres",
      host: db.host,
      port: db.port,
      namePrefix: "pg-to",
    });

    const started = Date.now();
    const res = await userFetch(
      `${url}/api/db/query/${encodeURIComponent(target.name)}`,
      userToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT pg_sleep(40)" }),
      },
    );
    const elapsed = Date.now() - started;
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(elapsed).toBeLessThan(40_000);
  }, 60_000);
});
