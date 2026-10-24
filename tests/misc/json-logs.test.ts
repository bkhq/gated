import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProcessManager } from "../helpers/process-manager";
import { waitPort } from "../helpers/util";
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import * as yaml from "js-yaml";

describe("JSON Logs", () => {
  let processes: ProcessManager;
  const timeout = Number(process.env.TIMEOUT || 10);

  beforeAll(() => {
    processes = new ProcessManager(timeout);
  });

  afterAll(async () => {
    await processes.stop();
  });

  test("json logs via config", async () => {
    const logPath = join(processes.ctx.tmpdir, `log-${randomUUID()}.log`);

    try {
      // Start gated for initial setup
      const wg = await processes.startWg();
      await waitPort(wg.httpPort, { recv: false, process: wg.process, timeout: timeout * 1000 });

      // Stop and modify config
      wg.process.kill("SIGTERM");
      try {
        await Promise.race([wg.process.exited, Bun.sleep(5000)]);
      } catch {}
      if (wg.process.exitCode === null) {
        wg.process.kill("SIGKILL");
        await wg.process.exited;
      }

      // Enable JSON logs
      const config = yaml.load(readFileSync(wg.configPath, "utf-8")) as Record<string, any>;
      config.log = config.log || {};
      config.log.format = "json";
      writeFileSync(wg.configPath, yaml.dump(config));

      // Restart with JSON log config, use file descriptor for stdout/stderr
      const fd = openSync(logPath, "w");

      const wgJson = await processes.startWg({
        shareWith: wg,
        args: ["run", "--enable-admin-token"],
        stdout: fd,
        stderr: fd,
      });

      await waitPort(wgJson.httpPort, { recv: false, process: wgJson.process, timeout: timeout * 1000 });
      await Bun.sleep(1000);

      // Make a request to generate logs
      try {
        await fetch(`https://localhost:${wgJson.httpPort}/`, {
          signal: AbortSignal.timeout(5000),
          tls: { rejectUnauthorized: false },
        } as any);
      } catch {}

      await Bun.sleep(500);

      // Stop the process so logs are flushed
      wgJson.process.kill("SIGTERM");
      try { await wgJson.process.exited; } catch {}
      closeSync(fd);

      // Validate log output
      const logContent = readFileSync(logPath, "utf-8");
      const lines = logContent.split("\n").filter((l) => l.trim());

      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const entry = JSON.parse(line);
        expect(entry).toHaveProperty("timestamp");
        expect(entry).toHaveProperty("level");
        expect(entry).toHaveProperty("target");
        expect(entry).toHaveProperty("message");
        expect(entry.timestamp).toContain("T");
        expect(["trace", "debug", "info", "warn", "error"]).toContain(entry.level);
      }
    } finally {
      try { unlinkSync(logPath); } catch {}
    }
  });

  test("json logs via cli", async () => {
    const logPath = join(processes.ctx.tmpdir, `log-${randomUUID()}.log`);

    try {
      // Start gated for initial setup
      const wg = await processes.startWg();
      await waitPort(wg.httpPort, { recv: false, process: wg.process, timeout: timeout * 1000 });

      // Stop
      wg.process.kill("SIGTERM");
      try {
        await Promise.race([wg.process.exited, Bun.sleep(5000)]);
      } catch {}
      if (wg.process.exitCode === null) {
        wg.process.kill("SIGKILL");
        await wg.process.exited;
      }

      // Restart with --log-format json
      const fd = openSync(logPath, "w");

      const wgJson = await processes.startWg({
        shareWith: wg,
        args: ["--log-format", "json", "run", "--enable-admin-token"],
        stdout: fd,
        stderr: fd,
      });

      await waitPort(wgJson.httpPort, { recv: false, process: wgJson.process, timeout: timeout * 1000 });
      await Bun.sleep(1000);

      // Stop to flush logs
      wgJson.process.kill("SIGTERM");
      try { await wgJson.process.exited; } catch {}
      closeSync(fd);

      // Validate
      const logContent = readFileSync(logPath, "utf-8");
      const lines = logContent.split("\n").filter((l) => l.trim());

      expect(lines.length).toBeGreaterThan(0);

      const entry = JSON.parse(lines[0]);
      expect(entry).toHaveProperty("timestamp");
      expect(entry).toHaveProperty("level");
      expect(entry).toHaveProperty("target");
      expect(entry).toHaveProperty("message");
    } finally {
      try { unlinkSync(logPath); } catch {}
    }
  });
});
