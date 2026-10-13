import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";
import { createConnection } from "net";

// Multi-protocol ticket auth: a ticket authorizes access via MySQL and
// PostgreSQL targets using the native clients (SSH is covered by the existing
// auth-ticket test; HTTP by tests/http/ticket-http.test.ts). The ticket is
// presented as the connection username `ticket-<secret>`; the AuthSelector
// resolves it to a Ticket, authorizes against its bound target, and the
// supplied password is irrelevant.
//
// The gated binary runs on the host and reaches the dockerised upstream DBs
// through the docker bridge gateway, so targets point at the gateway address
// rather than `localhost`. (On a host where docker also publishes to the
// loopback the gateway address still resolves to the same published port.)

function dockerGatewayHost(): string {
  const r = Bun.spawnSync([
    "docker", "network", "inspect", "bridge",
    "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
  ]);
  const gw = r.stdout.toString().trim();
  return gw || "127.0.0.1";
}

async function waitTcp(host: string, port: number, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ host, port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
      sock.setTimeout(2000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await Bun.sleep(500);
  }
  throw new Error(`tcp ${host}:${port} not up after ${timeoutMs}ms`);
}

async function waitMysqlReady(host: string, port: number, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proc = Bun.spawn(
      [
        "mysql", "--host", host, "--port", String(port),
        "--user=root", "--password=123", "--connect-timeout=3",
        "-e", "SELECT 1;",
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    if ((await proc.exited) === 0) return;
    await Bun.sleep(1000);
  }
  throw new Error(`mysql ${host}:${port} not ready after ${timeoutMs}ms`);
}

// This host runs a large fleet of concurrent e2e suites that all allocate
// docker host ports from the same low range, so a `docker run -p <port>` can
// lose the race and never publish. Retry on a fresh port instead of failing.
async function startMysqlReady(
  processes: ProcessManager,
  host: string,
  attempts = 8
): Promise<number> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const port = processes.startMysqlServer();
    try {
      await waitMysqlReady(host, port, 25000);
      return port;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500 + i * 300);
    }
  }
  throw new Error(`mysql upstream never came up after ${attempts} attempts: ${lastErr}`);
}

async function startPostgresReady(
  processes: ProcessManager,
  host: string,
  attempts = 8
): Promise<number> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const port = await processes.startPostgresServer();
      await waitTcp(host, port, 25000);
      return port;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500 + i * 300);
    }
  }
  throw new Error(`postgres upstream never came up after ${attempts} attempts: ${lastErr}`);
}

// gated's own listener bind can also lose the port race against the fleet;
// retry the whole bring-up on fresh ports.
async function startWgWithRetry(processes: ProcessManager, attempts = 12): Promise<GatedProcess> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const wg = await processes.startWg();
      await waitPort(wg.httpPort, { recv: false, process: wg.process });
      await waitPort(wg.mysqlPort, { recv: false, process: wg.process });
      await waitPort(wg.postgresPort, { recv: false, process: wg.process });
      return wg;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(800 + i * 400);
    }
  }
  throw new Error(`gated failed to start after ${attempts} attempts: ${lastErr}`);
}

describe("DB Ticket Multi-Protocol", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let api: AdminClient;
  let dockerHost: string;
  const timeout = Number(process.env.TIMEOUT || 30);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    dockerHost = dockerGatewayHost();
    wg = await startWgWithRetry(processes);
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
  });

  afterAll(async () => {
    await processes.stop();
  });

  async function setupUser() {
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);
    return { role, user };
  }

  test("mysql: ticket authorizes a MySQL connection via the native client", async () => {
    const dbPort = await startMysqlReady(processes, dockerHost);
    await waitPort(wg.mysqlPort, { recv: false, process: wg.process });

    const { role, user } = await setupUser();
    const target = await api.createTarget({
      name: `mysql-${randomUUID()}`,
      options: {
        kind: "MySql",
        host: dockerHost,
        port: dbPort,
        username: "root",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
    });
    await api.addTargetRole(target.id, role.id);

    const ticket = await api.createTicket({
      target_name: target.name,
      username: user.username,
    });

    const proc = processes.start(
      [
        "mysql",
        "-h", "127.0.0.1",
        "-P", String(wg.mysqlPort),
        "-u", `ticket-${ticket.secret}`,
        "--password=ignored",
        "--connect-timeout=10",
        "--ssl",
        "--ssl-verify-server-cert=FALSE",
        "-e", "SELECT 42 AS ok;",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("42");
  });

  test("postgres: ticket authorizes a PostgreSQL connection via the native client", async () => {
    const dbPort = await startPostgresReady(processes, dockerHost);
    await waitPort(wg.postgresPort, { recv: false, process: wg.process });

    const { role, user } = await setupUser();
    const target = await api.createTarget({
      name: `postgres-${randomUUID()}`,
      options: {
        kind: "Postgres",
        host: dockerHost,
        port: dbPort,
        username: "user",
        password: "123",
        tls: { mode: "Disabled", verify: false },
        readonly: false,
      },
    });
    await api.addTargetRole(target.id, role.id);

    const ticket = await api.createTicket({
      target_name: target.name,
      username: user.username,
    });

    const proc = processes.start(
      [
        "psql",
        "--user", `ticket-${ticket.secret}`,
        "--host", "127.0.0.1",
        "--port", String(wg.postgresPort),
        "-c", "SELECT 42 AS ok;",
        "db",
      ],
      {
        env: { ...process.env, PGPASSWORD: "ignored", PGSSLMODE: "require" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("42");
  });
});
