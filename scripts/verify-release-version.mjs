import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export const RELEASE_PACKAGE_PATHS = [
  "package.json",
  "apps/desktop/package.json",
  "apps/website/package.json",
];

const VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function verifyReleaseVersions(packages, tag) {
  const versions = new Set();
  for (const { file, version } of packages) {
    if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
      throw new Error(`${file} has an invalid release version: ${String(version)}`);
    }
    versions.add(version);
  }

  if (versions.size !== 1) {
    throw new Error(
      `Release version drift: ${packages.map(({ file, version }) => `${file}=${String(version)}`).join(", ")}`,
    );
  }

  const [version] = versions;
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match product version v${version}`);
  }
  return version;
}

export async function readReleasePackages(repoDir) {
  return Promise.all(
    RELEASE_PACKAGE_PATHS.map(async (file) => {
      const packageJson = JSON.parse(await readFile(path.join(repoDir, file), "utf8"));
      return { file, version: packageJson.version };
    }),
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      tag: { type: "string" },
    },
  });
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoDir = path.resolve(scriptDir, "..");
  const packages = await readReleasePackages(repoDir);
  const version = verifyReleaseVersions(packages, values.tag);
  const tagSuffix = values.tag ? ` and tag ${values.tag}` : "";
  console.log(`Release version contract valid for ${version}${tagSuffix}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
