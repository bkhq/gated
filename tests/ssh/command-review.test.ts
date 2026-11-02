import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager, type GatedProcess } from "../helpers/process-manager";
import { adminClient, type AdminClient } from "../helpers/api-client";
import { waitPort } from "../helpers/util";
import {
  wgClientEd25519PubkeyPath,
  readPubkey,
  setupUserAndSshTarget,
} from "../helpers/gated-helpers";

// CMD-REVIEW: an `action=review` command-ACL rule PAUSES the SSH exec command
// until an admin approves or rejects it via the admin API. Approve => the
// command runs; reject/timeout => the command is blocked. The pause reuses the
// auth_state_store-style pending/broadcast primitive (command_review_store).
//
// Bound the review timeout so the reject/no-decision paths resolve quickly.
// Must be set before the gateway starts so the child process inherits it.
process.env.GATED_COMMAND_REVIEW_TIMEOUT_SECS =
  process.env.GATED_COMMAND_REVIEW_TIMEOUT_SECS || "3";

// Poll the admin pending-review list until at least one entry appears (the SSH
// exec pauses asynchronously). Returns the first pending review.
async function waitForPendingReview(api: AdminClient, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await api.getCommandReviews();
    if (pending.length > 0) return pending[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no pending command-review appeared before timeout");
}

describe("SSH command-review (action=review pause/approve)", () => {
  let processes: ProcessManager;
  let wg: GatedProcess;
  const timeout = Number(process.env.TIMEOUT || 15);

  beforeAll(async () => {
    processes = new ProcessManager(timeout);
    wg = await processes.startWg();
    await waitPort(wg.httpPort, { recv: false, process: wg.process });
    await waitPort(wg.sshPort, { process: wg.process });
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("admin approve => paused exec runs and is audited", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const api = adminClient(`https://localhost:${wg.httpPort}`);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    await api.createCommandAclRule({
      name: `review-approve-${target.name}`,
      priority: 10,
      protocol: "ssh",
      match_type: "keyword",
      pattern: "reviewme",
      action: "review",
    });

    // Matching command -> paused awaiting an admin decision.
    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "echo reviewme-ok",
      { password: "123" }
    );

    const review = await waitForPendingReview(api);
    expect(review.command).toBe("echo reviewme-ok");
    expect(review.origin).toBe("exec");
    expect(review.username).toBe(user.username);

    // Approve => the command is forwarded and runs.
    await api.approveCommandReview(review.id);

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("reviewme-ok");
    expect(proc.exitCode).toBe(0);
    // The pending entry is released.
    expect(await api.getCommandReviews()).toHaveLength(0);
  });

  test("admin reject => paused exec is blocked", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const api = adminClient(`https://localhost:${wg.httpPort}`);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    await api.createCommandAclRule({
      name: `review-reject-${target.name}`,
      priority: 10,
      protocol: "ssh",
      match_type: "keyword",
      pattern: "reviewme",
      action: "review",
    });

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "echo reviewme-secret",
      { password: "123" }
    );

    const review = await waitForPendingReview(api);
    await api.rejectCommandReview(review.id);

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    // The upstream command never ran, so its output never reaches the client.
    expect(stdout).not.toContain("reviewme-secret");
    expect(proc.exitCode).not.toBe(0);
    expect(await api.getCommandReviews()).toHaveLength(0);
  });

  test("no admin decision => review times out and blocks", async () => {
    const sshPort = processes.startSshServer({
      trustedKeys: [readPubkey(wgClientEd25519PubkeyPath())],
    });
    await waitPort(sshPort);

    const api = adminClient(`https://localhost:${wg.httpPort}`);
    const { user, target } = await setupUserAndSshTarget(api, sshPort);

    await api.createCommandAclRule({
      name: `review-timeout-${target.name}`,
      priority: 10,
      protocol: "ssh",
      match_type: "keyword",
      pattern: "reviewme",
      action: "review",
    });

    const proc = processes.startSshClient(
      `${user.username}:${target.name}@localhost`,
      "-p", String(wg.sshPort),
      "-i", "/dev/null",
      "-o", "PreferredAuthentications=password",
      "echo reviewme-timeout",
      { password: "123" }
    );

    // Do not decide; the bounded timeout elapses and the command is blocked.
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).not.toContain("reviewme-timeout");
    expect(proc.exitCode).not.toBe(0);
  });
});
