import { expect, test } from "bun:test";
import { createServer } from "net";
import { waitPort } from "./util";

test("waitPort retries a connection closed before the service banner", async () => {
  let attempts = 0;
  const server = createServer((socket) => {
    attempts++;
    if (attempts === 1) socket.destroy();
    else socket.end("ready\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await Promise.race([
      waitPort(address.port, { timeout: 1000, readTimeout: 100 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("waitPort hung after close")), 1500)),
    ]);
    expect(attempts).toBeGreaterThan(1);
  } finally {
    server.close();
  }
});
