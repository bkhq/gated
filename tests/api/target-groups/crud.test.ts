import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

// Target-group endpoints have no helper in the shared AdminClient, so we
// talk to /admin/api directly with the admin token, mirroring sql-console.test.ts.
const ADMIN_TOKEN = "token-value";

async function adminReq(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/admin/api${path}`, {
    method,
    headers: {
      "X-Gated-Token": ADMIN_TOKEN,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    tls: { rejectUnauthorized: false },
  } as any);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Membership is expressed through a target's group_id, so we need a valid
// target. An SSH target is created without ever connecting to an upstream.
function sshOptions(): any {
  return {
    kind: "Ssh",
    host: "localhost",
    port: 22,
    username: "root",
    auth: { kind: "PublicKey" },
  };
}

async function listGroupTargetIds(url: string, groupId: string): Promise<string[]> {
  const { status, body } = await adminReq(url, "GET", `/targets?group_id=${groupId}`);
  expect(status).toBe(200);
  return (body as Array<{ id: string }>).map((t) => t.id);
}

describe("API Target Groups - CRUD + membership", () => {
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

  test("create / validation / conflict", async () => {
    const name = `group-${randomUUID()}`;
    const created = await adminReq(url, "POST", "/target-groups", {
      name,
      description: "initial description",
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTruthy();
    expect(created.body.name).toBe(name);
    expect(created.body.description).toBe("initial description");

    // Empty name is rejected.
    const empty = await adminReq(url, "POST", "/target-groups", { name: "" });
    expect(empty.status).toBe(400);

    // Duplicate name conflicts.
    const dup = await adminReq(url, "POST", "/target-groups", { name });
    expect(dup.status).toBe(409);
  });

  test("list / get / update lifecycle", async () => {
    const name = `group-${randomUUID()}`;
    const created = await adminReq(url, "POST", "/target-groups", {
      name,
      description: "desc",
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    // List reflects the new group.
    const list = await adminReq(url, "GET", "/target-groups");
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map((g) => g.id)).toContain(id);

    // Get by id.
    const got = await adminReq(url, "GET", `/target-groups/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.name).toBe(name);

    // Update name + description.
    const newName = `group-${randomUUID()}`;
    const updated = await adminReq(url, "PUT", `/target-groups/${id}`, {
      name: newName,
      description: "updated",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe(newName);
    expect(updated.body.description).toBe("updated");

    const reGot = await adminReq(url, "GET", `/target-groups/${id}`);
    expect(reGot.body.name).toBe(newName);
    expect(reGot.body.description).toBe("updated");

    // Get / update of a non-existent group is 404.
    const missing = randomUUID();
    expect((await adminReq(url, "GET", `/target-groups/${missing}`)).status).toBe(404);
    expect(
      (await adminReq(url, "PUT", `/target-groups/${missing}`, { name: "x" })).status
    ).toBe(404);
  });

  test("membership add / remove via target group_id", async () => {
    const group = await adminReq(url, "POST", "/target-groups", {
      name: `group-${randomUUID()}`,
    });
    const groupId = group.body.id as string;

    // Create a target that belongs to the group.
    const target = await adminReq(url, "POST", "/targets", {
      name: `ssh-${randomUUID()}`,
      options: sshOptions(),
      group_id: groupId,
    });
    expect(target.status).toBe(201);
    const targetId = target.body.id as string;

    // The group filter lists the member.
    expect(await listGroupTargetIds(url, groupId)).toContain(targetId);

    // Remove from the group by updating the target without a group_id.
    const removed = await adminReq(url, "PUT", `/targets/${targetId}`, {
      name: target.body.name,
      options: sshOptions(),
    });
    expect(removed.status).toBe(200);
    expect(await listGroupTargetIds(url, groupId)).not.toContain(targetId);

    // Re-add to the group.
    const readded = await adminReq(url, "PUT", `/targets/${targetId}`, {
      name: target.body.name,
      options: sshOptions(),
      group_id: groupId,
    });
    expect(readded.status).toBe(200);
    expect(await listGroupTargetIds(url, groupId)).toContain(targetId);
  });

  test("delete group unassigns members rather than cascading", async () => {
    const group = await adminReq(url, "POST", "/target-groups", {
      name: `group-${randomUUID()}`,
    });
    const groupId = group.body.id as string;

    const target = await adminReq(url, "POST", "/targets", {
      name: `ssh-${randomUUID()}`,
      options: sshOptions(),
      group_id: groupId,
    });
    const targetId = target.body.id as string;
    expect(await listGroupTargetIds(url, groupId)).toContain(targetId);

    // Delete the group while it still has a member.
    const del = await adminReq(url, "DELETE", `/target-groups/${groupId}`);
    expect(del.status).toBe(204);

    // Group is gone.
    expect((await adminReq(url, "GET", `/target-groups/${groupId}`)).status).toBe(404);

    // The target survives the group deletion (unassigned, not cascade-deleted).
    const stillThere = await adminReq(url, "GET", `/targets/${targetId}`);
    expect(stillThere.status).toBe(200);
    expect(await listGroupTargetIds(url, groupId)).not.toContain(targetId);

    // Deleting an already-deleted group is 404.
    expect((await adminReq(url, "DELETE", `/target-groups/${groupId}`)).status).toBe(404);
  });
});
