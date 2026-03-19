import { createConnection, type Socket } from "net";

let lastPort = 1234;

export function allocPort(): number {
  return ++lastPort;
}

export async function waitPort(
  port: number,
  opts: {
    recv?: boolean;
    timeout?: number;
    process?: import("bun").Subprocess;
    connectTimeout?: number;
    readTimeout?: number;
  } = {}
): Promise<void> {
  const {
    recv = true,
    timeout = 60000,
    process: proc,
    connectTimeout = 5000,
    readTimeout = 5000,
  } = opts;

  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) {
      throw new Error("Process exited while waiting for port");
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const sock: Socket = createConnection({ port, host: "localhost" }, () => {
          if (!recv) {
            sock.destroy();
            resolve();
            return;
          }
          sock.setTimeout(readTimeout);
          sock.once("data", () => {
            sock.destroy();
            resolve();
          });
          sock.once("timeout", () => {
            sock.destroy();
            reject(new Error("Port is open but not responding"));
          });
        });
        sock.setTimeout(connectTimeout);
        sock.once("error", (err) => {
          sock.destroy();
          reject(err);
        });
        sock.once("timeout", () => {
          sock.destroy();
          reject(new Error("Connection timeout"));
        });
      });
      return;
    } catch {
      await Bun.sleep(100);
    }
  }

  throw new Error(`Port ${port} is not up after ${timeout}ms`);
}

export async function waitMysqlPort(port: number): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const proc = Bun.spawn(
      [
        "mysql",
        "--user=root",
        "--password=123",
        "--host=127.0.0.1",
        `--port=${port}`,
        '--execute=show schemas;',
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const code = await proc.exited;
    if (code === 0) return;
    await Bun.sleep(1000);
  }
  throw new Error(`MySQL port ${port} is not up`);
}

export async function createTicket(
  url: string,
  username: string,
  targetName: string
): Promise<string> {
  const agent = new (await import("https")).Agent({ rejectUnauthorized: false });

  // Login as admin
  let resp = await fetch(`${url}/@gated/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "123" }),
    tls: { rejectUnauthorized: false },
  } as any);
  const cookies = resp.headers.getSetCookie();

  // Create ticket
  resp = await fetch(`${url}/@gated/admin/api/tickets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies.join("; "),
    },
    body: JSON.stringify({ username, target_name: targetName }),
    tls: { rejectUnauthorized: false },
  } as any);
  const data = (await resp.json()) as { secret: string };
  return data.secret;
}
