import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const verifier = fileURLToPath(new URL("./verify-linux-release.sh", import.meta.url));

function normalize(version) {
  return execFileSync("bash", [verifier, "--normalize-debian-version", version], {
    encoding: "utf8",
    env: { ...process.env, HOME: "/home/runner" },
  }).trimEnd();
}

test("normalizes Debian prerelease versions without expanding HOME", () => {
  assert.equal(normalize("0.1.0-beta.33"), "0.1.0~beta.33");
});

test("leaves stable Debian versions unchanged", () => {
  assert.equal(normalize("1.2.3"), "1.2.3");
});
