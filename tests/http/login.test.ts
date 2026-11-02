import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

describe("Gateway HTTP - /api/auth/login", () => {
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

  test("correct password → 201 Success and cookie grants /api/info with username", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd-ok" });

    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd-ok",
    });
    expect(loginResp.status).toBe(201);

    // After cookie auth, /api/info must reflect the authenticated user.
    const infoResp = await session.get(`${url}/api/info`);
    expect(infoResp.status).toBe(200);
    const info = (await infoResp.json()) as { username?: string; version?: string };
    expect(info.username).toBe(user.username);
    // `version` is only populated once the request is authorized, so it
    // doubles as a cheap "cookie auth is live" assertion.
    expect(info.version).toBeTruthy();
  });

  test("wrong password → 401 with state=Failed, no auth cookie granted", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd-right" });

    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd-wrong",
    });
    // `LoginResponse::Failure` is `#[oai(status = 401)]`; rejected +
    // interstitial states both come back as 401.
    expect(loginResp.status).toBe(401);
    const body = (await loginResp.json()) as { state?: string };
    // With just a password policy, invalid creds leave the state machine
    // in Need(Password) — not the hard-Failed branch. Either outcome
    // means "login did not complete"; the handler picks Need when at
    // least one credential type is still in play.
    expect(["PasswordNeeded", "Failed"]).toContain(body.state);

    // Subsequent /api/info must behave as anonymous — no version leak.
    const infoResp = await session.get(`${url}/api/info`);
    const info = (await infoResp.json()) as { username?: string; version?: string };
    expect(info.username).toBeFalsy();
    expect(info.version).toBeFalsy();
  });

  test("unknown username → state=Failed (handler must not leak existence)", async () => {
    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: `ghost-${randomUUID()}`,
      password: "whatever",
    });
    expect(loginResp.status).toBe(401);
    const body = (await loginResp.json()) as { state?: string };
    // The `UserNotFound` branch short-circuits before the state machine
    // runs — see `api_auth_login` in `gated-protocol-http/src/api/auth.rs`.
    expect(body.state).toBe("Failed");
  });

  test("policy requires OTP → password login returns state=OtpNeeded", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    // Minimal valid OTP secret — policy check doesn't execute the OTP,
    // so any well-formed bytes suffice.
    await api.createOtpCredential(user.id, {
      secret_key: Array.from(new TextEncoder().encode("0123456789abcdef0123")),
    });
    await api.updateUser(user.id, {
      username: user.username,
      credential_policy: { http: ["Password", "Totp"] },
    });

    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd",
    });
    // `Need(...)` interstitial also rides the 401 Failure variant;
    // only the `state` field distinguishes "rejected" from "need more".
    expect(loginResp.status).toBe(401);
    const body = (await loginResp.json()) as { state?: string };
    expect(body.state).toBe("OtpNeeded");
  });
});
