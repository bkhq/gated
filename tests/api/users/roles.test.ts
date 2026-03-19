import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Users - Role Association", () => {
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

  test("add and remove user role", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    const role = await api.createRole({ name: `role-${randomUUID()}` });

    await api.addUserRole(user.id, role.id);
    const roles = await api.getUserRoles(user.id);
    expect(roles.some((r) => r.id === role.id)).toBe(true);

    await api.removeUserRole(user.id, role.id);
    const rolesAfter = await api.getUserRoles(user.id);
    expect(rolesAfter.some((r) => r.id === role.id)).toBe(false);
  });
});
