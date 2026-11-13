import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, ADMIN_TOKEN } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

// Repeated failed sign-ins lock the user out and block the address; an
// administrator can see and lift both.
describe("Login protection", () => {
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

  async function setThresholds(login_protection: Record<string, unknown>) {
    const current = await (await admin("GET", "/parameters")).json();
    return admin("PUT", "/parameters", {
      ...current,
      login_protection: { ...current.login_protection, ...login_protection },
    });
  }

  async function newUser() {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "right-pw" });
    return user.username as string;
  }

  const login = (username: string, password: string) =>
    new HttpSession().post(`${url}/api/auth/login`, { username, password });

  test("thresholds out of range are rejected", async () => {
    expect((await setThresholds({ ip_max_attempts: 0 })).status).toBe(400);
    expect((await setThresholds({ user_lockout_seconds: 5 })).status).toBe(400);
  });

  test("a user is locked out, listed, and admitted again once the lockout is lifted", async () => {
    expect((await setThresholds({ ip_max_attempts: 1000, user_max_attempts: 3 })).status).toBe(201);
    const username = await newUser();
    for (let i = 0; i < 3; i++) expect((await login(username, "guess")).status).toBe(401);
    expect((await login(username, "right-pw")).status).toBe(401);

    const lockouts = await (await admin("GET", "/login-protection/user-lockouts")).json();
    expect(lockouts.map((l: any) => l.username)).toContain(username);

    expect((await admin("DELETE", `/login-protection/user-lockouts/${username}`)).status).toBe(204);
    expect((await admin("DELETE", `/login-protection/user-lockouts/${username}`)).status).toBe(404);
    expect((await login(username, "right-pw")).status).toBe(201);
  }, 60_000);

  test("an address is blocked for every user until the block is lifted", async () => {
    expect((await setThresholds({ ip_max_attempts: 3, user_max_attempts: 1000 })).status).toBe(201);
    const victim = await newUser();
    for (let i = 0; i < 3; i++) expect((await login(`nobody-${i}`, "guess")).status).toBe(401);
    expect((await login(victim, "right-pw")).status).toBe(401);

    const blocks = await (await admin("GET", "/login-protection/ip-blocks")).json();
    expect(blocks.length).toBe(1);
    expect(blocks[0].block_count).toBe(1);

    const ip = encodeURIComponent(blocks[0].ip_address);
    expect((await admin("DELETE", `/login-protection/ip-blocks/${ip}`)).status).toBe(204);
    expect((await login(victim, "right-pw")).status).toBe(201);
  }, 60_000);

  test("nothing is blocked when the protection is switched off", async () => {
    expect((await setThresholds({ enabled: false, ip_max_attempts: 2, user_max_attempts: 2 })).status).toBe(201);
    const username = await newUser();
    for (let i = 0; i < 4; i++) expect((await login(username, "guess")).status).toBe(401);
    expect((await login(username, "right-pw")).status).toBe(201);
  }, 60_000);
});
