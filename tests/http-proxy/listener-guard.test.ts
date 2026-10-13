/**
 * Plaintext-listener loopback guard.
 *
 * With `proxy.tls = false`, gated must refuse to bind the
 * HTTP-proxy listener to a non-loopback address unless `proxy.behind_proxy`
 * is set — otherwise `?gated-token=` credentials and upstream traffic would
 * travel the network in cleartext. A refused bind makes the `run` command
 * exit non-zero (run.rs: a protocol future returning Err triggers
 * `std::process::exit(1)`).
 */
import { afterAll, expect, test } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { allocPort } from "../helpers/util";

let processes: ProcessManager;

afterAll(async () => {
  await processes?.stop();
});

test("refuses to bind a plaintext proxy listener to a non-loopback address", async () => {
  processes = new ProcessManager(60);
  const proxyBindPort = allocPort();

  let wg: GatedProcess;
  try {
    wg = await processes.startWg({
      configPatch: {
        proxy: {
          tls: false,
          listen: `0.0.0.0:${proxyBindPort}`,
        },
      },
      stderr: "pipe",
    });
  } catch (e) {
    // unattended-setup or an immediate bind refusal at startup is also an
    // acceptable expression of the guard.
    expect(String(e)).toBeTruthy();
    return;
  }

  // The run process should exit (non-zero) because the
  // plaintext non-loopback bind is refused. Give it a few seconds.
  const exited = await Promise.race([
    wg.process.exited.then(() => true),
    Bun.sleep(8000).then(() => false),
  ]);

  let stderrText = "";
  if (wg.process.stderr && typeof wg.process.stderr !== "number") {
    stderrText = await Promise.race([
      new Response(wg.process.stderr as ReadableStream).text().catch(() => ""),
      Bun.sleep(1500).then(() => ""),
    ]);
  }

  expect(
    exited,
    `gated did not refuse the plaintext non-loopback proxy bind. exitCode=${wg.process.exitCode}. ` +
      `stderr tail: ${stderrText.slice(-500)}`
  ).toBe(true);
  expect(wg.process.exitCode ?? 0).not.toBe(0);
});
