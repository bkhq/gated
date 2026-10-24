import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

const TESTS_DIR = resolve(import.meta.dir, "../..");

describe("API Credentials - Public Key", () => {
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

  test("create public key credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    const pubkey = readFileSync(
      resolve(TESTS_DIR, "ssh-keys/id_ed25519.pub"),
      "utf-8"
    ).trim();

    await api.createPublicKeyCredential(user.id, {
      label: "Test Key",
      openssh_public_key: pubkey,
    });

    const creds = await api.getPublicKeyCredentials(user.id);
    expect(creds.length).toBe(1);
  });

  test("delete public key credential", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    const pubkey = readFileSync(
      resolve(TESTS_DIR, "ssh-keys/id_ed25519.pub"),
      "utf-8"
    ).trim();

    await api.createPublicKeyCredential(user.id, {
      label: "Test Key",
      openssh_public_key: pubkey,
    });

    const creds = await api.getPublicKeyCredentials(user.id);
    await api.deletePublicKeyCredential(user.id, creds[0].id);

    const afterDelete = await api.getPublicKeyCredentials(user.id);
    expect(afterDelete.length).toBe(0);
  });
});
