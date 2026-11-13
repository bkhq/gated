import WebSocket from "ws";

export interface StateMessage {
  type: "state";
  state: "connecting" | "connected" | "closed";
  message?: string;
  details?: { session_id: string; address: string; username: string; clipboard: boolean };
}

export interface Image {
  kind: number;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Buffer;
}

/** Opens the desktop socket of a target and collects what the gateway sends:
 * JSON control messages and binary image frames. `query` is appended to the
 * URL (for example `width=1024&height=768`). */
export function openDesktop(httpPort: number, targetName: string, cookie: string, query = "") {
  const base = `https://localhost:${httpPort}`;
  const socket = new WebSocket(`wss://localhost:${httpPort}/api/desktop/${targetName}${query ? `?${query}` : ""}`, {
    headers: { Cookie: cookie, Origin: base }, rejectUnauthorized: false,
  });
  const messages: any[] = [];
  const images: Image[] = [];
  const waiters: (() => void)[] = [];
  const ended = new Promise<void>(resolve => socket.on("close", () => { resolve(); waiters.forEach(w => w()); }));
  socket.on("error", () => {});
  socket.on("message", (data, isBinary) => {
    const frame = Buffer.from(data as Buffer);
    if (isBinary) {
      images.push({
        kind: frame[0], x: frame.readUInt16LE(1), y: frame.readUInt16LE(3),
        width: frame.readUInt16LE(5), height: frame.readUInt16LE(7), data: frame.subarray(9),
      });
    } else {
      messages.push(JSON.parse(frame.toString()));
    }
    waiters.forEach(w => w());
  });
  // Resolves with the first truthy result of `check`, re-run on every frame.
  async function until<T>(what: string, check: () => T | undefined | null | false, ms = 20000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = check();
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${what} timed out; messages: ${JSON.stringify(messages)}`);
      await Promise.race([new Promise<void>(resolve => waiters.push(resolve)), Bun.sleep(250)]);
    }
  }
  const state = (name: StateMessage["state"]) =>
    until(`state ${name}`, () => messages.find(m => m.type === "state" && m.state === name) as StateMessage | undefined);
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  return { socket, messages, images, ended, until, state, send };
}
