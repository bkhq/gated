/**
 * Self-contained local HTTP upstream for the http-proxy integration suite.
 *
 * A single Bun.serve instance that routes by request path so one upstream can
 * exercise every proxy behaviour under test:
 *   GET  /echo        -> 200, body = JSON of the exact request line + headers
 *                        the upstream actually received (used to prove that
 *                        gated stripped XFF/Forwarded/Cookie/Authorization/Host
 *                        before forwarding).
 *   GET  /set-cookie  -> 200 with a parent-domain-widened `Set-Cookie` and a
 *                        `Strict-Transport-Security` response header (used to
 *                        prove gated strips the cookie Domain widening + HSTS
 *                        from upstream responses).
 *   GET  /redirect    -> 302 with an off-target absolute `Location` (used to
 *                        prove gated drops/neutralizes it).
 *   GET  /oversized   -> 200 with a fixed body strictly larger than the proxy
 *                        response cap (used to prove gated aborts rather than
 *                        buffering the whole body).
 *
 * Every request is recorded in `requests` so a test can assert what (if
 * anything) reached the upstream — e.g. an aborted/refused proxy request must
 * leave `requests` empty.
 *
 * Dependency-free (only Bun + node:https/node:http) and torn down via stop().
 */
import { request as httpsRequest } from "https";
import { request as httpRequest } from "http";

export interface ReceivedRequest {
  method: string;
  path: string;
  /** Lower-cased header name -> value, exactly as the upstream received it. */
  headers: Record<string, string>;
}

export interface HttpUpstream {
  port: number;
  /** Plaintext base URL a gated target should point at. */
  url: string;
  /** Every request the upstream actually served, in order. */
  requests: ReceivedRequest[];
  stop(): void;
}

export interface UpstreamConfig {
  /**
   * Domain attribute the upstream widens its Set-Cookie to.
   * Defaults to `.example.com`.
   */
  cookieDomain?: string;
  /** Off-target absolute Location for /redirect. */
  redirectLocation?: string;
  /** Total bytes for /oversized. Defaults to proxy cap (100 MiB) + 1 MiB. */
  oversizedBytes?: number;
}

const PROXY_BODY_CAP = 100 * 1024 * 1024; // mirrors API_PROXY_MAX_BODY_SIZE

export function startHttpUpstream(config: UpstreamConfig = {}): HttpUpstream {
  const cookieDomain = config.cookieDomain ?? ".example.com";
  const redirectLocation =
    config.redirectLocation ?? "http://evil.example.com/stolen";
  const oversizedBytes = config.oversizedBytes ?? PROXY_BODY_CAP + 1024 * 1024;

  const requests: ReceivedRequest[] = [];

  const server = Bun.serve({
    port: 0,
    // Max idle window so a multi-hundred-MB body can drain without tripping
    // the default 10s idle timeout while the proxy buffers up to its cap.
    idleTimeout: 255,
    fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
      requests.push({ method: req.method, path: url.pathname, headers });

      switch (url.pathname) {
        case "/set-cookie":
          return new Response("cookie-set", {
            status: 200,
            headers: {
              "Set-Cookie": `gated_test=1; Domain=${cookieDomain}; Path=/`,
              "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
              "X-Upstream-Marker": "set-cookie-route",
            },
          });

        case "/redirect":
          return new Response(null, {
            status: 302,
            headers: { Location: redirectLocation },
          });

        case "/oversized": {
          // Fixed-size body (Content-Length set, no chunked encoding) so the
          // proxy takes its buffering branch and must abort BEFORE the cap is
          // exceeded. Built from a reused 1 MiB block to bound test memory.
          const block = new Uint8Array(1024 * 1024).fill(120); // 'x'
          const total = oversizedBytes;
          let sent = 0;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent >= total) {
                controller.close();
                return;
              }
              const remaining = total - sent;
              const chunk =
                remaining >= block.length ? block : block.subarray(0, remaining);
              controller.enqueue(chunk);
              sent += chunk.length;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "Content-Length": String(total) },
          });
        }

        default: {
          // /echo and everything else: echo back what the upstream received.
          return Response.json({
            method: req.method,
            path: url.pathname,
            headers,
          });
        }
      }
    },
  });

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  /** All Set-Cookie values (node exposes these separately from headers). */
  setCookies: string[];
  /** Body, truncated to `maxBodyBytes`; full byte count in `bodyBytes`. */
  body: string;
  bodyBytes: number;
}

/**
 * Issue a single request at the gated HTTP-proxy listener with full control
 * over headers (so a test can inject XFF/Forwarded/Cookie/Host and observe
 * stripping) and without following redirects. Speaks TLS when `tls` is true
 * (the default proxy mode) with verification disabled.
 */
export function proxyRequest(opts: {
  host: string; // connect target, e.g. "127.0.0.1"
  port: number;
  tls?: boolean;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  maxBodyBytes?: number;
  timeoutMs?: number;
}): Promise<ProxyResponse> {
  const tls = opts.tls ?? true;
  const maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024;
  const reqFn = tls ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = reqFn(
      {
        host: opts.host,
        port: opts.port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: opts.headers ?? {},
        rejectUnauthorized: false,
        servername: undefined,
      } as any,
      (res) => {
        const setCookies = (res.headers["set-cookie"] as string[] | undefined) ?? [];
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (k.toLowerCase() === "set-cookie") continue;
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
        }
        let bodyBytes = 0;
        const kept: Buffer[] = [];
        let keptBytes = 0;
        res.on("data", (chunk: Buffer) => {
          bodyBytes += chunk.length;
          if (keptBytes < maxBodyBytes) {
            kept.push(chunk);
            keptBytes += chunk.length;
          }
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers,
            setCookies,
            body: Buffer.concat(kept).toString("utf-8").slice(0, maxBodyBytes),
            bodyBytes,
          });
        });
        // A mid-stream abort (the proxy cutting an oversized body) surfaces
        // here; resolve with what we have so the caller can assert truncation.
        res.on("error", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers,
            setCookies,
            body: Buffer.concat(kept).toString("utf-8").slice(0, maxBodyBytes),
            bodyBytes,
          });
        });
      }
    );
    req.setTimeout(opts.timeoutMs ?? 30000, () => {
      req.destroy(new Error("proxy request timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Log in as `username`/`password` against gated's user API and mint a personal
 * API token (the Bearer credential the HTTP-proxy listener validates). Returns
 * the plaintext secret.
 */
export async function mintApiToken(
  wgUrl: string,
  username: string,
  password: string
): Promise<string> {
  const login = await fetch(`${wgUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    tls: { rejectUnauthorized: false },
  } as any);
  if (login.status >= 400) {
    throw new Error(`login failed for ${username}: ${login.status} ${await login.text()}`);
  }
  const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!cookies) throw new Error(`login for ${username} returned no session cookie`);

  const resp = await fetch(`${wgUrl}/api/profile/api-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies },
    body: JSON.stringify({
      label: `http-proxy-test-${username}`,
      expiry: "2099-12-31T23:59:59Z",
    }),
    tls: { rejectUnauthorized: false },
  } as any);
  if (resp.status >= 400) {
    throw new Error(`mint api-token failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { secret: string };
  if (!data.secret) throw new Error("api-token response missing secret");
  return data.secret;
}
