import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

// We run inside a dev container on the `traefik` bridge network. Docker port
// publishing from a child container doesn't reach us (different subnets), so we
// start the postgres image on the same network and have the proxy connect by
// its container IP instead of a host-published port. Mirrors sql-console.test.ts.
const POSTGRES_IMAGE = {
  namePrefix: "gated-pg-auth",
  image: "gated-e2e-postgres-server",
  port: 5432,
  readyCmd: ["pg_isready", "-h", "localhost", "-U", "user"],
  label: "Postgres",
};

async function startDbInNetwork(): Promise<{ host: string; port: number; name: string }> {
  const name = `${POSTGRES_IMAGE.namePrefix}-${randomUUID()}`;
  const spawnProc = Bun.spawnSync([
    "docker", "run", "--label", "ai-agent=true", "--rm", "-d",
    "--name", name,
    "--network", "traefik",
    POSTGRES_IMAGE.image,
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
    const check = Bun.spawnSync(["docker", "exec", name, ...POSTGRES_IMAGE.readyCmd]);
    if (check.exitCode === 0) return { host, port: POSTGRES_IMAGE.port, name };
    await Bun.sleep(500);
  }
  throw new Error(`${POSTGRES_IMAGE.label} did not start in time`);
}

describe("PostgreSQL User Auth Password", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const containers: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
    await waitPort(wg.kubernetesPort, { recv: false, process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) {
      Bun.spawnSync(["docker", "rm", "-f", name]);
    }
  });

  test("postgres auth success and failure", async () => {
    const db = await startDbInNetwork();
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
        port: db.port,
        username: "user",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
    });
    await api.addTargetRole(target.id, role.id);

    await waitPort(wg.postgresPort, { recv: false });

    // Correct password
    let proc = processes.start(
      [
        "psql",
        "--user", `${user.username}#${target.name}`,
        "--host", "127.0.0.1",
        "--port", String(wg.postgresPort),
        "db",
      ],
      {
        env: { ...process.env, PGPASSWORD: "123" },
        stdin: "pipe",
        stdout: "pipe",
      }
    );
    proc.stdin.write("\\dt\n");
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("tbl");
    expect(proc.exitCode).toBe(0);

    // Wrong password
    proc = processes.start(
      [
        "psql",
        "--user", `${user.username}#${target.name}`,
        "--host", "127.0.0.1",
        "--port", String(wg.postgresPort),
        "db",
      ],
      {
        env: { ...process.env, PGPASSWORD: "wrong" },
        stdin: "pipe",
        stdout: "pipe",
      }
    );
    proc.stdin.write("\\dt\n");
    proc.stdin.end();
    await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });
});
