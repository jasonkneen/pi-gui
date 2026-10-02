import assert from "node:assert/strict";
import test from "node:test";

import { verifyReleaseVersions } from "./verify-release-version.mjs";

const aligned = [
  { file: "package.json", version: "1.2.3-beta.4" },
  { file: "apps/desktop/package.json", version: "1.2.3-beta.4" },
  { file: "apps/website/package.json", version: "1.2.3-beta.4" },
];

test("accepts aligned product versions and an exact release tag", () => {
  assert.equal(verifyReleaseVersions(aligned, "v1.2.3-beta.4"), "1.2.3-beta.4");
});

test("rejects drift between product package manifests", () => {
  assert.throws(
    () =>
      verifyReleaseVersions([
        ...aligned.slice(0, 2),
        { file: "apps/website/package.json", version: "1.2.3-beta.3" },
      ]),
    /Release version drift/,
  );
});

test("rejects a tag that does not exactly match the product version", () => {
  assert.throws(
    () => verifyReleaseVersions(aligned, "v1.2.3-beta.5"),
    /does not match product version/,
  );
});

test("rejects invalid package versions", () => {
  assert.throws(
    () =>
      verifyReleaseVersions([
        ...aligned.slice(0, 2),
        { file: "apps/website/package.json", version: "not-a-version" },
      ]),
    /invalid release version/,
  );
});
