import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { waitPort, allocPort } from "../helpers/util";
import { randomUUID } from "crypto";

// Console restriction coverage, parallel-safe sibling of
// `sql-console.test.ts`. We re-derive the network/admin helpers here rather
// than importing from that file so the two suites stay independent.
//
// We run inside a dev container on the `traefik` bridge network; docker port
// publishing from a child container doesn't reach us, so we start each DB
// image on the same network and connect by its container IP (mirrors
// `startDbInNetwork` in `sql-console.test.ts`).
//
// Port contention note: `allocPort` is a naive monotonic counter that resets
// to ~1235 in every test process. When many suites run
// concurrently they all fight for the same low ports and gated's SSH listener
// fails to bind ("Address already in use"), which destabilises the server.
// We push the counter into a high, uncontended band before allocating so this
// suite is robust under parallel execution.
{
  const base = 24000 + Math.floor(Math.random() * 8000);
  while (allocPort() < base) {
    /* advance the shared counter past the low contended range */
  }
}

type DbImage = {
  namePrefix: string;
  image: string;
  port: number;
  readyCmd: string[];
  label: string;
};

const MYSQL_IMAGE: DbImage = {
  namePrefix: "gated-sqlr",
  image: "gated-e2e-mysql-server",
  port: 3306,
  readyCmd: ["mariadb", "-uroot", "-p123", "-e", "SELECT 1"],
  label: "MariaDB",
};

const POSTGRES_IMAGE: DbImage = {
  namePrefix: "gated-sqlr-pg",
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
    "docker", "run", "--rm", "-d", "--label", "ai-agent=true",
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
  label: string,
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

async function provisionDbTarget(
  url: string,
  opts: {
    kind: DbKind;
    host: string;
    port: number;
    readonly?: boolean;
    namePrefix: string;
  },
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

function queryUrl(url: string, targetName: string): string {
  return `${url}/api/db/query/${encodeURIComponent(targetName)}`;
}

async function runQuery(
  url: string,
  targetName: string,
  token: string,
  body: { sql: string; limit?: number },
) {
  return userFetch(queryUrl(url, targetName), token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// One gated instance serves both DB kinds (each as an independent target),
// keeping the port footprint small under parallel execution.
describe("SQL Console restrictions", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let mysqlDb: { host: string; port: number; name: string };
  let pgDb: { host: string; port: number; name: string };
  const containers: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 20);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;

    mysqlDb = await startDbInNetwork(MYSQL_IMAGE);
    containers.push(mysqlDb.name);
    pgDb = await startDbInNetwork(POSTGRES_IMAGE);
    containers.push(pgDb.name);
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) {
      Bun.spawnSync(["docker", "rm", "-f", name]);
    }
  });

  test("readonly transactions reject writes hidden inside a user function", async () => {
    const setup = Bun.spawnSync(["docker", "exec", pgDb.name, "psql", "-U", "user", "-d", "db", "-v", "ON_ERROR_STOP=1", "-c",
      "CREATE TABLE audit_probe (value integer); CREATE FUNCTION audit_probe_write() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit_probe VALUES (1); RETURN 1; END $$;"]);
    expect(setup.exitCode).toBe(0);
    const { target, userToken } = await provisionDbTarget(url, { kind: "Postgres", host: pgDb.host, port: pgDb.port, readonly: true, namePrefix: "pg-readonly" });
    const response = await runQuery(url, target.name, userToken, { sql: "SELECT audit_probe_write()" });
    expect(response.status).toBe(400);
    expect((await response.text()).toLowerCase()).toContain("read-only");
    const read = await runQuery(url, target.name, userToken, { sql: "SELECT count(*) AS n FROM audit_probe" });
    expect(read.status).toBe(200);
    expect((await read.json() as { rows: number[][] }).rows).toEqual([[0]]);
    for (const sql of [`SELECT "pg_read_file"('/etc/hostname')`, 'SELECT 1 INTO audit_created_table']) {
      const denied = await runQuery(url, target.name, userToken, { sql });
      expect(denied.status).toBe(403);
    }
  }, 120_000);

  // ── File-read/write denylist ───────────────────────────────
  // The denylist is the read-only SQL validator (`validate_readonly_sql`), which
  // only runs on read-only targets and rejects BEFORE the query touches the DB.
  // So these assertions are independent of any MariaDB execution quirks.
  test("INTO OUTFILE / INTO DUMPFILE / LOAD_FILE are rejected (MySQL)", async () => {
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "MySql",
      host: mysqlDb.host,
      port: mysqlDb.port,
      readonly: true,
      namePrefix: "mysql-f3",
    });

    const read = await runQuery(url, target.name, userToken, { sql: "SELECT 1 AS n" });
    expect(read.status).toBe(200);
    expect((await read.json() as { rows: number[][] }).rows).toEqual([[1]]);

    const cases: Array<[string, string, string]> = [
      // [label, sql, substring expected (lowercased) in the error message]
      ["INTO OUTFILE", "SELECT * FROM `db`.`table` INTO OUTFILE '/tmp/x'", "outfile"],
      ["INTO OUTFILE (mid)", "SELECT * INTO OUTFILE '/tmp/x' FROM `db`.`table`", "outfile"],
      ["INTO DUMPFILE", "SELECT * FROM `db`.`table` INTO DUMPFILE '/tmp/x'", "dumpfile"],
      ["LOAD_FILE", "SELECT LOAD_FILE('/etc/passwd')", "load_file"],
    ];

    await Promise.all(
      cases.map(async ([label, sql, needle]) => {
        const res = await runQuery(url, target.name, userToken, { sql });
        expect([label, res.status]).toEqual([label, 403]);
        const body = (await res.json()) as { error: string };
        expect([label, body.error.toLowerCase().includes(needle)]).toEqual([label, true]);
      }),
    );

    // Column names that merely contain the denied substrings must NOT be
    // false-positives — the validator tokenises `_` as part of the word, so
    // `into_x` / `outfile_path` are distinct tokens and the denylist must not
    // fire. (The query then reaches MariaDB and 400s on the unknown columns;
    // we only assert it was NOT a 403 denylist rejection.)
    const okRes = await runQuery(url, target.name, userToken, {
      sql: "SELECT into_x, outfile_path FROM `db`.`table`",
    });
    expect(okRes.status).not.toBe(403);
  }, 120_000);

  // ── Row/byte cap + statement timeout ───────────────────────────────────
  // Exercised on PostgreSQL: the cap is engine-agnostic, and the timeout relies
  // on `SET statement_timeout` which Postgres supports natively.
  //
  // NOTE (not faked): the MySQL/MariaDB console timeout sub-item is NOT
  // exercised here. The console issues `SET SESSION MAX_EXECUTION_TIME` (a
  // MySQL-only variable) before every query; the e2e image is MariaDB 10.8,
  // which rejects it ("Unknown system variable 'MAX_EXECUTION_TIME'"), so every
  // MariaDB console query (incl. a SLEEP timeout probe) fails with that error
  // rather than via the intended timeout path. The byte/row cap and denylist
  // happen before/independent of execution, so they are covered above (denylist
  // on MySQL) and below (cap on Postgres).
  test("row cap truncates at the requested limit (Postgres)", async () => {
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "Postgres",
      host: pgDb.host,
      port: pgDb.port,
      namePrefix: "pg-rowcap",
    });

    const res = await runQuery(url, target.name, userToken, {
      sql: "SELECT g FROM generate_series(1, 50) AS g",
      limit: 10,
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { rows: unknown[]; truncated: boolean };
    // The cap is enforced BEFORE materializing the over-cap row, so exactly
    // `limit` rows come back and `truncated` is set.
    expect(body.rows.length).toBe(10);
    expect(body.truncated).toBe(true);
  }, 60_000);

  test("byte cap (>5 MiB) sets truncated=true (Postgres)", async () => {
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "Postgres",
      host: pgDb.host,
      port: pgDb.port,
      namePrefix: "pg-bytecap",
    });

    const oneMib = 1048576;
    const unions = Array.from(
      { length: 6 },
      () => `SELECT repeat('x', ${oneMib})`,
    ).join(" UNION ALL ");

    const res = await runQuery(url, target.name, userToken, { sql: unions, limit: 1000 });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { rows: unknown[]; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
  }, 60_000);

  test("pg_sleep(40) is aborted before the full 40s (Postgres timeout)", async () => {
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "Postgres",
      host: pgDb.host,
      port: pgDb.port,
      namePrefix: "pg-timeout",
    });

    const started = Date.now();
    const res = await runQuery(url, target.name, userToken, {
      sql: "SELECT pg_sleep(40)",
    });
    const elapsed = Date.now() - started;
    // Either the 30s statement_timeout fired or the +5s tokio guard did; either
    // way the request fails well before pg_sleep's full 40s would elapse.
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(elapsed).toBeLessThan(40_000);
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
  }, 60_000);

  // ── Schema/table/column browsing ───────────────────────────────────────
  test("schemas/tables/columns return MySQL metadata", async () => {
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "MySql",
      host: mysqlDb.host,
      port: mysqlDb.port,
      namePrefix: "mysql-f5",
    });

    let res = await userFetch(
      `${url}/api/db/schemas/${encodeURIComponent(target.name)}`,
      userToken,
    );
    expect(res.ok).toBe(true);
    const schemas = (await res.json()) as { schemas: string[]; kind: string };
    expect(schemas.kind).toBe("MySql");
    expect(schemas.schemas).toContain("db");
    // System schemas are filtered out.
    expect(schemas.schemas).not.toContain("mysql");
    expect(schemas.schemas).not.toContain("information_schema");

    res = await userFetch(
      `${url}/api/db/tables/${encodeURIComponent(target.name)}?schema=db`,
      userToken,
    );
    expect(res.ok).toBe(true);
    const tables = (await res.json()) as { tables: Array<{ name: string; type: string }> };
    expect(tables.tables.map((t) => t.name)).toContain("table");

    res = await userFetch(
      `${url}/api/db/columns/${encodeURIComponent(target.name)}?schema=db&table=table`,
      userToken,
    );
    expect(res.ok).toBe(true);
    const cols = (await res.json()) as {
      columns: Array<{ name: string; data_type: string; nullable: boolean }>;
    };
    const byName = new Map(cols.columns.map((c) => [c.name, c]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining(["id", "name"]));
    expect(byName.get("id")!.data_type.toLowerCase()).toContain("int");
    expect(byName.get("name")!.data_type.toLowerCase()).toContain("varchar");
    // Both columns are NOT NULL in the upstream schema.
    expect(byName.get("id")!.nullable).toBe(false);
    expect(byName.get("name")!.nullable).toBe(false);
  }, 60_000);

  test("schemas/tables/columns return Postgres metadata", async () => {
    const { target, userToken } = await provisionDbTarget(url, {
      kind: "Postgres",
      host: pgDb.host,
      port: pgDb.port,
      namePrefix: "pg-f5",
    });

    let res = await userFetch(
      `${url}/api/db/schemas/${encodeURIComponent(target.name)}`,
      userToken,
    );
    expect(res.ok).toBe(true);
    const schemas = (await res.json()) as { schemas: string[]; kind: string };
    expect(schemas.kind).toBe("Postgres");
    expect(schemas.schemas).toContain("public");
    // System schemas (information_schema, pg_*) are filtered out.
    expect(schemas.schemas).not.toContain("information_schema");
    expect(schemas.schemas.some((s) => s.startsWith("pg_"))).toBe(false);

    res = await userFetch(
      `${url}/api/db/tables/${encodeURIComponent(target.name)}?schema=public`,
      userToken,
    );
    expect(res.ok).toBe(true);
    const tables = (await res.json()) as { tables: Array<{ name: string; type: string }> };
    expect(tables.tables.map((t) => t.name)).toContain("tbl");

    res = await userFetch(
      `${url}/api/db/columns/${encodeURIComponent(target.name)}?schema=public&table=tbl`,
      userToken,
    );
    expect(res.ok).toBe(true);
    const cols = (await res.json()) as {
      columns: Array<{ name: string; data_type: string; nullable: boolean }>;
    };
    const byName = new Map(cols.columns.map((c) => [c.name, c]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining(["id", "name"]));
    expect(byName.get("id")!.data_type.toLowerCase()).toContain("integer");
    expect(byName.get("name")!.data_type.toLowerCase()).toContain("text");
    expect(byName.get("id")!.nullable).toBe(false);
    expect(byName.get("name")!.nullable).toBe(false);
  }, 60_000);
});
