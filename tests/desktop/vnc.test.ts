import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import * as yaml from "js-yaml";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { openDesktop as openDesktopSocket } from "../helpers/desktop";

const VNC_PASSWORD = "vnc-pass";

// A VNC desktop opened through `GET /api/desktop/{target}`: the gateway is
// the RFB client, the browser side gets JSON control messages and binary
// image frames.
describe("Web desktop - VNC", () => {
  const processes = new ProcessManager(60);
  let gateway: GatedProcess;
  let base: string;
  let api: AdminClient;
  let vnc: { port: number; container: string };

  beforeAll(async () => {
    gateway = await processes.startWg({ configPatch: { recordings: { enable: true } } });
    await waitPort(gateway.httpPort, { recv: false, process: gateway.process });
    vnc = await processes.startVncServer(VNC_PASSWORD);
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

  function inTarget(...command: string[]): string {
    const result = Bun.spawnSync(["docker", "exec", "-e", "DISPLAY=:0", vnc.container, ...command]);
    return result.stdout.toString();
  }

  async function signIn(username: string): Promise<string> {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "123" }), tls: { rejectUnauthorized: false },
    } as any);
    expect(login.status).toBe(201);
    return login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  }

  async function setup(opts: {
    password?: string;
    allowClipboard?: boolean;
    recordKeystrokes?: boolean;
    grant?: boolean;
  } = {}) {
    const role = await (await admin("POST", "/roles", {
      name: `desk-${randomUUID()}`, allow_clipboard: opts.allowClipboard ?? false,
    })).json() as { id: string };
    const user = await api.createUser({ username: `desk-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);
    const account = await (await admin("POST", "/accounts", {
      name: `desk-${randomUUID()}`, kind: "desktop-password",
      credentials: { kind: "desktop-password", username: "", password: opts.password ?? VNC_PASSWORD },
    })).json() as { id: number };
    const target = await (await admin("POST", "/targets", {
      name: `desk-${randomUUID()}`,
      options: { kind: "Vnc", host: "localhost", port: vnc.port, record_keystrokes: opts.recordKeystrokes ?? false },
      accounts: [{ account_id: account.id, role: "primary" }],
    })).json() as { id: string; name: string };
    if (opts.grant ?? true)
      await api.addTargetRole(target.id, role.id);
    return { role, user, target, cookie: await signIn(user.username) };
  }

  const openDesktop = (targetName: string, cookie: string) =>
    openDesktopSocket(gateway.httpPort, targetName, cookie);

  function recordingItems(sessionId: string): any[] {
    const config = yaml.load(readFileSync(gateway.configPath, "utf-8")) as any;
    const dir = join(config.recordings.path as string, sessionId);
    const file = readdirSync(dir).find(name => !name.endsWith(".index"))!;
    return readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  }

  test("opens the desktop, shows it and passes input on", async () => {
    const { user, target, cookie } = await setup();
    const desktop = openDesktop(target.name, cookie);
    try {
      await desktop.state("connecting");
      const connected = await desktop.state("connected");
      expect(connected.details?.address).toBe(`localhost:${vnc.port}`);
      expect(connected.details?.clipboard).toBe(false);
      const sessionId = connected.details!.session_id;

      const resize = await desktop.until("resize", () => desktop.messages.find(m => m.type === "resize"));
      expect([resize.width, resize.height]).toEqual([800, 600]);

      // The whole screen arrives as image frames.
      await desktop.until("full frame", () => {
        const pixels = desktop.images
          .filter(image => image.kind === 1 || image.kind === 2)
          .reduce((sum, image) => sum + image.width * image.height, 0);
        return pixels >= 800 * 600;
      });
      const jpeg = desktop.images.find(image => image.kind === 2)!;
      expect([...jpeg.data.subarray(0, 2)]).toEqual([0xff, 0xd8]);

      desktop.send({ type: "pointer_event", x: 123, y: 234, buttons: 0 });
      desktop.send({ type: "key_event", keysym: 0x61, down: true });
      desktop.send({ type: "key_event", keysym: 0x61, down: false });
      await desktop.until("pointer in the target", () => {
        const location = inTarget("xdotool", "getmouselocation");
        return location.includes("x:123 y:234");
      });

      // Listed while open, with the user and target.
      const { items } = await (await admin("GET", "/sessions?active_only=true")).json() as
        { items: { id: string; username: string | null; protocol: string }[] };
      const session = items.find(item => item.id === sessionId);
      expect(session?.protocol).toBe("WebVNC");
      expect(session?.username).toBe(user.username);

      desktop.socket.close();
      await desktop.ended;
      await Bun.sleep(1500);

      // Recorded, with the pointer but without the keystrokes.
      const recordings = await (await admin("GET", `/sessions/${sessionId}/recordings`)).json() as { id: string; kind: string }[];
      expect(recordings.map(recording => recording.kind)).toEqual(["Desktop"]);

      // The player reads the recording as it is stored, one item per line.
      const download = await admin("GET", `/recordings/${recordings[0]!.id}/desktop`);
      expect(download.status).toBe(200);
      const lines = (await download.text()).split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(lines[0]).toMatchObject({ type: "resize" });
      expect(lines.some(line => line.type === "png_image" || line.type === "jpeg_image")).toBe(true);
      // Only a desktop recording is served here, and only to an administrator.
      expect((await admin("GET", `/recordings/${recordings[0]!.id}/tcpdump`)).status).toBe(404);
      const unauthenticated = await fetch(`${base}/admin/api/recordings/${recordings[0]!.id}/desktop`, {
        tls: { rejectUnauthorized: false },
      } as any);
      expect([401, 403]).toContain(unauthenticated.status);
      const items2 = recordingItems(sessionId);
      expect(items2.some(item => item.type === "resize")).toBe(true);
      expect(items2.some(item => item.type === "png_image" || item.type === "jpeg_image")).toBe(true);
      expect(items2.some(item => item.type === "pointer_input" && item.x === 123)).toBe(true);
      expect(items2.some(item => item.type === "key_input")).toBe(false);
    } finally { desktop.socket.close(); }
  }, 120000);

  test("records keystrokes when the target asks for them", async () => {
    const { target, cookie } = await setup({ recordKeystrokes: true });
    const desktop = openDesktop(target.name, cookie);
    try {
      const connected = await desktop.state("connected");
      desktop.send({ type: "key_event", keysym: 0x62, down: true });
      desktop.send({ type: "pointer_event", x: 5, y: 6, buttons: 0 });
      await desktop.until("pointer in the target", () => inTarget("xdotool", "getmouselocation").includes("x:5 y:6"));
      desktop.socket.close();
      await desktop.ended;
      await Bun.sleep(1500);
      const items = recordingItems(connected.details!.session_id);
      expect(items.some(item => item.type === "key_input" && item.keysym === 0x62)).toBe(true);
    } finally { desktop.socket.close(); }
  }, 120000);

  test("a rejected password is reported without target details", async () => {
    const { target, cookie } = await setup({ password: "wrong" });
    const desktop = openDesktop(target.name, cookie);
    try {
      const closed = await desktop.state("closed");
      const error = desktop.messages.find(m => m.type === "error");
      expect(error?.message).toBe("Target connection failed: Target rejected the credentials");
      expect(JSON.stringify(desktop.messages)).not.toContain(String(vnc.port) + " ");
      expect(JSON.stringify(desktop.messages)).not.toContain("wrong");
      expect(closed.message).toBeTruthy();
    } finally { desktop.socket.close(); }
  }, 120000);

  test("a user without a role on the target is refused", async () => {
    const { target, cookie } = await setup({ grant: false });
    const desktop = openDesktop(target.name, cookie);
    try {
      const closed = await desktop.state("closed");
      expect(closed.message).toBe("Access denied to target");
      expect(desktop.images.length).toBe(0);
    } finally { desktop.socket.close(); }
  }, 120000);

  test("needs a signed-in user", async () => {
    const { target } = await setup();
    const response = await fetch(`${base}/api/desktop/${target.name}`, { tls: { rejectUnauthorized: false } } as any);
    expect(response.status).toBe(401);
  }, 120000);

  // Both sessions share one X display: the server announces a clipboard
  // change to every client, and echoes what a client sets.
  test("the clipboard is closed unless the role opens it", async () => {
    const closedRole = await setup();
    const openRole = await setup({ allowClipboard: true });
    const refused = openDesktop(closedRole.target.name, closedRole.cookie);
    const allowed = openDesktop(openRole.target.name, openRole.cookie);
    const clipboardOf = (desktop: typeof allowed, text: string) =>
      desktop.messages.find(m => m.type === "clipboard" && m.text === text);
    try {
      expect((await refused.state("connected")).details?.clipboard).toBe(false);
      expect((await allowed.state("connected")).details?.clipboard).toBe(true);

      // Allowed: reaches the target, which announces it.
      const fromAllowed = `clip-${randomUUID()}`;
      allowed.send({ type: "clipboard", text: fromAllowed });
      await allowed.until("clipboard echo", () => clipboardOf(allowed, fromAllowed));

      // Refused: never reaches the target, so nobody hears of it.
      const fromRefused = `clip-${randomUUID()}`;
      refused.send({ type: "clipboard", text: fromRefused });
      refused.send({ type: "pointer_event", x: 40, y: 41, buttons: 0 });
      await refused.until("pointer in the target", () => inTarget("xdotool", "getmouselocation").includes("x:40 y:41"));
      await Bun.sleep(1500);
      expect(clipboardOf(allowed, fromRefused)).toBeUndefined();

      // And the target's clipboard is not passed to the refused session.
      expect(refused.messages.filter(m => m.type === "clipboard")).toEqual([]);
    } finally { refused.socket.close(); allowed.socket.close(); }
  }, 120000);

  test("an administrator can close the session", async () => {
    const { target, cookie } = await setup();
    const desktop = openDesktop(target.name, cookie);
    try {
      const connected = await desktop.state("connected");
      await api.closeSession(connected.details!.session_id);
      const closed = await desktop.state("closed");
      expect(closed.message).toContain("closed by the gateway");
      await desktop.ended;
    } finally { desktop.socket.close(); }
  }, 120000);

  test("removing the role binding closes the session", async () => {
    const { role, target, cookie } = await setup();
    const desktop = openDesktop(target.name, cookie);
    try {
      await desktop.state("connected");
      await api.removeTargetRole(target.id, role.id);
      const closed = await desktop.state("closed");
      expect(closed.message).toContain("closed by the gateway");
    } finally { desktop.socket.close(); }
  }, 120000);
});
