import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Server } from "bun";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

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

async function createUserToken(baseUrl: string, userId: string, label: string): Promise<string> {
  const expiry = new Date(Date.now() + 1000 * 60 * 60).toISOString();
  const body = await adminReq(baseUrl, "POST", `/users/${userId}/api-tokens`, { label, expiry });
  return body.secret as string;
}

const UPSTREAM_BODY = "rbac-http-ok";

// Reach an HTTP-proxy target by its name via the explicit X-Gated-Target
// header (no DNS needed), authenticating the end user with a Bearer API token.
async function proxyGet(
  proxyUrl: string,
  targetName: string,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = { "X-Gated-Target": targetName };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(`${proxyUrl}/`, { headers, tls: { rejectUnauthorized: false } } as any);
}

// gated binds its listeners on deterministic ports; across back-to-back runs a
// port can still be in TIME_WAIT from a just-killed instance, making the next
// gated abort at startup ("Address already in use"). Retry until it comes up —
// startWg hands out fresh, higher ports on each call.
async function startWgReady(processes: ProcessManager): Promise<GatedProcess> {
  for (let attempt = 0; ; attempt++) {
    const wg = await processes.startWg();
    try {
      await waitPort(wg.httpPort, { recv: false, process: wg.process });
      await waitPort(wg.sshPort, { process: wg.process });
      await waitPort(wg.mysqlPort, { recv: false, process: wg.process });
      await waitPort(wg.postgresPort, { recv: false, process: wg.process });
      await waitPort(wg.kubernetesPort, { recv: false, process: wg.process });
      return wg;
    } catch (e) {
      try { wg.process.kill("SIGINT"); } catch {}
      await wg.process.exited.catch(() => {});
      if (attempt >= 7) throw e;
      await Bun.sleep(500);
    }
  }
}

describe("RBAC HTTP-proxy access (allow/deny, revocation)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let proxyUrl: string;
  let upstream: Server;

  const timeout = Number(process.env.TIMEOUT || 20);

  let allowedToken: string;
  let deniedToken: string;
  let targetName: string;
  let roleId: string;
  let targetId: string;

  beforeAll(async () => {
    // Self-contained HTTP echo upstream.
    upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(UPSTREAM_BODY, { status: 200 });
      },
    });

    processes = new ProcessManager(timeout);
    // The HTTP-proxy listener shares the "kubernetes" port (store.http.listen).
    wg = await startWgReady(processes);
    url = `https://localhost:${wg.httpPort}`;
    proxyUrl = `https://localhost:${wg.kubernetesPort}`;

    const role = await adminReq(url, "POST", "/roles", { name: `role-${randomUUID()}` });
    roleId = role.id;
    // Target name must be a valid DNS label for the proxy resolver.
    targetName = `http-${randomUUID()}`;
    const target = await adminReq(url, "POST", "/targets", {
      name: targetName,
      options: {
        kind: "Http",
        url: `http://127.0.0.1:${upstream.port}`,
        tls: { mode: "Disabled", verify: false },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });
    targetId = target.id;
    await adminReq(url, "POST", `/targets/${target.id}/roles/${role.id}`);

    const allowed = await adminReq(url, "POST", "/users", { username: `allowed-${randomUUID()}` });
    await adminReq(url, "POST", `/users/${allowed.id}/roles/${role.id}`);
    allowedToken = await createUserToken(url, allowed.id, "rbac-http-allow");

    const denied = await adminReq(url, "POST", "/users", { username: `denied-${randomUUID()}` });
    // no role binding
    deniedToken = await createUserToken(url, denied.id, "rbac-http-deny");
  });

  afterAll(async () => {
    await processes.stop();
    upstream?.stop(true);
  });

  test("user WITH the role reaches the upstream through the proxy (200)", async () => {
    const res = await proxyGet(proxyUrl, targetName, allowedToken);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_BODY);
  }, 60_000);

  test("user WITHOUT the role is denied at the proxy", async () => {
    const res = await proxyGet(proxyUrl, targetName, deniedToken);
    // The proxy collapses unauthorized-target / bad-credential into 401.
    expect(res.status).toBe(401);
    expect(await res.text()).not.toBe(UPSTREAM_BODY);
  }, 60_000);

  test("a request with no credential is denied", async () => {
    const res = await proxyGet(proxyUrl, targetName, undefined);
    expect(res.status).toBe(401);
  }, 60_000);

  test("revoking the target<->role binding denies a previously-working user", async () => {
    const before = await proxyGet(proxyUrl, targetName, allowedToken);
    expect(before.status).toBe(200);
    await before.text();

    await adminReq(url, "DELETE", `/targets/${targetId}/roles/${roleId}`);

    const after = await proxyGet(proxyUrl, targetName, allowedToken);
    expect(after.status).toBe(401);

    await adminReq(url, "POST", `/targets/${targetId}/roles/${roleId}`);
  }, 60_000);
});
