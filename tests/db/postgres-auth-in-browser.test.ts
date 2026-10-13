import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";
import WebSocket from "ws";

// We run inside a dev container on the `traefik` bridge network. Docker port
// publishing from a child container doesn't reach us (different subnets), so we
// start the postgres image on the same network and have the proxy connect by
// its container IP instead of a host-published port. Mirrors sql-console.test.ts.
const POSTGRES_IMAGE = {
  namePrefix: "gated-pg-auth-web",
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

describe("PostgreSQL User Auth In Browser", () => {
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

  test("postgres web user approval", async () => {
    const db = await startDbInNetwork();
    containers.push(db.name);
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);
    await api.updateUser(user.id, {
      username: user.username,
      credential_policy: {
        postgres: ["Password", "WebUserApproval"],
      },
    });

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

    // Login via HTTP
    const loginResp = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "123" }),
      tls: { rejectUnauthorized: false },
    } as any);
    const loginCookies = loginResp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // Connect WebSocket
    const wsUrl = `wss://localhost:${wg.httpPort}/api/auth/web-auth-requests/stream`;
    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: loginCookies, Origin: `https://localhost:${wg.httpPort}` },
      rejectUnauthorized: false,
    });

    const messages: string[] = [];
    const authIdPromise = new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.length >= 2) resolve(data.toString());
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 15000);
    });

    await new Promise<void>((resolve) => ws.on("open", resolve));

    // Start psql client
    const client = processes.start(
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

    // Wait for auth request (second message)
    const authId = await authIdPromise;

    // Verify and approve
    const stateResp = await fetch(`${url}/api/auth/state/${authId}`, {
      headers: { Cookie: loginCookies },
      tls: { rejectUnauthorized: false },
    } as any);
    const authState = (await stateResp.json()) as any;
    expect(authState.protocol).toBe("PostgreSQL");
    expect(authState.state).toBe("WebUserApprovalNeeded");

    const approveResp = await fetch(`${url}/api/auth/state/${authId}/approve`, {
      method: "POST",
      headers: { Cookie: loginCookies },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(approveResp.status).toBe(200);

    client.stdin.write("\r\n");
    client.stdin.write("\\dt\n");
    client.stdin.end();

    const stdout = await new Response(client.stdout).text();
    await client.exited;
    expect(stdout).toContain("tbl");
    expect(client.exitCode).toBe(0);

    ws.close();
  });
});
