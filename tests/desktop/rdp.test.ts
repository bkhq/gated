import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { openDesktop } from "../helpers/desktop";

// An RDP desktop opened through `GET /api/desktop/{target}`: the gateway is
// the RDP client. The target is xrdp, which has no network level
// authentication and no dynamic resize in this version; both need a Windows
// target and are not covered here.
describe("Web desktop - RDP", () => {
  const processes = new ProcessManager(60);
  let gateway: GatedProcess;
  let base: string;
  let api: AdminClient;
  let rdp: { port: number; container: string };

  beforeAll(async () => {
    gateway = await processes.startWg({ configPatch: { recordings: { enable: true } } });
    await waitPort(gateway.httpPort, { recv: false, process: gateway.process });
    rdp = await processes.startRdpServer();
    base = `https://localhost:${gateway.httpPort}`;
    api = adminClient(base);
  }, 180000);
  afterAll(async () => { await processes.stop(); });

  async function admin(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${base}/admin/api${path}`, {
      method,
      headers: { "X-Gated-Token": "token-value", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    } as any);
  }

  // Runs a command against the X display of the first xrdp session.
  function inSession(...command: string[]): string {
    const result = Bun.spawnSync(["docker", "exec", "-u", "user", "-e", "DISPLAY=:10", rdp.container, ...command]);
    return result.stdout.toString() + result.stderr.toString();
  }

  async function setup(opts: { verifyTls?: boolean } = {}) {
    const role = await (await admin("POST", "/roles", { name: `desk-${randomUUID()}` })).json() as { id: string };
    const user = await api.createUser({ username: `desk-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);
    const account = await (await admin("POST", "/accounts", {
      name: `desk-${randomUUID()}`, kind: "desktop-password",
      credentials: { kind: "desktop-password", username: "user", password: "rdp-pass" },
    })).json() as { id: number };
    const target = await (await admin("POST", "/targets", {
      name: `desk-${randomUUID()}`,
      options: {
        kind: "Rdp", host: "localhost", port: rdp.port, username: "", domain: null, password: null,
        verify_tls: opts.verifyTls ?? false, record_keystrokes: false,
      },
      accounts: [{ account_id: account.id, role: "primary" }],
    })).json() as { id: string; name: string };
    await api.addTargetRole(target.id, role.id);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "123" }), tls: { rejectUnauthorized: false },
    } as any);
    expect(login.status).toBe(201);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    return { user, target, cookie };
  }

  test("opens the desktop at the viewer's size, shows it and passes the pointer on", async () => {
    const { user, target, cookie } = await setup();
    const desktop = openDesktop(gateway.httpPort, target.name, cookie, "width=1024&height=768");
    try {
      const connected = await desktop.state("connected");
      expect(connected.details?.address).toBe(`localhost:${rdp.port}`);
      expect(connected.details?.username).toBe("user");
      const sessionId = connected.details!.session_id;

      const resize = await desktop.until("resize", () => desktop.messages.find(m => m.type === "resize"));
      expect([resize.width, resize.height]).toEqual([1024, 768]);

      // The whole screen arrives as image frames.
      await desktop.until("full frame", () => {
        const pixels = desktop.images
          .filter(image => image.kind === 1 || image.kind === 2)
          .reduce((sum, image) => sum + image.width * image.height, 0);
        return pixels >= 1024 * 768;
      }, 40000);

      // The account was logged on without a prompt: its session is running.
      await desktop.until("logged-on session", () => inSession("xdotool", "getdisplaygeometry").includes("1024 768"), 40000);

      desktop.send({ type: "pointer_event", x: 123, y: 45, buttons: 0 });
      await desktop.until("pointer in the target", () => inSession("xdotool", "getmouselocation").includes("x:123 y:45"));

      const sessions = await (await admin("GET", "/sessions?limit=50")).json() as { items: { id: string; protocol: string; username: string }[] };
      const session = sessions.items.find(item => item.id === sessionId);
      expect(session?.protocol).toBe("WebRDP");
      expect(session?.username).toBe(user.username);

      desktop.socket.close();
      await desktop.ended;
      await Bun.sleep(1500);
      const recordings = await (await admin("GET", `/sessions/${sessionId}/recordings`)).json() as { id: string; kind: string }[];
      expect(recordings.map(recording => recording.kind)).toEqual(["Desktop"]);
      const lines = (await (await admin("GET", `/recordings/${recordings[0]!.id}/desktop`)).text())
        .split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(lines[0]).toMatchObject({ type: "resize", width: 1024, height: 768 });
      expect(lines.some(line => line.type === "pointer_input" && line.x === 123)).toBe(true);
    } finally { desktop.socket.close(); }
  }, 180000);

  test("an administrator can see the certificate the target presents", async () => {
    const { target } = await setup({ verifyTls: true });
    const response = await admin("GET", `/targets/${target.id}/upstream-certificate`);
    expect(response.status).toBe(200);
    const report = await response.json() as {
      tls: boolean; verify: boolean; chain: { subject: string; sha256_fingerprint: string }[];
      verify_error: string | null; error: string | null;
    };
    expect(report.tls).toBe(true);
    expect(report.verify).toBe(true);
    expect(report.error).toBeNull();
    // xrdp's certificate is self-signed: shown, and reported as not trusted.
    expect(report.chain.length).toBe(1);
    expect(report.chain[0]!.sha256_fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(report.verify_error).toBeTruthy();
  }, 120000);

  test("a certificate that does not verify ends the connection before the logon", async () => {
    const { target, cookie } = await setup({ verifyTls: true });
    const desktop = openDesktop(gateway.httpPort, target.name, cookie);
    try {
      const closed = await desktop.state("closed");
      const error = desktop.messages.find(m => m.type === "error");
      expect(error?.message).toBe("Target connection failed: TLS negotiation with the target failed");
      expect(JSON.stringify(desktop.messages)).not.toContain("rdp-pass");
      expect(closed.message).toBeTruthy();
    } finally { desktop.socket.close(); }
  }, 120000);
});
