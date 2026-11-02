// Tiny mock k8s API for e2e testing.
//
// Replaces k3s for the k8s-token / k8s-client-cert probes — k3s would add
// ~1GB image and ~60s startup just to confirm gated injected the expected
// Authorization header. This server echoes the received Authorization
// header in JSON; the probe scripts grep the response for their unique
// test token to prove the bound account credentials reached the upstream.
//
// Listens HTTP on port 8080 by default. The k8s-client-cert scenario uses a
// SEPARATE upstream that terminates TLS with mTLS — that auth
// flavor needs the upstream to read the peer cert, which is orthogonal to
// this echo.
Bun.serve({
  port: 8080,
  fetch: (req) => {
    const url = new URL(req.url);
    const body = {
      authorization: req.headers.get("authorization"),
      method: req.method,
      path: url.pathname,
      query: url.search,
    };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  },
});
