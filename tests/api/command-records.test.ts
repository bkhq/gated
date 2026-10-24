import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { HttpSession } from "../helpers/session";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

// Admin API for the unified command-records query (shell + SQL audit streams).
//
// Seeding strategy: this sandbox cannot always drive a live SSH/SQL upstream
// (that needs docker), so we seed the two structured recording streams directly
// through the recordings store gated itself uses — insert a Session + two
// Recording rows (kinds command_audit / sql_audit) into the same sqlite file,
// and drop the matching JSONL item files under the recordings root. The running
// gated process reads both back on each request (find() + file read), so the
// API sees them exactly as if a real session had produced them. This is the
// "seed via recordings storage" path called out in the task.

const ADMIN_TOKEN = "token-value";

// sqlite stores UUID columns as 16-byte BLOBs (sea-orm/sqlx), so seeded rows
// must bind the raw bytes, not the hyphenated string.
function uuidBytes(u: string): Uint8Array {
  const hex = u.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

// sea-orm/sqlx stores chrono DateTime<Utc> as "YYYY-MM-DD HH:MM:SS.ffffff+00:00".
function dbTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.` +
    `${p(d.getUTCMilliseconds(), 3)}000+00:00`
  );
}

interface Seeded {
  sessionId: string;
  shellTargetId: string;
  userId: string;
  username: string;
  shellTs: string;
  sqlTs: string;
}

// Insert one session and two structured recordings (shell + sql) plus their
// on-disk JSONL item files, reading the DB and recordings locations straight
// from gated's own config so the layout can't drift:
//   db file:    <database_url dir>/db.sqlite3
//   recordings: <recordings.path>/<session_id>/<recording_name>
function seed(configPath: string): Seeded {
  const cfg = yaml.load(readFileSync(configPath, "utf-8")) as any;
  const dbDir = String(cfg.database_url).replace(/^sqlite:/, "");
  const dbFile = join(dbDir, "db.sqlite3");
  const recRoot = cfg.recordings.path as string;

  const sessionId = randomUUID();
  const shellTargetId = randomUUID();
  const userId = randomUUID();
  const username = `audit-${randomUUID().slice(0, 8)}`;
  const shellRecId = randomUUID();
  const sqlRecId = randomUUID();
  const shellTs = "2026-07-02T07:00:00Z";
  const sqlTs = "2026-07-02T07:05:00Z";

  const db = new Database(dbFile);
  db.exec("PRAGMA busy_timeout = 8000");
  const sessionBytes = uuidBytes(sessionId);
  db.run(
    `INSERT INTO sessions (id, target_snapshot, username, remote_address, started, ended, ticket_id, protocol)
     VALUES (?, NULL, ?, ?, ?, ?, NULL, ?)`,
    [sessionBytes, username, "127.0.0.1:0", dbTime("2026-07-02T06:59:00Z"), dbTime("2026-07-02T07:10:00Z"), "ssh"],
  );
  const insertRec = (id: string, name: string, started: string, kind: string, metadata: string) =>
    db.run(
      `INSERT INTO recordings (id, name, started, ended, session_id, kind, metadata)
       VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      [uuidBytes(id), name, dbTime(started), sessionBytes, kind, metadata],
    );
  insertRec(
    shellRecId,
    "shell-commands",
    shellTs,
    "command_audit",
    JSON.stringify({ type: "ssh-shell-session", target: "prod-host", target_id: shellTargetId }),
  );
  insertRec(
    sqlRecId,
    "sql-proxy",
    sqlTs,
    "sql_audit",
    JSON.stringify({ type: "mysql-proxy-session", target: "reporting", database: "analytics" }),
  );
  db.close();

  const shellItem = {
    type: "shell-command",
    timestamp: shellTs,
    target: "prod-host",
    target_id: shellTargetId,
    user_id: userId,
    username,
    origin: "exec",
    command: "cat /etc/passwd",
    acl_action: "allow",
    acl_rule_id: 7,
    acl_rule_name: "allow-all",
    outcome: "allowed",
  };
  const sqlItem = {
    type: "sql-query",
    timestamp: sqlTs,
    target_kind: "mysql",
    target: "reporting",
    database: "analytics",
    sql: "SELECT secret FROM vault",
    statement_kind: "select",
    readonly: true,
    elapsed_ms: 12,
    success: true,
    error: null,
  };

  const sessDir = join(recRoot, sessionId);
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(join(sessDir, "shell-commands"), JSON.stringify(shellItem) + "\n");
  writeFileSync(join(sessDir, "sql-proxy"), JSON.stringify(sqlItem) + "\n");

  return { sessionId, shellTargetId, userId, username, shellTs, sqlTs };
}

async function query(
  url: string,
  qs: string,
  token = ADMIN_TOKEN,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/admin/api/command-records${qs}`, {
    headers: token ? { "X-Gated-Token": token } : {},
    tls: { rejectUnauthorized: false },
  } as any);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("Command records API (unified shell + SQL query/search)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let s: Seeded;
  const timeout = Number(process.env.TIMEOUT || 20);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg({ configPatch: { recordings: { enable: true } } });
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    s = seed(wg.configPath);
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("lists both shell and SQL records for the session, newest first", async () => {
    const { status, body } = await query(url, `?session_id=${s.sessionId}`);
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.items.length).toBe(2);

    const sources = body.items.map((i: any) => i.source);
    expect(sources).toContain("shell");
    expect(sources).toContain("sql");

    // Newest first: sql (07:05) precedes shell (07:00).
    expect(body.items[0].source).toBe("sql");
    expect(body.items[1].source).toBe("shell");

    const shell = body.items.find((i: any) => i.source === "shell");
    expect(shell.command).toBe("cat /etc/passwd");
    expect(shell.target_id).toBe(s.shellTargetId);
    expect(shell.user_id).toBe(s.userId);
    expect(shell.username).toBe(s.username);
    // ACL decision fields round-trip losslessly for shell records.
    expect(shell.acl_action).toBe("allow");
    expect(shell.acl_rule_id).toBe(7);
    expect(shell.acl_rule_name).toBe("allow-all");
    expect(shell.outcome).toBe("allowed");
    expect(shell.origin).toBe("exec");

    const sql = body.items.find((i: any) => i.source === "sql");
    expect(sql.command).toBe("SELECT secret FROM vault");
    expect(sql.success).toBe(true);
    // SQL items carry no user in the item; the session username is inherited.
    expect(sql.username).toBe(s.username);
  });

  test("filters by source", async () => {
    const shellOnly = await query(url, `?session_id=${s.sessionId}&source=shell`);
    expect(shellOnly.body.items.every((i: any) => i.source === "shell")).toBe(true);
    expect(shellOnly.body.items.length).toBe(1);

    const sqlOnly = await query(url, `?session_id=${s.sessionId}&source=sql`);
    expect(sqlOnly.body.items.every((i: any) => i.source === "sql")).toBe(true);
    expect(sqlOnly.body.items.length).toBe(1);

    const bad = await query(url, `?source=bogus`);
    expect(bad.status).toBe(400);
  });

  test("free-text q filters over the command/query text", async () => {
    const passwd = await query(url, `?session_id=${s.sessionId}&q=passwd`);
    expect(passwd.body.items.length).toBe(1);
    expect(passwd.body.items[0].source).toBe("shell");

    const vault = await query(url, `?session_id=${s.sessionId}&q=vault`);
    expect(vault.body.items.length).toBe(1);
    expect(vault.body.items[0].source).toBe("sql");

    const none = await query(url, `?session_id=${s.sessionId}&q=no-such-text-anywhere`);
    expect(none.body.items.length).toBe(0);
  });

  test("filters by user, target, and time range", async () => {
    const byUser = await query(url, `?session_id=${s.sessionId}&username=${s.username}`);
    expect(byUser.body.items.length).toBe(2);

    const byUserId = await query(url, `?session_id=${s.sessionId}&user_id=${s.userId}`);
    // user_id lives only on shell items.
    expect(byUserId.body.items.length).toBe(1);
    expect(byUserId.body.items[0].source).toBe("shell");

    const byTarget = await query(url, `?session_id=${s.sessionId}&target_id=${s.shellTargetId}`);
    expect(byTarget.body.items.length).toBe(1);
    expect(byTarget.body.items[0].source).toBe("shell");

    // from cutoff after the shell timestamp keeps only the sql record.
    const afterShell = await query(url, `?session_id=${s.sessionId}&from=2026-07-02T07:03:00Z`);
    expect(afterShell.body.items.length).toBe(1);
    expect(afterShell.body.items[0].source).toBe("sql");

    const badTime = await query(url, `?from=not-a-timestamp`);
    expect(badTime.status).toBe(400);
  });

  test("paginates", async () => {
    const page = await query(url, `?session_id=${s.sessionId}&limit=1`);
    expect(page.body.total).toBe(2);
    expect(page.body.items.length).toBe(1);
    expect(page.body.limit).toBe(1);
    expect(page.body.items[0].source).toBe("sql");

    const page2 = await query(url, `?session_id=${s.sessionId}&limit=1&offset=1`);
    expect(page2.body.items.length).toBe(1);
    expect(page2.body.items[0].source).toBe("shell");
  });

  test("is admin-gated: non-admin is denied and no data leaks", async () => {
    // A logged-in non-admin user hitting the /admin/api tree gets 403.
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    const session = new HttpSession();
    const login = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd",
    });
    expect(login.status).toBe(201);
    const denied = await session.get(`${url}/admin/api/command-records?session_id=${s.sessionId}`);
    expect(denied.status).toBe(403);

    // No token at all must not return data either.
    const unauth = await query(url, `?session_id=${s.sessionId}`, "");
    expect(unauth.status).not.toBe(200);
    expect(unauth.body?.items).toBeUndefined();
  });
});
