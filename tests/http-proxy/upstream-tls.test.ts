/**
 * Upstream-TLS-Required / downgrade abort.
 *
 * When a target's upstream TLS mode is `Required` but its URL is plaintext
 * `http://`, gated must refuse the connection rather than silently downgrading
 * and forwarding the request (which would expose credentials/traffic in the
 * clear). `build_http_client` (engine.rs) enforces this at client-build time:
 * `TlsMode::Required` + an `http://` URL bails before any connection is made.
 *
 * Assertion: the proxy request fails (non-2xx) AND the plaintext upstream
 * receives ZERO requests — proving nothing was downgraded onto the wire.
 *
 * This fix IS present in the base branch, so this suite passes here.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { waitPort } from "../helpers/util";
import {
  startHttpUpstream,
  proxyRequest,
  mintApiToken,
  type HttpUpstream,
} from "../helpers/http-upstream";

let processes: ProcessManager;
let wg: GatedProcess;
let upstream: HttpUpstream;
let api: AdminClient;

let targetName: string;
let token: string;
let proxyPort: number;

function dnsLabel(): string {
  return "t" + randomUUID().replace(/-/g, "").slice(0, 24);
}

beforeAll(async () => {
  processes = new ProcessManager(120);
  upstream = startHttpUpstream();

  wg = await processes.startWg();
  await waitPort(wg.httpPort, { recv: false, process: wg.process });
  await waitPort(wg.kubernetesPort, { recv: false, process: wg.process });

  proxyPort = wg.kubernetesPort;
  const wgUrl = `https://127.0.0.1:${wg.httpPort}`;
  api = adminClient(wgUrl);

  // Target REQUIRES upstream TLS, but points at the PLAINTEXT http:// upstream.
  targetName = dnsLabel();
  const role = await api.createRole({ name: `role-${randomUUID()}` });
  const target = await api.createTarget({
    name: targetName,
    options: {
      kind: "Http",
      url: upstream.url, // http://127.0.0.1:<port>
      tls: { mode: "Required", verify: false },
      upstream_auth: { kind: "None" },
      flavor: "generic",
    },
  });
  await api.addTargetRole(target.id, role.id);

  const username = dnsLabel();
  const password = "pw-" + randomUUID();
  const user = await api.createUser({ username });
  await api.createPasswordCredential(user.id, { password });
  await api.addUserRole(user.id, role.id);
  token = await mintApiToken(wgUrl, username, password);
});

afterAll(async () => {
  upstream?.stop();
  await processes?.stop();
});

test("upstream-TLS-required target aborts on a plaintext upstream", async () => {
  const before = upstream.requests.length;
  const res = await proxyRequest({
    host: "127.0.0.1",
    port: proxyPort,
    tls: true,
    path: "/echo",
    headers: { "X-Gated-Target": targetName, Authorization: `Bearer ${token}` },
  });

  // Not a success — the downgrade is refused.
  expect(res.status).toBeGreaterThanOrEqual(500);
  // Decisive: nothing ever reached the plaintext upstream.
  expect(upstream.requests.length).toBe(before);
});
