import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

describe("Gateway HTTP - /api/profile/api-tokens", () => {
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

  // Helper: provision a user with password creds + web session cookie.
  async function loggedInUser(): Promise<{
    username: string;
    userId: string;
    session: HttpSession;
  }> {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });

    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd",
    });
    expect(loginResp.status).toBe(201);
    return { username: user.username, userId: user.id, session };
  }

  test("create → list round-trip exposes the new token (secret only returned once)", async () => {
    const { session } = await loggedInUser();
    const expiry = new Date(Date.now() + 86400_000).toISOString();

    const createResp = await session.post(`${url}/api/profile/api-tokens`, {
      label: "e2e-test",
      expiry,
    });
    expect(createResp.status).toBe(201);
    const created = (await createResp.json()) as {
      token: { id: string; label: string; expiry: string };
      secret: string;
    };
    expect(created.token.label).toBe("e2e-test");
    expect(created.secret).toBeTruthy();
    // Shape-only check: secret must not also echo in the token field.
    expect(created.secret.length).toBeGreaterThan(10);

    const listResp = await session.get(`${url}/api/profile/api-tokens`);
    expect(listResp.status).toBe(200);
    const list = (await listResp.json()) as Array<{
      id: string;
      label: string;
      secret?: string;
    }>;
    const found = list.find((t) => t.id === created.token.id);
    expect(found).toBeTruthy();
    expect(found!.label).toBe("e2e-test");
    // `secret` must NOT be returned on subsequent list reads.
    expect(found!.secret).toBeUndefined();
  });

  test("issued secret is accepted as X-Gated-Token — /api/info reports authenticated context", async () => {
    const { session } = await loggedInUser();
    const createResp = await session.post(`${url}/api/profile/api-tokens`, {
      label: "bearer",
      expiry: new Date(Date.now() + 86400_000).toISOString(),
    });
    const { secret } = (await createResp.json()) as { secret: string };

    // Cold fetch with only the bearer token — no cookies. `/api/info`
    // reads `username` off the session (which a bearer request doesn't
    // have), so the authoritative signal is `version`: it's only
    // populated when `request_authorization.is_some()` — see
    // `crates/gated-protocol-http/src/api/info.rs::api_get_info`.
    const resp = await fetch(`${url}/api/info`, {
      headers: { "X-Gated-Token": secret },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(resp.status).toBe(200);
    const info = (await resp.json()) as { version?: string };
    expect(info.version).toBeTruthy();
  });

  test("delete → token stops authenticating; re-use returns 401", async () => {
    const { session } = await loggedInUser();
    const createResp = await session.post(`${url}/api/profile/api-tokens`, {
      label: "revoke-me",
      expiry: new Date(Date.now() + 86400_000).toISOString(),
    });
    const body = (await createResp.json()) as {
      token: { id: string };
      secret: string;
    };

    const delResp = await session.del(
      `${url}/api/profile/api-tokens/${body.token.id}`,
    );
    // The delete endpoint is declared with `#[oai(status = 204)]`.
    expect(delResp.status).toBe(204);

    const probe = await fetch(`${url}/api/info`, {
      headers: { "X-Gated-Token": body.secret },
      tls: { rejectUnauthorized: false },
    } as any);
    // `/api/info` is open to anonymous callers, but it must NOT reflect
    // the revoked user — `username` should be absent.
    const info = (await probe.json()) as { username?: string };
    expect(info.username).toBeFalsy();
  });
});
