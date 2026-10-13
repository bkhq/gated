import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { adminClient, type AdminClient } from "../../helpers/api-client";
import { waitPort } from "../../helpers/util";
import { HttpSession } from "../../helpers/session";
import { randomUUID } from "crypto";

const ADMIN_TOKEN = "token-value";

// The admin `createTicket` helper only sets target/username, but the
// `/admin/api/tickets` endpoint also accepts `expiry` and `number_of_uses`
// (see crates/gated-admin/src/api/tickets_list.rs). Drive it directly so the
// ticket lifecycle (expiry, limited uses) can be exercised. Returns both the
// created ticket model and its plaintext secret.
async function createTicketRaw(
  url: string,
  body: {
    username: string;
    target_name: string;
    expiry?: string;
    number_of_uses?: number;
  }
): Promise<{ id: string; secret: string }> {
  const resp = await fetch(`${url}/admin/api/tickets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gated-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify(body),
    tls: { rejectUnauthorized: false },
  } as any);
  if (resp.status !== 201) {
    throw new Error(`createTicketRaw failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { ticket: { id: string }; secret: string };
  return { id: data.ticket.id, secret: data.secret };
}

// Present a ticket via the `Authorization: Gated <secret>` header to a
// connection-class API endpoint that requires authentication. GET
// /api/profile/tickets has no ticket-specific guard, so an *authorized*
// ticket yields 200 (the ticket's user is resolved) and an
// expired/exhausted/revoked/unknown ticket yields 401 (the middleware never
// establishes a session). This is the lifecycle probe for G4/G5/G6/G7.
async function probeWithHeader(url: string, secret: string): Promise<number> {
  const resp = await fetch(`${url}/api/profile/tickets`, {
    headers: { Authorization: `Gated ${secret}` },
    tls: { rejectUnauthorized: false },
  } as any);
  return resp.status;
}

// This host runs a large fleet of concurrent e2e suites that allocate listener
// ports from the same low range, so gated's own bind can lose the race
// ("Address already in use"). Retry the whole bring-up on fresh ports.
async function startWgWithRetry(processes: ProcessManager, attempts = 12): Promise<GatedProcess> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const wg = await processes.startWg();
      await waitPort(wg.httpPort, { recv: false, process: wg.process });
      return wg;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(800 + i * 400);
    }
  }
  throw new Error(`gated failed to start after ${attempts} attempts: ${lastErr}`);
}

async function setupUserAndTarget(api: AdminClient) {
  const role = await api.createRole({ name: `role-${randomUUID()}` });
  const user = await api.createUser({ username: `user-${randomUUID()}` });
  await api.createPasswordCredential(user.id, { password: "pw-123" });
  await api.addUserRole(user.id, role.id);
  const target = await api.createTarget({
    name: `tgt-${randomUUID()}`,
    options: {
      kind: "Http",
      url: "https://example.invalid/",
      tls: { mode: "Preferred", verify: false },
      upstream_auth: { kind: "None" },
      flavor: "generic",
    },
  });
  await api.addTargetRole(target.id, role.id);
  return { role, user, target };
}

describe("API Tickets - Semantics", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let api: AdminClient;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await startWgWithRetry(processes);
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
  });

  afterAll(async () => {
    await processes.stop();
  });

  // An expired ticket is rejected; a not-yet-expired one is accepted.
  test("expiry: future-dated ticket authorizes, past-dated ticket is denied", async () => {
    const { user, target } = await setupUserAndTarget(api);

    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const valid = await createTicketRaw(url, {
      username: user.username,
      target_name: target.name,
      expiry: future,
    });
    const expired = await createTicketRaw(url, {
      username: user.username,
      target_name: target.name,
      expiry: past,
    });

    expect(await probeWithHeader(url, valid.secret)).toBe(200);
    expect(await probeWithHeader(url, expired.secret)).toBe(401);
  });

  // A ticket with N uses works exactly N times, then is denied.
  test("limited-use exhaustion: N uses succeed, then denied", async () => {
    const { user, target } = await setupUserAndTarget(api);
    const N = 3;
    const { secret } = await createTicketRaw(url, {
      username: user.username,
      target_name: target.name,
      number_of_uses: N,
    });

    const statuses: number[] = [];
    for (let i = 0; i < N + 2; i++) {
      statuses.push(await probeWithHeader(url, secret));
    }

    // Exactly the first N presentations are authorized; the rest denied.
    expect(statuses.slice(0, N)).toEqual([200, 200, 200]);
    expect(statuses.slice(N)).toEqual([401, 401]);
  });

  // Many concurrent requests presenting the SAME
  // single-use ticket must NOT all succeed — the atomic conditional decrement
  // guarantees at most one consumer wins. Assert no over-use.
  test("single-use concurrency: only one of K concurrent requests succeeds", async () => {
    const { user, target } = await setupUserAndTarget(api);
    const { secret } = await createTicketRaw(url, {
      username: user.username,
      target_name: target.name,
      number_of_uses: 1,
    });

    const K = 25;
    const statuses = await Promise.all(
      Array.from({ length: K }, () => probeWithHeader(url, secret))
    );

    const authorized = statuses.filter((s) => s === 200).length;
    // No over-use: at most (and here exactly) one concurrent presentation of a
    // single-use ticket may be authorized.
    expect(authorized).toBe(1);
    expect(statuses.filter((s) => s !== 200).length).toBe(K - 1);
  });

  // Deleting (revoking) a ticket denies subsequent use.
  test("revocation: deleting a ticket denies subsequent use", async () => {
    const { user, target } = await setupUserAndTarget(api);
    const { id, secret } = await createTicketRaw(url, {
      username: user.username,
      target_name: target.name,
    });

    // Works before revocation (unlimited uses ticket).
    expect(await probeWithHeader(url, secret)).toBe(200);

    await api.deleteTicket(id);

    // Denied after revocation.
    expect(await probeWithHeader(url, secret)).toBe(401);
  });

  // A ticket-authorized request to credential-management /
  // ticket-creation endpoints must be rejected with 403 — ticket auth is
  // confined to connection/terminal routes and can never escalate to account
  // takeover.
  //
  // Models the real attack: a leaked ticket secret is used to bootstrap a
  // ticket-backed session cookie (via ?gated-ticket=), which is then replayed
  // against the self-service account endpoints. The is_ticket_auth guard must
  // turn each into a 403.
  test("ticket auth is rejected (403) on credential & ticket-mint endpoints", async () => {
    const { user, target } = await setupUserAndTarget(api);
    const { secret } = await createTicketRaw(url, {
      username: user.username,
      target_name: target.name,
    });

    // Establish the ticket-backed session: ?gated-ticket= authenticates and
    // the resulting `gated-http-session` cookie is captured for replay.
    const ticketSession = new HttpSession();
    const establish = await ticketSession.get(
      `${url}/api/profile/tickets?gated-ticket=${encodeURIComponent(secret)}`
    );
    expect(establish.status).toBe(200);

    // Change password (body must parse so the is_ticket_auth guard, not a
    // payload error, produces the rejection).
    expect(
      (await ticketSession.post(`${url}/api/profile/credentials/password`, {
        old_password: "pw-123",
        password: "x",
      })).status
    ).toBe(403);
    // Add public key
    expect(
      (await ticketSession.post(`${url}/api/profile/credentials/public-keys`, {
        label: "k",
        openssh_public_key: "ssh-ed25519 AAAA test",
      })).status
    ).toBe(403);
    // Add OTP
    expect(
      (await ticketSession.post(`${url}/api/profile/credentials/otp`, { otp: "123456" })).status
    ).toBe(403);
    // Mint a new ticket
    expect(
      (await ticketSession.post(`${url}/api/profile/tickets`, { target_name: target.name })).status
    ).toBe(403);

    // Positive control: a normal interactive session for the SAME user CAN use
    // the credential endpoint (201). This proves the 403 above is specific to
    // ticket auth, not credential management being disabled.
    const session = new HttpSession();
    const login = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pw-123",
    });
    expect(login.status).toBe(201);
    const ok = await session.post(`${url}/api/profile/credentials/public-keys`, {
      label: "k2",
      openssh_public_key: "ssh-ed25519 AAAA test2",
    });
    expect(ok.status).toBe(201);
  });
});
