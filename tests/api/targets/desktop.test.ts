import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

const ADMIN_TOKEN = "token-value";

// RDP and VNC targets: options, inline secrets, accounts and the role switch
// for the clipboard.
describe("API Targets - RDP and VNC", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
  });

  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}/admin/api${path}`, {
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
  };

  test("an RDP target stores its options and hides the password", async () => {
    const name = `rdp-${randomUUID()}`;
    const created = await admin("POST", "/targets", {
      name,
      options: {
        kind: "Rdp",
        host: " win.example.com ",
        port: 3389,
        username: "Administrator",
        domain: "CORP",
        password: "s3cret",
        verify_tls: true,
        record_keystrokes: false,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.options).toEqual({
      kind: "Rdp",
      host: "win.example.com",
      port: 3389,
      username: "Administrator",
      domain: "CORP",
      password: null,
      verify_tls: true,
      record_keystrokes: false,
    });

    // A blank password on update keeps the stored one; the rest changes.
    const updated = await admin("PUT", `/targets/${created.body.id}`, {
      name,
      options: { ...created.body.options, verify_tls: false, record_keystrokes: true },
      accounts: [],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.options.verify_tls).toBe(false);
    expect(updated.body.options.record_keystrokes).toBe(true);
    expect(updated.body.options.password).toBeNull();
  });

  test("a VNC target stores its options and hides the password", async () => {
    const created = await admin("POST", "/targets", {
      name: `vnc-${randomUUID()}`,
      options: { kind: "Vnc", host: "desk.example.com", port: 5901, password: "s3cret", record_keystrokes: false },
    });
    expect(created.status).toBe(201);
    expect(created.body.options).toEqual({
      kind: "Vnc",
      host: "desk.example.com",
      port: 5901,
      password: null,
      record_keystrokes: false,
    });
  });

  test("desktop targets take desktop accounts and no others", async () => {
    const desktop = await admin("POST", "/accounts", {
      kind: "desktop-password",
      name: `acct-${randomUUID()}`,
      credentials: { kind: "desktop-password", username: "ops", password: "pw", domain: null },
    });
    expect(desktop.status).toBe(201);
    const ssh = await admin("POST", "/accounts", {
      kind: "ssh-password",
      name: `acct-${randomUUID()}`,
      credentials: { kind: "ssh-password", username: "ops", password: "pw" },
    });
    expect(ssh.status).toBe(201);

    const rdp = (accountId: number) => admin("POST", "/targets", {
      name: `rdp-${randomUUID()}`,
      options: { kind: "Rdp", host: "win.example.com", port: 3389, username: "", domain: null, password: null, verify_tls: true, record_keystrokes: false },
      accounts: [{ account_id: accountId, role: "primary" }],
    });
    const bound = await rdp(desktop.body.id);
    expect(bound.status).toBe(201);
    expect(bound.body.accounts.length).toBe(1);
    expect((await rdp(ssh.body.id)).status).toBe(422);

    const vnc = await admin("POST", "/targets", {
      name: `vnc-${randomUUID()}`,
      options: { kind: "Vnc", host: "desk.example.com", port: 5900, password: null, record_keystrokes: false },
      accounts: [{ account_id: desktop.body.id, role: "primary" }],
    });
    expect(vnc.status).toBe(201);
  });

  test("the clipboard is a role switch that is off by default", async () => {
    const created = await admin("POST", "/roles", { name: `role-${randomUUID()}` });
    expect(created.status).toBe(201);
    expect(created.body.allow_clipboard).toBe(false);

    const updated = await admin("PUT", `/role/${created.body.id}`, {
      name: created.body.name,
      allow_clipboard: true,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.allow_clipboard).toBe(true);
    expect((await admin("GET", `/role/${created.body.id}`)).body.allow_clipboard).toBe(true);
  });
});
