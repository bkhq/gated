/**
 * HTTP session with cookie persistence (replaces Python requests.Session)
 */
export class HttpSession {
  private cookies: Map<string, string> = new Map();

  async get(
    url: string,
    opts: {
      headers?: Record<string, string>;
      redirect?: "follow" | "manual";
    } = {}
  ): Promise<Response> {
    return this.request("GET", url, undefined, opts);
  }

  async post(
    url: string,
    body?: any,
    opts: { headers?: Record<string, string> } = {}
  ): Promise<Response> {
    return this.request("POST", url, body, opts);
  }

  private async request(
    method: string,
    url: string,
    body?: any,
    opts: {
      headers?: Record<string, string>;
      redirect?: "follow" | "manual";
    } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = { ...opts.headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const cookieStr = [...this.cookies.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (cookieStr) {
      headers["Cookie"] = cookieStr;
    }

    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: opts.redirect || "follow",
      tls: { rejectUnauthorized: false },
    } as any);

    // Store cookies from response
    for (const sc of resp.headers.getSetCookie()) {
      const match = sc.match(/^([^=]+)=([^;]*)/);
      if (match) {
        this.cookies.set(match[1], match[2]);
      }
    }

    return resp;
  }

  getCookies(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }

  getCookieString(): string {
    return [...this.cookies.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}
