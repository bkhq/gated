import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager } from "../helpers/process-manager";
import { allocPort, waitPort } from "../helpers/util";

describe("/healthz and /readyz", () => {
  let processes: ProcessManager;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(() => {
    processes = new ProcessManager(timeout);
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("liveness stays green; readiness returns a deep-check JSON report", async () => {
    const metricsPort = allocPort();
    const wg = await processes.startWg({
      configPatch: {
        metrics: { enable: true, listen: `127.0.0.1:${metricsPort}` },
      },
    });
    await waitPort(wg.httpPort, { recv: false, process: wg.process, timeout: timeout * 1000 });
    await waitPort(metricsPort, { recv: false, process: wg.process, timeout: timeout * 1000 });

    // /healthz: static 200 / "ok"
    const live = await fetch(`http://127.0.0.1:${metricsPort}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(live.status).toBe(200);
    expect((await live.text()).trim()).toBe("ok");

    // /readyz: JSON report, 200 when all checks pass
    const ready = await fetch(`http://127.0.0.1:${metricsPort}/readyz`, {
      signal: AbortSignal.timeout(5000),
    });
    expect([200, 503]).toContain(ready.status);
    const report = (await ready.json()) as {
      status: "ok" | "warn" | "fail";
      generated_at: string;
      checks: Array<{ name: string; status: "ok" | "warn" | "fail"; message?: string }>;
    };
    expect(["ok", "warn", "fail"]).toContain(report.status);
    expect(report.generated_at).toContain("T");
    // All three local DB checks must be present in the report.
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("db.ping");
    expect(names).toContain("db.migrations");
    expect(names).toContain("db.tx_roundtrip");
    expect(names).toContain("tls.cert");
    // LDAP / SSO are skipped on the /readyz path (skip_lookups=true).
    expect(names).not.toContain("ldap.reachability");
    expect(names).not.toContain("sso.reachability");
    // Fresh test-container setup should have everything green.
    for (const c of report.checks) {
      if (c.status !== "ok") {
        throw new Error(`unexpected non-ok check: ${JSON.stringify(c)}`);
      }
    }
  }, 120_000);
});
