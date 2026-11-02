import { afterAll, beforeAll, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";
import { ProcessManager } from "../helpers/process-manager";
import { waitPort } from "../helpers/util";

const processes = new ProcessManager(60);
let base: string;
let cookie: string;
let accountId: number;

async function request(path: string, method = "GET", body?: unknown, token = false) {
  return fetch(`${base}${path}`, {
    method, redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", ...(token ? { "X-Gated-Token": "token-value" } : { Cookie: cookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    tls: { rejectUnauthorized: false },
  });
}

beforeAll(async () => {
  const gateway = await processes.startWg({ stdout: "pipe", stderr: "pipe" });
  await waitPort(gateway.httpPort, { recv: false, process: gateway.process });
  base = `https://localhost:${gateway.httpPort}`;
  const login = await request("/api/auth/login", "POST", { username: "admin", password: "123" });
  expect(login.status).toBe(201);
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const account = await request("/admin/api/accounts", "POST", { kind: "ssh-password", name: "reveal-check", credentials: { kind: "ssh-password", username: "upstream", password: "fixture-secret" } }, true);
  expect(account.status).toBe(201);
  accountId = (await account.json() as { id: number }).id;
}, 120_000);

afterAll(async () => processes.stop());

test("browser login is separate from proxy sessions and management audit is queryable", async () => {
  const sessions = await request("/admin/api/sessions");
  expect(sessions.status).toBe(200);
  expect(await sessions.json()).toEqual({ items: [], offset: 0, total: 0 });
  const audit = await request("/admin/api/management-audit", "POST", { limit: 100 });
  expect(audit.status).toBe(200);
  const rows = await audit.json() as { username: string; values: { event?: string } }[];
  expect(rows.some(row => row.username === "admin" && row.values.event === "auth.login")).toBe(true);
});

test("reveal rejects unconfirmed access and verifies the current password", async () => {
  const path = `/admin/api/accounts/${accountId}/reveal`;
  expect((await request(path, "POST", { reason: "maintenance", password: "123" }, true)).status).toBe(401);
  expect((await request(path, "POST", { reason: "maintenance" })).status).toBe(400);
  expect((await request(path, "POST", { reason: "maintenance", password: "incorrect" })).status).toBe(401);
  // The reason is optional; a fresh password alone confirms.
  const response = await request(path, "POST", { password: "123" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect((await response.json() as any).credentials.password).toBe("fixture-secret");
});

test("OTP reveal rejects expired and reused codes and rate-limits attempts", async () => {
  const users = await (await request("/admin/api/users")).json() as { id: string; username: string }[];
  const admin = users.find(user => user.username === "admin")!;
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({ secret, digits: 6, period: 30, algorithm: "SHA1" });
  expect((await request(`/admin/api/users/${admin.id}/credentials/otp`, "POST", { secret_key: Array.from(new Uint8Array(secret.buffer)) })).status).toBe(201);
  const path = `/admin/api/accounts/${accountId}/reveal`;
  expect((await request(path, "POST", { reason: "maintenance", otp: totp.generate({ timestamp: Date.now() - 300_000 }) })).status).toBe(401);
  const otp = totp.generate();
  expect((await request(path, "POST", { reason: "maintenance", otp })).status).toBe(200);
  expect((await request(path, "POST", { reason: "maintenance", otp })).status).toBe(401);
  expect((await request(path, "POST", { reason: "maintenance", password: "123" })).status).toBe(429);
});

test("concurrent duplicate usernames yield exactly one success", async () => {
  const responses = await Promise.all(Array.from({ length: 2 }, () => request("/admin/api/users", "POST", { username: "unique-race" }, true)));
  expect(responses.filter(response => response.status === 201)).toHaveLength(1);
  expect(responses.filter(response => response.status === 400)).toHaveLength(1);
});
