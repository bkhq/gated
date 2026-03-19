import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { HttpSession } from "../../helpers/session";
import { randomUUID } from "crypto";

describe("API Auth - Cookie Auth", () => {
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

  test("cookie auth grants access to admin API", async () => {
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    const roles = await api.getRoles("gated:admin");
    await api.addUserRole(user.id, roles[0].id);

    const session = new HttpSession();
    const loginResp = await session.post(`${url}/@gated/api/auth/login`, {
      username: user.username,
      password: "123",
    });
    expect(loginResp.status).toBe(201);

    const sessionsResp = await session.get(`${url}/@gated/admin/api/sessions`);
    expect(sessionsResp.status).toBe(200);
  });
});
