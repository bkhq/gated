import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { randomUUID } from "crypto";

// Cross-Site WebSocket Hijacking protection.
//
// WebSocket upgrades bypass the Same-Origin Policy / CORS, so the server must
// reject handshakes whose `Origin` is not the configured external host or the
// request's own host. A foreign Origin must be refused *before* `ws.on_upgrade`
// (handshake fails, no `open` event); a same-origin handshake from an
// authenticated client must still upgrade.

interface WsOutcome {
  opened: boolean;
}

/**
 * Attempt a WebSocket handshake with explicit Origin/Cookie headers and report
 * whether the upgrade succeeded (101 → `open`) or was refused (`error`/`close`).
 */
function tryWs(
  wsUrl: string,
  headers: Record<string, string>
): Promise<WsOutcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers,
      tls: { rejectUnauthorized: false },
    } as any);

    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve({ opened });
    };

    ws.addEventListener("open", () => finish(true));
    ws.addEventListener("error", () => finish(false));
    ws.addEventListener("close", () => finish(false));
    setTimeout(() => finish(false), 4000);
  });
}

describe("Gateway HTTP - WebSocket Origin validation (CSWSH)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let wsBase: string;
  let cookie: string;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    wsBase = `wss://localhost:${wg.httpPort}`;

    // Authenticate so allowed-origin handshakes reach the upgrade.
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd-ok" });

    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "pwd-ok",
    });
    expect(loginResp.status).toBe(201);
    cookie = session.getCookieString();
    expect(cookie).toContain("gated-http-session");
  }, 60_000);

  afterAll(async () => {
    await processes.stop();
  }, 30_000);

  const FOREIGN_ORIGIN = "https://evil.example.com";

  test("ssh terminal: foreign Origin is rejected", async () => {
    const { opened } = await tryWs(`${wsBase}/api/ssh/terminal/test-target`, {
      Origin: FOREIGN_ORIGIN,
      Cookie: cookie,
    });
    expect(opened).toBe(false);
  });

  test("ssh terminal: same-origin handshake upgrades", async () => {
    const { opened } = await tryWs(`${wsBase}/api/ssh/terminal/test-target`, {
      Origin: url, // https://localhost:<port> — matches the request host
      Cookie: cookie,
    });
    expect(opened).toBe(true);
  });

  test("web-auth stream: foreign Origin is rejected", async () => {
    const { opened } = await tryWs(
      `${wsBase}/api/auth/web-auth-requests/stream`,
      { Origin: FOREIGN_ORIGIN, Cookie: cookie }
    );
    expect(opened).toBe(false);
  });

  test("web-auth stream: same-origin handshake upgrades", async () => {
    const { opened } = await tryWs(
      `${wsBase}/api/auth/web-auth-requests/stream`,
      { Origin: url, Cookie: cookie }
    );
    expect(opened).toBe(true);
  });
});
