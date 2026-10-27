import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "fs";
import { join, resolve } from "path";
import { createConnection, type Socket } from "net";

const TESTS_DIR = resolve(import.meta.dir, "../..");
const ADMIN_TOKEN = "token-value";

// The SSH connection-test endpoint makes the gated process dial the
// upstream and report the host key. gated runs in this dev container, which
// sits on the `traefik` docker network, while child containers published on the
// host are unreachable from here. So (mirroring db/sql-console.test.ts) we run
// the SSH upstream on the `traefik` network and reach it by container IP.
async function startSshInNetwork(): Promise<{ host: string; name: string; dataDir: string }> {
  const name = `gated-conn-ssh-${randomUUID()}`;
  const dataDir = join(TESTS_DIR, `.conn-test-${randomUUID()}`);
  mkdirSync(dataDir, { recursive: true });

  const authorizedKeys = join(dataDir, "authorized_keys");
  writeFileSync(authorizedKeys, "");
  chmodSync(authorizedKeys, 0o600);

  const configPath = join(dataDir, "sshd_config");
  writeFileSync(
    configPath,
    `Port 22
AuthorizedKeysFile ${authorizedKeys}
UseDNS no
StrictModes no
PermitRootLogin yes
HostKey /ssh-keys/id_ed25519
LogLevel DEBUG3
`
  );
  chmodSync(configPath, 0o600);
  chmodSync(dataDir, 0o700);

  const run = Bun.spawnSync([
    "docker", "run", "--label", "ai-agent=true", "--rm", "-d",
    "--name", name,
    "--network", "traefik",
    "-v", `${dataDir}:${dataDir}`,
    "-v", `${join(TESTS_DIR, "ssh-keys")}:/ssh-keys`,
    "gated-e2e-ssh-server",
    "-f", configPath,
  ]);
  if (run.exitCode !== 0) {
    throw new Error(`docker run failed: ${run.stderr.toString()}`);
  }

  const inspect = Bun.spawnSync([
    "docker", "inspect", name,
    "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
  ]);
  const host = inspect.stdout.toString().trim();
  if (host === "") throw new Error("no container IP for ssh upstream");

  await waitTcp(host, 22, 30_000);
  return { host, name, dataDir };
}

// waitPort only connects to localhost; the upstream lives at a container IP.
async function waitTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((res, rej) => {
        const sock: Socket = createConnection({ host, port }, () => {
          sock.destroy();
          res();
        });
        sock.setTimeout(3000);
        sock.once("error", (e) => { sock.destroy(); rej(e); });
        sock.once("timeout", () => { sock.destroy(); rej(new Error("timeout")); });
      });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`tcp ${host}:${port} not reachable in ${timeoutMs}ms`);
}

async function checkHostKey(
  url: string,
  host: string,
  port: number
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/admin/api/ssh/check-host-key`, {
    method: "POST",
    headers: { "X-Gated-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ host, port }),
    tls: { rejectUnauthorized: false },
  } as any);
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* error responses are plain text */
  }
  return { status: res.status, body };
}

describe("API SSH - Connection Test (check-host-key)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  const containers: string[] = [];
  const dataDirs: string[] = [];
  const timeout = Number(process.env.TIMEOUT || 20);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
    for (const name of containers) {
      Bun.spawnSync(["docker", "rm", "-f", name]);
    }
    for (const dir of dataDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports the host key for a reachable SSH upstream", async () => {
    const ssh = await startSshInNetwork();
    containers.push(ssh.name);
    dataDirs.push(ssh.dataDir);

    const res = await checkHostKey(url, ssh.host, 22);
    expect(res.status).toBe(200);
    expect(typeof res.body.remote_key_type).toBe("string");
    expect(res.body.remote_key_type).toContain("ssh-");
    expect(typeof res.body.remote_key_base64).toBe("string");
    expect(res.body.remote_key_base64.length).toBeGreaterThan(0);
  }, 90_000);

  test("reports a sensible failure for an unreachable port", async () => {
    // Reuse the reachable host so the failure is a fast connection-refused on a
    // closed port (bounded), not a DNS / routing hang.
    const ssh = await startSshInNetwork();
    containers.push(ssh.name);
    dataDirs.push(ssh.dataDir);

    const started = Date.now();
    const res = await checkHostKey(url, ssh.host, 9);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(500);
    expect(typeof res.body).toBe("string");
    expect((res.body as string).length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(30_000);
  }, 90_000);
});
