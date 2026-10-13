// API-level assertions for the self-service authentication contract:
//
//   Password change  POST /api/profile/credentials/password requires the
//                    caller's CURRENT password (a live session is not enough);
//                    a wrong/absent old password is rejected, and OTHER live
//                    sessions are revoked.
//   OTP enrollment   POST /otp/begin mints the secret server-side and returns
//                    only a provisioning URI; POST /otp persists the
//                    credential only when a live TOTP code proves possession.
//                    A client cannot plant its own secret without proof.
//
// Run: GATED_BINARY=.../gated bun test api/authn-contract.test.ts --timeout 300000
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { HttpSession } from "../helpers/session";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";
import * as OTPAuth from "otpauth";

describe("AUTHN contract (at the API level)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let api: AdminClient;
  const timeout = Number(process.env.TIMEOUT || 60);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);

    // Self-service credential endpoints are gated behind this parameter
    // (`parameters_based_auth`). Make sure it is on so a 403 below means the
    // contract rejected the request, not that the feature was disabled.
    const params = await api.getParameters();
    if (!params.allow_own_credential_management) {
      await api.updateParameters({ ...params, allow_own_credential_management: true });
    }
  });

  afterAll(async () => {
    await processes.stop();
  });

  // Create a fresh user with a password credential and return a logged-in,
  // cookie-persistent session for it.
  async function makeUserAndLogin(password: string): Promise<{
    username: string;
    userId: string;
    session: HttpSession;
  }> {
    const username = `user-${randomUUID()}`;
    const user = await api.createUser({ username });
    await api.createPasswordCredential(user.id, { password });
    const session = await login(username, password);
    return { username, userId: user.id, session };
  }

  async function login(username: string, password: string): Promise<HttpSession> {
    const session = new HttpSession();
    const resp = await session.post(`${url}/api/auth/login`, { username, password });
    if (resp.status >= 400) {
      throw new Error(`login(${username}) failed: ${resp.status} ${await resp.text()}`);
    }
    return session;
  }

  async function whoami(session: HttpSession): Promise<string | null> {
    const resp = await session.get(`${url}/api/info`);
    const info = (await resp.json()) as { username: string | null };
    return info.username;
  }

  // Session revocation is delivered asynchronously (the handle Close command is
  // processed off-thread). Poll until the session goes unauthenticated, up to a
  // bounded deadline, so a pass is not a race and a genuine gap is not masked by
  // checking too early.
  async function waitUnauthenticated(session: HttpSession, timeoutMs = 8000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let last: string | null = null;
    while (Date.now() < deadline) {
      last = await whoami(session);
      if (last === null) return null;
      await Bun.sleep(250);
    }
    return last;
  }

  // ----------------------------------------------------------------------- //
  // Change-my-password requires the current password
  // ----------------------------------------------------------------------- //

  describe("password change requires old password", () => {
    test("a logged-in session alone cannot change the password (wrong old password -> 401)", async () => {
      const { session } = await makeUserAndLogin("OldPass1");

      const resp = await session.post(`${url}/api/profile/credentials/password`, {
        old_password: "not-the-old-password",
        password: "NewPass2",
      });

      expect(resp.status).toBe(401);
    });

    test("an absent old password is rejected (not accepted as a change)", async () => {
      const { username, session } = await makeUserAndLogin("OldPass1");

      // Omit `old_password` entirely. The required field makes this a bad
      // request; it must NOT succeed.
      const resp = await session.post(`${url}/api/profile/credentials/password`, {
        password: "NewPass2",
      });
      expect(resp.status).not.toBe(201);
      expect(resp.status).toBeGreaterThanOrEqual(400);

      // The old password must still work; the new one must not.
      await login(username, "OldPass1");
      await expect(login(username, "NewPass2")).rejects.toThrow();
    });

    test("the correct old password rotates the password (old stops working, new works)", async () => {
      const { username, session } = await makeUserAndLogin("OldPass1");

      const resp = await session.post(`${url}/api/profile/credentials/password`, {
        old_password: "OldPass1",
        password: "NewPass2",
      });
      expect(resp.status).toBe(201);

      await expect(login(username, "OldPass1")).rejects.toThrow();
      await login(username, "NewPass2"); // throws if it fails
    });

    // A password change must invalidate every OTHER live session for the
    // user. Closing a session's handle cannot drop its HTTP session on its
    // own (the Close task never learns the poem session id of the login
    // request that created the handle), so SessionStore::process_request purges a cookie whose
    // server-side handle is gone.
    test("password change evicts OTHER live sessions", async () => {
      const { username } = await makeUserAndLogin("OldPass1");

      // Two independent sessions for the same user.
      const sessionA = await login(username, "OldPass1");
      const sessionB = await login(username, "OldPass1");
      expect(await whoami(sessionA)).toBe(username);
      expect(await whoami(sessionB)).toBe(username);

      // Change the password from A.
      const resp = await sessionA.post(`${url}/api/profile/credentials/password`, {
        old_password: "OldPass1",
        password: "NewPass2",
      });
      expect(resp.status).toBe(201);

      // A (the caller) stays authenticated; B is revoked.
      expect(await whoami(sessionA)).toBe(username);
      expect(await waitUnauthenticated(sessionB)).toBeNull();
    });
  });

  // ----------------------------------------------------------------------- //
  // OTP self-enrollment is server-secret + live-code confirm
  // ----------------------------------------------------------------------- //

  describe("OTP self-enroll is server-generated-secret + live-code confirm", () => {
    // Pull the server-generated secret out of the provisioning URI returned by
    // /otp/begin and build a TOTP generator for it.
    function totpFromProvisioningUri(uri: string): OTPAuth.TOTP {
      const parsed = OTPAuth.URI.parse(uri);
      if (!(parsed instanceof OTPAuth.TOTP)) {
        throw new Error("provisioning URI is not a TOTP otpauth URI");
      }
      return parsed;
    }

    test("begin mints a server-side secret and returns only a provisioning URI", async () => {
      const { session } = await makeUserAndLogin("Pass1234");

      const resp = await session.post(`${url}/api/profile/credentials/otp/begin`, {});
      expect(resp.status).toBe(201);
      const body = (await resp.json()) as { provisioning_uri: string; secret_key?: unknown };

      // The raw secret is never handed back to the client.
      expect(body.secret_key).toBeUndefined();
      expect(body.provisioning_uri.startsWith("otpauth://totp/")).toBe(true);
      // The URI must carry a server-chosen secret the client never supplied.
      expect(totpFromProvisioningUri(body.provisioning_uri).secret.base32.length).toBeGreaterThan(0);
    });

    test("a live code for the server secret completes enrollment (201) and persists the credential", async () => {
      const { userId, session } = await makeUserAndLogin("Pass1234");

      const begin = await session.post(`${url}/api/profile/credentials/otp/begin`, {});
      expect(begin.status).toBe(201);
      const { provisioning_uri } = (await begin.json()) as { provisioning_uri: string };
      const totp = totpFromProvisioningUri(provisioning_uri);

      const confirm = await session.post(`${url}/api/profile/credentials/otp`, {
        otp: totp.generate(),
      });
      expect(confirm.status).toBe(201);

      // The credential is now persisted for the user.
      const creds = await api.getOtpCredentials(userId);
      expect(creds.length).toBe(1);
    });

    test("confirm without a prior begin is rejected (403) — no enrollment to prove", async () => {
      const { userId, session } = await makeUserAndLogin("Pass1234");

      const totp = new OTPAuth.TOTP({ digits: 6, period: 30 });
      const resp = await session.post(`${url}/api/profile/credentials/otp`, {
        otp: totp.generate(),
      });

      expect(resp.status).toBe(403);
      expect((await api.getOtpCredentials(userId)).length).toBe(0);
    });

    test("confirm with a wrong code after begin is rejected (403)", async () => {
      const { userId, session } = await makeUserAndLogin("Pass1234");

      const begin = await session.post(`${url}/api/profile/credentials/otp/begin`, {});
      expect(begin.status).toBe(201);

      const resp = await session.post(`${url}/api/profile/credentials/otp`, {
        otp: "000000",
      });
      expect(resp.status).toBe(403);
      expect((await api.getOtpCredentials(userId)).length).toBe(0);
    });

    test("planting a client-supplied secret without proof does NOT enroll OTP", async () => {
      const { userId, session } = await makeUserAndLogin("Pass1234");

      // POST the credential with a client-chosen secret and no live-code
      // proof. The confirm endpoint reads only `otp`; a body
      // carrying a planted `secret_key` (and no valid otp) must not enroll.
      const planted = Array.from({ length: 32 }, (_, i) => i);
      const resp = await session.post(`${url}/api/profile/credentials/otp`, {
        secret_key: planted,
      });

      expect(resp.status).not.toBe(201);
      expect((await api.getOtpCredentials(userId)).length).toBe(0);
    });
  });
});
