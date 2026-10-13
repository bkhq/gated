/**
 * HTTP reverse-proxy real access against a REAL local HTTP upstream.
 *
 * Exercises gated's Generic-flavor HTTP reverse proxy end to end: subdomain /
 * Host routing, downstream auth, the response-size cap, and request/response
 * header hygiene.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { waitPort } from "../helpers/util";
import {
  startHttpUpstream,
  proxyRequest,
  mintApiToken,
  type HttpUpstream,
  type ProxyResponse,
} from "../helpers/http-upstream";

const BASE_DOMAIN = "proxy.test";

let processes: ProcessManager;
let wg: GatedProcess;
let upstream: HttpUpstream;
let api: AdminClient;

let targetName: string;
let authorizedToken: string; // user granted the target
let unauthorizedToken: string; // valid user, NOT granted the target

let proxyHost: string;
let proxyPort: number;

function dnsLabel(): string {
  return "t" + randomUUID().replace(/-/g, "").slice(0, 24);
}

async function makeUserWithToken(wgUrl: string): Promise<{ id: string; username: string; token: string }> {
  const username = dnsLabel();
  const password = "pw-" + randomUUID();
  const user = await api.createUser({ username });
  await api.createPasswordCredential(user.id, { password });
  const token = await mintApiToken(wgUrl, username, password);
  return { id: user.id, username, token };
}

// Convenience: an authorized GET at the proxy, routed by X-Gated-Target.
function proxyGet(
  path: string,
  extraHeaders: Record<string, string> = {},
  token: string | undefined = authorizedToken
): Promise<ProxyResponse> {
  const headers: Record<string, string> = {
    "X-Gated-Target": targetName,
    ...extraHeaders,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return proxyRequest({ host: proxyHost, port: proxyPort, tls: true, path, headers });
}

beforeAll(async () => {
  processes = new ProcessManager(120);
  upstream = startHttpUpstream();

  wg = await processes.startWg({
    configPatch: { proxy: { base_domain: BASE_DOMAIN } },
  });
  await waitPort(wg.httpPort, { recv: false, process: wg.process });
  await waitPort(wg.kubernetesPort, { recv: false, process: wg.process });

  proxyHost = "127.0.0.1";
  proxyPort = wg.kubernetesPort; // unattended-setup binds the proxy here
  const wgUrl = `https://127.0.0.1:${wg.httpPort}`;
  api = adminClient(wgUrl);

  // HTTP target -> the real upstream, plaintext (tls disabled), generic flavor.
  targetName = dnsLabel();
  const role = await api.createRole({ name: `role-${randomUUID()}` });
  const target = await api.createTarget({
    name: targetName,
    options: {
      kind: "Http",
      url: upstream.url,
      tls: { mode: "Disabled", verify: false },
      upstream_auth: { kind: "None" },
      flavor: "generic",
    },
  });
  await api.addTargetRole(target.id, role.id);

  const authorized = await makeUserWithToken(wgUrl);
  await api.addUserRole(authorized.id, role.id);
  authorizedToken = authorized.token;

  // A valid, authenticated user who is NOT granted the target.
  const outsider = await makeUserWithToken(wgUrl);
  unauthorizedToken = outsider.token;
});

afterAll(async () => {
  upstream?.stop();
  await processes?.stop();
});

describe("routing", () => {
  test("routes to the upstream via X-Gated-Target header", async () => {
    const before = upstream.requests.length;
    const res = await proxyGet("/echo");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.path).toBe("/echo");
    expect(upstream.requests.length).toBe(before + 1);
  });

  test("routes to the upstream via Host header <label>.<base_domain>", async () => {
    const res = await proxyRequest({
      host: proxyHost,
      port: proxyPort,
      tls: true,
      path: "/echo",
      headers: {
        Host: `${targetName}.${BASE_DOMAIN}`,
        Authorization: `Bearer ${authorizedToken}`,
      },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).path).toBe("/echo");
  });
});

describe("auth", () => {
  test("rejects an unauthenticated request with 401", async () => {
    const res = await proxyRequest({
      host: proxyHost,
      port: proxyPort,
      tls: true,
      path: "/echo",
      headers: { "X-Gated-Target": targetName }, // no Authorization
    });
    expect(res.status).toBe(401);
  });

  test("rejects an authenticated user not granted the target with 401", async () => {
    const res = await proxyGet("/echo", {}, unauthorizedToken);
    expect(res.status).toBe(401);
  });

  test("accepts an authorized token with 200", async () => {
    const res = await proxyGet("/echo");
    expect(res.status).toBe(200);
  });
});

describe("response-size cap", () => {
  test("oversized upstream body is aborted, not fully buffered", async () => {
    const before = upstream.requests.length;
    const res = await proxyGet("/oversized", {}, authorizedToken);
    // The upstream did receive the request...
    expect(upstream.requests.length).toBe(before + 1);
    // ...but the proxy must not have relayed the full >100 MiB body to us:
    // it aborts at the cap, so the client sees an error status and/or a body
    // far smaller than the upstream's. Either proves it was not buffered whole.
    const cap = 100 * 1024 * 1024;
    const refused = res.status >= 500 || res.status === 0;
    expect(refused || res.bodyBytes <= cap).toBe(true);
    expect(res.bodyBytes).toBeLessThan(cap + 1024 * 1024);
  });
});

describe("request header hygiene toward upstream", () => {
  test("strips the inbound Host header (upstream sees gated's own host)", async () => {
    const res = await proxyGet("/echo", { "X-Client-Marker": "host-test" });
    expect(res.status).toBe(200);
    const recv = JSON.parse(res.body).headers as Record<string, string>;
    // The upstream's host must be its own authority, never a client-forged one.
    expect(recv.host ?? "").not.toContain(BASE_DOMAIN);
    expect(recv["x-client-marker"]).toBe("host-test"); // unrelated headers pass
  });

  test("strips the inbound Authorization header (gated's Bearer not leaked upstream)", async () => {
    const res = await proxyGet("/echo");
    expect(res.status).toBe(200);
    const recv = JSON.parse(res.body).headers as Record<string, string>;
    expect(recv.authorization).toBeUndefined();
  });

  // Inbound X-Forwarded-*/Forwarded/Cookie must
  // NOT be forwarded verbatim to the upstream.
  test("strips inbound X-Forwarded-*/Forwarded/Cookie from the upstream request", async () => {
    const res = await proxyGet("/echo", {
      "X-Forwarded-For": "203.0.113.7",
      "X-Forwarded-Host": "victim.internal",
      "X-Forwarded-Proto": "https",
      Forwarded: 'for=203.0.113.7;host=victim.internal;proto=https',
      Cookie: "session=stolen-session-value",
    });
    expect(res.status).toBe(200);
    const recv = JSON.parse(res.body).headers as Record<string, string>;
    expect(recv["x-forwarded-for"]).toBeUndefined();
    expect(recv["x-forwarded-host"]).toBeUndefined();
    expect(recv["x-forwarded-proto"]).toBeUndefined();
    expect(recv["forwarded"]).toBeUndefined();
    expect(recv["cookie"]).toBeUndefined();
  });
});

describe("response header hygiene from upstream", () => {
  // Upstream Set-Cookie Domain widening to a
  // parent domain must be stripped so the cookie is scoped host-only.
  test("strips parent-domain widening from upstream Set-Cookie", async () => {
    const res = await proxyGet("/set-cookie");
    expect(res.status).toBe(200);
    expect(res.setCookies.length).toBeGreaterThan(0);
    for (const sc of res.setCookies) {
      expect(sc.toLowerCase()).not.toContain("domain=");
    }
  });

  // HSTS (and other security/hop headers) from
  // the upstream must not be relayed downstream.
  test("strips upstream Strict-Transport-Security from the response", async () => {
    const res = await proxyGet("/set-cookie");
    expect(res.status).toBe(200);
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  // An off-target absolute redirect Location must
  // be dropped/neutralised rather than handed back to the client verbatim.
  test("drops off-target absolute redirect Location", async () => {
    const res = await proxyRequest({
      host: proxyHost,
      port: proxyPort,
      tls: true,
      path: "/redirect",
      headers: { "X-Gated-Target": targetName, Authorization: `Bearer ${authorizedToken}` },
    });
    const loc = res.headers["location"];
    if (loc !== undefined) {
      expect(loc).not.toContain("evil.example.com");
    } else {
      expect(loc).toBeUndefined();
    }
  });
});
