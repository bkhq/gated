import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { HttpSession } from "../../helpers/session";
import { randomUUID } from "crypto";

describe("API Auth - Session lifetime", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("a lifetime chosen before sign-in applies to the session and slides", async () => {
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    const roles = await api.getRoles("admin");
    await api.addUserRole(user.id, roles[0].id);

    const session = new HttpSession();
    const before = await (await session.get(`${url}/api/info`)).json();
    expect(before.session_lifetime).toBe(1800);
    expect(before.session_lifetime_options).toEqual([1800, 3600, 14400, 28800, 86400]);

    const invalid = await session.put(`${url}/api/auth/session-lifetime`, { seconds: 999 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toBe("session lifetime is not one of the offered options");

    const chosen = await session.put(`${url}/api/auth/session-lifetime`, { seconds: 14400 });
    expect(chosen.status).toBe(204);
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "123",
    });
    expect(loginResp.status).toBe(201);

    const info = await (await session.get(`${url}/api/info`)).json();
    expect(info.username).toBe(user.username);
    expect(info.session_lifetime).toBe(14400);

    const list = await (await session.get(`${url}/admin/api/management-sessions`)).json();
    const current = list.find((s: { current: boolean }) => s.current);
    const expires = Date.parse(current.expires) - Date.parse(current.last_active);
    expect(expires).toBe(14400 * 1000);
  });

  test("polled endpoints do not move the session's last activity", async () => {
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    const roles = await api.getRoles("admin");
    await api.addUserRole(user.id, roles[0].id);
    const session = new HttpSession();
    expect((await session.post(`${url}/api/auth/login`, { username: user.username, password: "123" })).status).toBe(201);

    const lastActive = async () => {
      const list = await (await session.get(`${url}/admin/api/management-sessions`)).json();
      return list.find((s: { current: boolean }) => s.current).last_active as string;
    };
    const atLogin = await lastActive();
    await Bun.sleep(1100);
    await session.get(`${url}/admin/api/system/update`);
    await session.get(`${url}/admin/api/command-reviews`);
    // last_active is derived from a monotonic clock, so allow a little drift.
    expect(Math.abs(Date.parse(await lastActive()) - Date.parse(atLogin))).toBeLessThan(200);

    await session.get(`${url}/api/info`);
    const afterRequest = await lastActive();
    expect(Date.parse(afterRequest) - Date.parse(atLogin)).toBeGreaterThan(1000);

    await Bun.sleep(1100);
    expect((await session.post(`${url}/api/auth/activity`)).status).toBe(204);
    expect(Date.parse(await lastActive()) - Date.parse(afterRequest)).toBeGreaterThan(1000);
  });
});
