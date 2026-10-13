import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../../helpers/process-manager";
import { waitPort } from "../../helpers/util";
import { randomUUID } from "crypto";

// Account endpoints have no helper in the shared AdminClient, so we talk
// to /admin/api directly with the admin token, mirroring sql-console.test.ts.
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

// An ssh-password account is compatible with an SSH target, which lets us
// exercise the references / referenced-delete behavior without an upstream.
function sshPasswordCredentials(password: string): any {
  return { kind: "ssh-password", username: "deploy", password };
}

describe("API Accounts - CRUD + reveal + references", () => {
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
    const name = `acct-${randomUUID()}`;
    const created = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name,
      description: "ssh deploy account",
      credentials: sshPasswordCredentials("s3cret"),
      tags: ["prod", "ssh"],
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTruthy();
    expect(created.body.kind).toBe("ssh-password");
    expect(created.body.name).toBe(name);
    expect(created.body.reference_count).toBe(0);
    expect(created.body.tags).toEqual(["prod", "ssh"]);

    // Empty name -> 400.
    const empty = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name: "   ",
      credentials: sshPasswordCredentials("x"),
    });
    expect(empty.status).toBe(400);

    // Credentials that don't match the kind -> 422.
    const badCreds = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name: `acct-${randomUUID()}`,
      credentials: { kind: "ssh-password", username: "only" },
    });
    expect(badCreds.status).toBe(422);

    // Duplicate name -> 409.
    const dup = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name,
      credentials: sshPasswordCredentials("x"),
    });
    expect(dup.status).toBe(409);
  });

  test("list / get (schema hides secret) / update", async () => {
    const name = `acct-${randomUUID()}`;
    const created = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name,
      description: "before",
      credentials: sshPasswordCredentials("topsecret-value"),
      tags: ["a"],
    });
    const id = created.body.id as number;

    // List includes it.
    const list = await adminReq(url, "GET", "/accounts");
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: number }>).map((a) => a.id)).toContain(id);

    // Get returns a credentials schema that marks the password sensitive and
    // never leaks the actual secret value.
    const got = await adminReq(url, "GET", `/accounts/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.name).toBe(name);
    expect(got.body.credentials_schema.kind).toBe("ssh-password");
    expect(got.body.credentials_schema.fields.password.sensitive).toBe(true);
    expect(JSON.stringify(got.body.credentials_schema)).not.toContain("topsecret-value");

    // Update description + tags.
    const updated = await adminReq(url, "PUT", `/accounts/${id}`, {
      description: "after",
      tags: ["b", "c"],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.description).toBe("after");
    expect(updated.body.tags).toEqual(["b", "c"]);

    // Get of a non-existent account is 404.
    expect((await adminReq(url, "GET", `/accounts/999999`)).status).toBe(404);
  });

  test("reveal returns the stored secret to an admin", async () => {
    const created = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name: `acct-${randomUUID()}`,
      credentials: sshPasswordCredentials("reveal-me-please"),
    });
    const id = created.body.id as number;

    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "123" }),
      tls: { rejectUnauthorized: false },
    });
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const reveal = (accountId: number) => fetch(`${url}/admin/api/accounts/${accountId}/reveal`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ reason: "integration verification", password: "123" }),
      tls: { rejectUnauthorized: false },
    });
    const response = await reveal(id);
    expect(response.status).toBe(200);
    const revealed = await response.json() as any;
    expect(revealed.credentials.kind).toBe("ssh-password");
    expect(revealed.credentials.username).toBe("deploy");
    expect(revealed.credentials.password).toBe("reveal-me-please");
    expect((await reveal(999999)).status).toBe(404);
  });

  test("browser sessions need step-up to write accounts; blank secrets keep stored values", async () => {
    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "123" }),
      tls: { rejectUnauthorized: false },
    } as any);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const sessionReq = async (method: string, path: string, body: unknown) => {
      const res = await fetch(`${url}/admin/api${path}`, {
        method, headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body),
        tls: { rejectUnauthorized: false },
      } as any);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const confirmation = { reason: "integration verification", password: "123" };
    const draft = { kind: "ssh-password", name: `acct-${randomUUID()}`, credentials: sshPasswordCredentials("keep-me") };

    expect((await sessionReq("POST", "/accounts", draft)).status).toBe(400);
    expect((await sessionReq("POST", "/accounts", { ...draft, confirmation: { ...confirmation, password: "wrong" } })).status).toBe(401);
    const created = await sessionReq("POST", "/accounts", { ...draft, rotation_due_at: "2030-01-01T00:00:00Z", confirmation });
    expect(created.status).toBe(201);
    expect(created.body.rotation_due_at).toStartWith("2030-01-01");
    const id = created.body.id as number;

    const detail = await adminReq(url, "GET", `/accounts/${id}`);
    expect(detail.body.credentials_public).toEqual({ kind: "ssh-password", username: "deploy" });

    expect((await sessionReq("PUT", `/accounts/${id}`, { name: "renamed" })).status).toBe(400);
    const updated = await sessionReq("PUT", `/accounts/${id}`, {
      credentials: { kind: "ssh-password", username: "ops", password: "" },
      confirmation,
    });
    expect(updated.status).toBe(200);

    const reveal = await sessionReq("POST", `/accounts/${id}/reveal`, confirmation);
    expect(reveal.status).toBe(200);
    expect(reveal.body.credentials).toEqual({ kind: "ssh-password", username: "ops", password: "keep-me" });

    // Automation via admin token stays confirmation-free.
    expect((await adminReq(url, "PUT", `/accounts/${id}`, { description: "token edit" })).status).toBe(200);
  });

  test("references list referencing targets and block deletion while referenced", async () => {
    const account = await adminReq(url, "POST", "/accounts", {
      kind: "ssh-password",
      name: `acct-${randomUUID()}`,
      credentials: sshPasswordCredentials("bound"),
    });
    const accountId = account.body.id as number;

    // No references yet.
    const before = await adminReq(url, "GET", `/accounts/${accountId}/references`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual([]);

    // Bind the account to a new SSH target as its primary credential.
    const targetName = `ssh-${randomUUID()}`;
    const target = await adminReq(url, "POST", "/targets", {
      name: targetName,
      options: {
        kind: "Ssh",
        host: "localhost",
        port: 22,
        username: "root",
        auth: { kind: "PublicKey" },
      },
      accounts: [{ account_id: accountId, role: "primary" }],
    });
    expect(target.status).toBe(201);
    const targetId = target.body.id as string;

    // References now list the binding.
    const refs = await adminReq(url, "GET", `/accounts/${accountId}/references`);
    expect(refs.status).toBe(200);
    expect(refs.body.length).toBe(1);
    expect(refs.body[0].target_id).toBe(targetId);
    expect(refs.body[0].target_name).toBe(targetName);
    expect(refs.body[0].target_kind).toBe("ssh");
    expect(refs.body[0].role).toBe("primary");

    // The summary reference_count reflects the binding.
    const got = await adminReq(url, "GET", `/accounts/${accountId}`);
    expect(got.body.reference_count).toBe(1);

    // Deletion is blocked with a 409 that surfaces the references.
    const blocked = await adminReq(url, "DELETE", `/accounts/${accountId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("account_in_use");
    expect(blocked.body.reference_count).toBe(1);
    expect(blocked.body.references.length).toBe(1);
    expect(blocked.body.references[0].target_id).toBe(targetId);

    // Remove the reference by deleting the target, then deletion succeeds.
    expect((await adminReq(url, "DELETE", `/targets/${targetId}`)).status).toBe(204);
    const afterRefs = await adminReq(url, "GET", `/accounts/${accountId}/references`);
    expect(afterRefs.body).toEqual([]);

    expect((await adminReq(url, "DELETE", `/accounts/${accountId}`)).status).toBe(204);
    expect((await adminReq(url, "GET", `/accounts/${accountId}`)).status).toBe(404);

    // Deleting an already-deleted account is 404.
    expect((await adminReq(url, "DELETE", `/accounts/${accountId}`)).status).toBe(404);
  });
});
