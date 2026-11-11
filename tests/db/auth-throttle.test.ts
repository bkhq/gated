import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";
import { hostname } from "os";

// Repeated wrong passwords on the native database listeners lock the
// (user, client address) pair out, even for the right password.
//
// The native client runs inside the upstream database container and connects
// back to the gateway by this host's name (see readonly-native.test.ts).

const FAILURES_BEFORE_LOCKOUT = 10;

type Db = { host: string; name: string };

function startDb(image: string, ready: string[]): Db {
  const name = `gated-throttle-${randomUUID()}`;
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

describe("Failed login throttling on the database listeners", () => {
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

  async function provision(kind: "MySql" | "Postgres", db: Db) {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const target = await api.createTarget({
      name: `${kind.toLowerCase()}-${randomUUID()}`,
      options: {
        kind,
        host: db.host,
        port: kind === "MySql" ? 3306 : 5432,
        username: kind === "MySql" ? "root" : "user",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
    } as any);
    await api.addTargetRole(target.id, role.id);
    const selector = async () => {
      const user = await api.createUser({ username: `user-${randomUUID()}` });
      await api.createPasswordCredential(user.id, { password: "gated-pw" });
      await api.addUserRole(user.id, role.id);
      return `${user.username}:${target.name}`;
    };
    return { attacked: await selector(), control: await selector() };
  }

  test("mysql", async () => {
    const db = startDb("gated-e2e-mysql-server", [
      "mariadb", "-h127.0.0.1", "--protocol=TCP", "-uroot", "-p123", "-e", "SELECT 1",
    ]);
    containers.push(db.name);
    const login = (selector: string, password: string) => Bun.spawnSync([
      "docker", "exec", db.name,
      "mariadb", "-h", gateway, "-P", String(wg.mysqlPort), "-u", selector, `--password=${password}`,
      "--connect-timeout=10", "--ssl", "--ssl-verify-server-cert=FALSE", "-e", "SELECT 1",
    ]).exitCode;

    const { attacked, control } = await provision("MySql", db);
    expect(login(attacked, "gated-pw")).toBe(0);
    for (let i = 0; i < FAILURES_BEFORE_LOCKOUT; i++) expect(login(attacked, "wrong")).not.toBe(0);
    expect(login(attacked, "gated-pw")).not.toBe(0);
    expect(login(control, "gated-pw")).toBe(0);
  }, 180_000);

  test("postgres", async () => {
    const db = startDb("gated-e2e-postgres-server", ["pg_isready", "-h", "localhost", "-U", "user"]);
    containers.push(db.name);
    const login = (selector: string, password: string) => Bun.spawnSync([
      "docker", "exec", "-e", `PGPASSWORD=${password}`, "-e", "PGSSLMODE=require", db.name,
      "psql", "--user", selector, "--host", gateway, "--port", String(wg.postgresPort), "-c", "SELECT 1", "db",
    ]).exitCode;

    const { attacked, control } = await provision("Postgres", db);
    expect(login(attacked, "gated-pw")).toBe(0);
    for (let i = 0; i < FAILURES_BEFORE_LOCKOUT; i++) expect(login(attacked, "wrong")).not.toBe(0);
    expect(login(attacked, "gated-pw")).not.toBe(0);
    expect(login(control, "gated-pw")).toBe(0);
  }, 180_000);
});
