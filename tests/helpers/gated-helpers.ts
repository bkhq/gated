import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { AdminClient } from "./api-client";
import { ProcessManager, type GatedProcess } from "./process-manager";
import { allocPort, waitPort } from "./util";

const TESTS_DIR = resolve(import.meta.dir, "..");

export const OTP_KEY_BASE64 = "Isj0ekwF1YsKW8VUUQiU4awp/9dMnyMcTPH9rlr1OsE=";
export const OTP_KEY_BASE32 = "ELEPI6SMAXKYWCS3YVKFCCEU4GWCT76XJSPSGHCM6H624WXVHLAQ";
export const PASSWORD_123_HASH = "$argon2id$v=19$m=4096,t=3,p=1$cxT6YKZS7r3uBT4nPJXEJQ$GhjTXyGi5vD2H/0X8D3VgJCZSXM4I8GiXRzl4k5ytk0";

export function wgClientEd25519PubkeyPath(): string {
  return resolve(TESTS_DIR, "ssh-keys/wg/client-ed25519.pub");
}

export function wgClientRsaPubkeyPath(): string {
  return resolve(TESTS_DIR, "ssh-keys/wg/client-rsa.pub");
}

export function readPubkey(path: string): string {
  return readFileSync(path, "utf-8").trim();
}

export function sshTargetOptions(sshPort: number): any {
  return {
    kind: "Ssh",
    host: "localhost",
    port: sshPort,
    username: "root",
    auth: { kind: "PublicKey" },
  };
}

export function postgresTargetOptions(dbPort: number): any {
  return {
    kind: "Postgres",
    host: "localhost",
    port: dbPort,
    username: "user",
    password: "123",
    tls: { mode: "Preferred", verify: false },
  };
}

export function kubernetesTokenTargetOptions(k3sPort: number, token: string): any {
  return {
    kind: "Kubernetes",
    cluster_url: `https://127.0.0.1:${k3sPort}`,
    tls: { mode: "Preferred", verify: false },
    auth: { kind: "Token", token },
  };
}

export function kubernetesCertTargetOptions(k3sPort: number, cert: string, key: string): any {
  return {
    kind: "Kubernetes",
    cluster_url: `https://127.0.0.1:${k3sPort}`,
    tls: { mode: "Preferred", verify: false },
    auth: { kind: "Certificate", certificate: cert, private_key: key },
  };
}

export async function setupUserAndSshTarget(
  api: AdminClient,
  sshPort: number,
  opts: {
    addPassword?: boolean;
    addPubkey?: boolean;
    pubkeyFile?: string;
  } = {}
) {
  const role = await api.createRole({ name: `role-${randomUUID()}` });
  const user = await api.createUser({ username: `user-${randomUUID()}` });

  if (opts.addPassword !== false) {
    await api.createPasswordCredential(user.id, { password: "123" });
  }

  if (opts.addPubkey) {
    const keyFile = opts.pubkeyFile || resolve(TESTS_DIR, "ssh-keys/id_ed25519.pub");
    await api.createPublicKeyCredential(user.id, {
      label: "Public Key",
      openssh_public_key: readFileSync(keyFile, "utf-8").trim(),
    });
  }

  await api.addUserRole(user.id, role.id);

  const target = await api.createTarget({
    name: `ssh-${randomUUID()}`,
    options: sshTargetOptions(sshPort),
  });
  await api.addTargetRole(target.id, role.id);

  return { role, user, target };
}

export const DEFAULT_OIDC_SCOPES = ["openid", "email", "profile", "preferred_username"];

export function makeSsoProviderConfig(
  oidcPort: number,
  opts: {
    autoCreateUsers?: boolean;
    roleMappings?: Record<string, string>;
    extraScopes?: string[];
  } = {}
) {
  const scopes = [...DEFAULT_OIDC_SCOPES, ...(opts.extraScopes || [])];
  const provider: any = {
    type: "custom",
    client_id: "gated-test",
    client_secret: "gated-test-secret",
    issuer_url: `http://localhost:${oidcPort}`,
    scopes,
  };
  if (opts.roleMappings) {
    provider.role_mappings = opts.roleMappings;
  }
  return {
    name: "test-oidc",
    label: "OIDC Test",
    provider,
    auto_create_users: opts.autoCreateUsers || false,
  };
}

export async function startWgWithOidc(
  processes: ProcessManager,
  wgHttpPort: number,
  oidcPort: number,
  opts: {
    autoCreateUsers?: boolean;
    roleMappings?: Record<string, string>;
    extraScopes?: string[];
  } = {}
): Promise<GatedProcess> {
  const ssoConfig = makeSsoProviderConfig(oidcPort, opts);
  const wg = await processes.startWg({
    httpPort: wgHttpPort,
    configPatch: {
      external_host: "127.0.0.1",
      sso_providers: [ssoConfig],
    },
  });
  await waitPort(wg.httpPort, { recv: false, process: wg.process });
  return wg;
}

export async function doOidcLogin(
  wgUrl: string,
  oidcPort: number,
  opts: { username?: string; password?: string } = {}
): Promise<{ cookies: Record<string, string>; response: Response }> {
  const username = opts.username || "User1";
  const password = opts.password || "pwd";

  // Start SSO — capture gated session cookies for later
  let resp = await fetch(`${wgUrl}/@gated/api/sso/providers/test-oidc/start`, {
    tls: { rejectUnauthorized: false },
  } as any);
  const gatedCookies = resp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const { url: authUrl } = (await resp.json()) as { url: string };

  // Follow to OIDC mock login page
  resp = await fetch(authUrl, { redirect: "follow" });
  const loginPageUrl = resp.url;
  const loginHtml = await resp.text();
  const oidcCookies = resp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  // Extract anti-forgery token
  let tokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]*)"/);
  if (!tokenMatch) {
    tokenMatch = loginHtml.match(/value="([^"]*)"[^>]*name="__RequestVerificationToken"/);
  }
  if (!tokenMatch) throw new Error("Could not find __RequestVerificationToken");
  const verificationToken = tokenMatch[1].replace(/&amp;/g, "&");

  // Extract ReturnUrl
  const returnUrlMatch = loginHtml.match(/name="Input\.ReturnUrl"[^>]*value="([^"]*)"/);
  if (!returnUrlMatch) throw new Error("Could not find ReturnUrl");
  const returnUrl = returnUrlMatch[1].replace(/&amp;/g, "&");

  const usesInputPrefix = loginHtml.includes('name="Input.');
  const field = (name: string) => usesInputPrefix ? `Input.${name}` : name;

  // Submit credentials
  const formData = new URLSearchParams();
  formData.set(field("Username"), username);
  formData.set(field("Password"), password);
  formData.set(usesInputPrefix ? field("Button") : "button", "login");
  formData.set(field("ReturnUrl"), returnUrl);
  formData.set("__RequestVerificationToken", verificationToken);

  resp = await fetch(loginPageUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: oidcCookies,
    },
    body: formData.toString(),
    redirect: "manual",
  });

  // Chase redirects until we reach gated's SSO return
  let redirectUrl: string | null = null;
  for (let i = 0; i < 15; i++) {
    if (![301, 302, 303, 307, 308].includes(resp.status)) break;
    let location = resp.headers.get("Location")!;
    if (location.startsWith("/")) {
      location = `http://localhost:${oidcPort}${location}`;
    }
    if (location.includes("/@gated/api/sso/return")) {
      redirectUrl = location;
      break;
    }
    // Collect cookies from intermediate redirects (strip attributes)
    const intermediateCookies = resp.headers.getSetCookie().map((c) => c.split(";")[0]);
    const cookieHeader = [oidcCookies, ...intermediateCookies].filter(Boolean).join("; ");
    resp = await fetch(location, {
      redirect: "manual",
      headers: { Cookie: cookieHeader },
    });
  }

  if (!redirectUrl) throw new Error("OIDC mock did not redirect back to gated");
  if (!redirectUrl.includes("code=")) throw new Error("Redirect URL missing authorization code");

  // Rewrite URL to match wgUrl host
  const parsedRedirect = new URL(redirectUrl);
  const parsedWg = new URL(wgUrl);
  redirectUrl = redirectUrl.replace(
    `${parsedRedirect.protocol}//${parsedRedirect.host}`,
    `${parsedWg.protocol}//${parsedWg.host}`
  );

  // Complete SSO flow on gated — must include gated session cookies
  const finalResp = await fetch(redirectUrl, {
    redirect: "manual",
    headers: { Cookie: gatedCookies },
    tls: { rejectUnauthorized: false },
  } as any);

  // Merge cookies from SSO start and SSO return
  const cookies: Record<string, string> = {};
  // First add gated session cookies from SSO start
  for (const part of gatedCookies.split("; ")) {
    const match = part.match(/^([^=]+)=(.*)$/);
    if (match) cookies[match[1]] = match[2];
  }
  // Then overlay any new cookies from SSO return
  for (const sc of finalResp.headers.getSetCookie()) {
    const match = sc.match(/^([^=]+)=([^;]*)/);
    if (match) cookies[match[1]] = match[2];
  }

  return { cookies, response: finalResp };
}
