import { spawnSync } from "child_process";
import { resolve } from "path";

// Fix SSH key permissions
const testsDir = resolve(import.meta.dir, "..");
spawnSync("chmod", ["600", ...Bun.spawnSync(["sh", "-c", `ls ${testsDir}/ssh-keys/id*`]).stdout.toString().trim().split("\n")]);

// Disable TLS verification globally for tests
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
