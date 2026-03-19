import { spawn, type Subprocess } from "bun";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import * as yaml from "js-yaml";
import deepmerge from "deepmerge";
import { allocPort, waitPort } from "./util";

const TESTS_DIR = resolve(import.meta.dir, "..");
const CARGO_ROOT = resolve(TESTS_DIR, "..");
const BINARY_PATH = process.env.GATED_BINARY || "target/debug/gated";

export interface GatedProcess {
  configPath: string;
  process: Subprocess;
  httpPort: number;
  sshPort: number;
  mysqlPort: number;
  postgresPort: number;
  kubernetesPort: number;
}

export interface K3sInstance {
  port: number;
  token: string;
  containerName: string;
  clientCert: string;
  clientKey: string;
  kubectl(args: string[], input?: Uint8Array): { stdout: Buffer; stderr: Buffer; exitCode: number };
}

interface Child {
  process: Subprocess;
  stopSignal: string;
  stopTimeout: number;
}

export class ProcessManager {
  private children: Child[] = [];
  private tmpDir: string;
  private timeout: number;

  constructor(timeout: number = 10) {
    this.tmpDir = mkdtempSync(join(tmpdir(), "gated-test-"));
    this.timeout = timeout;
  }

  get ctx() {
    return { tmpdir: this.tmpDir };
  }

  async stop(): Promise<void> {
    for (const child of this.children) {
      try {
        child.process.kill(child.stopSignal === "SIGINT" ? "SIGINT" : "SIGTERM");
        // Wait for process to exit
        const timeout = setTimeout(() => {
          try {
            child.process.kill("SIGKILL");
          } catch {}
        }, child.stopTimeout * 1000);
        await child.process.exited.catch(() => {});
        clearTimeout(timeout);
      } catch {}
    }
  }

  startSshServer(opts: {
    trustedKeys?: string[];
    extraConfig?: string;
  } = {}): number {
    const port = allocPort();
    const dataDir = join(this.tmpDir, `sshd-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });

    const authorizedKeysPath = join(dataDir, "authorized_keys");
    writeFileSync(authorizedKeysPath, (opts.trustedKeys || []).join("\n"));
    chmodSync(authorizedKeysPath, 0o600);

    const configPath = join(dataDir, "sshd_config");
    writeFileSync(
      configPath,
      `Port 22
AuthorizedKeysFile ${authorizedKeysPath}
AllowAgentForwarding yes
AllowTcpForwarding yes
GatewayPorts yes
X11Forwarding yes
UseDNS no
PermitTunnel yes
StrictModes no
PermitRootLogin yes
HostKey /ssh-keys/id_ed25519
Subsystem\tsftp\t/usr/lib/ssh/sftp-server
LogLevel DEBUG3
${opts.extraConfig || ""}
`
    );
    chmodSync(configPath, 0o600);
    chmodSync(dataDir, 0o700);

    this.start([
      "docker", "run", "--rm",
      "-p", `${port}:22`,
      "-v", `${dataDir}:${dataDir}`,
      "-v", `${join(TESTS_DIR, "ssh-keys")}:/ssh-keys`,
      "gated-e2e-ssh-server",
      "-f", configPath,
    ]);

    return port;
  }

  startMysqlServer(): number {
    const port = allocPort();
    this.start([
      "docker", "run", "--rm",
      "-p", `${port}:3306`,
      "gated-e2e-mysql-server",
    ]);
    return port;
  }

  async startPostgresServer(): Promise<number> {
    const port = allocPort();
    const containerName = `gated-e2e-postgres-server-${randomUUID()}`;
    this.start([
      "docker", "run", "--rm",
      "--name", containerName,
      "-p", `${port}:5432`,
      "gated-e2e-postgres-server",
    ]);

    // Wait for postgres to be ready
    const deadline = Date.now() + this.timeout * 1000;
    while (Date.now() < deadline) {
      const proc = Bun.spawnSync([
        "docker", "exec", containerName,
        "pg_isready", "-h", "localhost", "-U", "user",
      ]);
      if (proc.exitCode === 0) return port;
      await Bun.sleep(1000);
    }
    throw new Error("Postgres is not ready");
  }

  async startK3s(): Promise<K3sInstance> {
    const port = allocPort();
    const containerName = `gated-e2e-k3s-${randomUUID()}`;
    const image = process.env.K3S_IMAGE || "rancher/k3s:v1.35.2-k3s1";

    this.start([
      "docker", "run", "--rm",
      "--name", containerName,
      "--privileged",
      "-p", `${port}:6443`,
      image,
      "server", "--disable", "traefik",
    ]);

    const kubectl = (args: string[], input?: Uint8Array) => {
      const result = Bun.spawnSync(
        ["docker", "exec", "-i", containerName, "kubectl", ...args],
        { stdin: input ? new Blob([input]) : undefined }
      );
      return {
        stdout: Buffer.from(result.stdout),
        stderr: Buffer.from(result.stderr),
        exitCode: result.exitCode,
      };
    };

    // Wait for k3s API
    const deadline = Date.now() + this.timeout * 5000;
    while (Date.now() < deadline) {
      const r = Bun.spawnSync(["docker", "exec", containerName, "kubectl", "get", "nodes"]);
      if (r.exitCode === 0) break;
      await Bun.sleep(1000);
    }

    // Wait for default namespace
    while (Date.now() < deadline) {
      const r = Bun.spawnSync(["docker", "exec", containerName, "kubectl", "get", "namespace", "default"]);
      if (r.exitCode === 0) break;
      await Bun.sleep(1000);
    }

    // Create service account
    Bun.spawnSync(["docker", "exec", containerName, "kubectl", "create", "serviceaccount", "test-sa", "-n", "default"]);
    Bun.spawnSync(["docker", "exec", containerName, "kubectl", "create", "clusterrolebinding", "test-sa-binding", "--clusterrole=cluster-admin", "--serviceaccount=default:test-sa"]);

    // Get token
    const tokenResult = Bun.spawnSync(["docker", "exec", containerName, "kubectl", "create", "token", "test-sa", "-n", "default"]);
    const token = Buffer.from(tokenResult.stdout).toString().trim();

    // Generate client key and CSR
    const { generateKeyPairSync, createSign } = await import("crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const clientKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

    // Create CSR using openssl
    const keyPath = join(this.tmpDir, `k3s-key-${randomUUID()}.pem`);
    const csrPath = join(this.tmpDir, `k3s-csr-${randomUUID()}.pem`);
    writeFileSync(keyPath, clientKeyPem);

    Bun.spawnSync(["openssl", "req", "-new", "-key", keyPath, "-out", csrPath, "-subj", "/CN=system:masters"]);
    const csrPem = readFileSync(csrPath);
    const csrBase64 = csrPem.toString("base64");

    const csrName = "wg-client";
    const csrYaml = `apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: ${csrName}
spec:
  groups:
  - system:authenticated
  - system:masters
  request: ${csrBase64}
  signerName: kubernetes.io/kube-apiserver-client
  usages:
  - client auth
`;

    Bun.spawnSync(
      ["docker", "exec", "-i", containerName, "sh", "-c", "kubectl apply -f -"],
      { stdin: new Blob([csrYaml]) }
    );
    Bun.spawnSync(["docker", "exec", containerName, "kubectl", "certificate", "approve", csrName]);

    // Fetch signed cert
    let clientCert = "";
    const certDeadline = Date.now() + this.timeout * 1000;
    while (Date.now() < certDeadline) {
      const r = Bun.spawnSync([
        "docker", "exec", containerName, "sh", "-c",
        `kubectl get csr ${csrName} -o jsonpath='{.status.certificate}' | base64 -d`,
      ]);
      const cert = Buffer.from(r.stdout).toString();
      if (cert && cert.includes("BEGIN CERTIFICATE")) {
        clientCert = cert;
        break;
      }
      await Bun.sleep(100);
    }

    // Bind cert user
    Bun.spawnSync([
      "docker", "exec", containerName, "kubectl", "create", "clusterrolebinding",
      "wg-cert-binding", "--clusterrole=cluster-admin", "--user=system:masters",
    ]);

    return { port, token, containerName, clientCert, clientKey: clientKeyPem, kubectl };
  }

  async startOidcServer(
    gatedHttpPort: number,
    opts: {
      extraScopes?: string[];
      usersOverride?: any[];
      extraIdentityResources?: any[];
    } = {}
  ): Promise<number> {
    const port = allocPort();
    const containerName = `gated-e2e-oidc-mock-${randomUUID()}`;
    const oidcDataDir = join(this.tmpDir, `oidc-${randomUUID()}`);
    mkdirSync(oidcDataDir, { recursive: true });

    const allowedScopes = [
      "openid", "profile", "email", "preferred_username",
      ...(opts.extraScopes || []),
    ];

    const clientsConfig = [{
      ClientId: "gated-test",
      ClientSecrets: ["gated-test-secret"],
      AllowedGrantTypes: ["authorization_code"],
      AllowedScopes: allowedScopes,
      ClientClaimsPrefix: "",
      RedirectUris: [`https://127.0.0.1:${gatedHttpPort}/@gated/api/sso/return`],
    }];

    writeFileSync(
      join(oidcDataDir, "clients-config.json"),
      JSON.stringify(clientsConfig)
    );

    const serverOptions = JSON.stringify({
      AccessTokenJwtType: "JWT",
      Discovery: { ShowKeySet: true },
      Authentication: {
        CookieSameSiteMode: "Lax",
        CheckSessionCookieSameSiteMode: "Lax",
      },
    });

    const defaultUsers = [{
      SubjectId: "1",
      Username: "User1",
      Password: "pwd",
      Claims: [
        { Type: "name", Value: "Sam Tailor", ValueType: "string" },
        { Type: "email", Value: "sam.tailor@gmail.com", ValueType: "string" },
        { Type: "preferred_username", Value: "sam_tailor", ValueType: "string" },
      ],
    }];

    const usersConfig = JSON.stringify(opts.usersOverride || defaultUsers);

    const identityResources = [
      { Name: "preferred_username", ClaimTypes: ["preferred_username"] },
      ...(opts.extraIdentityResources || []),
    ];

    this.start([
      "docker", "run", "--rm",
      "--name", containerName,
      "-p", `${port}:8080`,
      "-e", "ASPNETCORE_ENVIRONMENT=Development",
      "-e", `SERVER_OPTIONS_INLINE=${serverOptions}`,
      "-e", 'LOGIN_OPTIONS_INLINE={"AllowRememberLogin": true}',
      "-e", `USERS_CONFIGURATION_INLINE=${usersConfig}`,
      "-e", `IDENTITY_RESOURCES_INLINE=${JSON.stringify(identityResources)}`,
      "-e", "CLIENTS_CONFIGURATION_PATH=/tmp/config/clients-config.json",
      "-v", `${oidcDataDir}:/tmp/config:ro`,
      "ghcr.io/soluto/oidc-server-mock:0.10.1",
    ]);

    // Wait for OIDC to be ready
    const deadline = Date.now() + this.timeout * 3000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://localhost:${port}/.well-known/openid-configuration`, {
          signal: AbortSignal.timeout(2000),
        });
        if (r.status === 200) return port;
      } catch {}
      await Bun.sleep(500);
    }
    throw new Error("OIDC mock is not ready");
  }

  startSshClient(
    ...args: (string | { password?: string; stderr?: "pipe" })[]
  ): Subprocess {
    // Extract options object if last arg is an object
    let password: string | undefined;
    let stderrMode: "pipe" | "inherit" = "inherit";
    const strArgs: string[] = [];

    for (const arg of args) {
      if (typeof arg === "object" && arg !== null) {
        password = arg.password;
        if (arg.stderr === "pipe") stderrMode = "pipe";
      } else {
        strArgs.push(arg);
      }
    }

    const preargs: string[] = [];
    if (password) {
      preargs.push("sshpass", "-p", password);
    }

    return this.start([
      ...preargs,
      "ssh",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeychecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      ...strArgs,
    ], { stdin: "pipe", stdout: "pipe", stderr: stderrMode });
  }

  async startWg(opts: {
    configPatch?: Record<string, any>;
    args?: string[];
    shareWith?: GatedProcess;
    stderr?: any;
    stdout?: any;
    httpPort?: number;
  } = {}): Promise<GatedProcess> {
    const runArgs = opts.args || ["run", "--enable-admin-token"];
    let configPath: string;
    let sshPort: number;
    let httpPort: number;
    let mysqlPort: number;
    let postgresPort: number;
    let kubernetesPort: number;

    if (opts.shareWith) {
      configPath = opts.shareWith.configPath;
      sshPort = opts.shareWith.sshPort;
      httpPort = opts.shareWith.httpPort;
      mysqlPort = opts.shareWith.mysqlPort;
      postgresPort = opts.shareWith.postgresPort;
      kubernetesPort = opts.shareWith.kubernetesPort;
    } else {
      sshPort = allocPort();
      httpPort = opts.httpPort || allocPort();
      mysqlPort = allocPort();
      postgresPort = allocPort();
      kubernetesPort = allocPort();

      const dataDir = join(this.tmpDir, `wg-data-${randomUUID()}`);
      mkdirSync(dataDir, { recursive: true });

      const keysDir = join(dataDir, "ssh-keys");
      mkdirSync(keysDir, { recursive: true });

      for (const k of [
        "ssh-keys/wg/client-ed25519",
        "ssh-keys/wg/client-rsa",
        "ssh-keys/wg/host-ed25519",
        "ssh-keys/wg/host-rsa",
      ]) {
        copyFileSync(join(TESTS_DIR, k), join(keysDir, k.split("/").pop()!));
      }

      for (const k of [
        "certs/tls.certificate.pem",
        "certs/tls.key.pem",
      ]) {
        copyFileSync(join(TESTS_DIR, k), join(dataDir, k.split("/").pop()!));
      }

      configPath = join(dataDir, "gated.yaml");

      // Run unattended-setup
      const setupProc = this.startGatedProcess(
        [
          "unattended-setup",
          "--ssh-port", String(sshPort),
          "--http-port", String(httpPort),
          "--mysql-port", String(mysqlPort),
          "--postgres-port", String(postgresPort),
          "--kubernetes-port", String(kubernetesPort),
          "--data-path", dataDir,
          "--external-host", "external-host",
        ],
        { GATED_ADMIN_PASSWORD: "123" },
        configPath
      );
      await setupProc.exited;
      if (setupProc.exitCode !== 0) {
        throw new Error(`Gated unattended-setup failed with code ${setupProc.exitCode}`);
      }

      // Patch config
      let config = yaml.load(readFileSync(configPath, "utf-8")) as Record<string, any>;
      config.ssh = config.ssh || {};
      config.ssh.host_key_verification = "auto_accept";
      if (opts.configPatch) {
        config = deepmerge(config, opts.configPatch);
      }
      writeFileSync(configPath, yaml.dump(config));
    }

    const proc = this.startGatedProcess(
      runArgs,
      { GATED_ADMIN_TOKEN: "token-value" },
      configPath,
      opts.stdout,
      opts.stderr
    );

    return {
      configPath,
      process: proc,
      httpPort,
      sshPort,
      mysqlPort,
      postgresPort,
      kubernetesPort,
    };
  }

  private startGatedProcess(
    args: string[],
    extraEnv: Record<string, string> = {},
    configPath?: string,
    stdout?: any,
    stderr?: any
  ): Subprocess {
    const binaryFullPath = resolve(CARGO_ROOT, BINARY_PATH);
    const cmdArgs = configPath
      ? [binaryFullPath, "--config", configPath, ...args]
      : [binaryFullPath, ...args];

    return this.start(cmdArgs, {
      cwd: CARGO_ROOT,
      env: { ...process.env, ...extraEnv },
      stopSignal: "SIGINT",
      stopTimeout: 5,
      stdout,
      stderr,
    });
  }

  start(
    args: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      stdin?: "pipe" | "inherit";
      stdout?: "pipe" | "inherit" | any;
      stderr?: "pipe" | "inherit" | any;
      stopSignal?: string;
      stopTimeout?: number;
    } = {}
  ): Subprocess {
    const proc = spawn(args, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin || "inherit",
      stdout: opts.stdout || "inherit",
      stderr: opts.stderr || "inherit",
    });

    this.children.push({
      process: proc,
      stopSignal: opts.stopSignal || "SIGTERM",
      stopTimeout: opts.stopTimeout || 3,
    });

    return proc;
  }
}
