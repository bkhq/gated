import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Targets - Update", () => {
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

  test("update target name and options", async () => {
    const api = adminClient(url);
    const target = await api.createTarget({
      name: `target-${randomUUID()}`,
      options: {
        kind: "Api",
        url: "https://httpbin.org/get",
        tls: { mode: "Preferred", verify: true },
        headers: {},
      },
    });

    const newName = `updated-${randomUUID()}`;
    const updated = await api.updateTarget(target.id, {
      name: newName,
      options: {
        kind: "Api",
        url: "https://httpbin.org/get",
        tls: { mode: "Preferred", verify: true },
        headers: {},
      },
    });
    expect(updated.name).toBe(newName);

    const fetched = await api.getTarget(target.id);
    expect(fetched.name).toBe(newName);
  });
});
