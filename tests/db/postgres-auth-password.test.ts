import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

describe("PostgreSQL User Auth Password", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
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
  });

  test("postgres auth success and failure", async () => {
    const dbPort = await processes.startPostgresServer();
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
        host: "localhost",
        port: dbPort,
        username: "user",
        password: "123",
        tls: { mode: "Preferred", verify: false },
      },
    });
    await api.addTargetRole(target.id, role.id);

    await waitPort(dbPort, { recv: false });
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
