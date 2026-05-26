import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, launchDesktopAndWaitForExit, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("allows multiple isolated user-data profiles to run at the same time", async () => {
  const firstUserDataDir = await makeUserDataDir();
  const secondUserDataDir = await makeUserDataDir();
  const firstWorkspace = await makeWorkspace("isolated-profile-first");
  const secondWorkspace = await makeWorkspace("isolated-profile-second");
  let firstHarness: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  let secondHarness: Awaited<ReturnType<typeof launchDesktop>> | undefined;

  try {
    firstHarness = await launchDesktop(firstUserDataDir, {
      initialWorkspaces: [firstWorkspace],
      testMode: "background",
    });
    secondHarness = await launchDesktop(secondUserDataDir, {
      initialWorkspaces: [secondWorkspace],
      testMode: "background",
    });

    expect(await firstHarness.firstWindow()).toBeTruthy();
    expect(await secondHarness.firstWindow()).toBeTruthy();
  } finally {
    await secondHarness?.close();
    await firstHarness?.close();
  }
});

test("prevents multiple launches from sharing one custom user-data profile", async () => {
  const userDataDir = await makeUserDataDir();
  const firstWorkspace = await makeWorkspace("shared-profile-first");
  const secondWorkspace = await makeWorkspace("shared-profile-second");
  let firstHarness: Awaited<ReturnType<typeof launchDesktop>> | undefined;

  try {
    firstHarness = await launchDesktop(userDataDir, {
      initialWorkspaces: [firstWorkspace],
      testMode: "background",
    });

    expect(await firstHarness.firstWindow()).toBeTruthy();

    await launchDesktopAndWaitForExit(userDataDir, {
      agentDir: join(userDataDir, "agent"),
      initialWorkspaces: [secondWorkspace],
      testMode: "background",
    });

    expect(firstHarness.electronApp.process().exitCode).toBeNull();
  } finally {
    await firstHarness?.close();
  }
});
