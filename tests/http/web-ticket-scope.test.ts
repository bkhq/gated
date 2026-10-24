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

  for (const path of ["/api/db/schemas/other", "/api/db/query/other", "/api/ssh/terminal/other", "/api/mysql/terminal/other", "/api/postgres/terminal/other"]) {
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
