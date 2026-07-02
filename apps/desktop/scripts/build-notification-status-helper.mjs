import { execFile } from "node:child_process";
import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const outputDir = path.join(desktopDir, "build", "native");
const computerUseHelperExecutableName = "pi-gui-computer-use-helper";
const computerUseHelperOutputPath = path.join(outputDir, computerUseHelperExecutableName);
const computerUseHelperAppName = "pi-gui Computer Use.app";
const computerUseHelperAppPath = path.join(outputDir, computerUseHelperAppName);
const lockedUseInstallerExecutableName = "pi-gui-computer-use-locked-use-installer";
const lockedUseInstallerOutputPath = path.join(outputDir, lockedUseInstallerExecutableName);
const authorizationPluginBundleName = "PiGuiComputerUseAuthorizationPlugin.bundle";
const authorizationPluginBundlePath = path.join(outputDir, authorizationPluginBundleName);
const helpers = [
  {
    sourcePath: path.join(desktopDir, "resources", "notification-status-helper.swift"),
    outputPath: path.join(desktopDir, "build", "native", "pi-gui-notification-status-helper"),
  },
  {
    sourcePath: path.join(desktopDir, "resources", "computer-use-helper.swift"),
    outputPath: computerUseHelperOutputPath,
  },
];
const computerUseExtensionSourceDir = path.join(repoDir, "packages", "computer-use-extension");
const computerUseExtensionOutputDir = path.join(desktopDir, "out", "computer-use-extension");

if (process.platform !== "darwin") {
  console.log("Skipping notification status helper build outside macOS.");
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
for (const helper of helpers) {
  await execFileAsync("xcrun", ["swiftc", helper.sourcePath, "-O", "-o", helper.outputPath], {
    cwd: desktopDir,
  });
  console.log(`Built native helper at ${helper.outputPath}`);
}

await buildLockedUseInstaller();
await buildLockedUseAuthorizationPlugin();
await buildComputerUseHelperApp();

await rm(computerUseExtensionOutputDir, { recursive: true, force: true });
await mkdir(computerUseExtensionOutputDir, { recursive: true });
await copyFile(
  path.join(computerUseExtensionSourceDir, "package.json"),
  path.join(computerUseExtensionOutputDir, "package.json"),
);
await cp(path.join(computerUseExtensionSourceDir, "dist"), path.join(computerUseExtensionOutputDir, "dist"), {
  recursive: true,
});
console.log(`Staged Computer Use extension at ${computerUseExtensionOutputDir}`);

async function buildComputerUseHelperApp() {
  const contentsDir = path.join(computerUseHelperAppPath, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const sharedSupportDir = path.join(contentsDir, "SharedSupport");
  const appExecutablePath = path.join(macosDir, computerUseHelperExecutableName);

  await rm(computerUseHelperAppPath, { recursive: true, force: true });
  await mkdir(macosDir, { recursive: true });
  await mkdir(sharedSupportDir, { recursive: true });
  await copyFile(computerUseHelperOutputPath, appExecutablePath);
  await chmod(appExecutablePath, 0o755);
  await copyFile(lockedUseInstallerOutputPath, path.join(sharedSupportDir, lockedUseInstallerExecutableName));
  await chmod(path.join(sharedSupportDir, lockedUseInstallerExecutableName), 0o755);
  await cp(authorizationPluginBundlePath, path.join(sharedSupportDir, authorizationPluginBundleName), {
    recursive: true,
  });
  await writeFile(path.join(contentsDir, "Info.plist"), computerUseHelperInfoPlist(), "utf8");
  await writeFile(path.join(contentsDir, "PkgInfo"), "APPL????", "utf8");
  console.log(`Built Computer Use helper app at ${computerUseHelperAppPath}`);
}

async function buildLockedUseInstaller() {
  await execFileAsync(
    "xcrun",
    [
      "swiftc",
      path.join(desktopDir, "resources", "computer-use-locked-use-installer.swift"),
      "-O",
      "-o",
      lockedUseInstallerOutputPath,
    ],
    { cwd: desktopDir },
  );
  console.log(`Built Computer Use locked-use installer at ${lockedUseInstallerOutputPath}`);
}

async function buildLockedUseAuthorizationPlugin() {
  const contentsDir = path.join(authorizationPluginBundlePath, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const executablePath = path.join(macosDir, "PiGuiComputerUseAuthorizationPlugin");

  await rm(authorizationPluginBundlePath, { recursive: true, force: true });
  await mkdir(macosDir, { recursive: true });
  await execFileAsync(
    "xcrun",
    [
      "clang",
      "-bundle",
      path.join(desktopDir, "resources", "computer-use-authorization-plugin.c"),
      "-framework",
      "CoreFoundation",
      "-framework",
      "Security",
      "-lbsm",
      "-o",
      executablePath,
    ],
    { cwd: desktopDir },
  );
  await chmod(executablePath, 0o755);
  await writeFile(path.join(contentsDir, "Info.plist"), authorizationPluginInfoPlist(), "utf8");
  console.log(`Built Computer Use authorization plugin at ${authorizationPluginBundlePath}`);
}

function computerUseHelperInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>pi-gui Computer Use</string>
  <key>CFBundleExecutable</key>
  <string>${computerUseHelperExecutableName}</string>
  <key>CFBundleIdentifier</key>
  <string>com.pi-gui.desktop.computer-use-helper</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>pi-gui Computer Use</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function authorizationPluginInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>PiGuiComputerUseAuthorizationPlugin</string>
  <key>CFBundleIdentifier</key>
  <string>com.pi-gui.desktop.computer-use.authorization-plugin</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>PiGuiComputerUseAuthorizationPlugin</string>
  <key>CFBundlePackageType</key>
  <string>BNDL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
`;
}
