import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

describe("Gateway HTTP - /api/info", () => {
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

  test("anonymous caller receives a minimal payload — no version, no ports", async () => {
    const resp = await fetch(`${url}/api/info`, {
      tls: { rejectUnauthorized: false },
    } as any);
    expect(resp.status).toBe(200);
    const info = (await resp.json()) as {
      version?: string;
      username?: string;
      admin?: boolean;
      ports: { ssh?: number; http?: number; mysql?: number; postgres?: number; kubernetes?: number };
    };
    // Defensive: server must not leak the build version or listener
    // ports to an unauthenticated caller. Both are explicitly gated on
    // `request_authorization.is_some()` in
    // `crates/gated-protocol-http/src/api/info.rs::api_get_info`.
    expect(info.version).toBeFalsy();
    expect(info.username).toBeFalsy();
    // `admin` is always false without auth; ports dict is present but
    // every entry is null.
    expect(info.admin).toBe(false);
    expect(info.ports.ssh).toBeNull();
    expect(info.ports.http).toBeNull();
    expect(info.ports.mysql).toBeNull();
    expect(info.ports.postgres).toBeNull();
  });

  test("authenticated non-admin sees version + ports but admin=false", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });

    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd",
    });
    expect(loginResp.status).toBe(201);

    const infoResp = await session.get(`${url}/api/info`);
    const info = (await infoResp.json()) as {
      version: string;
      username: string;
      admin: boolean;
      ports: { ssh: number | null; http: number | null };
    };
    expect(info.username).toBe(user.username);
    expect(info.version).toMatch(/\w/);
    expect(info.admin).toBe(false);
    // `startWg` always brings SSH + HTTP up; their external_port values
    // must surface to the authenticated caller.
    expect(typeof info.ports.ssh).toBe("number");
    expect(typeof info.ports.http).toBe("number");
  });

  test("admin role caller reports admin=true", async () => {
    const api = adminClient(url);
    const user = await api.createUser({ username: `admin-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    const adminRoles = await api.getRoles("admin");
    expect(adminRoles.length).toBeGreaterThan(0);
    await api.addUserRole(user.id, adminRoles[0].id);

    const session = new HttpSession();
    await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd",
    });

    const infoResp = await session.get(`${url}/api/info`);
    const info = (await infoResp.json()) as { admin: boolean };
    expect(info.admin).toBe(true);
  });
});
