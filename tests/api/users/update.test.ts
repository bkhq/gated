import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

describe("API Users - Update", () => {
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

  test("update username", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    const newUsername = `updated-${randomUUID()}`;

    const updated = await api.updateUser(user.id, { username: newUsername });
    expect(updated.username).toBe(newUsername);

    const fetched = await api.getUser(user.id);
    expect(fetched.username).toBe(newUsername);
  });

  test("update credential policy", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });

    const updated = await api.updateUser(user.id, {
      username: user.username,
      credential_policy: {
        http: ["Password"],
        ssh: ["PublicKey"],
      },
    });
    expect(updated.id).toBe(user.id);
  });
});
