// Tiny echo upstream: returns the request's received headers as JSON.
// Used to prove gated injected the bound http-headers account's headers
// (and not the inline empty upstream_auth).
Bun.serve({
  port: 8080,
  hostname: "0.0.0.0",
  fetch(req) {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return Response.json({
      method: req.method,
      url: req.url,
      headers,
    });
  },
});

console.log("[http-upstream] listening on 0.0.0.0:8080");
