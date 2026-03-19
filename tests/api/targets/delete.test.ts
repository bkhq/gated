import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient, ApiError } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Targets - Delete", () => {
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

  test("delete target returns 404 on subsequent get", async () => {
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

    await api.deleteTarget(target.id);

    try {
      await api.getTarget(target.id);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(404);
    }
  });
});
