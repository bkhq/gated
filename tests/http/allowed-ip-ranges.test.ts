import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, ADMIN_TOKEN } from "../helpers/api-client";
import { mintApiToken } from "../helpers/http-upstream";
import { waitPort } from "../helpers/util";
import { sshPublicKeyAuth } from "../helpers/gated-helpers";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

// A user limited to address ranges can sign in, use API tokens and claim
// tickets only from inside them.
describe("Allowed address ranges of a user", () => {
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

  const setRanges = async (user: any, allowed_ip_ranges: string[] | null) =>
    admin("PUT", `/users/${user.id}`, { username: user.username, allowed_ip_ranges });

  const LOCAL = ["127.0.0.0/8", "::1"];
  const ELSEWHERE = ["203.0.113.0/24", "2001:db8::/32"];

  test("malformed ranges are rejected and valid ones are stored", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    expect(user.allowed_ip_ranges ?? null).toBeNull();
    for (const bad of ["10.0.0.0/33", "not-an-address", "10.0.0.1/", ""]) {
      expect((await setRanges(user, [bad])).status).toBe(400);
    }
    const saved = await setRanges(user, ["10.0.0.0/8", " 192.168.1.7 "]);
    expect(saved.status).toBe(200);
    expect((await saved.json()).allowed_ip_ranges).toEqual(["10.0.0.0/8", "192.168.1.7"]);
    // An empty list lifts the restriction.
    expect((await (await setRanges(user, [])).json()).allowed_ip_ranges ?? null).toBeNull();
  });

  test("sign-in and API tokens work only from an allowed address", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    const login = () =>
      new HttpSession().post(`${url}/api/auth/login`, { username: user.username, password: "pwd" });
    const withToken = (token: string) =>
      fetch(`${url}/api/targets`, { headers: { "X-Gated-Token": token }, tls: { rejectUnauthorized: false } } as any);

    expect((await setRanges(user, LOCAL)).status).toBe(200);
    expect((await login()).status).toBe(201);
    const token = await mintApiToken(url, user.username, "pwd");
    expect((await withToken(token)).status).toBe(200);

    expect((await setRanges(user, ELSEWHERE)).status).toBe(200);
    expect((await login()).status).toBe(401);
    expect((await withToken(token)).status).toBe(401);

    expect((await setRanges(user, null)).status).toBe(200);
    expect((await login()).status).toBe(201);
    expect((await withToken(token)).status).toBe(200);
  }, 60_000);

  test("a ticket cannot be claimed from outside the user's ranges", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `target-${randomUUID()}`,
      options: { kind: "Ssh", host: "127.0.0.1", port: 1, username: "root", auth: sshPublicKeyAuth() },
    });
    await api.addTargetRole(target.id, role.id);
    const ticket = await (await admin("POST", "/tickets", { target_name: target.name, username: user.username })).json();
    const claim = () =>
      new HttpSession().post(`${url}/api/tickets/claim`, { secret: ticket.secret });

    expect((await setRanges(user, ELSEWHERE)).status).toBe(200);
    expect((await claim()).ok).toBe(false);
    expect((await setRanges(user, LOCAL)).status).toBe(200);
    expect((await claim()).ok).toBe(true);
  }, 60_000);
});
