import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { mintApiToken } from "../helpers/http-upstream";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";

// `admin.user_api_token_allowed_endpoints` limits what a user API token can
// call; sessions and the admin token are not affected.
describe("API token endpoint allow-list", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  let url: string;
  let token: string;

  beforeAll(async () => {
    processes = new ProcessManager(Number(process.env.TIMEOUT || 10));
    wg = await processes.startWg({
      configPatch: {
        admin: {
          user_api_token_allowed_endpoints: ["GET /api/targets", "get /api/profile/*"],
        },
      },
    });
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "pwd" });
    token = await mintApiToken(url, user.username, "pwd");
  });

  afterAll(async () => {
    await processes.stop();
  });

  const call = (method: string, path: string, headers: Record<string, string>) =>
    fetch(`${url}${path}`, { method, headers, tls: { rejectUnauthorized: false } } as any);

  test("a token reaches only the listed endpoints", async () => {
    const auth = { "X-Gated-Token": token };
    expect((await call("GET", "/api/targets", auth)).status).toBe(200);
    expect((await call("GET", "/api/profile/api-tokens", auth)).status).toBe(200);
    expect((await call("GET", "/api/info", auth)).status).toBe(403);
    expect((await call("GET", "/api/targets/", auth)).status).toBe(403);
    expect((await call("DELETE", `/api/profile/api-tokens/${randomUUID()}`, auth)).status).toBe(403);
    expect((await call("GET", "/admin/api/users", auth)).status).toBe(403);
  });

  test("the admin token and anonymous requests are not limited by the list", async () => {
    expect((await call("GET", "/admin/api/users", { "X-Gated-Token": "token-value" })).status).toBe(200);
    expect((await call("GET", "/api/info", {})).status).toBe(200);
    expect((await call("GET", "/api/info", { "X-Gated-Token": "not-a-token" })).status).toBe(200);
  });
});
