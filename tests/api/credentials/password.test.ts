import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Credentials - Password", () => {
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

  test("create password credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "test-pass" });

    const creds = await api.getPasswordCredentials(user.id);
    expect(creds.length).toBe(1);
  });

  test("list password credentials", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pass1" });
    await api.createPasswordCredential(user.id, { password: "pass2" });

    const creds = await api.getPasswordCredentials(user.id);
    expect(creds.length).toBe(2);
  });

  test("delete password credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "test-pass" });

    const creds = await api.getPasswordCredentials(user.id);
    await api.deletePasswordCredential(user.id, creds[0].id);

    const afterDelete = await api.getPasswordCredentials(user.id);
    expect(afterDelete.length).toBe(0);
  });
});
