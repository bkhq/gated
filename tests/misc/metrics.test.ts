import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager } from "../helpers/process-manager";
import { allocPort, waitPort } from "../helpers/util";

describe("Prometheus /metrics endpoint", () => {
  let processes: ProcessManager;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(() => {
    processes = new ProcessManager(timeout);
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("exposes metrics when enabled; closed when disabled", async () => {
    // --- Case 1: metrics disabled (default) ------------------------------
    const wgOff = await processes.startWg();
    await waitPort(wgOff.httpPort, { recv: false, process: wgOff.process, timeout: timeout * 1000 });

    // Port 9090 on loopback must NOT be listening when disabled.
    let connectErr: unknown = null;
    try {
      await fetch("http://127.0.0.1:9090/metrics", { signal: AbortSignal.timeout(500) });
    } catch (e) {
      connectErr = e;
    }
    expect(connectErr).not.toBeNull();

    wgOff.process.kill("SIGTERM");
    try { await wgOff.process.exited; } catch {}

    // --- Case 2: metrics enabled on a random loopback port ---------------
    const metricsPort = allocPort();
    const wgOn = await processes.startWg({
      configPatch: {
        metrics: { enable: true, listen: `127.0.0.1:${metricsPort}` },
      },
    });
    await waitPort(wgOn.httpPort, { recv: false, process: wgOn.process, timeout: timeout * 1000 });
    await waitPort(metricsPort, { recv: false, process: wgOn.process, timeout: timeout * 1000 });

    // Fire a bogus login so `gated_auth_attempts_total{result=rejected}`
    // becomes a non-empty family. The label-free `gated_config_reload_total`
    // is always present because it's zero-initialised at recorder install.
    try {
      await fetch(`https://localhost:${wgOn.httpPort}/api/auth/login`, {
        method: "POST",
        signal: AbortSignal.timeout(3000),
        tls: { rejectUnauthorized: false },
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "no-such-user", password: "x" }),
      } as any);
    } catch {}

    const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(res.ok).toBe(true);
    const body = await res.text();
    expect(body).toContain("# TYPE gated_");
    expect(body).toContain("gated_auth_attempts_total");
    expect(body).toContain("gated_config_reload_total");
  }, 120_000);
});
