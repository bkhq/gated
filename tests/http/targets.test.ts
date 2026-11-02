import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

describe("Gateway HTTP - /api/targets (RBAC filter)", () => {
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

  test("gateway /api/targets only returns targets the caller's roles are allow-listed for", async () => {
    const api = adminClient(url);

    // Two roles: user gets A only. Targets split across them.
    const roleA = await api.createRole({ name: `role-a-${randomUUID()}` });
    const roleB = await api.createRole({ name: `role-b-${randomUUID()}` });

    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    await api.addUserRole(user.id, roleA.id);

    const allowedName = `ssh-allowed-${randomUUID()}`;
    const forbiddenName = `ssh-forbidden-${randomUUID()}`;

    const allowed = await api.createTarget({
      name: allowedName,
      options: {
        kind: "Ssh",
        host: "example.invalid",
        port: 22,
        username: "root",
        auth: { kind: "PublicKey" },
      },
    });
    const forbidden = await api.createTarget({
      name: forbiddenName,
      options: {
        kind: "Ssh",
        host: "example.invalid",
        port: 22,
        username: "root",
        auth: { kind: "PublicKey" },
      },
    });
    await api.addTargetRole(allowed.id, roleA.id);
    await api.addTargetRole(forbidden.id, roleB.id);

    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd",
    });
    expect(loginResp.status).toBe(201);

    const listResp = await session.get(`${url}/api/targets`);
    expect(listResp.status).toBe(200);
    const visible = (await listResp.json()) as Array<{ name: string }>;
    const names = visible.map((t) => t.name);
    expect(names).toContain(allowedName);
    expect(names).not.toContain(forbiddenName);
  });

  test("search query filters the gateway list by target name substring", async () => {
    const api = adminClient(url);

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    await api.addUserRole(user.id, role.id);

    const suffix = randomUUID().slice(0, 8);
    const hitName = `ssh-match-${suffix}`;
    const missName = `ssh-other-${randomUUID()}`;

    const hit = await api.createTarget({
      name: hitName,
      options: { kind: "Ssh", host: "example.invalid", port: 22, username: "root", auth: { kind: "PublicKey" } },
    });
    const miss = await api.createTarget({
      name: missName,
      options: { kind: "Ssh", host: "example.invalid", port: 22, username: "root", auth: { kind: "PublicKey" } },
    });
    await api.addTargetRole(hit.id, role.id);
    await api.addTargetRole(miss.id, role.id);

    const session = new HttpSession();
    await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd",
    });

    const resp = await session.get(
      `${url}/api/targets?search=${encodeURIComponent(suffix)}`,
    );
    const hits = (await resp.json()) as Array<{ name: string }>;
    const hitNames = hits.map((t) => t.name);
    expect(hitNames).toContain(hitName);
    expect(hitNames).not.toContain(missName);
  });
});
