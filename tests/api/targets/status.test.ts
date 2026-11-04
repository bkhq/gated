import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";
import { sshPublicKeyAuth } from "../../helpers/gated-helpers";

describe("API Targets - Reachability status", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
  });

  async function admin(method: string, path: string, body?: unknown) {
    const res = await fetch(`${url}/admin/api${path}`, {
      method,
      headers: { "X-Gated-Token": "token-value", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : null };
  }

  // SSH kind, but only the TCP port matters: the gateway's own HTTPS
  // listener is up, port 1 is not.
  async function target(port: number) {
    return adminClient(url).createTarget({
      name: `status-${randomUUID()}`,
      options: { kind: "Ssh", host: "127.0.0.1", port, username: "root", auth: sshPublicKeyAuth() },
    });
  }

  test("checks targets, stores the result and shows it to granted users read-only", async () => {
    const api = adminClient(url);
    const up = await target(wg.httpPort);
    const down = await target(1);

    const checked = await admin("POST", "/targets/check", { target_ids: [up.id, down.id, randomUUID()] });
    expect(checked.status).toBe(200);
    expect(checked.body).toHaveLength(2);
    const byId = new Map(checked.body.map((s: any) => [s.target_id, s]));
    expect(byId.get(up.id)).toMatchObject({ reachable: true, error: null });
    expect(typeof (byId.get(up.id) as any).latency_ms).toBe("number");
    expect(byId.get(down.id)).toMatchObject({ reachable: false, latency_ms: null, error: "connection refused" });

    const stored = await admin("GET", "/targets/status");
    expect(stored.status).toBe(200);
    expect(stored.body).toContainEqual(byId.get(up.id));
    expect(stored.body).toContainEqual(byId.get(down.id));

    // A granted user sees the status on My targets but cannot check.
    const suffix = randomUUID().slice(0, 8);
    const role = await api.createRole({ name: `status-${suffix}` });
    const user = await api.createUser({ username: `status-${suffix}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);
    await api.addTargetRole(down.id, role.id);
    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "123" }), tls: { rejectUnauthorized: false },
    } as any);
    expect(login.status).toBe(201);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const mine = await fetch(`${url}/api/targets`, {
      headers: { Cookie: cookie }, tls: { rejectUnauthorized: false },
    } as any);
    const list = await mine.json();
    expect(list).toHaveLength(1);
    expect(list[0].status).toMatchObject({ target_id: down.id, reachable: false, error: "connection refused" });
    const userCheck = await fetch(`${url}/admin/api/targets/check`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ target_ids: [down.id] }), tls: { rejectUnauthorized: false },
    } as any);
    expect([401, 403]).toContain(userCheck.status);

    // Deleting the target removes its status.
    expect((await admin("DELETE", `/targets/${down.id}`)).status).toBe(204);
    const after = await admin("GET", "/targets/status");
    expect(after.body.map((s: any) => s.target_id)).not.toContain(down.id);
  });

  test("rejects empty and oversized requests", async () => {
    expect((await admin("POST", "/targets/check", { target_ids: [] })).status).toBe(400);
    const many = Array.from({ length: 201 }, () => randomUUID());
    expect((await admin("POST", "/targets/check", { target_ids: many })).status).toBe(400);
  });

  test("stores the check interval, 0 to 168 hours", async () => {
    const params = await admin("GET", "/parameters");
    expect(params.body.target_check_interval_hours).toBe(24);
    const update = (hours: number) => admin("PUT", "/parameters", {
      allow_own_credential_management: params.body.allow_own_credential_management,
      target_check_interval_hours: hours,
    });
    expect((await update(6)).status).toBe(201);
    expect((await admin("GET", "/parameters")).body.target_check_interval_hours).toBe(6);
    expect((await update(169)).status).toBe(400);
    expect((await update(0)).status).toBe(201);
    expect((await admin("GET", "/parameters")).body.target_check_interval_hours).toBe(0);
  });
});
