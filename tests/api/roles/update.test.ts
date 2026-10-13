import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Roles - Update", () => {
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

  test("update role name", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const newName = `updated-${randomUUID()}`;

    const updated = await api.updateRole(role.id, { name: newName });
    expect(updated.name).toBe(newName);

    const fetched = await api.getRole(role.id);
    expect(fetched.name).toBe(newName);
  });
});
