import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";
import { OTP_KEY_BASE64 } from "../../helpers/gated-helpers";

describe("API Credentials - OTP", () => {
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

  test("create OTP credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    const keyBytes = Array.from(Buffer.from(OTP_KEY_BASE64, "base64"));

    await api.createOtpCredential(user.id, { secret_key: keyBytes });

    const creds = await api.getOtpCredentials(user.id);
    expect(creds.length).toBe(1);
  });

  test("delete OTP credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    const keyBytes = Array.from(Buffer.from(OTP_KEY_BASE64, "base64"));

    await api.createOtpCredential(user.id, { secret_key: keyBytes });

    const creds = await api.getOtpCredentials(user.id);
    await api.deleteOtpCredential(user.id, creds[0].id);

    const afterDelete = await api.getOtpCredentials(user.id);
    expect(afterDelete.length).toBe(0);
  });
});
