import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, ADMIN_TOKEN, type AdminClient } from "../helpers/api-client";
import { sshTargetOptions } from "../helpers/gated-helpers";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

// A role assignment with `expires_at` grants nothing once that time has passed.
describe("Role assignment expiry", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let api: AdminClient;

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
  });

  afterAll(async () => {
    await processes.stop();
  });

  const admin = (method: string, path: string, body?: unknown) =>
    fetch(`${url}/admin/api${path}`, {
      method,
      headers: { "X-Gated-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);

  test("an expired assignment grants nothing until it is extended", async () => {
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    const target = await api.createTarget({
      name: `ssh-${randomUUID()}`,
      options: sshTargetOptions(1),
    });
    await api.addTargetRole(target.id, role.id);
    await api.addUserRole(user.id, role.id);

    const session = new HttpSession();
    expect((await session.post(`${url}/api/auth/login`, {
      username: user.username, password: "pwd",
    })).status).toBe(201);
    const sees = async () =>
      ((await (await session.get(`${url}/api/targets`)).json()) as { name: string }[])
        .some(t => t.name === target.name);
    const assignment = async () =>
      ((await (await admin("GET", `/users/${user.id}/roles`)).json()) as any[])
        .find(r => r.id === role.id);
    const listed = async () =>
      ((await (await admin("GET", "/users")).json()) as any[])
        .find(u => u.id === user.id).roles as string[];
    const expire = (expires_at: string | null) =>
      admin("PUT", `/users/${user.id}/roles/${role.id}`, { expires_at });

    // Permanent by default.
    expect((await assignment()).expires_at).toBeNull();
    expect(await sees()).toBe(true);

    expect((await expire(new Date(Date.now() - 60_000).toISOString())).status).toBe(400);
    expect((await admin("PUT", `/users/${user.id}/roles/${randomUUID()}`, { expires_at: null })).status).toBe(404);

    const soon = new Date(Date.now() + 2000).toISOString();
    expect((await expire(soon)).status).toBe(200);
    expect(new Date((await assignment()).expires_at).getTime()).toBe(new Date(soon).getTime());
    expect(await sees()).toBe(true);
    expect(await listed()).toContain(role.name);

    await Bun.sleep(2500);
    expect(await sees()).toBe(false);
    // The assignment is kept, marked by its time, and no longer counted.
    expect((await assignment()).expires_at).not.toBeNull();
    expect(await listed()).not.toContain(role.name);

    expect((await expire(null)).status).toBe(200);
    expect(await sees()).toBe(true);
    expect(await listed()).toContain(role.name);
  }, 60_000);

  test("an administrator whose admin role expired is no administrator", async () => {
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    const adminRole = (await (await admin("GET", "/roles")).json() as any[])
      .find(r => r.name === "admin");
    await api.addUserRole(user.id, adminRole.id);

    const session = new HttpSession();
    expect((await session.post(`${url}/api/auth/login`, {
      username: user.username, password: "pwd",
    })).status).toBe(201);
    expect((await session.get(`${url}/admin/api/users`)).status).toBe(200);

    expect((await admin("PUT", `/users/${user.id}/roles/${adminRole.id}`, {
      expires_at: new Date(Date.now() + 1500).toISOString(),
    })).status).toBe(200);
    await Bun.sleep(2000);
    expect((await session.get(`${url}/admin/api/users`)).status).toBe(403);
  }, 60_000);
});
