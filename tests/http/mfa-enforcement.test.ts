import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, ADMIN_TOKEN, type AdminClient } from "../helpers/api-client";
import { mintApiToken } from "../helpers/http-upstream";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";
import * as OTPAuth from "otpauth";

const SETUP_HEADER = "x-gated-mfa-setup-required";

// With `mfa_required` on, a user without an OTP device can sign in to the
// web interface only to enroll one. Other protocols: ssh/mfa-enforcement.test.ts.
describe("MFA enforcement", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let api: AdminClient;

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
  });

  afterAll(async () => {
    await processes.stop();
  });

  const admin = (method: string, path: string, body?: unknown) =>
    fetch(`${url}/admin/api${path}`, {
      method,
      headers: { "X-Gated-Token": ADMIN_TOKEN, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);

  const setParameters = async (patch: Record<string, unknown>) => {
    const current = await (await admin("GET", "/parameters")).json();
    expect((await admin("PUT", "/parameters", { ...current, ...patch })).status).toBe(201);
  };

  const signIn = async (username: string, password: string) => {
    const session = new HttpSession();
    const response = await session.post(`${url}/api/auth/login`, { username, password });
    return { session, response };
  };

  test("is off by default", async () => {
    const current = await (await admin("GET", "/parameters")).json();
    expect(current.mfa_required).toBe(false);

    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    const { session, response } = await signIn(user.username, "pwd");
    expect(response.status).toBe(201);
    expect((await (await session.get(`${url}/api/info`)).json()).mfa_setup_required).toBe(false);
    expect((await session.get(`${url}/api/targets`)).status).toBe(200);
  }, 60_000);

  test("a user without OTP reaches only enrollment, then everything", async () => {
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    const token = await mintApiToken(url, user.username, "pwd");
    // Enrollment overrides the self-service switch.
    await setParameters({ mfa_required: true, allow_own_credential_management: false });

    try {
      const { session, response } = await signIn(user.username, "pwd");
      expect(response.status).toBe(201);
      expect((await (await session.get(`${url}/api/info`)).json()).mfa_setup_required).toBe(true);

      for (const path of ["/api/targets", "/api/profile/api-tokens", "/api/profile/credentials"]) {
        const refused = await session.get(`${url}${path}`);
        expect(refused.status).toBe(403);
        expect(refused.headers.get(SETUP_HEADER)).toBe("1");
      }
      const byToken = await fetch(`${url}/api/targets`, {
        headers: { "X-Gated-Token": token },
        tls: { rejectUnauthorized: false },
      } as any);
      expect(byToken.status).toBe(403);
      expect(byToken.headers.get(SETUP_HEADER)).toBe("1");
      // The admin token is not a user.
      expect((await admin("GET", "/users")).status).toBe(200);

      const begin = await session.post(`${url}/api/profile/credentials/otp/begin`, {});
      expect(begin.status).toBe(201);
      const totp = OTPAuth.URI.parse((await begin.json()).provisioning_uri) as OTPAuth.TOTP;
      expect((await session.post(`${url}/api/profile/credentials/otp`, {
        otp: totp.generate(),
      })).status).toBe(201);

      expect((await (await session.get(`${url}/api/info`)).json()).mfa_setup_required).toBe(false);
      expect((await session.get(`${url}/api/targets`)).status).toBe(200);

      // Self-service is on again; the last device still cannot be removed.
      await setParameters({ allow_own_credential_management: true });
      const state = await (await session.get(`${url}/api/profile/credentials`)).json();
      expect(state.otp.length).toBe(1);
      expect((await session.del(`${url}/api/profile/credentials/otp/${state.otp[0].id}`)).status).toBe(403);

      // A policy without OTP no longer lets the password in alone.
      await api.updateUser(user.id, {
        username: user.username,
        credential_policy: { http: ["Password"] },
      });
      const again = await signIn(user.username, "pwd");
      expect(again.response.status).toBe(401);
      expect((await again.response.json()).state).toBe("OtpNeeded");
    } finally {
      await setParameters({ mfa_required: false, allow_own_credential_management: true });
    }
  }, 60_000);
});
