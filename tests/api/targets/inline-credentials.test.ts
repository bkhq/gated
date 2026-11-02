import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

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

function sshOptions(username: string, password: string): any {
  return {
    kind: "Ssh",
    host: "localhost",
    port: 22,
    username,
    auth: { kind: "Password", password },
  };
}

describe("API Targets - inline credentials vs bound accounts", () => {
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

  test("inline target keeps its username and hides the secret", async () => {
    const created = await adminReq(url, "POST", "/targets", {
      name: `inline-${randomUUID()}`,
      options: sshOptions("root", "s3cret"),
    });
    expect(created.status).toBe(201);
    expect(created.body.accounts).toEqual([]);
    expect(created.body.options.username).toBe("root");
    expect(created.body.options.auth).toEqual({ kind: "Password", password: "" });
  });

  test("an empty accounts list switches a bound target back to inline credentials", async () => {
    const account = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name: `acct-${randomUUID()}`,
      credentials: { kind: "ssh-password", username: "deploy", password: "pw" },
    });
    expect(account.status).toBe(201);

    const name = `bound-${randomUUID()}`;
    const bound = await adminReq(url, "POST", "/targets", {
      name,
      options: sshOptions("", ""),
      accounts: [{ account_id: account.body.id, role: "primary" }],
    });
    expect(bound.status).toBe(201);
    expect(bound.body.accounts.length).toBe(1);

    const inline = await adminReq(url, "PUT", `/targets/${bound.body.id}`, {
      name,
      options: sshOptions("ops", "new-secret"),
      accounts: [],
    });
    expect(inline.status).toBe(200);
    expect(inline.body.accounts).toEqual([]);
    expect(inline.body.options.username).toBe("ops");

    const refs = await adminReq(url, "GET", `/accounts/${account.body.id}/references`);
    expect(refs.body).toEqual([]);
  });

  test("a non-empty accounts list still requires a primary binding", async () => {
    const account = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name: `acct-${randomUUID()}`,
      credentials: { kind: "ssh-password", username: "deploy", password: "pw" },
    });
    const res = await adminReq(url, "POST", "/targets", {
      name: `fallback-only-${randomUUID()}`,
      options: sshOptions("", ""),
      accounts: [{ account_id: account.body.id, role: "fallback" }],
    });
    expect(res.status).toBe(422);
  });
});
