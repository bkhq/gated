import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { waitPort } from "../../helpers/util";

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

describe("API System - lode-backed update and restart", () => {
  let processes: ProcessManager;
  const timeout = Number(process.env.TIMEOUT || 10);
  let lodeDir: string;

  beforeAll(() => {
    processes = new ProcessManager(timeout);
    lodeDir = mkdtempSync(join(tmpdir(), "gated-lode-"));
  });

  afterAll(async () => {
    await processes.stop();
    rmSync(lodeDir, { recursive: true, force: true });
  });

  test("without lode every action reports not supervised", async () => {
    const wg: GatedProcess = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    const url = `https://localhost:${wg.httpPort}`;

    const status = await adminReq(url, "GET", "/system/update");
    expect(status.status).toBe(200);
    expect(status.body.supervised).toBe(false);
    expect((await adminReq(url, "POST", "/system/update/check")).status).toBe(409);
    expect((await adminReq(url, "POST", "/system/update", {})).status).toBe(409);
    expect((await adminReq(url, "POST", "/system/restart", {})).status).toBe(409);
  });

  test("under lode, status is read and requests are written to state.json", async () => {
    const statePath = join(lodeDir, "state.json");
    writeFileSync(statePath, JSON.stringify({ current: "0.23.0", last_good: "0.23.0", status: "running" }));
    const wg = await processes.startWg({ env: { LODE_DIR: lodeDir, LODE_INSTANCE: "7-e2e" } });
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    const url = `https://localhost:${wg.httpPort}`;
    const state = () => JSON.parse(readFileSync(statePath, "utf-8"));

    const status = await adminReq(url, "GET", "/system/update");
    expect(status.body).toMatchObject({
      supervised: true,
      instance: "7-e2e",
      current: "0.23.0",
      status: "running",
      available: null,
    });

    // Nothing to update to until a check finds a version.
    expect((await adminReq(url, "POST", "/system/update", {})).status).toBe(400);

    const check = await adminReq(url, "POST", "/system/update/check");
    expect(check.status).toBe(202);
    expect(check.body.nonce).toBe(1);
    expect(state().check_nonce).toBe(1);

    // lode answers the check.
    writeFileSync(statePath, JSON.stringify({ ...state(), available: "0.24.0", checked_nonce: 1 }));
    expect((await adminReq(url, "GET", "/system/update")).body).toMatchObject({
      available: "0.24.0",
      checked_nonce: 1,
    });

    expect((await adminReq(url, "POST", "/system/update", {})).status).toBe(202);
    expect(state().target).toBe("0.24.0");

    expect((await adminReq(url, "POST", "/system/restart", {})).status).toBe(202);
    expect(state().restart_nonce).toBe(1);
    expect(state().current).toBe("0.23.0");

    const audit = await adminReq(url, "POST", "/management-audit", {});
    const events = JSON.stringify(audit.body);
    expect(events).toContain("system.update");
    expect(events).toContain("system.restart");
  });
});
