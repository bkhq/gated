import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID, generateKeyPairSync } from "crypto";

describe("API Credentials - Certificate", () => {
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

  test("issue certificate credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });

    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const issued = await api.issueCertificateCredential(user.id, {
      label: "Test Cert",
      public_key_pem: pubPem,
    });
    expect(issued.certificate_pem).toContain("BEGIN CERTIFICATE");

    const creds = await api.getCertificateCredentials(user.id);
    expect(creds.length).toBe(1);
  });

  test("delete certificate credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });

    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    await api.issueCertificateCredential(user.id, {
      label: "Test Cert",
      public_key_pem: pubPem,
    });

    const creds = await api.getCertificateCredentials(user.id);
    await api.deleteCertificateCredential(user.id, creds[0].id);

    const afterDelete = await api.getCertificateCredentials(user.id);
    expect(afterDelete.length).toBe(0);
  });
});
