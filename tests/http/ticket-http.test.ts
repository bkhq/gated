import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

// Ticket auth for HTTP targets and the `?gated-ticket=` URL param. Ticket auth is an
// API-plane mechanism: the `TicketMiddleware`
// (crates/gated-admin/.../middleware/ticket.rs) accepts a ticket on management
// `/api` routes via either the `?gated-ticket=<secret>` query param or an
// `Authorization: Gated <secret>` header, resolves it to its bound target, and
// establishes a ticket-scoped session. (The dedicated HTTP-proxy upstream
// listener authenticates via Bearer/api-token/mTLS, not tickets.)
//
// GET /api/profile/tickets requires authentication and has no ticket-specific
// guard, so a 200 proves the ticket authenticated, and an unauthenticated 401
// is the control.
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

describe("HTTP Ticket Auth (HTTP / ?gated-ticket=)", () => {
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

  async function setupHttpTargetAndTicket() {
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    const target = await api.createTarget({
      name: `http-${randomUUID()}`,
      options: {
        kind: "Http",
        url: "https://example.invalid/",
        tls: { mode: "Preferred", verify: false },
        upstream_auth: { kind: "None" },
        flavor: "generic",
      },
    });
    await api.addTargetRole(target.id, role.id);

    // Unlimited-use ticket so repeated probes don't exhaust it.
    const ticket = await api.createTicket({
      target_name: target.name,
      username: user.username,
    });
    return { user, target, ticket };
  }

  test("?gated-ticket= query param authenticates an HTTP-target ticket at the API level", async () => {
    const { target, ticket } = await setupHttpTargetAndTicket();

    // Control: no credential => 401.
    const anon = await fetch(`${url}/api/profile/tickets`, {
      tls: { rejectUnauthorized: false },
    } as any);
    expect(anon.status).toBe(401);

    // ?gated-ticket=<secret> in the URL authenticates the request.
    const viaQuery = await fetch(
      `${url}/api/profile/tickets?gated-ticket=${encodeURIComponent(ticket.secret)}`,
      { tls: { rejectUnauthorized: false } } as any
    );
    expect(viaQuery.status).toBe(200);

    // The same ticket also authenticates via the Authorization header form.
    const viaHeader = await fetch(`${url}/api/profile/tickets`, {
      headers: { Authorization: `Gated ${ticket.secret}` },
      tls: { rejectUnauthorized: false },
    } as any);
    expect(viaHeader.status).toBe(200);

    // The authenticating ticket is bound to the HTTP/Api
    // target created above.
    const tickets = (await api.getTickets()) as Array<{ target: string }>;
    expect(tickets.some((t) => t.target === target.name)).toBe(true);
  });
});
