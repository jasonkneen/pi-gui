import type {
  DesktopComputerUsePrivacyPane,
  DesktopComputerUseStatus,
  DesktopComputerUseStatusValue,
} from "./ipc";
import { SettingsGroup, SettingsInfoRow, SettingsRow } from "./settings-utils";

interface SettingsComputerUseSectionProps {
  readonly status?: DesktopComputerUseStatus;
  readonly pending: boolean;
  readonly onRefresh: () => void;
  readonly onSetLockedUseEnabled: (enabled: boolean) => void;
  readonly onOpenPrivacySettings: (pane: DesktopComputerUsePrivacyPane) => void;
}

export function SettingsComputerUseSection({
  status,
  pending,
  onRefresh,
  onSetLockedUseEnabled,
  onOpenPrivacySettings,
}: SettingsComputerUseSectionProps) {
  return (
    <>
      <SettingsGroup title="Status">
        <SettingsRow title="Helper" description={status?.helperPath}>
          <span className="settings-row__value">{helperLabel(status, pending)}</span>
        </SettingsRow>
        <SettingsInfoRow label="Desktop" value={desktopLabel(status?.desktop)} />
        <SettingsInfoRow label="Frontmost app" value={frontmostAppLabel(status?.frontmostApp)} />
        <SettingsRow
          title="Locked computer use"
          description="Lets pi-gui continue an active Computer Use turn after macOS locks. macOS will ask for an administrator password."
        >
          <LockedUseControl
            status={status}
            pending={pending}
            onSetEnabled={onSetLockedUseEnabled}
          />
        </SettingsRow>
        <SettingsInfoRow label="Locked setup" value={lockedUseInstallerLabel(status?.lockedUseInstaller)} />
        {status?.message ? <SettingsRow title="Details" description={status.message} /> : null}
        <SettingsRow title="Refresh status">
          <button className="button button--secondary" disabled={pending} type="button" onClick={onRefresh}>
            Refresh
          </button>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="macOS access">
        <SettingsRow title="Accessibility" description="Required for inspecting controls and using accessibility actions.">
          <PermissionControl
            status={status?.accessibility}
            onOpen={() => onOpenPrivacySettings("accessibility")}
          />
        </SettingsRow>
        <SettingsRow title="Screen Recording" description="Required for screenshots returned by get_app_state.">
          <PermissionControl
            status={status?.screenRecording}
            onOpen={() => onOpenPrivacySettings("screen-recording")}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

function LockedUseControl({
  status,
  pending,
  onSetEnabled,
}: {
  readonly status?: DesktopComputerUseStatus;
  readonly pending: boolean;
  readonly onSetEnabled: (enabled: boolean) => void;
}) {
  const enabled = status?.lockedUse === "enabled";
  const buttonLabel = lockedUseActionLabel(status);
  return (
    <div className="settings-row__actions">
      <span className="settings-row__value">{lockedUseLabel(status?.lockedUse)}</span>
      {buttonLabel ? (
        <button className="button button--secondary" disabled={pending} type="button" onClick={() => onSetEnabled(!enabled)}>
          {buttonLabel}
        </button>
      ) : null}
    </div>
  );
}

function PermissionControl({
  status,
  onOpen,
}: {
  readonly status?: DesktopComputerUseStatusValue;
  readonly onOpen: () => void;
}) {
  return (
    <div className="settings-row__actions">
      <span className="settings-row__value">{permissionLabel(status)}</span>
      {status !== "granted" ? (
        <button className="button button--secondary" type="button" onClick={onOpen}>
          Open Settings
        </button>
      ) : null}
    </div>
  );
}

function desktopLabel(value: DesktopComputerUseStatus["desktop"] | undefined): string {
  switch (value) {
    case "locked":
      return "Locked";
    case "unlocked":
      return "Unlocked";
    default:
      return "Unknown";
  }
}

function frontmostAppLabel(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || "Unknown";
}

function helperLabel(status: DesktopComputerUseStatus | undefined, pending: boolean): string {
  if (!status) {
    return pending ? "Checking..." : "Unknown";
  }
  return status.helperAvailable ? "Available" : "Unavailable";
}

export function lockedUseLabel(value: DesktopComputerUseStatus["lockedUse"] | undefined): string {
  switch (value) {
    case "enabled":
      return "Enabled";
    case "not_enabled":
      return "Not enabled";
    default:
      return "Unknown";
  }
}

export function lockedUseInstallerLabel(value: DesktopComputerUseStatus["lockedUseInstaller"] | undefined): string {
  switch (value) {
    case "installed":
      return "Installed";
    case "not-installed":
      return "Not installed";
    case "not-configured":
      return "Not configured";
    case "partial":
      return "Needs repair";
    default:
      return "Unknown";
  }
}

export function lockedUseActionLabel(status: DesktopComputerUseStatus | undefined): string | undefined {
  if (!status?.helperAvailable) {
    return undefined;
  }
  if (!status.lockedUseInstallerPath) {
    return undefined;
  }
  if (!["installed", "not-installed", "partial"].includes(status.lockedUseInstaller ?? "")) {
    return undefined;
  }
  if (status.lockedUse === "enabled") {
    return "Disable";
  }
  if (status.lockedUseInstaller === "partial") {
    return "Repair";
  }
  return status.lockedUseInstaller === "not-installed" ? "Enable" : undefined;
}

function permissionLabel(value: DesktopComputerUseStatusValue | undefined): string {
  switch (value) {
    case "granted":
      return "Enabled";
    case "denied":
      return "Turned off";
    default:
      return "Unknown";
  }
}
