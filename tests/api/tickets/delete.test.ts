import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Tickets - Delete", () => {
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

  test("delete ticket removes it from list", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    const target = await api.createTarget({
      name: `target-${randomUUID()}`,
      options: {
        kind: "Api",
        url: "https://httpbin.org/get",
        tls: { mode: "Preferred", verify: true },
        headers: {},
      },
    });
    await api.addTargetRole(target.id, role.id);

    await api.createTicket({
      target_name: target.name,
      username: user.username,
    });

    const tickets = await api.getTickets();
    const before = tickets.length;
    expect(before).toBeGreaterThan(0);

    await api.deleteTicket(tickets[0].id);
    const after = await api.getTickets();
    expect(after.length).toBe(before - 1);
  });
});
