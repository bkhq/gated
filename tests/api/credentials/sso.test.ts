import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Credentials - SSO", () => {
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

  test("create SSO credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });

    await api.createSsoCredential(user.id, {
      email: `test-${randomUUID()}@example.com`,
      provider: "test-provider",
    });

    const creds = await api.getSsoCredentials(user.id);
    expect(creds.length).toBe(1);
  });

  test("delete SSO credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });

    await api.createSsoCredential(user.id, {
      email: `test-${randomUUID()}@example.com`,
      provider: "test-provider",
    });

    const creds = await api.getSsoCredentials(user.id);
    await api.deleteSsoCredential(user.id, creds[0].id);

    const afterDelete = await api.getSsoCredentials(user.id);
    expect(afterDelete.length).toBe(0);
  });
});
