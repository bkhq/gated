import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

const PASSWORD = "initial-password-1";

describe("Sessions and tickets follow identity changes", () => {
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

  async function signedInUser() {
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: PASSWORD });
    const session = new HttpSession();
    const login = await session.post(`${url}/api/auth/login`, {
      username: user.username, password: PASSWORD,
    });
    expect(login.status).toBe(201);
    expect(await signedIn(session)).toBe(true);
    return { user, session };
  }

  async function signedIn(session: HttpSession) {
    const res = await session.get(`${url}/api/profile/tickets`);
    await res.text();
    return res.status === 200;
  }

  async function httpTarget(name = `http-${randomUUID()}`) {
    return api.createTarget({
      name,
      options: {
        kind: "Http",
        url: "https://example.invalid/",
        tls: { mode: "Preferred", verify: false },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });
  }

  // 403 = the ticket authenticated, 401 = it did not.
  async function ticketStatus(secret: string) {
    const res = await fetch(`${url}/api/profile/tickets`, {
      headers: { Authorization: `Gated ${secret}` },
      tls: { rejectUnauthorized: false },
    } as any);
    await res.text();
    return res.status;
  }

  test("an admin password reset ends the user's sessions", async () => {
    const { user, session } = await signedInUser();
    await api.createPasswordCredential(user.id, { password: "replacement-password-1" });
    expect(await signedIn(session)).toBe(false);
  }, 60_000);

  test("removing a password ends the user's sessions", async () => {
    const { user, session } = await signedInUser();
    const [credential] = await api.getPasswordCredentials(user.id);
    await api.deletePasswordCredential(user.id, credential.id);
    expect(await signedIn(session)).toBe(false);
  }, 60_000);

  test("a deleted user's session does not pass to a new user of the same name", async () => {
    const { user, session } = await signedInUser();
    await api.deleteUser(user.id);
    expect(await signedIn(session)).toBe(false);

    await api.createUser({ username: user.username });
    expect(await signedIn(session)).toBe(false);
  }, 60_000);

  test("renaming a user ends their sessions", async () => {
    const { user, session } = await signedInUser();
    await api.updateUser(user.id, { username: `renamed-${randomUUID()}` });
    await api.createUser({ username: user.username });
    expect(await signedIn(session)).toBe(false);
  }, 60_000);

  test("a ticket does not pass to a new user or target of the same name", async () => {
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.addUserRole(user.id, role.id);
    const target = await httpTarget();
    await api.addTargetRole(target.id, role.id);

    const forUser = await api.createTicket({ target_name: target.name, username: user.username });
    expect(await ticketStatus(forUser.secret)).toBe(403);
    await api.deleteUser(user.id);
    const recreated = await api.createUser({ username: user.username });
    await api.addUserRole(recreated.id, role.id);
    expect(await ticketStatus(forUser.secret)).toBe(401);

    const forTarget = await api.createTicket({ target_name: target.name, username: recreated.username });
    expect(await ticketStatus(forTarget.secret)).toBe(403);
    await api.deleteTarget(target.id);
    const sameName = await httpTarget(target.name);
    await api.addTargetRole(sameName.id, role.id);
    expect(await ticketStatus(forTarget.secret)).toBe(401);
    expect((await api.getTickets()).some((t: any) => t.target === target.name)).toBe(false);
  }, 60_000);

  test("a ticket follows its user and target through a rename", async () => {
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.addUserRole(user.id, role.id);
    const target = await httpTarget();
    await api.addTargetRole(target.id, role.id);
    const ticket = await api.createTicket({ target_name: target.name, username: user.username });

    const newUsername = `renamed-${randomUUID()}`;
    const newTargetName = `renamed-${randomUUID()}`;
    await api.updateUser(user.id, { username: newUsername });
    const current = await api.getTarget(target.id);
    await api.updateTarget(target.id, { name: newTargetName, options: (current as any).options });

    const stored = (await api.getTickets()).find((t: any) => t.id === (ticket as any).ticket.id);
    expect(stored).toMatchObject({ username: newUsername, target: newTargetName });
    expect(await ticketStatus(ticket.secret)).toBe(403);
  }, 60_000);

  test("signing in issues a new session id", async () => {
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: PASSWORD });
    const login = (cookie?: string) => fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ username: user.username, password: PASSWORD }),
      tls: { rejectUnauthorized: false },
    } as any);
    const cookieOf = (res: Response) => res.headers.getSetCookie()[0]?.split(";")[0];
    const profile = async (cookie: string) => {
      const res = await fetch(`${url}/api/profile/tickets`, {
        headers: { Cookie: cookie }, tls: { rejectUnauthorized: false },
      } as any);
      await res.text();
      return res.status;
    };

    const first = cookieOf(await login());
    expect(first).toBeTruthy();
    const second = cookieOf(await login(first));
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(await profile(second!)).toBe(200);
    expect(await profile(first!)).toBe(401);
  }, 60_000);
});
