import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { waitPort } from "../../helpers/util";

describe("API Auth - Unauthorized", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("all endpoints return 401 without auth", async () => {
    const url = `https://localhost:${wg.httpPort}`;
    const noAuthFetch = async (path: string) => {
      const resp = await fetch(`${url}/@gated/admin/api${path}`, {
        tls: { rejectUnauthorized: false },
      } as any);
      return resp.status;
    };

    expect(await noAuthFetch("/parameters")).toBe(401);
    expect(await noAuthFetch("/roles/1")).toBe(401);
    expect(await noAuthFetch("/roles")).toBe(401);
    expect(await noAuthFetch("/users/1")).toBe(401);
    expect(await noAuthFetch("/users")).toBe(401);
    expect(await noAuthFetch("/targets/1")).toBe(401);
    expect(await noAuthFetch("/targets")).toBe(401);
    expect(await noAuthFetch("/sessions/1")).toBe(401);
    expect(await noAuthFetch("/sessions")).toBe(401);
  });
});
