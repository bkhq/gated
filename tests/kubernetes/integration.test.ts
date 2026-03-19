import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess, type K3sInstance } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import { randomUUID } from "crypto";
import { generateKeyPairSync } from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";

function runKubectl(args: string[], input?: Uint8Array, timeoutMs = 120000) {
  return Bun.spawnSync(args, {
    stdin: input ? new Blob([input]) : undefined,
    timeout: timeoutMs,
  });
}

async function loginAndGetToken(
  url: string,
  username: string,
  password: string,
  httpPort: number
): Promise<string> {
  const loginResp = await fetch(`${url}/@gated/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    tls: { rejectUnauthorized: false },
  } as any);
  if (!loginResp.ok) throw new Error(`Login failed: ${loginResp.status}`);
  const cookies = loginResp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const expiry = new Date(Date.now() + 86400000).toISOString();
  const tokenResp = await fetch(`${url}/@gated/api/profile/api-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookies },
    body: JSON.stringify({ label: `test-token-${randomUUID()}`, expiry }),
    tls: { rejectUnauthorized: false },
  } as any);
  if (!tokenResp.ok) throw new Error(`Token creation failed: ${tokenResp.status}`);
  const { secret } = (await tokenResp.json()) as { secret: string };
  return secret;
}

describe("Kubernetes Integration", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
    await waitPort(wg.kubernetesPort, { recv: false, process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("kubectl through gated with token and cert auth", async () => {
    const k3s = await processes.startK3s();
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    // Create user
    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    // Generate keypair for cert auth
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyPem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    // Issue certificate credential
    const issued = await api.issueCertificateCredential(user.id, {
      label: "kubectl-cert",
      public_key_pem: pubPem,
    });

    // Create token-based K8s target
    const tokenTargetName = `k8s-token-${randomUUID()}`;
    const tokenTarget = await api.createTarget({
      name: tokenTargetName,
      options: {
        kind: "Kubernetes",
        cluster_url: `https://127.0.0.1:${k3s.port}`,
        tls: { mode: "Preferred", verify: false },
        auth: { kind: "Token", token: k3s.token },
      },
    });
    await api.addTargetRole(tokenTarget.id, role.id);

    // Get user token
    const userToken = await loginAndGetToken(url, user.username, "123", wg.httpPort);

    const server = `https://127.0.0.1:${wg.kubernetesPort}/${tokenTargetName}`;

    // Positive token auth
    let p = runKubectl([
      "kubectl", "get", "pods",
      "--server", server,
      "--insecure-skip-tls-verify",
      "--token", userToken,
      "-n", "default",
    ]);
    expect(p.exitCode).toBe(0);

    // Negative token (wrong)
    p = runKubectl([
      "kubectl", "get", "pods",
      "--server", server,
      "--insecure-skip-tls-verify",
      "--token", userToken + "x",
      "-n", "default",
    ]);
    expect(p.exitCode).not.toBe(0);

    // Positive client-certificate auth
    const certFile = join(processes.ctx.tmpdir, `k8s-cert-${randomUUID()}.pem`);
    const keyFile = join(processes.ctx.tmpdir, `k8s-key-${randomUUID()}.pem`);
    writeFileSync(certFile, issued.certificate_pem);
    writeFileSync(keyFile, keyPem);
    const kubeconf = join(processes.ctx.tmpdir, `kubeconfig-${randomUUID()}.yaml`);
    writeFileSync(kubeconf, "apiVersion: v1\nkind: Config\n");

    p = runKubectl([
      "kubectl", "--kubeconfig", kubeconf,
      "get", "pods",
      "--server", server,
      "--insecure-skip-tls-verify",
      "--client-certificate", certFile,
      "--client-key", keyFile,
      "-n", "default",
    ]);
    expect(p.exitCode).toBe(0);

    // Negative cert (wrong key)
    const { privateKey: wrongKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wrongKeyFile = join(processes.ctx.tmpdir, `k8s-wrong-${randomUUID()}.pem`);
    writeFileSync(wrongKeyFile, wrongKey.export({ type: "pkcs1", format: "pem" }) as string);

    p = runKubectl([
      "kubectl", "--kubeconfig", kubeconf,
      "get", "pods",
      "--server", server,
      "--insecure-skip-tls-verify",
      "--client-certificate", certFile,
      "--client-key", wrongKeyFile,
      "-n", "default",
    ]);
    expect(p.exitCode).not.toBe(0);
  });

  test("kubectl run", async () => {
    const k3s = await processes.startK3s();
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    const targetName = `k8s-run-${randomUUID()}`;
    const target = await api.createTarget({
      name: targetName,
      options: {
        kind: "Kubernetes",
        cluster_url: `https://127.0.0.1:${k3s.port}`,
        tls: { mode: "Preferred", verify: false },
        auth: { kind: "Token", token: k3s.token },
      },
    });
    await api.addTargetRole(target.id, role.id);

    const userToken = await loginAndGetToken(url, user.username, "123", wg.httpPort);
    const server = `https://127.0.0.1:${wg.kubernetesPort}/${targetName}`;

    const p = runKubectl(
      [
        "kubectl", "run", "-v9",
        "--server", server,
        "--insecure-skip-tls-verify",
        "--token", userToken,
        "-n", "default",
        "test-cat", "--image=alpine:3",
        "--restart=Never", "-i", "--rm",
        "--command", "--", "cat",
      ],
      Buffer.from("hello-from-run\n")
    );
    expect(p.exitCode).toBe(0);
    expect(Buffer.from(p.stdout).toString()).toContain("hello-from-run");
  });

  test("mtls upstream and token user", async () => {
    const k3s = await processes.startK3s();
    expect(k3s.clientCert).toContain("BEGIN CERTIFICATE");
    expect(k3s.clientKey).toContain("BEGIN");

    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    const targetName = `k8s-mtls-${randomUUID()}`;
    const target = await api.createTarget({
      name: targetName,
      options: {
        kind: "Kubernetes",
        cluster_url: `https://127.0.0.1:${k3s.port}`,
        tls: { mode: "Preferred", verify: false },
        auth: { kind: "Certificate", certificate: k3s.clientCert, private_key: k3s.clientKey },
      },
    });
    await api.addTargetRole(target.id, role.id);

    const userToken = await loginAndGetToken(url, user.username, "123", wg.httpPort);
    const server = `https://127.0.0.1:${wg.kubernetesPort}/${targetName}`;

    const p = runKubectl([
      "kubectl", "get", "pods",
      "--server", server,
      "--insecure-skip-tls-verify",
      "--token", userToken,
      "-n", "default",
    ]);
    expect(p.exitCode).toBe(0);
  });

  test("kubectl exec io", async () => {
    const k3s = await processes.startK3s();
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    const targetName = `k8s-exec-${randomUUID()}`;
    const target = await api.createTarget({
      name: targetName,
      options: {
        kind: "Kubernetes",
        cluster_url: `https://127.0.0.1:${k3s.port}`,
        tls: { mode: "Preferred", verify: false },
        auth: { kind: "Token", token: k3s.token },
      },
    });
    await api.addTargetRole(target.id, role.id);

    const userToken = await loginAndGetToken(url, user.username, "123", wg.httpPort);
    const server = `https://127.0.0.1:${wg.kubernetesPort}/${targetName}`;

    // Create a pod
    const podName = `exec-test-${randomUUID().slice(0, 8)}`;
    const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: default
spec:
  containers:
  - name: alpine
    image: alpine:3
    command: ['sleep', '3600']
`;
    k3s.kubectl(["apply", "-f", "-"], Buffer.from(podYaml));

    // Wait for Running
    for (let i = 0; i < 120; i++) {
      const r = k3s.kubectl(
        ["get", "pod", podName, "-n", "default", "-o", "jsonpath={.status.phase}"],
      );
      if (Buffer.from(r.stdout).toString().trim() === "Running") break;
      await Bun.sleep(1000);
    }

    const p = runKubectl(
      [
        "kubectl", "--server", server,
        "--insecure-skip-tls-verify", "--token", userToken,
        "exec", "-i", "-n", "default", podName,
        "--", "cat",
      ],
      Buffer.from("hello-from-exec\n"),
      30000
    );
    expect(p.exitCode).toBe(0);
    expect(Buffer.from(p.stdout).toString()).toContain("hello-from-exec");
  });

  test("kubectl attach io", async () => {
    const k3s = await processes.startK3s();
    const url = `https://localhost:${wg.httpPort}`;
    const api = adminClient(url);

    const role = await api.createRole({ name: `role-${randomUUID()}` });
    const user = await api.createUser({ username: `user-${randomUUID()}` });
    await api.createPasswordCredential(user.id, { password: "123" });
    await api.addUserRole(user.id, role.id);

    const targetName = `k8s-attach-${randomUUID()}`;
    const target = await api.createTarget({
      name: targetName,
      options: {
        kind: "Kubernetes",
        cluster_url: `https://127.0.0.1:${k3s.port}`,
        tls: { mode: "Preferred", verify: false },
        auth: { kind: "Token", token: k3s.token },
      },
    });
    await api.addTargetRole(target.id, role.id);

    const userToken = await loginAndGetToken(url, user.username, "123", wg.httpPort);
    const server = `https://127.0.0.1:${wg.kubernetesPort}/${targetName}`;

    // Create a pod that reads stdin
    const podName = `attach-test-${randomUUID().slice(0, 8)}`;
    const podYaml = `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: default
spec:
  containers:
  - name: cat
    image: alpine:3
    command: ['cat']
    stdin: true
    stdinOnce: true
`;
    k3s.kubectl(["apply", "-f", "-"], Buffer.from(podYaml));

    // Wait for Running
    for (let i = 0; i < 120; i++) {
      const r = k3s.kubectl(
        ["get", "pod", podName, "-n", "default", "-o", "jsonpath={.status.phase}"],
      );
      if (Buffer.from(r.stdout).toString().trim() === "Running") break;
      await Bun.sleep(1000);
    }

    const p = runKubectl(
      [
        "kubectl", "-v9", "--server", server,
        "--insecure-skip-tls-verify", "--token", userToken,
        "attach", "-i", "-n", "default", podName,
      ],
      Buffer.from("hello-from-attach\n"),
      30000
    );
    expect(p.exitCode).toBe(0);
    expect(Buffer.from(p.stdout).toString()).toContain("hello-from-attach");
  });
});
