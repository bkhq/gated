import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

const ADMIN_TOKEN = "token-value";

function sshOpts() {
  return {
    kind: "Ssh",
    host: "example.invalid",
    port: 22,
    username: "root",
    auth: { kind: "PublicKey" },
  };
}

// Raw admin call for endpoints the shared AdminClient doesn't cover (creating a
// target with a group_id). Does not mutate any shared helper file.
async function adminReq(baseUrl: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/admin/api${path}`, {
    method,
    headers: {
      "X-Gated-Token": ADMIN_TOKEN,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    tls: { rejectUnauthorized: false },
  } as any);
  if (!res.ok) throw new Error(`admin ${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// gated binds its listeners on deterministic ports; across back-to-back runs a
// port can still be in TIME_WAIT from a just-killed instance, making the next
// gated abort at startup ("Address already in use"). Retry until it comes up —
// startWg hands out fresh, higher ports on each call.
async function startWgReady(processes: ProcessManager): Promise<GatedProcess> {
  for (let attempt = 0; ; attempt++) {
    const wg = await processes.startWg();
    try {
      await waitPort(wg.httpPort, { recv: false, process: wg.process });
      await waitPort(wg.sshPort, { process: wg.process });
      await waitPort(wg.mysqlPort, { recv: false, process: wg.process });
      await waitPort(wg.postgresPort, { recv: false, process: wg.process });
      await waitPort(wg.kubernetesPort, { recv: false, process: wg.process });
      return wg;
    } catch (e) {
      try { wg.process.kill("SIGINT"); } catch {}
      await wg.process.exited.catch(() => {});
      if (attempt >= 7) throw e;
      await Bun.sleep(500);
    }
  }
}

async function makeUser(api: AdminClient, roleIds: string[]) {
  const user = await api.createUser({ username: `user-${randomUUID()}` });
  await api.createPasswordCredential(user.id, { password: "pwd" });
  for (const r of roleIds) await api.addUserRole(user.id, r);
  return user;
}

// The gateway /api/targets endpoint, scoped to a single user's session, is the
// canonical RBAC view: it returns exactly the targets that user is authorized
// for (config_provider.authorize_target per row).
async function listTargetsAs(
  url: string,
  username: string,
  password: string
): Promise<Array<{ name: string; group?: { name: string } | null }>> {
  const session = new HttpSession();
  const login = await session.post(`${url}/api/auth/login`, { username, password });
  expect(login.status).toBe(201);
  const resp = await session.get(`${url}/api/targets`);
  expect(resp.status).toBe(200);
  return (await resp.json()) as Array<{ name: string; group?: { name: string } | null }>;
}

describe("RBAC authorization matrix", () => {
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

  test("multi-user isolation — each user sees only their own grants", async () => {
    const api = adminClient(url);
    const roleA = await api.createRole({ name: `role-a-${randomUUID()}` });
    const roleB = await api.createRole({ name: `role-b-${randomUUID()}` });

    const targetX = await api.createTarget({ name: `tgt-x-${randomUUID()}`, options: sshOpts() });
    const targetY = await api.createTarget({ name: `tgt-y-${randomUUID()}`, options: sshOpts() });
    await api.addTargetRole(targetX.id, roleA.id);
    await api.addTargetRole(targetY.id, roleB.id);

    const userA = await makeUser(api, [roleA.id]);
    const userB = await makeUser(api, [roleB.id]);

    const aNames = (await listTargetsAs(url, userA.username, "pwd")).map((t) => t.name);
    expect(aNames).toContain(targetX.name);
    expect(aNames).not.toContain(targetY.name);

    const bNames = (await listTargetsAs(url, userB.username, "pwd")).map((t) => t.name);
    expect(bNames).toContain(targetY.name);
    expect(bNames).not.toContain(targetX.name);
  });

  test("multi-role union — a user with two roles gets the union of grants", async () => {
    const api = adminClient(url);
    const role1 = await api.createRole({ name: `role-1-${randomUUID()}` });
    const role2 = await api.createRole({ name: `role-2-${randomUUID()}` });

    const t1 = await api.createTarget({ name: `tgt-1-${randomUUID()}`, options: sshOpts() });
    const t2 = await api.createTarget({ name: `tgt-2-${randomUUID()}`, options: sshOpts() });
    await api.addTargetRole(t1.id, role1.id);
    await api.addTargetRole(t2.id, role2.id);

    const both = await makeUser(api, [role1.id, role2.id]);
    const only1 = await makeUser(api, [role1.id]);

    const bothNames = (await listTargetsAs(url, both.username, "pwd")).map((t) => t.name);
    expect(bothNames).toContain(t1.name);
    expect(bothNames).toContain(t2.name);

    const only1Names = (await listTargetsAs(url, only1.username, "pwd")).map((t) => t.name);
    expect(only1Names).toContain(t1.name);
    expect(only1Names).not.toContain(t2.name);
  });

  test("removing the target<->role binding removes visibility", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const target = await api.createTarget({ name: `tgt-${randomUUID()}`, options: sshOpts() });
    await api.addTargetRole(target.id, role.id);
    const user = await makeUser(api, [role.id]);

    const before = (await listTargetsAs(url, user.username, "pwd")).map((t) => t.name);
    expect(before).toContain(target.name);

    await api.removeTargetRole(target.id, role.id);

    const after = (await listTargetsAs(url, user.username, "pwd")).map((t) => t.name);
    expect(after).not.toContain(target.name);
  });

  test("removing the user<->role binding removes visibility", async () => {
    const api = adminClient(url);
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const target = await api.createTarget({ name: `tgt-${randomUUID()}`, options: sshOpts() });
    await api.addTargetRole(target.id, role.id);
    const user = await makeUser(api, [role.id]);

    const before = (await listTargetsAs(url, user.username, "pwd")).map((t) => t.name);
    expect(before).toContain(target.name);

    await api.removeUserRole(user.id, role.id);

    const after = (await listTargetsAs(url, user.username, "pwd")).map((t) => t.name);
    expect(after).not.toContain(target.name);
  });

  test("target-group — group info surfaces, but access stays per-target-role", async () => {
    // Authorization in this product is computed purely from the direct
    // target<->role binding (config_providers/db.rs::authorize_target). Target
    // groups are organizational metadata, not an authorization grant: a target
    // in a group is reachable only if its role is also bound to the caller, and
    // group membership alone never grants access.
    const api = adminClient(url);
    const group = await adminReq(url, "POST", "/target-groups", { name: `grp-${randomUUID()}` });
    const role = await api.createRole({ name: `role-${randomUUID()}` });

    // Member of the group AND bound to the role -> visible, with group info.
    const memberAllowed = await adminReq(url, "POST", "/targets", {
      name: `grp-allow-${randomUUID()}`,
      options: sshOpts(),
      group_id: group.id,
    });
    await api.addTargetRole(memberAllowed.id, role.id);

    // Member of the same group but NOT bound to the role -> not authorized.
    const memberUnbound = await adminReq(url, "POST", "/targets", {
      name: `grp-deny-${randomUUID()}`,
      options: sshOpts(),
      group_id: group.id,
    });

    const user = await makeUser(api, [role.id]);
    const targets = await listTargetsAs(url, user.username, "pwd");
    const names = targets.map((t) => t.name);

    expect(names).toContain(memberAllowed.name);
    expect(names).not.toContain(memberUnbound.name);

    const shown = targets.find((t) => t.name === memberAllowed.name);
    expect(shown?.group?.name).toBe(group.name);
  });
});
