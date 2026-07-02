import { test } from "@playwright/test";
import { launchPackagedDesktop, makeUserDataDir, makeWorkspace, writeProjectExtension } from "../helpers/electron-app";
import {
  assertComputerUseExtensionSurface,
  disabledMentionExtensionSource,
} from "./computer-use-extension-surface-assertions";

test("packaged app presents Computer Use and actionable extension mentions", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("packaged-computer-use-extension-surface");
  const disabledExtensionName = "disabled-mention-extension";
  const disabledExtensionPath = await writeProjectExtension(
    workspacePath,
    `${disabledExtensionName}.ts`,
    disabledMentionExtensionSource,
  );
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await assertComputerUseExtensionSurface(window, workspacePath, "Packaged extension mentions", {
      disabledExtensionName,
      disabledExtensionPath,
    });
  } finally {
    await harness.close();
  }
});
