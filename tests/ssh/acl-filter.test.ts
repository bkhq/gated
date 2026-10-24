import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import {
  wgClientEd25519PubkeyPath,
  readPubkey,
  setupUserAndSshTarget,
} from "../helpers/gated-helpers";

// Command-ACL enforcement on the SSH exec path. The interactive (PTY) path is
// best-effort byte-stream reconstruction and is not exercised here — see the
// unit tests in gated-core::command_acl and the reconstruction limits
// documented in gated-protocol-ssh's `filter_pty_input`.
// Bound the command-review timeout so the "no admin decision" case blocks
// quickly instead of waiting the 5-minute default. Set before the gateway
// starts so the child process inherits it.
process.env.GATED_COMMAND_REVIEW_TIMEOUT_SECS =
  process.env.GATED_COMMAND_REVIEW_TIMEOUT_SECS || "3";

describe("SSH command-ACL exec filter", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("empty ruleset does not change exec behavior (feature OFF by default)", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const api = adminClient(`https://localhost:${wg.httpPort}`);
    // No command-ACL rules exist yet: the command must pass through unchanged.
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "ls", "/bin/sh",
      { password: "123" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toBe("/bin/sh\n");
    expect(proc.exitCode).toBe(0);
  });

  test("deny rule blocks a matching exec; non-matching exec still passes", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const api = adminClient(`https://localhost:${wg.httpPort}`);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    // Deny any exec whose reconstructed command contains the `whoami` token.
    await api.createCommandAclRule({
      name: `deny-whoami-${target.name}`,
      priority: 10,
      protocol: "ssh",
      match_type: "keyword",
      pattern: "whoami",
      action: "deny",
    });

    // Matching command -> blocked: channel closed with a non-zero exit and the
    // upstream command output ("root") never reaches the client.
    const denied = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "whoami",
      { password: "123" }
    );
    const deniedOut = await new Response(denied.stdout).text();
    await denied.exited;
    expect(denied.exitCode).not.toBe(0);
    expect(deniedOut).not.toContain("root");

    // Non-matching command -> forwarded and runs normally.
    const allowed = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "ls", "/bin/sh",
      { password: "123" }
    );
    const allowedOut = await new Response(allowed.stdout).text();
    await allowed.exited;
    expect(allowedOut).toBe("/bin/sh\n");
    expect(allowed.exitCode).toBe(0);
  });

  test("role-scoped deny rule matches on SSH exec (role parity)", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const api = adminClient(`https://localhost:${wg.httpPort}`);
    // setupUserAndSshTarget assigns `role` to `user`, so a rule scoped to that
    // role must match on the SSH exec path.
    const { role, user, target } = await setupUserAndSshTarget(api, sshPort);

    await api.createCommandAclRule({
      name: `deny-whoami-role-${target.name}`,
      priority: 10,
      protocol: "ssh",
      match_type: "keyword",
      pattern: "whoami",
      action: "deny",
      role_id: role.id,
    });

    // The acting user holds the scoped role -> the deny rule matches.
    const denied = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "whoami",
      { password: "123" }
    );
    const deniedOut = await new Response(denied.stdout).text();
    await denied.exited;
    expect(denied.exitCode).not.toBe(0);
    expect(deniedOut).not.toContain("root");
  });

  test("review rule with no admin decision times out and blocks a matching exec", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const api = adminClient(`https://localhost:${wg.httpPort}`);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    // A `review` verdict PAUSES the exec awaiting an admin decision. With no
    // admin acting, the bounded timeout (GATED_COMMAND_REVIEW_TIMEOUT_SECS, set
    // for this suite) elapses and the command fails safe (blocks like deny).
    // The interactive approve/reject flow is exercised in command-review.test.ts.
    await api.createCommandAclRule({
      name: `review-hostname-${target.name}`,
      priority: 10,
      protocol: "ssh",
      match_type: "keyword",
      pattern: "hostname",
      action: "review",
    });

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "hostname",
      { password: "123" }
    );
    await new Response(proc.stdout).text();
    await proc.exited;
    expect(proc.exitCode).not.toBe(0);
  });
});
