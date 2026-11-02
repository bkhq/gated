import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { HttpSession } from "../helpers/session";
import { connect } from "tls";
import { openSync, closeSync, readFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

const TESTS_DIR = resolve(import.meta.dir, "..");

// Attacker-controlled values that land in the
// DEFAULT text log must have CR/LF / control / ANSI characters neutralized so
// they cannot forge a log line or smuggle terminal escape sequences.
//
//  - HTTP: the per-request "HTTP" span records the client
//    user-agent and x-forwarded-for header values; `sanitize_log_value`
//    backslash-escapes any control character before it is written.
//  - SSH: a client-supplied SSH username is neutralized before it
//    is recorded.
//
// End-to-end, the security property is: no client-supplied input produces a
// forged standalone log line. The HTTP request parser already rejects CR/LF
// and most control bytes in header values (so they never reach the log), and
// the OpenSSH client refuses to transmit a username containing control
// characters; the gated-side sanitizers are the defense-in-depth that this
// test exercises through the one control byte (HTAB) that survives the HTTP
// parser, plus the negative "no forged line" property for the CR/LF vectors.
describe("Misc - text log injection neutralization", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let logPath: string;
  let logFd: number;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    logPath = join(processes.ctx.tmpdir, `loginj-${randomUUID()}.log`);
    logFd = openSync(logPath, "w");
    // Default log format is text; pin the level to info so the per-request
    // span (which carries the sanitized header fields) is emitted.
    // The shared allocPort starts at a fixed low base, so on a host running
    // other gated suites concurrently a port can already be taken. Retry
    // startup; each attempt draws fresh (higher) ports and dodges the collision.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const proc = await processes.startWg({
        configPatch: { log: { level: "info" } },
        stdout: logFd,
        stderr: logFd,
      });
      try {
        await waitPort(proc.httpPort, { recv: false, process: proc.process, timeout: 20000 });
        wg = proc;
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        try { proc.process.kill("SIGKILL"); } catch {}
        await proc.process.exited.catch(() => {});
      }
    }
    if (lastErr) throw lastErr;
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
    try { closeSync(logFd); } catch {}
    try { unlinkSync(logPath); } catch {}
  });

  // Raw HTTPS request over a TLS socket so we can send byte sequences the fetch
  // client would refuse. Resolves with the full response text (or "" on error).
  function sendRaw(port: number, raw: string): Promise<string> {
    return new Promise((res) => {
      const sock = connect({ port, host: "localhost", rejectUnauthorized: false }, () => {
        sock.write(raw);
      });
      let buf = "";
      sock.on("data", (d) => (buf += d.toString()));
      sock.on("close", () => res(buf));
      sock.on("error", () => res(buf));
      setTimeout(() => { try { sock.destroy(); } catch {} res(buf); }, 3000);
    });
  }

  async function readLog(): Promise<{ raw: string; lines: string[] }> {
    // Stop the process so the text sink is flushed, then read what it wrote.
    wg.process.kill("SIGINT");
    await wg.process.exited.catch(() => {});
    closeSync(logFd);
    const raw = readFileSync(logPath, "utf-8");
    return { raw, lines: raw.split("\n") };
  }

  // All log-producing actions run here; the single test below reads + asserts.
  // (The text sink must be flushed by stopping the process before reading, so a
  // single test owns the whole lifecycle.)
  test("control/CR-LF/ANSI in HTTP headers and SSH usernames cannot forge a log line", async () => {
    const FORGED_TAB = `FORGEDTAB${randomUUID().replace(/-/g, "")}`;
    const FORGED_XFF = `FORGEDXFF${randomUUID().replace(/-/g, "")}`;
    const FORGED_CRLF = `FORGEDCRLF${randomUUID().replace(/-/g, "")}`;
    const FORGED_ESC = `FORGEDESC${randomUUID().replace(/-/g, "")}`;
    const FORGED_SSH = `FORGEDSSH${randomUUID().replace(/-/g, "")}`;

    // --- HTTP positive: a control byte (HTAB) that survives the HTTP
    // parser must be escaped in the logged span fields. The span only records
    // header values for an authenticated request, so log in first. ---
    const api = adminClient(url);
    const user = await api.createUser({ username: `loginj-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    const session = new HttpSession();
    const loginResp = await session.post(`${url}/api/auth/login`, {
      username: user.username,
      password: "123",
    });
    expect(loginResp.status).toBe(201);

    await fetch(`${url}/api/info`, {
      headers: {
        Cookie: session.getCookieString(),
        // Real TAB (0x09) characters around the markers.
        "User-Agent": `ua\t${FORGED_TAB}\tend`,
        "X-Forwarded-For": `1.2.3.4\t${FORGED_XFF}`,
      },
      tls: { rejectUnauthorized: false },
    } as any);

    // --- HTTP negative: CR/LF and ANSI/ESC injection attempts via raw
    // header bytes. The parser rejects them; nothing forged reaches the log. ---
    await sendRaw(
      wg.httpPort,
      `GET /api/info HTTP/1.1\r\nHost: localhost\r\nUser-Agent: evil\r\n2099-01-01 00:00:00  WARN ${FORGED_CRLF} injected entry\r\nConnection: close\r\n\r\n`
    );
    await sendRaw(
      wg.httpPort,
      `GET /api/info HTTP/1.1\r\nHost: localhost\r\nUser-Agent: a\x1b[31m${FORGED_ESC}\x1b[0m\r\nConnection: close\r\n\r\n`
    );

    // --- SSH username carrying CR/LF + a forged line. The OpenSSH
    // client refuses to transmit control characters in a username and the
    // gated-side sanitizer neutralizes it; either way no forged line appears. ---
    const craftedUser = `evil\r\n2099-01-01 00:00:00  WARN ${FORGED_SSH} injected entry\r\nx`;
    const sshProc = processes.startSshClient(
      "-p", String(wg.sshPort),
      "-i", join(TESTS_DIR, "ssh-keys/id_ed25519"),
      "-o", "PreferredAuthentications=publickey",
      "-o", "BatchMode=yes",
      "-l", craftedUser,
      "localhost",
      { stderr: "pipe" }
    );
    await Promise.race([sshProc.exited, Bun.sleep(8000)]);
    try { sshProc.kill("SIGKILL"); } catch {}

    // Let the final events flush, then stop + read.
    await Bun.sleep(500);
    const { raw, lines } = await readLog();

    // Sanity: the process logged something (not a vacuous pass).
    expect(lines.filter((l) => l.trim()).length).toBeGreaterThan(0);

    // HTTP positive: the user-agent TAB was logged but ESCAPED (the marker
    // is present, preceded by the two-char "\t" escape, and the line carries no
    // raw TAB byte).
    const uaLine = lines.find((l) => l.includes(FORGED_TAB));
    expect(uaLine).toBeDefined();
    expect(uaLine!).toContain(`\\t${FORGED_TAB}`);
    expect(uaLine!.includes("\t")).toBe(false);
    // x-forwarded-for is sanitized the same way.
    const xffLine = lines.find((l) => l.includes(FORGED_XFF));
    expect(xffLine).toBeDefined();
    expect(xffLine!).toContain(`\\t${FORGED_XFF}`);
    expect(xffLine!.includes("\t")).toBe(false);

    // HTTP negative: no forged standalone line from the CR/LF or ANSI
    // header-injection attempts, and no raw ESC byte anywhere from our payload.
    expect(lines.some((l) => l.trimStart().startsWith(FORGED_CRLF))).toBe(false);
    expect(lines.some((l) => l.trimStart().startsWith(FORGED_ESC))).toBe(false);
    expect(raw.includes(`\x1b[31m${FORGED_ESC}`)).toBe(false);

    // No forged standalone line from the malicious SSH username.
    expect(lines.some((l) => l.trimStart().startsWith(FORGED_SSH))).toBe(false);
  }, 120000);
});
