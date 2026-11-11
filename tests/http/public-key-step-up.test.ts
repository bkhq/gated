import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import * as OTPAuth from "otpauth";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";

describe("Gateway HTTP - adding a public key confirms the user's identity", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  const timeout = Number(process.env.TIMEOUT || 10);
  const key = readFileSync(resolve(import.meta.dir, "../ssh-keys/id_ed25519.pub"), "utf-8").trim();

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
  });

  async function loggedInUser() {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    const session = new HttpSession();
    const login = await session.post(`${url}/api/auth/login`, { username: user.username, password: "pwd" });
    expect(login.status).toBe(201);
    return { api, user, session };
  }

  const add = (session: HttpSession, confirmation: Record<string, string>) =>
    session.post(`${url}/api/profile/credentials/public-keys`, {
      label: "laptop",
      openssh_public_key: key,
      ...confirmation,
    });

  test("a password-only user confirms with the password", async () => {
    const { session } = await loggedInUser();
    expect((await add(session, {})).status).toBe(400);
    expect((await add(session, { password: "wrong" })).status).toBe(401);
    expect((await add(session, { password: "pwd" })).status).toBe(201);
  });

  test("a user with an OTP confirms with the OTP, not the password", async () => {
    const { api, user, session } = await loggedInUser();
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ secret, digits: 6, period: 30, algorithm: "SHA1" });
    await api.createOtpCredential(user.id, { secret_key: Array.from(new Uint8Array(secret.buffer)) });

    expect((await add(session, { password: "pwd" })).status).toBe(400);
    expect((await add(session, { otp: totp.generate({ timestamp: Date.now() - 300_000 }) })).status).toBe(401);
    const otp = totp.generate();
    expect((await add(session, { otp })).status).toBe(201);
    expect((await add(session, { otp })).status).toBe(401);
  });
});
