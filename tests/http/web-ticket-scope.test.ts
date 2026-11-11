import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { ProcessManager } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";

describe("Web ticket target scope", () => {
  let processes: ProcessManager;
  let api: AdminClient;
  let url: string;
  let username: string;
  let boundTarget: string;

  beforeAll(async () => {
    processes = new ProcessManager(60);
    const wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
    username = `scope-${randomUUID()}`;
    const user = await api.createUser({ username });
    const role = await api.createRole({ name: `scope-${randomUUID()}` });
    await api.addUserRole(user.id, role.id);
    for (const name of ["bound", "other"]) {
      const target = await api.createTarget({ name, options: { kind: "Postgres", host: "127.0.0.1", port: 1, username: "test", readonly: false, tls: { mode: "Disabled", verify: false } } });
      await api.addTargetRole(target.id, role.id);
    }
    boundTarget = "bound";
  });

  afterAll(async () => { await processes?.stop(); });

  for (const path of ["/api/db/schemas/other", "/api/db/query/other", "/api/ssh/terminal/other"]) {
    test(`rejects a ticket for another target at ${path}`, async () => {
      const ticket = await api.createTicket({ target_name: boundTarget, username });
      const query = path.includes("/query/");
      const headers: Record<string, string> = { Authorization: `Gated ${ticket.secret}`, Origin: url };
      if (!path.includes("/terminal/")) {
        const prime = await fetch(`${url}/ui/?gated-ticket=${encodeURIComponent(ticket.secret)}`, { tls: { rejectUnauthorized: false } });
        headers.Cookie = prime.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
        delete headers.Authorization;
      }
      if (query) headers["Content-Type"] = "application/json";
      if (path.includes("/terminal/")) Object.assign(headers, { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" });
      const response = await fetch(`${url}${path}`, { method: query ? "POST" : "GET", headers, body: query ? JSON.stringify({ sql: "SELECT 1" }) : undefined, tls: { rejectUnauthorized: false } });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Ticket does not permit this target");
    });
  }
});

describe("Web ticket sessions", () => {
  let processes: ProcessManager;
  let api: AdminClient;
  let url: string;
  let username: string;

  beforeAll(async () => {
    processes = new ProcessManager(60);
    const wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
    username = `ticket-${randomUUID()}`;
    const user = await api.createUser({ username });
    const role = await api.createRole({ name: `ticket-${randomUUID()}` });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({ name: "db", options: { kind: "Postgres", host: "127.0.0.1", port: 1, username: "test", readonly: false, tls: { mode: "Disabled", verify: false } } });
    await api.addTargetRole(target.id, role.id);
  });

  afterAll(async () => { await processes?.stop(); });

  async function claim() {
    const ticket = await api.createTicket({ target_name: "db", username });
    const claimed = await fetch(`${url}/api/tickets/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ secret: ticket.secret }),
      tls: { rejectUnauthorized: false },
    } as any);
    expect(claimed.status).toBe(200);
    const cookie = claimed.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const get = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, {
      ...init, headers: { Cookie: cookie, Origin: url, "Content-Type": "application/json" }, tls: { rejectUnauthorized: false },
    } as any);
    return { ticket, get };
  }

  test("the profile API is closed to a ticket session", async () => {
    const { get } = await claim();
    expect((await get("/api/targets")).status).toBe(200);
    for (const path of ["/api/profile/credentials", "/api/profile/api-tokens", "/api/profile/tickets", "/api/profile/sessions"])
      expect((await get(path)).status).toBe(403);
    const mint = await get("/api/profile/api-tokens", {
      method: "POST",
      body: JSON.stringify({ label: "x", expiry: new Date(Date.now() + 86400_000).toISOString() }),
    });
    expect(mint.status).toBe(403);
  });

  test("a ticket session is listed, revocable and ends with its ticket", async () => {
    const first = await claim();
    const sessions = await (await fetch(`${url}/admin/api/management-sessions`, {
      headers: { "X-Gated-Token": "token-value" }, tls: { rejectUnauthorized: false },
    } as any)).json() as { id: string, username: string }[];
    const listed = sessions.filter(session => session.username === username);
    expect(listed.length).toBeGreaterThan(0);
    for (const session of listed) {
      const revoke = await fetch(`${url}/admin/api/management-sessions/${session.id}`, {
        method: "DELETE", headers: { "X-Gated-Token": "token-value" }, tls: { rejectUnauthorized: false },
      } as any);
      expect(revoke.ok).toBe(true);
    }
    expect((await first.get("/api/targets")).status).toBe(401);

    const second = await claim();
    expect((await second.get("/api/targets")).status).toBe(200);
    await api.deleteTicket((second.ticket as any).ticket.id);
    expect((await second.get("/api/targets")).status).toBe(401);
  });
});
