import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { AppView, DesktopAppState, WorkspaceRecord } from "../desktop-state";
import { updateSnapshot } from "./desktop-app-state";
import { getEffectiveModelRuntime } from "../model-settings";
import {
  type CustomProviderConfig,
  type DesktopNotificationPermissionStatus,
} from "../ipc";
import { SkillsView } from "../skills-view";
import { ExtensionsView } from "../extensions-view";
import { SettingsView, type SettingsSection } from "../settings-view";
import { SecondarySurface } from "../secondary-surface";

const settingsNav = [
  { id: "appearance", label: "Appearance" },
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "models", label: "Models" },
  { id: "notifications", label: "Notifications" },
] as const;

interface SecondarySurfacesProps {
  readonly api: NonNullable<typeof window.piApp>;
  readonly snapshot: DesktopAppState;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly activeView: Extract<AppView, "settings" | "skills" | "extensions">;
  readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
  readonly settingsSection: SettingsSection;
  readonly onSelectSettingsSection: (section: SettingsSection) => void;
  readonly settingsWorkspaceId: string;
  readonly onSelectSettingsWorkspace: (workspaceId: string) => void;
  readonly skillsWorkspaceId: string;
  readonly onSelectSkillsWorkspace: (workspaceId: string) => void;
  readonly extensionsWorkspaceId: string;
  readonly onSelectExtensionsWorkspace: (workspaceId: string) => void;
  readonly onBack: () => void;
  readonly onTrySkill: (command: string) => void;
}

export function SecondarySurfaces({
  api,
  snapshot,
  setSnapshot,
  activeView,
  rootWorkspaceOptions,
  settingsSection,
  onSelectSettingsSection,
  settingsWorkspaceId,
  onSelectSettingsWorkspace,
  skillsWorkspaceId,
  onSelectSkillsWorkspace,
  extensionsWorkspaceId,
  onSelectExtensionsWorkspace,
  onBack,
  onTrySkill,
}: SecondarySurfacesProps) {
  const [notificationPermissionStatus, setNotificationPermissionStatus] =
    useState<DesktopNotificationPermissionStatus>("unknown");
  const [notificationPermissionPending, setNotificationPermissionPending] = useState(false);

  const settingsWorkspace = settingsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === settingsWorkspaceId)
    : undefined;
  const skillsWorkspace = skillsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === skillsWorkspaceId)
    : undefined;
  const extensionsWorkspace = extensionsWorkspaceId
    ? rootWorkspaceOptions.find((workspace) => workspace.id === extensionsWorkspaceId)
    : undefined;
  const settingsRuntime = settingsWorkspace ? snapshot.runtimeByWorkspace[settingsWorkspace.id] : undefined;
  const settingsModelRuntime = getEffectiveModelRuntime(snapshot, settingsWorkspace);
  const skillsRuntime = skillsWorkspace ? snapshot.runtimeByWorkspace[skillsWorkspace.id] : undefined;
  const extensionsRuntime = extensionsWorkspace ? snapshot.runtimeByWorkspace[extensionsWorkspace.id] : undefined;
  const extensionsCommandCompatibility = extensionsWorkspace
    ? snapshot.extensionCommandCompatibilityByWorkspace[extensionsWorkspace.id] ?? []
    : [];

  useEffect(() => {
    const piApi = window.piApp;
    if (!piApi?.onNotificationPermissionStatusChanged) {
      return;
    }
    return piApi.onNotificationPermissionStatusChanged((status) => {
      setNotificationPermissionStatus(status);
    });
  }, []);

  const refreshNotificationPermissionStatus = useCallback(() => {
    if (!api.getNotificationPermissionStatus) {
      return Promise.resolve("unknown" as DesktopNotificationPermissionStatus);
    }
    return api.getNotificationPermissionStatus().then((status) => {
      setNotificationPermissionStatus(status);
      return status;
    });
  }, [api]);

  useEffect(() => {
    if (activeView !== "settings" || settingsSection !== "notifications") {
      return;
    }
    void refreshNotificationPermissionStatus();
  }, [activeView, refreshNotificationPermissionStatus, settingsSection]);

  const handleSetDefaultModel = (provider: string, modelId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setDefaultModel(settingsWorkspace.id, provider, modelId));
  };

  const handleSetThinkingLevel = (thinkingLevel: RuntimeSnapshot["settings"]["defaultThinkingLevel"]) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setDefaultThinkingLevel(settingsWorkspace.id, thinkingLevel));
  };

  const handleToggleSkillCommands = (enabled: boolean) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setEnableSkillCommands(settingsWorkspace.id, enabled));
  };

  const handleSetScopedModelPatterns = (patterns: readonly string[]) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setScopedModelPatterns(settingsWorkspace.id, patterns));
  };

  const handleSetModelSettingsScopeMode = (mode: "app-global" | "per-repo") => {
    void updateSnapshot(api, setSnapshot, () => api.setModelSettingsScopeMode(mode));
  };

  const handleLoginProvider = (providerId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.loginProvider(settingsWorkspace.id, providerId));
  };

  const handleLogoutProvider = (providerId: string) => {
    if (!settingsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.logoutProvider(settingsWorkspace.id, providerId));
  };

  const handleSetProviderApiKey = async (providerId: string, apiKey: string): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(api, setSnapshot, () =>
      api.setProviderApiKey(settingsWorkspace.id, providerId, apiKey),
    );
    return state.lastError;
  };

  const handleRemoveProviderApiKey = async (providerId: string): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(api, setSnapshot, () => api.logoutProvider(settingsWorkspace.id, providerId));
    return state.lastError;
  };

  const handleSaveCustomProvider = async (config: CustomProviderConfig): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(api, setSnapshot, () => api.setCustomProvider(settingsWorkspace.id, config));
    return state.lastError;
  };

  const handleDeleteCustomProvider = async (providerId: string): Promise<string | undefined> => {
    if (!settingsWorkspace) {
      return "Select a workspace first.";
    }
    const state = await updateSnapshot(api, setSnapshot, () =>
      api.deleteCustomProvider(settingsWorkspace.id, providerId),
    );
    return state.lastError;
  };

  const handleToggleSkill = (filePath: string, enabled: boolean) => {
    if (!skillsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setSkillEnabled(skillsWorkspace.id, filePath, enabled));
  };

  const handleOpenSkillFolder = (filePath: string) => {
    if (!skillsWorkspace) {
      return;
    }
    void api.openSkillInFinder(skillsWorkspace.id, filePath);
  };

  const handleToggleExtension = (filePath: string, enabled: boolean) => {
    if (!extensionsWorkspace) {
      return;
    }
    void updateSnapshot(api, setSnapshot, () => api.setExtensionEnabled(extensionsWorkspace.id, filePath, enabled));
  };

  const handleOpenExtensionFolder = (filePath: string) => {
    if (!extensionsWorkspace) {
      return;
    }
    void api.openExtensionInFinder(extensionsWorkspace.id, filePath);
  };

  const handleSetThemeMode = (mode: "system" | "light" | "dark") => {
    void updateSnapshot(api, setSnapshot, () => api.setThemeMode(mode));
  };

  const handleSetThemePresetId = (presetId: DesktopAppState["themePresetId"]) => {
    void updateSnapshot(api, setSnapshot, () => api.setThemePresetId(presetId));
  };

  const handleSetNotificationPreferences = (preferences: Partial<DesktopAppState["notificationPreferences"]>) => {
    void updateSnapshot(api, setSnapshot, () => api.setNotificationPreferences(preferences));
  };

  const handleSetIntegratedTerminalShell = (shellPath: string) => {
    void updateSnapshot(api, setSnapshot, () => api.setIntegratedTerminalShell(shellPath));
  };

  const handleRequestNotificationPermission = () => {
    if (!api.requestNotificationPermission) {
      return;
    }
    setNotificationPermissionPending(true);
    void api
      .requestNotificationPermission()
      .then((status) => {
        setNotificationPermissionStatus(status);
      })
      .finally(() => {
        setNotificationPermissionPending(false);
      });
  };

  const handleOpenSystemNotificationSettings = () => {
    if (!api.openSystemNotificationSettings) {
      return;
    }
    setNotificationPermissionPending(true);
    void api.openSystemNotificationSettings().finally(() => {
      setNotificationPermissionPending(false);
    });
  };

  if (activeView === "skills") {
    return (
      <SecondarySurface onBack={onBack} testId="skills-surface" title="Skills">
        <div className="surface-toolbar">
          <label className="surface-toolbar__field">
            <span>Workspace</span>
            <select
              value={skillsWorkspace?.id ?? ""}
              onChange={(event) => onSelectSkillsWorkspace(event.target.value)}
            >
              {rootWorkspaceOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <SkillsView
          workspace={skillsWorkspace}
          runtime={skillsRuntime}
          onOpenSkillFolder={handleOpenSkillFolder}
          onRefresh={() => {
            if (!skillsWorkspace) {
              return;
            }
            void updateSnapshot(api, setSnapshot, () => api.refreshRuntime(skillsWorkspace.id));
          }}
          onToggleSkill={handleToggleSkill}
          onTrySkill={(skill) =>
            onTrySkill(
              skill.filePath
                ? `${skill.slashCommand} `
                : "Create a new skill for this workspace and explain which files you will add.",
            )
          }
        />
      </SecondarySurface>
    );
  }

  if (activeView === "extensions") {
    return (
      <SecondarySurface onBack={onBack} testId="extensions-surface" title="Extensions">
        <div className="surface-toolbar">
          <label className="surface-toolbar__field">
            <span>Workspace</span>
            <select
              value={extensionsWorkspace?.id ?? ""}
              onChange={(event) => onSelectExtensionsWorkspace(event.target.value)}
            >
              {rootWorkspaceOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ExtensionsView
          workspace={extensionsWorkspace}
          runtime={extensionsRuntime}
          commandCompatibility={extensionsCommandCompatibility}
          onOpenExtensionFolder={handleOpenExtensionFolder}
          onRefresh={() => {
            if (!extensionsWorkspace) {
              return;
            }
            void updateSnapshot(api, setSnapshot, () => api.refreshRuntime(extensionsWorkspace.id));
          }}
          onToggleExtension={handleToggleExtension}
        />
      </SecondarySurface>
    );
  }

  return (
    <SecondarySurface
      activeNavId={settingsSection}
      navItems={settingsNav}
      onBack={onBack}
      onSelectNav={(section) => onSelectSettingsSection(section as SettingsSection)}
      testId="settings-surface"
      title="Settings"
    >
      {settingsSection === "providers" ||
      (settingsSection === "models" && snapshot.modelSettingsScopeMode === "per-repo") ? (
        <div className="surface-toolbar">
          <label className="surface-toolbar__field">
            <span>Workspace</span>
            <select
              value={settingsWorkspace?.id ?? ""}
              onChange={(event) => onSelectSettingsWorkspace(event.target.value)}
            >
              {rootWorkspaceOptions.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <SettingsView
        workspace={settingsWorkspace}
        runtime={settingsSection === "models" ? settingsModelRuntime : settingsRuntime}
        section={settingsSection}
        notificationPreferences={snapshot.notificationPreferences}
        notificationPermissionStatus={notificationPermissionStatus}
        notificationPermissionPending={notificationPermissionPending}
        modelSettingsScopeMode={snapshot.modelSettingsScopeMode}
        integratedTerminalShell={snapshot.integratedTerminalShell}
        themeMode={snapshot.themeMode}
        themePresetId={snapshot.themePresetId}
        enableTransparency={snapshot.enableTransparency}
        onLoginProvider={handleLoginProvider}
        onLogoutProvider={handleLogoutProvider}
        onSetProviderApiKey={handleSetProviderApiKey}
        onRemoveProviderApiKey={handleRemoveProviderApiKey}
        onSaveCustomProvider={handleSaveCustomProvider}
        onDeleteCustomProvider={handleDeleteCustomProvider}
        onSetModelSettingsScopeMode={handleSetModelSettingsScopeMode}
        onSetDefaultModel={handleSetDefaultModel}
        onSetNotificationPreferences={handleSetNotificationPreferences}
        onSetIntegratedTerminalShell={handleSetIntegratedTerminalShell}
        onRequestNotificationPermission={handleRequestNotificationPermission}
        onOpenSystemNotificationSettings={handleOpenSystemNotificationSettings}
        onSetScopedModelPatterns={handleSetScopedModelPatterns}
        onSetThemeMode={handleSetThemeMode}
        onSetThemePresetId={handleSetThemePresetId}
        onSetThinkingLevel={handleSetThinkingLevel}
        onToggleSkillCommands={handleToggleSkillCommands}
        onSetEnableTransparency={(enabled) => {
          void updateSnapshot(api, setSnapshot, () => api.setEnableTransparency(enabled));
        }}
      />
    </SecondarySurface>
  );
}
