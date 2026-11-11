import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

// Password hashing for failing logins must not hold up authorized requests:
// it runs outside the configuration provider lock.
describe("Authorization latency under failing logins", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("token-authenticated requests stay fast while passwords are being checked", async () => {
    const api = adminClient(url);
    const users: { id: string, username: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const user = await api.createUser({ username: `user-${randomUUID()}` });
      await api.createPasswordCredential(user.id, { password: "right" });
      users.push(user);
    }
    const token = await (await fetch(`${url}/admin/api/users/${users[0]!.id}/api-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gated-Token": "token-value" },
      body: JSON.stringify({ label: "t", expiry: new Date(Date.now() + 3600_000).toISOString() }),
      tls: { rejectUnauthorized: false },
    } as any)).json() as { secret: string };

    const probe = async () => {
      const started = performance.now();
      const res = await fetch(`${url}/api/targets`, {
        headers: { "X-Gated-Token": token.secret }, tls: { rejectUnauthorized: false },
      } as any);
      await res.text();
      expect(res.status).toBe(200);
      return performance.now() - started;
    };
    const baseline = Math.max(...await Promise.all([probe(), probe(), probe()]));

    let storming = true;
    const storm = Promise.all(users.map(user => fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, password: "wrong" }),
      tls: { rejectUnauthorized: false },
    } as any).then(res => res.text()))).then(() => { storming = false; });

    const latencies: number[] = [];
    while (storming) latencies.push(await probe());
    await storm;

    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length / 2)] ?? 0;
    console.log(`baseline ${baseline.toFixed(0)}ms, median under load ${median.toFixed(0)}ms over ${latencies.length} probes`);
    expect(latencies.length).toBeGreaterThan(0);
    expect(median).toBeLessThan(Math.max(250, baseline * 5));
  }, 120_000);
});
