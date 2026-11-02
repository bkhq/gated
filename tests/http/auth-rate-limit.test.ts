import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

// The unauthenticated /api/auth/login and /api/auth/otp
// endpoints share a governor token-bucket limiter keyed on (username, client
// IP). The bucket allows a burst of LOGIN_MAX_ATTEMPTS_PER_MIN (=10) credential
// attempts and then returns HTTP 429 until it refills. These tests assert the
// 429 threshold, that the limiter is per-username (a different identity from
// the same IP is unaffected), and that the OTP endpoint shares the same bucket.
const LOGIN_MAX_ATTEMPTS_PER_MIN = 10;

// The shared allocPort starts at a fixed low base, so on a host running other
// gated suites concurrently a port can already be taken. Retry startup; each
// attempt draws fresh (higher) ports and dodges the collision.
async function startWgReady(processes: ProcessManager): Promise<GatedProcess> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wg = await processes.startWg();
    try {
      await waitPort(wg.httpPort, { recv: false, process: wg.process, timeout: 20000 });
      return wg;
    } catch (e) {
      lastErr = e;
      try { wg.process.kill("SIGKILL"); } catch {}
      await wg.process.exited.catch(() => {});
    }
  }
  throw lastErr;
}

describe("Gateway HTTP - login/OTP rate limit", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await startWgReady(processes);
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
  });

  async function login(username: string, password: string): Promise<Response> {
    return fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      tls: { rejectUnauthorized: false },
    } as any);
  }

  test("repeated failed password logins for one username eventually return 429", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `rl-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "correct-pw" });

    // Drive more than one burst worth of bad-password attempts back to back.
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS_PER_MIN + 4; i++) {
      const r = await login(user.username, "wrong-pw");
      statuses.push(r.status);
    }

    // The very first attempt is a normal credential rejection (401), never a
    // pre-emptive 429 — the limiter must allow a legitimate burst through.
    expect(statuses[0]).toBe(401);

    // The limiter must trip within the window we drove.
    expect(statuses).toContain(429);

    // A burst is allowed before the first block (not throttled immediately).
    const firstBlocked = statuses.indexOf(429);
    expect(firstBlocked).toBeGreaterThanOrEqual(LOGIN_MAX_ATTEMPTS_PER_MIN - 1);

    // Once tripped, the bucket stays empty for the rest of this rapid burst.
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  test("a different username from the same IP is not blocked (per-username key)", async () => {
    const api = adminClient(url);
    // The previous test exhausted one username's bucket from this same client
    // IP (127.0.0.1). A fresh username must have its own, untouched bucket.
    const user = await api.createUser({ username: `rl-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "correct-pw" });

    const r = await login(user.username, "wrong-pw");
    // Wrong credentials → 401, NOT 429: the limiter did not bleed across
    // usernames.
    expect(r.status).toBe(401);
  });

  test("the OTP endpoint shares the same per-username/IP bucket (429)", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `rl-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "correct-pw" });
    // Minimal valid OTP secret — the code we submit is always wrong, so the
    // OTP is never actually verified; we only need the credential to exist so
    // the policy puts the login into the OTP step.
    await api.createOtpCredential(user.id, {
      secret_key: Array.from(new TextEncoder().encode("0123456789abcdef0123")),
    });
    await api.updateUser(user.id, {
      username: user.username,
      credential_policy: { http: ["Password", "Totp"] },
    });

    const session = new HttpSession();
    // Correct password advances the state machine to "OTP needed" and consumes
    // one token from the shared bucket.
    const passwordResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "correct-pw",
    });
    expect(passwordResp.status).toBe(401);
    expect(((await passwordResp.json()) as { state?: string }).state).toBe("OtpNeeded");

    // Hammer the OTP endpoint with bad codes; it draws from the same bucket as
    // the password login, so it trips 429 within the window.
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS_PER_MIN + 4; i++) {
      const r = await session.post(`${url}/api/auth/otp`, { otp: "000000" });
      statuses.push(r.status);
    }

    expect(statuses).toContain(429);
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});
