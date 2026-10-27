import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, readdirSync, renameSync } from "fs";
import { join, resolve } from "path";
import { ProcessManager } from "../helpers/process-manager";
import { allocPort, waitPort } from "../helpers/util";

const BINARY = resolve(import.meta.dir, "../..", process.env.GATED_BINARY || "target/debug/gated");

describe("--data-dir", () => {
  const processes = new ProcessManager(Number(process.env.TIMEOUT || 10));

  afterAll(async () => {
    await processes.stop();
  });

  async function run(args: string[], env: Record<string, string> = {}) {
    const proc = processes.start([BINARY, ...args], {
      cwd: processes.ctx.tmpdir,
      env: { ...process.env, ...env } as Record<string, string>,
      stopSignal: "SIGINT",
      stopTimeout: 5,
    });
    return proc;
  }

  async function serve(dataDir: string, httpPort: number) {
    const proc = await run(["--data-dir", dataDir, "run", "--enable-admin-token"], { GATED_ADMIN_TOKEN: "token-value" });
    await waitPort(httpPort, { recv: false, process: proc });
    const res = await fetch(`https://localhost:${httpPort}/admin/api/users`, {
      headers: { "X-Gated-Token": "token-value" },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(res.status).toBe(200);
    const users = (await res.json()) as { username: string }[];
    expect(users.map((u) => u.username)).toContain("admin");
    proc.kill("SIGINT");
    await proc.exited;
  }

  test("setup and run keep everything in the data directory, which can be moved", async () => {
    const dataDir = join(processes.ctx.tmpdir, "gated-data");
    const httpPort = allocPort();

    const setup = await run(
      [
        "--data-dir", dataDir,
        "unattended-setup",
        "--admin-port", String(httpPort),
        "--ssh-port", String(allocPort()),
        "--external-host", "localhost",
        "--record-sessions",
      ],
      { GATED_ADMIN_PASSWORD: "123" },
    );
    await setup.exited;
    expect(setup.exitCode).toBe(0);

    const config = readFileSync(join(dataDir, "config.yaml"), "utf-8");
    expect(config).toContain("sqlite:db");
    expect(config).not.toContain(dataDir);
    expect(existsSync(join(dataDir, "ssh-keys"))).toBe(true);

    await serve(dataDir, httpPort);
    expect(existsSync(join(dataDir, "db", "db.sqlite3"))).toBe(true);
    // Nothing is written next to the working directory.
    expect(readdirSync(processes.ctx.tmpdir)).toEqual(["gated-data"]);

    // Relative paths make the directory relocatable.
    const moved = join(processes.ctx.tmpdir, "moved");
    renameSync(dataDir, moved);
    await serve(moved, httpPort);
  });
});
