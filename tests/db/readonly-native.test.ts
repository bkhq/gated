import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";
import { hostname } from "os";

// A read-only database target must refuse writes on the native proxies too.
//
// The upstream runs on the `traefik` network and is reached by container IP
// (see sql-console.test.ts). The native client runs inside that same
// container and connects back to the gateway by this host's name.

type Db = { host: string; name: string };

function startDb(image: string, ready: string[]): Db {
  const name = `gated-ro-${randomUUID()}`;
  const run = Bun.spawnSync([
    "docker", "run", "--label", "ai-agent=true", "--rm", "-d", "--name", name, "--network", "traefik", image,
  ]);
  if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`);
  const host = Bun.spawnSync([
    "docker", "inspect", name, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
  ]).stdout.toString().trim();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (Bun.spawnSync(["docker", "exec", name, ...ready]).exitCode === 0) return { host, name };
    Bun.sleepSync(500);
  }
  throw new Error(`${image} did not start in time`);
}

function exec(container: string, env: Record<string, string>, argv: string[]) {
  const proc = Bun.spawnSync([
    "docker", "exec", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), container, ...argv,
  ]);
  return { code: proc.exitCode, output: `${proc.stdout.toString()}\n${proc.stderr.toString()}` };
}

describe("Read-only database targets on the native proxies", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  const containers: string[] = [];
  const gateway = hostname();

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) Bun.spawnSync(["docker", "rm", "-f", name]);
  });

  async function provision(kind: "MySql" | "Postgres", db: Db, readonly: boolean) {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "gated-pw" });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `${kind.toLowerCase()}-${randomUUID()}`,
      options: {
        kind,
        host: db.host,
        port: kind === "MySql" ? 3306 : 5432,
        username: kind === "MySql" ? "root" : "user",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly,
      },
    } as any);
    await api.addTargetRole(target.id, role.id);
    return `${user.username}:${target.name}`;
  }

  test("mysql: writes and attempts to leave read-only mode are refused", async () => {
    const db = startDb("gated-e2e-mysql-server", [
      "mariadb", "-h127.0.0.1", "--protocol=TCP", "-uroot", "-p123", "-e", "SELECT 1",
    ]);
    containers.push(db.name);
    const mysql = (selector: string, sql: string) => exec(db.name, {}, [
      "mariadb", "-h", gateway, "-P", String(wg.mysqlPort), "-u", selector, "--password=gated-pw",
      "--connect-timeout=10", "--ssl", "--ssl-verify-server-cert=FALSE", "db", "-e", sql,
    ]);

    const readonly = await provision("MySql", db, true);
    const read = mysql(readonly, "SELECT 41 + 1 AS n");
    expect(read.output).toContain("42");
    expect(read.code).toBe(0);
    for (const sql of [
      "INSERT INTO `table` (id, name) VALUES (901, 'x')",
      "CREATE TABLE ro_created (id int)",
      "SET SESSION TRANSACTION READ WRITE",
      "SET @@session.tx_read_only = 0",
      "SELECT 1 INTO OUTFILE '/tmp/ro.txt'",
    ]) {
      const write = mysql(readonly, sql);
      expect([sql, write.code === 0]).toEqual([sql, false]);
      expect(write.output.toLowerCase()).toContain("read");
    }

    const writable = await provision("MySql", db, false);
    expect(mysql(writable, "CREATE TABLE rw_created (id int)").code).toBe(0);
    const tables = mysql(writable, "SHOW TABLES").output;
    expect(tables).toContain("rw_created");
    expect(tables).not.toContain("ro_created");
  }, 180_000);

  test("postgres: writes and attempts to leave read-only mode are refused", async () => {
    const db = startDb("gated-e2e-postgres-server", ["pg_isready", "-h", "localhost", "-U", "user"]);
    containers.push(db.name);
    const psql = (selector: string, sql: string) => exec(db.name, { PGPASSWORD: "gated-pw", PGSSLMODE: "require" }, [
      "psql", "--user", selector, "--host", gateway, "--port", String(wg.postgresPort),
      "-v", "ON_ERROR_STOP=1", "-c", sql, "db",
    ]);

    const readonly = await provision("Postgres", db, true);
    const read = psql(readonly, "SELECT 41 + 1 AS n");
    expect(read.output).toContain("42");
    expect(read.code).toBe(0);
    for (const sql of [
      "CREATE TABLE ro_created (id int)",
      "SET default_transaction_read_only = off",
      "BEGIN READ WRITE",
      "DISCARD ALL",
    ]) {
      const write = psql(readonly, sql);
      expect([sql, write.code === 0]).toEqual([sql, false]);
      expect(write.output.toLowerCase()).toContain("read-only");
    }

    const writable = await provision("Postgres", db, false);
    expect(psql(writable, "CREATE TABLE rw_created (id int)").code).toBe(0);
    const tables = psql(writable, "\\dt").output;
    expect(tables).toContain("rw_created");
    expect(tables).not.toContain("ro_created");
  }, 180_000);
});
