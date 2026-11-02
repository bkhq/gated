import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from "fs";
import { connect } from "tls";
import { join, resolve } from "path";
import { ProcessManager } from "../helpers/process-manager";
import { allocPort, waitPort } from "../helpers/util";

const BINARY = resolve(import.meta.dir, "../..", process.env.GATED_BINARY || "target/x86_64-unknown-linux-musl/debug/gated");

function servedFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      resolve(socket.getPeerCertificate().fingerprint256);
      socket.end();
    });
    socket.on("error", reject);
  });
}

async function api(httpPort: number, path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token) headers["X-Gated-Token"] = init.token;
  return fetch(`https://localhost:${httpPort}${path}`, {
    ...init,
    headers,
    tls: { rejectUnauthorized: false },
  } as any);
}

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

  async function serve(dataDir: string, httpPort: number, setup: boolean) {
    const proc = await run(["--data-dir", dataDir, "run", "--enable-admin-token"], { GATED_ADMIN_TOKEN: "token-value" });
    await waitPort(httpPort, { recv: false, process: proc });
    if (setup) {
      const res = await api(httpPort, "/api/admin/setup/init", {
        method: "POST",
        token: "token-value",
        body: JSON.stringify({ username: "admin", password: "123" }),
      });
      expect(res.status).toBe(201);
    }
    const res = await api(httpPort, "/admin/api/users", { token: "token-value" });
    expect(res.status).toBe(200);
    const users = (await res.json()) as { username: string }[];
    expect(users.map((u) => u.username)).toContain("admin");
    proc.kill("SIGINT");
    await proc.exited;
  }

  test("setup and run keep everything in the data directory, which can be moved", async () => {
    const dataDir = join(processes.ctx.tmpdir, "gated-data");
    const httpPort = allocPort();

    const setup = await run([
      "--data-dir", dataDir,
      "unattended-setup",
      "--admin-port", String(httpPort),
      "--ssh-port", String(allocPort()),
      "--external-host", "localhost",
      "--record-sessions",
    ]);
    await setup.exited;
    expect(setup.exitCode).toBe(0);

    const config = readFileSync(join(dataDir, "config.yaml"), "utf-8");
    expect(config).toContain("sqlite:db");
    expect(config).not.toContain(dataDir);

    await serve(dataDir, httpPort, true);
    expect(existsSync(join(dataDir, "db", "db.sqlite3"))).toBe(true);
    // Nothing is written next to the working directory.
    expect(readdirSync(processes.ctx.tmpdir)).toEqual(["gated-data"]);

    // Relative paths make the directory relocatable.
    const moved = join(processes.ctx.tmpdir, "moved");
    renameSync(dataDir, moved);
    await serve(moved, httpPort, false);
  });

  test("first run writes a config; setup creates the admin once and SSH waits for its keys", async () => {
    const dataDir = join(processes.ctx.tmpdir, "fresh");
    const httpPort = allocPort();
    const sshPort = allocPort();
    const proxyPort = allocPort();
    const proc = await run(["--data-dir", dataDir, "run", "--admin-port", String(httpPort)], {
      GATED_SSH_PORT: String(sshPort),
      GATED_HTTP_PORT: String(proxyPort),
      GATED_EXTERNAL_HOST: "localhost",
    });
    await waitPort(httpPort, { recv: false, process: proc });
    // The HTTP proxy listener is on by default.
    await waitPort(proxyPort, { recv: false, process: proc });
    expect(readFileSync(join(dataDir, "config.yaml"), "utf-8")).toContain(`:${httpPort}`);

    let status = await api(httpPort, "/api/admin/setup/status");
    expect(await status.json()).toEqual({ needs_setup: true });

    // No key material on disk; SSH waits for host keys.
    expect(existsSync(join(dataDir, "ssh-keys"))).toBe(false);
    await expect(waitPort(sshPort, { recv: false, timeout: 1000 })).rejects.toThrow();

    const tokenPath = join(dataDir, "db", "bootstrap-token.txt");
    const token = readFileSync(tokenPath, "utf-8").trim();
    const body = (bootstrap_token: string) =>
      JSON.stringify({ bootstrap_token, username: "admin", password: "first-password" });

    const wrong = await api(httpPort, "/api/admin/setup/init", { method: "POST", body: body("0".repeat(64)) });
    expect(wrong.status).toBe(403);

    const init = await api(httpPort, "/api/admin/setup/init", { method: "POST", body: body(token) });
    expect(init.status).toBe(201);
    expect(existsSync(tokenPath)).toBe(false);

    const login = await api(httpPort, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "first-password" }),
    });
    expect(login.status).toBeLessThan(300);
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // Setup does not create SSH keys; an admin generates (or imports) them.
    await expect(waitPort(sshPort, { recv: false, timeout: 1000 })).rejects.toThrow();
    const generated = await fetch(`https://localhost:${httpPort}/admin/api/ssh/keys/generate`, {
      method: "POST",
      headers: { Cookie: cookie },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(generated.status).toBe(200);
    const keys = (await generated.json()) as { kind: string }[];
    expect(keys.map((k) => k.kind).sort()).toEqual(["client", "client", "host", "host"]);
    await waitPort(sshPort, { recv: false, process: proc });
    expect(existsSync(join(dataDir, "ssh-keys"))).toBe(false);

    // The HTTP proxy serves its own certificate from the database, and a
    // regenerated one without a restart.
    const listCerts = async () => {
      const res = await fetch(`https://localhost:${httpPort}/admin/api/tls/certificates`, {
        headers: { Cookie: cookie },
        tls: { rejectUnauthorized: false },
      } as any);
      expect(res.status).toBe(200);
      return (await res.json()) as { listener: string; chain: { sha256_fingerprint: string }[] }[];
    };
    const httpCert = () => listCerts().then((certs) => certs.find((c) => c.listener === "http")!.chain[0].sha256_fingerprint);
    const before = await httpCert();
    expect(await servedFingerprint(proxyPort)).toBe(before);
    expect(await servedFingerprint(httpPort)).not.toBe(before);
    const regenerated = await fetch(`https://localhost:${httpPort}/admin/api/tls/certificates/http/generate`, {
      method: "POST",
      headers: { Cookie: cookie },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(regenerated.status).toBe(200);
    const after = await httpCert();
    expect(after).not.toBe(before);
    expect(await servedFingerprint(proxyPort)).toBe(after);
    // Only the admin listener has certificate files.
    expect(readdirSync(dataDir).filter((name) => name.endsWith(".pem")).sort()).toEqual([
      "tls.certificate.pem",
      "tls.key.pem",
    ]);

    // Setup cannot run again.
    const again = await api(httpPort, "/api/admin/setup/init", { method: "POST", body: body(token) });
    expect(again.status).toBe(409);
    status = await api(httpPort, "/api/admin/setup/status");
    expect(await status.json()).toEqual({ needs_setup: false });

    proc.kill("SIGINT");
    await proc.exited;
  });

  test("first run with GATED_ENCRYPTION_ENABLE writes an encrypted config and starts locked", async () => {
    const dataDir = join(processes.ctx.tmpdir, "fresh-encrypted");
    const httpPort = allocPort();
    // The env overlay must not break later config loads.
    const proc = await run(["--data-dir", dataDir, "run", "--admin-port", String(httpPort)], {
      GATED_ENCRYPTION_ENABLE: "true",
      GATED_SSH_PORT: String(allocPort()),
      GATED_HTTP_PORT: String(allocPort()),
    });
    await waitPort(httpPort, { recv: false, process: proc });
    expect(readFileSync(join(dataDir, "config.yaml"), "utf-8")).toMatch(/encryption:\s*\n\s*enable: true/);
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/admin/encryption/status`);
    expect(((await res.json()) as { status: string }).status).toBe("uninitialized");
    proc.kill("SIGINT");
    await proc.exited;
  });

  test("a first start that fails after writing the config leaves a startable data directory", async () => {
    const dataDir = join(processes.ctx.tmpdir, "fresh-interrupted");
    const httpPort = allocPort();
    const args = ["--data-dir", dataDir, "run", "--admin-port", String(httpPort)];
    const env = { GATED_SSH_PORT: String(allocPort()), GATED_HTTP_PORT: String(allocPort()) };
    // An invalid GATED_ overlay makes loading the freshly written config fail.
    const failed = await run(args, { ...env, GATED_ENCRYPTION: "true" });
    await failed.exited;
    expect(failed.exitCode).not.toBe(0);
    expect(existsSync(join(dataDir, "config.yaml"))).toBe(true);

    const proc = await run(args, env);
    await waitPort(httpPort, { recv: false, process: proc });
    const status = await api(httpPort, "/api/admin/setup/status");
    expect(await status.json()).toEqual({ needs_setup: true });
    proc.kill("SIGINT");
    await proc.exited;
  });

  test("missing admin certificate files are regenerated on start", async () => {
    const dataDir = join(processes.ctx.tmpdir, "fresh-no-admin-cert");
    const httpPort = allocPort();
    const args = ["--data-dir", dataDir, "run", "--admin-port", String(httpPort)];
    const env = { GATED_SSH_PORT: String(allocPort()), GATED_HTTP_PORT: String(allocPort()) };
    let proc = await run(args, env);
    await waitPort(httpPort, { recv: false, process: proc });
    proc.kill("SIGINT");
    await proc.exited;

    rmSync(join(dataDir, "tls.certificate.pem"));
    rmSync(join(dataDir, "tls.key.pem"));
    proc = await run(args, env);
    await waitPort(httpPort, { recv: false, process: proc });
    expect(existsSync(join(dataDir, "tls.certificate.pem"))).toBe(true);
    const status = await api(httpPort, "/api/admin/setup/status");
    expect(status.status).toBe(200);
    proc.kill("SIGINT");
    await proc.exited;
  });
});
