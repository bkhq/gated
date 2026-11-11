import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Tickets - Create", () => {
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

  test("create ticket returns secret", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    const target = await api.createTarget({
      name: `target-${randomUUID()}`,
      options: {
        kind: "Http",
        url: "https://httpbin.org/get",
        tls: { mode: "Preferred", verify: true },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });
    await api.addTargetRole(target.id, role.id);

    const ticket = await api.createTicket({
      target_name: target.name,
      username: user.username,
    });
    expect(ticket.secret).toBeTruthy();
    expect(typeof ticket.secret).toBe("string");
  });

  test("create ticket rejects unknown names, ungranted users, past expiry and non-positive uses", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    const stranger = await api.createUser({ username: `user-${randomUUID()}` });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `target-${randomUUID()}`,
      options: {
        kind: "Http",
        url: "https://example.invalid/",
        tls: { mode: "Preferred", verify: false },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });
    await api.addTargetRole(target.id, role.id);

    const create = (body: Record<string, unknown>) => fetch(`${url}/admin/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gated-Token": "token-value" },
      body: JSON.stringify({ username: user.username, target_name: target.name, ...body }),
      tls: { rejectUnauthorized: false },
    } as any);

    expect((await create({})).status).toBe(201);
    expect((await create({ number_of_uses: 1, expiry: new Date(Date.now() + 60_000).toISOString() })).status).toBe(201);
    expect((await create({ username: "nobody" })).status).toBe(400);
    expect((await create({ target_name: "nothing" })).status).toBe(400);
    expect((await create({ username: stranger.username })).status).toBe(400);
    expect((await create({ expiry: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
    expect((await create({ number_of_uses: 0 })).status).toBe(400);
    expect((await create({ number_of_uses: -1 })).status).toBe(400);
  });
});
