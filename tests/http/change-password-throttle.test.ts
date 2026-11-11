import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

// A hijacked session must not be able to guess the current password without
// bound through the change-password form.
describe("Change password", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("repeated wrong current passwords lock the form", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "current-pw" });
    const session = new HttpSession();
    expect((await session.post(`${url}/api/auth/login`, {
      username: user.username, password: "current-pw",
    })).status).toBe(201);

    const change = (old_password: string) => session.post(`${url}/api/profile/credentials/password`, {
      old_password, password: "next-password-1",
    });
    for (let i = 0; i < 10; i++) expect((await change("guess")).ok).toBe(false);
    expect((await change("current-pw")).ok).toBe(false);
  }, 60_000);
});
