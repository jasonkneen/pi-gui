import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
} from "../helpers/electron-app";

async function expectGoalCommand(window: Page): Promise<void> {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const sessionKey = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
      return (state.sessionCommandsBySession[sessionKey] ?? []).map((command) => command.name);
    })
    .toContain("goal");
}

test("bundles pi-goal in the packaged app", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir("pi-gui-packaged-goal-user-data-");
  const workspacePath = await makeWorkspace("packaged-goal-workspace");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });

  const harness = await launchPackagedDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Packaged goal session");
    await expectGoalCommand(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/go");
    await expect(window.getByTestId("slash-menu")).toContainText("goal");

    await composer.fill("/goal prove packaged pi-goal loads");
    await composer.press("Enter");

    await expect(window.locator(".timeline")).toContainText("Goal active: prove packaged pi-goal loads");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: prove packaged pi-goal loads",
    );
  } finally {
    await harness.close();
  }
});
