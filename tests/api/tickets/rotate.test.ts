import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient, type AdminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { HttpSession } from "../../helpers/session";
import { randomUUID } from "crypto";

describe("API Tickets - Rotate", () => {
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

  async function admin(method: string, path: string): Promise<Response> {
    return fetch(`${url}/admin/api${path}`, {
      method, headers: { "X-Gated-Token": "token-value" }, tls: { rejectUnauthorized: false },
    } as any);
  }

  async function userWithTarget() {
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `http-${randomUUID()}`,
      options: {
        kind: "Http", url: "https://example.invalid/", tls: { mode: "Preferred", verify: false },
        upstream_auth: { kind: "None" }, flavor: "generic",
      },
    });
    await api.addTargetRole(target.id, role.id);
    return { user, target };
  }

  // 403 = signed in with a ticket, 401 = not signed in.
  async function probe(session: HttpSession, secret?: string) {
    const query = secret ? `?gated-ticket=${encodeURIComponent(secret)}` : "";
    const res = await session.get(`${url}/api/profile/tickets${query}`);
    await res.text();
    return res.status;
  }

  test("a browser session opened with a ticket names it", async () => {
    const { user, target } = await userWithTarget();
    const created = await api.createTicket({ target_name: target.name, username: user.username }) as any;
    const viaTicket = new HttpSession();
    expect(await probe(viaTicket, created.secret)).toBe(403);
    const viaPassword = new HttpSession();
    expect((await viaPassword.post(`${url}/api/auth/login`, { username: user.username, password: "123" })).status).toBe(201);

    const sessions = (await (await admin("GET", "/management-sessions")).json() as
      { username: string, ticket_id: string | null }[]).filter(s => s.username === user.username);
    expect(sessions.map(s => s.ticket_id).sort()).toEqual([created.ticket.id, null].sort());
  }, 60_000);

  test("rotating replaces the secret and ends sessions opened with the old one", async () => {
    const { user, target } = await userWithTarget();
    const created = await api.createTicket({ target_name: target.name, username: user.username }) as any;
    const open = new HttpSession();
    expect(await probe(open, created.secret)).toBe(403);

    const rotated = await admin("POST", `/tickets/${created.ticket.id}/rotate`);
    expect(rotated.status).toBe(200);
    const body = await rotated.json() as { secret: string, ticket: { id: string } };
    expect(body.ticket.id).toBe(created.ticket.id);
    expect(body.secret).not.toBe(created.secret);

    expect(await probe(open)).toBe(401);
    expect(await probe(new HttpSession(), created.secret)).toBe(401);
    expect(await probe(new HttpSession(), body.secret)).toBe(403);
    expect((await admin("POST", `/tickets/${randomUUID()}/rotate`)).status).toBe(404);
  }, 60_000);

  test("a user rotates their own ticket but not someone else's", async () => {
    const { user, target } = await userWithTarget();
    const other = await userWithTarget();
    const session = new HttpSession();
    expect((await session.post(`${url}/api/auth/login`, { username: user.username, password: "123" })).status).toBe(201);
    const mine = await (await session.post(`${url}/api/profile/tickets`, { target_name: target.name })).json() as any;
    const theirs = await api.createTicket({ target_name: other.target.name, username: other.user.username }) as any;

    const rotated = await session.post(`${url}/api/profile/tickets/${mine.ticket.id}/rotate`);
    expect(rotated.status).toBe(200);
    const body = await rotated.json() as { secret: string };
    expect(body.secret).not.toBe(mine.secret);
    expect(await probe(new HttpSession(), mine.secret)).toBe(401);
    expect(await probe(new HttpSession(), body.secret)).toBe(403);

    expect((await session.post(`${url}/api/profile/tickets/${theirs.ticket.id}/rotate`)).status).toBe(404);
    expect(await probe(new HttpSession(), theirs.secret)).toBe(403);
  }, 60_000);
});
