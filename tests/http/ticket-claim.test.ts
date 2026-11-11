import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { HttpSession } from "../helpers/session";
import { waitPort } from "../helpers/util";
import { sshPublicKeyAuth } from "../helpers/gated-helpers";
import { randomUUID } from "crypto";

// The recipient's link is `/ui/ticket#<secret>`: the browser posts the
// secret here, so only this call consumes a use. `?gated-ticket=` consumed
// one on any GET, which let a chat app's link preview use up a single-use
// ticket before the recipient clicked it.
describe("Ticket claim (POST /api/tickets/claim)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let api: AdminClient;
  let username: string;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    api = adminClient(url);
    username = `claim-${randomUUID().slice(0, 8)}`;
    const user = await api.createUser({ username });
    const role = await api.createRole({ name: `claim-${randomUUID().slice(0, 8)}` });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: "claim-ssh",
      options: { kind: "Ssh", host: "127.0.0.1", port: 1, username: "root", auth: sshPublicKeyAuth() },
    });
    await api.addTargetRole(target.id, role.id);
  });

  afterAll(async () => {
    await processes.stop();
  });

  async function singleUseTicket(): Promise<{ id: string; secret: string }> {
    const created = await api.request("POST", "/tickets", { target_name: "claim-ssh", username, number_of_uses: 1 });
    return { id: created.ticket.id, secret: created.secret };
  }

  async function usesLeft(id: string): Promise<number | null> {
    const tickets: any[] = await api.request("GET", "/tickets");
    return tickets.find(t => t.id === id)?.uses_left ?? null;
  }

  test("signs the session in, names the target and consumes one use", async () => {
    const ticket = await singleUseTicket();
    const session = new HttpSession();
    const claimed = await session.post(`${url}/api/tickets/claim`, { secret: ticket.secret });
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({ target_name: "claim-ssh", kind: "Ssh" });

    const info = await session.get(`${url}/api/info`);
    expect(await info.json()).toMatchObject({ username, authorized_via_ticket: true });
    const targets = await session.get(`${url}/api/targets`);
    expect((await targets.json()).map((t: any) => t.name)).toEqual(["claim-ssh"]);
    expect(await usesLeft(ticket.id)).toBe(0);

    // Used up: a second claim is refused and leaves the session alone.
    const again = new HttpSession();
    const refused = await again.post(`${url}/api/tickets/claim`, { secret: ticket.secret });
    expect(refused.status).toBe(404);
    expect((await (await again.get(`${url}/api/info`)).json()).username).toBeNull();
  });

  test("an unknown secret is refused without touching the session", async () => {
    const session = new HttpSession();
    const refused = await session.post(`${url}/api/tickets/claim`, { secret: randomUUID() });
    expect(refused.status).toBe(404);
    expect((await (await session.get(`${url}/api/info`)).json()).username).toBeNull();
  });

  // Last: the limiter is keyed by client address and would throttle the
  // tests above.
  test("guessing is rate limited", async () => {
    const session = new HttpSession();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await session.post(`${url}/api/tickets/claim`, { secret: `guess-${i}` })).status);
    }
    expect(statuses).toContain(429);
  });
});
