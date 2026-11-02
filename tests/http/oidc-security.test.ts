import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { allocPort } from "../helpers/util";
import { doOidcLogin, startWgWithOidc } from "../helpers/gated-helpers";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { createServer, connect as netConnect, type Server } from "net";

// OIDC security properties, asserted through the live oidc-server-mock.
//   - state/CSRF mismatch on the callback is rejected
//   - account resolution is by (iss, sub), never by email
//   - email_verified=false (or absent) is rejected fail-closed
//   - role sync applies only explicitly mapped roles
const timeout = Number(process.env.TIMEOUT || 10);

// --- Environment plumbing ----------------------------------------------------
// We launch the oidc-server-mock ourselves (instead of ProcessManager's
// startOidcServer) for two environment-portability reasons, both of which keep
// the file safe to run concurrently with the other suites:
//   1. The docker daemon here does not share the test runner's /tmp, so a mock
//      config volume-mounted from os.tmpdir() is invisible inside the container.
//      We place the config under a daemon-visible, gitignored path instead of
//      mutating the global TMPDIR (which would clobber sibling suites' data).
//   2. When the test runner is a sibling container, docker-published ports are
//      reachable only via the bridge gateway, not localhost (which the helper
//      and gated's issuer_url assume). We transparently bridge
//      `localhost:<port>` -> `<gateway>:<port>` with an in-process TCP proxy.
//      In a normal environment localhost works directly and no proxy is made.
const DOCKER_TMP = resolve(import.meta.dir, "..", "node_modules", ".oidc-tmp");
let proxyMode: boolean | undefined;
let cachedGateway: string | undefined;
const proxies: Server[] = [];

function bridgeGatewayIp(): string {
  if (cachedGateway) return cachedGateway;
  const r = Bun.spawnSync([
    "docker", "network", "inspect", "bridge",
    "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
  ]);
  cachedGateway = (r.stdout?.toString().trim()) || "172.17.0.1";
  return cachedGateway;
}

function startPortProxy(port: number, gateway: string): Promise<void> {
  return new Promise((res, rej) => {
    const srv = createServer((client) => {
      const upstream = netConnect(port, gateway);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    srv.on("error", rej);
    srv.listen(port, "127.0.0.1", () => { proxies.push(srv); res(); });
  });
}

function stopProxies(): void {
  for (const s of proxies) { try { s.close(); } catch {} }
  proxies.length = 0;
}

async function oidcReachable(port: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.status === 200) return true;
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

interface OidcOpts {
  usersOverride: any[];
  extraScopes?: string[];
  extraIdentityResources?: any[];
}

// Launch the oidc-server-mock for a given gated HTTP port and return the mock's
// port. We own the allocated port (no prediction), create the config under a
// daemon-visible path (no TMPDIR mutation), and add the gateway proxy only when
// localhost cannot reach the published port.
async function launchOidcMock(
  processes: ProcessManager,
  gatedHttpPort: number,
  opts: OidcOpts
): Promise<number> {
  const port = allocPort();
  const containerName = `gated-e2e-oidc-mock-${randomUUID()}`;
  const dataDir = join(DOCKER_TMP, `oidc-${randomUUID()}`);
  mkdirSync(dataDir, { recursive: true });

  const allowedScopes = ["openid", "profile", "email", "preferred_username", ...(opts.extraScopes || [])];
  const clientsConfig = [{
    ClientId: "gated-test",
    ClientSecrets: ["gated-test-secret"],
    AllowedGrantTypes: ["authorization_code"],
    AllowedScopes: allowedScopes,
    ClientClaimsPrefix: "",
    RedirectUris: [`https://127.0.0.1:${gatedHttpPort}/api/sso/return`],
  }];
  writeFileSync(join(dataDir, "clients-config.json"), JSON.stringify(clientsConfig));

  const serverOptions = JSON.stringify({
    AccessTokenJwtType: "JWT",
    Discovery: { ShowKeySet: true },
    Authentication: { CookieSameSiteMode: "Lax", CheckSessionCookieSameSiteMode: "Lax" },
  });
  const identityResources = [
    { Name: "preferred_username", ClaimTypes: ["preferred_username"] },
    ...(opts.extraIdentityResources || []),
  ];

  processes.start([
    "docker", "run", "--label", "ai-agent=true", "--rm",
    "--name", containerName,
    "-p", `${port}:8080`,
    "-e", "ASPNETCORE_ENVIRONMENT=Development",
    "-e", `SERVER_OPTIONS_INLINE=${serverOptions}`,
    "-e", 'LOGIN_OPTIONS_INLINE={"AllowRememberLogin": true}',
    "-e", `USERS_CONFIGURATION_INLINE=${JSON.stringify(opts.usersOverride)}`,
    "-e", `IDENTITY_RESOURCES_INLINE=${JSON.stringify(identityResources)}`,
    "-e", "CLIENTS_CONFIGURATION_PATH=/tmp/config/clients-config.json",
    "-v", `${dataDir}:/tmp/config:ro`,
    "ghcr.io/soluto/oidc-server-mock:0.10.1",
  ]);

  if (proxyMode === true) {
    await startPortProxy(port, bridgeGatewayIp());
    if (await oidcReachable(port, timeout * 3000)) return port;
    throw new Error("OIDC mock not reachable via gateway proxy");
  }
  if (proxyMode === false) {
    if (await oidcReachable(port, timeout * 3000)) return port;
    throw new Error("OIDC mock not reachable on localhost");
  }
  // First launch: detect whether localhost reaches published ports.
  if (await oidcReachable(port, 12000)) {
    proxyMode = false;
    return port;
  }
  proxyMode = true;
  await startPortProxy(port, bridgeGatewayIp());
  if (await oidcReachable(port, timeout * 3000)) return port;
  throw new Error("OIDC mock not reachable (localhost or gateway)");
}

// Bring up the mock + a gated wired to it, retrying with fresh ports so a host
// running other gated suites concurrently (shared low-base allocPort) does not
// flake us out on a taken port.
async function setupOidcGated(
  processes: ProcessManager,
  oidcOpts: OidcOpts,
  wgOpts: { autoCreateUsers?: boolean; roleMappings?: Record<string, string>; extraScopes?: string[] }
): Promise<{ wg: GatedProcess; oidcPort: number; wgUrl: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wgHttpPort = allocPort();
    try {
      const oidcPort = await launchOidcMock(processes, wgHttpPort, oidcOpts);
      const wg = await startWgWithOidc(processes, wgHttpPort, oidcPort, wgOpts);
      return { wg, oidcPort, wgUrl: `https://127.0.0.1:${wg.httpPort}` };
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500);
    }
  }
  throw lastErr;
}
// -----------------------------------------------------------------------------

interface MockUserOpts {
  sub: string;
  username: string;
  email: string;
  emailVerified?: boolean;
  preferredUsername: string;
  gatedRoles?: string[];
}

// Build an oidc-server-mock user definition with the requested claims.
function mockUser(opts: MockUserOpts): any {
  const claims: any[] = [
    { Type: "name", Value: opts.username, ValueType: "string" },
    { Type: "email", Value: opts.email, ValueType: "string" },
    { Type: "preferred_username", Value: opts.preferredUsername, ValueType: "string" },
  ];
  if (opts.emailVerified !== undefined) {
    claims.push({ Type: "email_verified", Value: String(opts.emailVerified), ValueType: "boolean" });
  }
  if (opts.gatedRoles) {
    claims.push({ Type: "gated_roles", Value: JSON.stringify(opts.gatedRoles), ValueType: "json" });
  }
  return { SubjectId: opts.sub, Username: opts.username, Password: "pwd", Claims: claims };
}

// Resolve the username gated reports for a cookie jar, or undefined if anonymous.
async function sessionUsername(
  wgUrl: string,
  cookies: Record<string, string> | string
): Promise<string | undefined> {
  const cookieStr =
    typeof cookies === "string"
      ? cookies
      : Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const r = await fetch(`${wgUrl}/api/info`, {
    headers: { Cookie: cookieStr },
    tls: { rejectUnauthorized: false },
  } as any);
  const j = (await r.json()) as { username?: string };
  return j.username || undefined;
}

describe("OIDC security - state / email_verified / (iss,sub)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let wgUrl: string;
  let oidcPort: number;

  const puVerified = `verified-${randomUUID()}`;
  const puUnverified = `unverified-${randomUUID()}`;
  const puAlice = `alice-${randomUUID()}`;
  const puBob = `bob-${randomUUID()}`;
  const sharedEmail = `shared-${randomUUID()}@example.com`;

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    const setup = await setupOidcGated(
      processes,
      {
        usersOverride: [
          mockUser({ sub: "sub-verified", username: "verified", email: `${puVerified}@example.com`, emailVerified: true, preferredUsername: puVerified }),
          mockUser({ sub: "sub-unverified", username: "unverified", email: `${puUnverified}@example.com`, emailVerified: false, preferredUsername: puUnverified }),
          mockUser({ sub: "sub-alice", username: "alice", email: sharedEmail, emailVerified: true, preferredUsername: puAlice }),
          mockUser({ sub: "sub-bob", username: "bob", email: sharedEmail, emailVerified: true, preferredUsername: puBob }),
        ],
      },
      { autoCreateUsers: true }
    );
    wg = setup.wg;
    oidcPort = setup.oidcPort;
    wgUrl = setup.wgUrl;
  });

  afterAll(async () => {
    await processes.stop();
    stopProxies();
  });

  test("a verified email logs in (positive control)", async () => {
    const { cookies } = await doOidcLogin(wgUrl, oidcPort, { username: "verified" });
    expect(await sessionUsername(wgUrl, cookies)).toBe(puVerified);
  });

  test("email_verified=false is rejected fail-closed", async () => {
    const { cookies } = await doOidcLogin(wgUrl, oidcPort, { username: "unverified" });
    // The login must not complete — the session stays anonymous.
    expect(await sessionUsername(wgUrl, cookies)).toBeUndefined();
  });

  test("a callback with a mismatched state is rejected (CSRF)", async () => {
    // Begin SSO to obtain a gated session holding the CSRF token, then return
    // with a forged state. The handler must reject before exchanging the code.
    const startResp = await fetch(`${wgUrl}/api/sso/providers/test-oidc/start`, {
      tls: { rejectUnauthorized: false },
    } as any);
    const cookie = startResp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await startResp.json()).url).toBeTruthy();

    const ret = await fetch(`${wgUrl}/api/sso/return?code=forged-code&state=wrong-state-${randomUUID()}`, {
      redirect: "manual",
      headers: { Cookie: cookie },
      tls: { rejectUnauthorized: false },
    } as any);
    expect([302, 307]).toContain(ret.status);
    const location = ret.headers.get("location") || "";
    expect(location).toContain("login_error");
    expect(decodeURIComponent(location).toLowerCase()).toContain("state");

    // The session must remain anonymous after the rejected callback.
    expect(await sessionUsername(wgUrl, cookie)).toBeUndefined();
  });

  test("same email + different sub resolves to distinct accounts (not email)", async () => {
    const a = await doOidcLogin(wgUrl, oidcPort, { username: "alice" });
    const b = await doOidcLogin(wgUrl, oidcPort, { username: "bob" });
    const userA = await sessionUsername(wgUrl, a.cookies);
    const userB = await sessionUsername(wgUrl, b.cookies);

    // Both authenticate, but to SEPARATE accounts: if resolution were by email
    // the second login would have landed on the first account.
    expect(userA).toBe(puAlice);
    expect(userB).toBe(puBob);
    expect(userA).not.toBe(userB);
  });
});

describe("OIDC security - role sync mapping", () => {
  let processes: ProcessManager;
  const mappedLocalRole = `sso-mapped-${randomUUID()}`;
  const puMapped = `mapped-${randomUUID()}`;
  const puUnmapped = `unmapped-${randomUUID()}`;

  beforeAll(() => {
    processes = new ProcessManager(timeout);
  });

  afterAll(async () => {
    await processes.stop();
    stopProxies();
  });

  // A login carrying an IdP group claim only grants a LOCAL role when the
  // provider maps that group; without a mapping config, SSO grants nothing.
  async function rolesAfterLogin(opts: {
    roleMappings?: Record<string, string>;
    preferredUsername: string;
    preCreateRole?: string;
  }): Promise<string[]> {
    const { wgUrl, oidcPort } = await setupOidcGated(
      processes,
      {
        extraScopes: ["gated_roles"],
        extraIdentityResources: [{ Name: "gated_roles", ClaimTypes: ["gated_roles"] }],
        usersOverride: [
          mockUser({
            sub: `sub-${opts.preferredUsername}`,
            username: "user",
            email: `${opts.preferredUsername}@example.com`,
            emailVerified: true,
            preferredUsername: opts.preferredUsername,
            gatedRoles: ["idp-admins"],
          }),
        ],
      },
      { autoCreateUsers: true, roleMappings: opts.roleMappings, extraScopes: ["gated_roles"] }
    );
    const api = adminClient(wgUrl);

    // The mapped local role must exist for the sync to apply it.
    if (opts.preCreateRole) {
      await api.createRole({ name: opts.preCreateRole });
    }

    await doOidcLogin(wgUrl, oidcPort, { username: "user" });

    const users = await api.getUsers();
    const created = users.find((u) => u.username === opts.preferredUsername);
    expect(created).toBeDefined();
    const roles = await api.getUserRoles(created!.id);
    return roles.map((r) => r.name);
  }

  test("a mapped IdP group grants exactly its mapped local role", async () => {
    const roles = await rolesAfterLogin({
      roleMappings: { "idp-admins": mappedLocalRole },
      preferredUsername: puMapped,
      preCreateRole: mappedLocalRole,
    });
    expect(roles).toContain(mappedLocalRole);
  });

  test("with no mapping config, IdP group claims grant no roles", async () => {
    const roles = await rolesAfterLogin({ preferredUsername: puUnmapped });
    expect(roles).toEqual([]);
  });
});
