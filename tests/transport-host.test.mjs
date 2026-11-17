import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIRMWARE = path.join(HERE, "..", "firmware", "esp32-follow");

// Found at load time: `skip` is read when the test is registered, not when it runs.
const compiler = ["g++", "clang++", "c++"].find(
  candidate => spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0
) ?? null;
const workDir = compiler ? mkdtempSync(path.join(tmpdir(), "esp32-follow-transport-")) : null;

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test("T1 transport host tests: BLE framing, queue, router, two transports on one kernel",
  { skip: compiler ? false : "no C++ compiler" },
  () => {
    const binary = path.join(workDir, "transport_test");
    execFileSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-O1", "-o", binary,
      path.join(FIRMWARE, "host", "transport_test.cpp")], { stdio: "pipe" });
    const result = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /checks=\d+ failures=0/);
    const checks = Number(/checks=(\d+)/.exec(result.stdout)[1]);
    assert.ok(checks >= 40, `only ${checks} checks ran`);
  });
