import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";

describe("API Parameters - Get", () => {
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

  test("get parameters returns all fields", async () => {
    const api = adminClient(url);
    const params = await api.getParameters();

    expect(params).toHaveProperty("allow_own_credential_management");
    expect(params).toHaveProperty("ssh_client_auth_publickey");
    expect(params).toHaveProperty("ssh_client_auth_password");
    expect(params).toHaveProperty("ssh_client_auth_keyboard_interactive");
  });
});
