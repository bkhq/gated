import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { readPubkey, wgClientEd25519PubkeyPath } from "../helpers/gated-helpers";

// File transfer: the web file manager REST API, native SFTP through the SSH
// listener, the per-role `allow_file_transfer` switch and the file audit.
describe("SFTP and the web file manager", () => {
  const processes = new ProcessManager(60);
  let gateway: GatedProcess;
  let base: string;
  let api: AdminClient;
  let sshPort: number;
  const keyPath = resolve(import.meta.dir, "../ssh-keys/id_ed25519");
  const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();

  beforeAll(async () => {
    gateway = await processes.startWg({ configPatch: { recordings: { enable: true } } });
    await waitPort(gateway.httpPort, { recv: false, process: gateway.process });
    await waitPort(gateway.sshPort, { process: gateway.process });
    // The upstream trusts the gateway's client key.
    sshPort = processes.startSshServer({ trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())] });
    await waitPort(sshPort);
    base = `https://localhost:${gateway.httpPort}`;
    api = adminClient(base);
  });
  afterAll(async () => { await processes.stop(); });

  async function admin(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}/admin/api${path}`, {
      method,
      headers: { "X-Gated-Token": "token-value", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);
  }

  async function setup(allowFileTransfer: boolean) {
    const role = await api.createRole({ name: `files-${randomUUID()}`, allow_file_transfer: allowFileTransfer });
    const user = await api.createUser({ username: `files-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.createPublicKeyCredential(user.id, { label: "ed25519", openssh_public_key: publicKey });
    await api.addUserRole(user.id, role.id);
    const target = await api.createTarget({
      name: `files-${randomUUID()}`,
      options: { kind: "Ssh", host: "localhost", port: sshPort, username: "root", auth: { kind: "PublicKey" } },
    });
    await api.addTargetRole(target.id, role.id);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "123" }), tls: { rejectUnauthorized: false },
    } as any);
    expect(login.status).toBe(201);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return { role, user, target, cookie };
  }

  function files(targetName: string, cookie: string) {
    return async (method: string, path: string, body?: BodyInit, json = true): Promise<Response> =>
      fetch(`${base}/api/sftp/${targetName}${path}`, {
        method,
        headers: { Cookie: cookie, ...(json && body ? { "Content-Type": "application/json" } : {}) },
        body,
        tls: { rejectUnauthorized: false },
      } as any);
  }

  async function fileRecords(username: string) {
    const response = await admin("GET", `/file-records?username=${encodeURIComponent(username)}&limit=100`);
    expect(response.status).toBe(200);
    return (await response.json() as { items: { origin: string, operation: string, path: string, new_path: string | null, bytes: number | null, success: boolean }[] }).items;
  }

  // Runs an sftp batch through the gateway; returns the exit code and output.
  async function nativeSftp(username: string, targetName: string, commands: string[]) {
    const batch = join(processes.ctx.tmpdir, `batch-${randomUUID()}`);
    writeFileSync(batch, `${commands.join("\n")}\n`);
    const proc = Bun.spawn([
      "sftp", "-b", batch, "-P", String(gateway.sshPort),
      "-o", `IdentityFile=${keyPath}`, "-o", "IdentitiesOnly=yes",
      "-o", "PreferredAuthentications=publickey",
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "-o", `User=${username}:${targetName}`, "localhost",
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { exitCode: proc.exitCode, output: stdout + stderr };
  }

  test("web file manager operations are audited", async () => {
    const { user, target, cookie } = await setup(true);
    const call = files(target.name, cookie);
    const dir = `/tmp/web-${randomUUID()}`;
    const content = randomBytes(300_000);

    const home = await call("GET", "/list");
    expect(home.status).toBe(200);
    expect((await home.json() as { path: string }).path).toBe("/root");

    expect((await call("POST", "/mkdir", JSON.stringify({ path: dir }))).status).toBe(204);
    expect((await call("PUT", `/upload?path=${dir}/a.bin`, content, false)).status).toBe(204);
    expect((await call("PUT", `/upload?path=${dir}/a.bin`, content, false)).status).toBe(409);

    const listing = await (await call("GET", `/list?path=${dir}`)).json() as { entries: { name: string, kind: string, size: number }[] };
    expect(listing.entries).toEqual([expect.objectContaining({ name: "a.bin", kind: "file", size: content.length })]);

    const download = await call("GET", `/download?path=${dir}/a.bin`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain('filename="a.bin"');
    expect(Buffer.from(await download.arrayBuffer()).equals(content)).toBe(true);

    expect((await call("POST", "/rename", JSON.stringify({ from: `${dir}/a.bin`, to: `${dir}/b.bin` }))).status).toBe(204);
    expect((await call("GET", `/list?path=${dir}/missing`)).status).toBe(404);
    expect((await call("POST", "/remove", JSON.stringify({ path: `${dir}/b.bin` }))).status).toBe(204);
    expect((await call("POST", "/remove", JSON.stringify({ path: dir, directory: true }))).status).toBe(204);

    // The download is recorded once its stream ends.
    let records = await fileRecords(user.username);
    for (let i = 0; i < 20 && !records.some(r => r.operation === "read"); i++) {
      await Bun.sleep(100);
      records = await fileRecords(user.username);
    }
    const ops = records.map(r => [r.origin, r.operation, r.path, r.bytes, r.success]);
    expect(ops).toContainEqual(["web", "mkdir", dir, null, true]);
    expect(ops).toContainEqual(["web", "write", `${dir}/a.bin`, content.length, true]);
    expect(ops).toContainEqual(["web", "read", `${dir}/a.bin`, content.length, true]);
    expect(ops).toContainEqual(["web", "remove", `${dir}/b.bin`, null, true]);
    expect(ops).toContainEqual(["web", "rmdir", dir, null, true]);
    expect(records.find(r => r.operation === "rename")?.new_path).toBe(`${dir}/b.bin`);
  });

  test("native SFTP is audited", async () => {
    const { user, target } = await setup(true);
    const local = join(processes.ctx.tmpdir, `up-${randomUUID()}`);
    writeFileSync(local, randomBytes(50_000));
    const remote = `/tmp/native-${randomUUID()}`;

    const result = await nativeSftp(user.username, target.name, [
      `put ${local} ${remote}`,
      `get ${remote} ${local}.back`,
      `rename ${remote} ${remote}.moved`,
      `rm ${remote}.moved`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(`${local}.back`).equals(readFileSync(local))).toBe(true);

    let records = await fileRecords(user.username);
    for (let i = 0; i < 20 && records.length < 4; i++) {
      await Bun.sleep(100);
      records = await fileRecords(user.username);
    }
    const ops = records.map(r => [r.origin, r.operation, r.path, r.bytes, r.success]);
    expect(ops).toContainEqual(["sftp", "write", remote, 50_000, true]);
    expect(ops).toContainEqual(["sftp", "read", remote, 50_000, true]);
    expect(ops).toContainEqual(["sftp", "remove", `${remote}.moved`, null, true]);
    expect(records.find(r => r.operation === "rename")?.new_path).toBe(`${remote}.moved`);
  });

  test("roles without file transfer are denied on both paths", async () => {
    const { role, user, target, cookie } = await setup(false);

    const web = await files(target.name, cookie)("GET", "/list");
    expect(web.status).toBe(403);
    expect((await web.json() as { error: string }).error).toContain("File transfer is not allowed");

    const native = await nativeSftp(user.username, target.name, ["ls /"]);
    expect(native.exitCode).not.toBe(0);
    expect(native.output).toContain("subsystem request failed");

    // Re-enabling the role takes effect on the next request.
    await api.updateRole(role.id, { name: role.name, allow_file_transfer: true });
    expect((await files(target.name, cookie)("GET", "/list")).status).toBe(200);
  });
});
