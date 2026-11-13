import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, ADMIN_TOKEN } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

// The password policy applies wherever a password is set through the API.
describe("Password policy", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
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

  test("passwords that break the policy are refused by the admin and profile APIs", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    // No policy by default.
    await api.createPasswordCredential(user.id, { password: "pwd" });

    const current = await (await admin("GET", "/parameters")).json();
    expect(current.password_policy).toEqual({
      min_length: 0,
      require_uppercase: false,
      require_lowercase: false,
      require_digits: false,
      require_special: false,
    });
    expect((await admin("PUT", "/parameters", {
      ...current,
      password_policy: { ...current.password_policy, min_length: 1000 },
    })).status).toBe(400);
    expect((await admin("PUT", "/parameters", {
      ...current,
      password_policy: { ...current.password_policy, min_length: 10, require_digits: true },
    })).status).toBe(201);

    const create = (password: string) =>
      admin("POST", `/users/${user.id}/credentials/passwords`, { password });
    expect((await create("short1")).status).toBe(400);
    expect((await create("long-enough-but-no-digit")).status).toBe(400);
    expect((await create("long-enough-with-1-digit")).status).toBe(201);

    // The existing weak password still signs in; the policy binds new passwords.
    const session = new HttpSession();
    expect((await session.post(`${url}/api/auth/login`, {
      username: user.username, password: "pwd",
    })).status).toBe(201);
    const state = await (await session.get(`${url}/api/profile/credentials`)).json();
    expect(state.password_policy.min_length).toBe(10);

    const change = (password: string) =>
      session.post(`${url}/api/profile/credentials/password`, { old_password: "pwd", password });
    const refused = await change("weak");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toContain("at least 10 characters");
    expect((await change("a-much-better-passw0rd")).ok).toBe(true);
  }, 60_000);
});
