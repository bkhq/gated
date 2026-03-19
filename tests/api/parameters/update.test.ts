import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";

describe("API Parameters - Update", () => {
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

  test("toggle allow_own_credential_management", async () => {
    const api = adminClient(url);
    const original = await api.getParameters();

    await api.updateParameters({
      ...original,
      allow_own_credential_management: !original.allow_own_credential_management,
    });

    const updated = await api.getParameters();
    expect(updated.allow_own_credential_management).toBe(
      !original.allow_own_credential_management
    );

    // Restore
    await api.updateParameters(original);
  });

  test("update ssh auth parameters", async () => {
    const api = adminClient(url);
    const original = await api.getParameters();

    await api.updateParameters({
      ...original,
      ssh_client_auth_publickey: false,
      ssh_client_auth_password: false,
    });

    const updated = await api.getParameters();
    expect(updated.ssh_client_auth_publickey).toBe(false);
    expect(updated.ssh_client_auth_password).toBe(false);

    // Restore
    await api.updateParameters(original);
  });
});
