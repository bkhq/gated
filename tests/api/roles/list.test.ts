import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Roles - List", () => {
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

  test("list all roles", async () => {
    const api = adminClient(url);
    const name = `role-list-${randomUUID()}`;
    await api.createRole({ name });

    const roles = await api.getRoles();
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.some((r) => r.name === name)).toBe(true);
  });

  test("search roles by name", async () => {
    const api = adminClient(url);
    const unique = randomUUID().slice(0, 8);
    const name = `searchable-${unique}`;
    await api.createRole({ name });

    const results = await api.getRoles(unique);
    expect(results.length).toBe(1);
    expect(results[0].name).toBe(name);
  });
});
