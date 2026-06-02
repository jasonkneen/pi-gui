import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import Security

struct Request: Decodable {
    let command: String
    let app: String?
    let element_index: String?
    let x: Double?
    let y: Double?
    let click_count: Int?
    let mouse_button: String?
    let from_x: Double?
    let from_y: Double?
    let to_x: Double?
    let to_y: Double?
    let direction: String?
    let pages: Double?
    let key: String?
    let text: String?
    let value: String?
    let prefix: String?
    let suffix: String?
    let selection: String?
    let action: String?
    let locked_use_app_token: String?
    let locked_use_turn_token: String?

    enum CodingKeys: String, CodingKey {
        case command
        case app
        case element_index
        case x
        case y
        case click_count
        case mouse_button
        case from_x
        case from_y
        case to_x
        case to_y
        case direction
        case pages
        case key
        case text
        case value
        case prefix
        case suffix
        case selection
        case action
        case locked_use_app_token
        case locked_use_turn_token
    }
}

struct ContentItem: Encodable {
    let type: String
    let text: String?
    let data: String?
    let mimeType: String?

    static func text(_ value: String) -> ContentItem {
        ContentItem(type: "text", text: value, data: nil, mimeType: nil)
    }

    static func image(data: String, mimeType: String) -> ContentItem {
        ContentItem(type: "image", text: nil, data: data, mimeType: mimeType)
    }
}

struct Response: Encodable {
    let ok: Bool
    let content: [ContentItem]?
    let details: [String: String]?
    let error: String?
}

struct ResolvedApp {
    let running: NSRunningApplication
    let query: String
    let displayName: String
    let bundleIdentifier: String
    let path: String
}

struct WindowCapture {
    let windowId: CGWindowID?
    let frame: CGRect?
}

private let cursorOverlayDisabledValue = "0"
private let cursorOverlayDaemonArgument = "--cursor-overlay-daemon"
private let lockedUseAuthorizationDaemonArgument = "--lock-screen-authorization-daemon"
private let lockedUseAuthorizationProtocolVersionArgument = "--lock-screen-authorization-protocol-version"
private let lockedUseAuthorizationProtocolVersion = "pi-gui-computer-use-active-turn-v1"
private let cursorOverlayShowEnv = "PI_GUI_COMPUTER_USE_SHOW_CURSOR"
private let cursorOverlayDurationEnv = "PI_GUI_COMPUTER_USE_CURSOR_DURATION_MS"
private let cursorOverlayGlideDurationEnv = "PI_GUI_COMPUTER_USE_CURSOR_GLIDE_MS"
private let allowPhysicalInputEnv = "PI_GUI_COMPUTER_USE_ALLOW_PHYSICAL_INPUT"
private let lockedUseInstallerPathEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH"
private let lockedUseAppTokenEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN"
private let lockedUseDesktopPidEnv = "PI_GUI_COMPUTER_USE_DESKTOP_PID"
private let lockedUseDesktopPathEnv = "PI_GUI_COMPUTER_USE_DESKTOP_PATH"
private let lockedUseAuthorizationSocketEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET"
private let lockedUseLeaseSecondsEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_LEASE_SECONDS"
private let lockedUseUnlockTimeoutMsEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_UNLOCK_TIMEOUT_MS"
private let testForceLockedEnv = "PI_GUI_COMPUTER_USE_TEST_FORCE_LOCKED"
private let testLockedUseInstallerStateEnv = "PI_GUI_COMPUTER_USE_TEST_LOCKED_USE_INSTALLER_STATE"
private let testAssumeUnlockedAfterAuthorizationEnv = "PI_GUI_COMPUTER_USE_TEST_ASSUME_UNLOCKED_AFTER_AUTHORIZATION"
private let testSkipRelockEnv = "PI_GUI_COMPUTER_USE_TEST_SKIP_RELOCK"
private let testSkipUnlockReturnKeyEnv = "PI_GUI_COMPUTER_USE_TEST_SKIP_UNLOCK_RETURN_KEY"
private let testForceScreenRecordingDeniedEnv = "PI_GUI_COMPUTER_USE_TEST_FORCE_SCREEN_RECORDING_DENIED"
private let testForbidMouseWarpEnv = "PI_GUI_COMPUTER_USE_TEST_FORBID_MOUSE_WARP"
private let defaultCursorOverlayDuration = 8.0
private let maxCursorOverlayDuration = 60.0
private let defaultCursorOverlayGlideDuration = 0.32
private let defaultLockedUseLeaseSeconds: TimeInterval = 300
private let defaultLockedUseUnlockTimeout: TimeInterval = 8.0
private let accessibleKeyTargetTimeout: TimeInterval = 1.2
private let desktopBundleIdentifier = "com.pi-gui.desktop"
private let helperBundleIdentifier = "com.pi-gui.desktop.computer-use-helper"
private let expectedTeamIdentifier = "P2MBURJVUW"
private let helperExecutableName = "pi-gui-computer-use-helper"
private let lockedUseConfigurationPath = "/Library/Application Support/PiGuiComputerUseAuthorizationPlugin/configuration.plist"
private let lockedUseSocketDirectory = "/tmp/com.pi-gui.desktop.computer-use"
private let lockedUseSocketPath = "\(lockedUseSocketDirectory)/LockScreenLoginAuthorization.sock"
private let lockedUseTurnTokenPath = "\(lockedUseSocketDirectory)/active-turn-token"
private let agentCursorPositionFile = FileManager.default.temporaryDirectory.appendingPathComponent("pi-gui-computer-use-agent-cursor-position")
private let agentCursorPidFile = FileManager.default.temporaryDirectory.appendingPathComponent("pi-gui-computer-use-agent-cursor.pid")
private let lockedUseDaemonPidFile = FileManager.default.temporaryDirectory.appendingPathComponent("pi-gui-computer-use-lock-screen-authorization.pid")
private let lockedUseDaemonStateFile = FileManager.default.temporaryDirectory.appendingPathComponent("pi-gui-computer-use-lock-screen-authorization-state")
private let maxSavedAgentCursorPositionAge: TimeInterval = 300
private let cursorOverlayFrameInterval: TimeInterval = 1.0 / 60.0

struct AgentCursorRequest {
    let point: CGPoint
    let pressed: Bool
    let timestamp: TimeInterval
}

struct LockedUseInstallerStatus {
    let state: String
    let message: String
    let path: String?
}

struct LockedUseAuthorizationDaemonInvocation {
    let launcherPid: pid_t
    let launcherPath: String
}

final class AgentCursorView: NSView {
    var pressed: Bool {
        didSet {
            needsDisplay = true
        }
    }

    init(frame frameRect: NSRect, pressed: Bool) {
        self.pressed = pressed
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.allowsEdgeAntialiasing = true
    }

    required init?(coder: NSCoder) {
        nil
    }

    override var isOpaque: Bool {
        false
    }

    override func draw(_ dirtyRect: NSRect) {
        let ringColor = pressed
            ? NSColor(calibratedRed: 0.98, green: 0.48, blue: 0.16, alpha: 0.26)
            : NSColor(calibratedRed: 0.12, green: 0.46, blue: 0.96, alpha: 0.22)
        ringColor.setFill()
        NSBezierPath(ovalIn: NSRect(x: 1, y: 5, width: 27, height: 27)).fill()

        let body = NSBezierPath()
        body.move(to: NSPoint(x: 5, y: 31))
        body.line(to: NSPoint(x: 5, y: 5))
        body.line(to: NSPoint(x: 12, y: 12))
        body.line(to: NSPoint(x: 17, y: 2))
        body.line(to: NSPoint(x: 22, y: 5))
        body.line(to: NSPoint(x: 17, y: 15))
        body.line(to: NSPoint(x: 28, y: 15))
        body.close()

        NSColor.white.setFill()
        body.fill()
        (pressed ? NSColor.systemOrange : NSColor.systemBlue).setStroke()
        body.lineWidth = 2
        body.stroke()
    }
}

final class TreeBuilder {
    private(set) var elements: [AXUIElement] = []
    private var lines: [String] = []
    private let maxDepth = 10
    private let maxNodes = 420

    func build(from root: AXUIElement) -> String {
        elements.removeAll()
        lines.removeAll()
        visit(root, depth: 0)
        return lines.joined(separator: "\n")
    }

    private func visit(_ element: AXUIElement, depth: Int) {
        if elements.count >= maxNodes || depth > maxDepth {
            return
        }

        let index = elements.count
        elements.append(element)
        lines.append("\(String(repeating: "\t", count: depth))\(index) \(describe(element))")

        guard let children: [AXUIElement] = copyAttribute(element, kAXChildrenAttribute) else {
            return
        }

        for child in children.prefix(120) {
            visit(child, depth: depth + 1)
            if elements.count >= maxNodes {
                break
            }
        }
    }

    private func describe(_ element: AXUIElement) -> String {
        let role = normalizeRole(copyStringAttribute(element, kAXRoleAttribute) ?? "element")
        var parts: [String] = [role]

        if let title = copyStringAttribute(element, kAXTitleAttribute), !title.isEmpty {
            parts.append(clean(title))
        }
        if let description = copyStringAttribute(element, kAXDescriptionAttribute), !description.isEmpty {
            parts.append("Description: \(clean(description))")
        }
        if let value = describeValue(element), !value.isEmpty {
            parts.append("Value: \(clean(value))")
        }
        if let help = copyStringAttribute(element, kAXHelpAttribute), !help.isEmpty {
            parts.append("Help: \(clean(help))")
        }
        if let identifier = copyStringAttribute(element, kAXIdentifierAttribute), !identifier.isEmpty {
            parts.append("ID: \(clean(identifier))")
        }
        if let enabled: Bool = copyAttribute(element, kAXEnabledAttribute), !enabled {
            parts.append("(disabled)")
        }

        let secondaryActions = copyActionNames(element).map(normalizeActionName)
        if !secondaryActions.isEmpty {
            parts.append("Secondary Actions: \(secondaryActions.joined(separator: ", "))")
        }

        return parts.joined(separator: ", ")
    }
}

enum HelperError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let value):
            return value
        }
    }
}

func main() {
    if CommandLine.arguments.contains(lockedUseAuthorizationProtocolVersionArgument) {
        print(lockedUseAuthorizationProtocolVersion)
        exit(EXIT_SUCCESS)
    }
    if CommandLine.arguments.contains(cursorOverlayDaemonArgument) {
        runAgentCursorOverlayDaemon()
    }
    if CommandLine.arguments.contains(lockedUseAuthorizationDaemonArgument) {
        do {
            let invocation = try lockedUseAuthorizationDaemonInvocation()
            try requireTrustedLockedUseAuthorizationDaemonLaunch(invocation)
            let turnToken = try readLockedUseAuthorizationDaemonTurnToken()
            runLockedUseAuthorizationDaemon(turnToken: turnToken)
        } catch {
            fputs("ERROR: \(error)\n", stderr)
            exit(EXIT_FAILURE)
        }
    }

    do {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let request = try JSONDecoder().decode(Request.self, from: input)
        let response = try handle(request)
        emit(response)
    } catch {
        emit(Response(ok: false, content: nil, details: helperErrorDetails(for: error), error: String(describing: error)))
    }
}

func lockedUseAuthorizationDaemonInvocation() throws -> LockedUseAuthorizationDaemonInvocation {
    guard let argumentIndex = CommandLine.arguments.firstIndex(of: lockedUseAuthorizationDaemonArgument),
          CommandLine.arguments.count > argumentIndex + 2 else {
        throw HelperError.message("Locked Computer Use authorization daemon launch is missing required credentials.")
    }
    let launcherPidValue = CommandLine.arguments[argumentIndex + 1]
    let launcherPath = CommandLine.arguments[argumentIndex + 2]
    guard let launcherPid = Int32(launcherPidValue),
          URL(fileURLWithPath: launcherPath).lastPathComponent == helperExecutableName else {
        throw HelperError.message("Locked Computer Use authorization daemon launch received invalid credentials.")
    }
    return LockedUseAuthorizationDaemonInvocation(
        launcherPid: launcherPid,
        launcherPath: launcherPath
    )
}

func readLockedUseAuthorizationDaemonTurnToken() throws -> String {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let token = String(data: input, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
          isValidLockedUseToken(token) else {
        throw HelperError.message("Locked Computer Use authorization daemon launch received an invalid active-turn token.")
    }
    return token
}

func handle(_ request: Request) throws -> Response {
    if request.command != "list_apps",
       request.command != "status",
       request.command != "hide_cursor",
       request.command != "locked_use_begin",
       request.command != "locked_use_end",
       request.command != "locked_use_authorization_probe" {
        try requireUnlockedDesktop()
    }

    switch request.command {
    case "list_apps":
        return try listApps()
    case "status":
        return status()
    case "hide_cursor":
        return hideCursor()
    case "locked_use_begin":
        return try beginLockedUse(request)
    case "locked_use_end":
        return try endLockedUse(request)
    case "locked_use_authorization_probe":
        return try probeLockedUseAuthorizationServer(request)
    case "get_app_state":
        return try getAppState(request)
    case "click":
        return try click(request)
    case "perform_secondary_action":
        return try performSecondaryAction(request)
    case "set_value":
        return try setValue(request)
    case "select_text":
        return try selectText(request)
    case "scroll":
        return try scroll(request)
    case "drag":
        return try drag(request)
    case "press_key":
        return try pressKey(request)
    case "type_text":
        return try typeText(request)
    default:
        throw HelperError.message("Unknown Computer Use action: \(request.command)")
    }
}

func status() -> Response {
    let locked = isScreenLocked()
    let frontmostApp = frontmostAppName()
    let accessibilityGranted = AXIsProcessTrusted()
    let screenRecordingGranted = screenRecordingStatus()
    let installerStatus = lockedUseInstallerStatus()
    let lockSupport = installerStatus.state == "installed" ? "enabled" : "not_enabled"
    let lockSupportMessage = lockedUseMessage(for: installerStatus)
    let daemonActive = isLockedUseAuthorizationDaemonRunning()
    let cursorVisible = isAgentCursorOverlayVisible()
    let cursorActive = isAgentCursorOverlayDaemonRunning()
    let cursorDurationMs = formatMilliseconds(cursorOverlayDuration())
    let cursorGlideMs = formatMilliseconds(cursorOverlayGlideDuration())

    var text = "Computer Use status (Pi GUI)\n"
    text += "Desktop: \(locked ? "locked" : "unlocked")\n"
    text += "Frontmost App: \(frontmostApp)\n"
    text += "Accessibility: \(accessibilityGranted ? "granted" : "not granted")\n"
    text += "Screen Recording: \(screenRecordingGranted)\n"
    text += "Agent Cursor: \(cursorVisible ? "enabled" : "disabled")\n"
    text += "Agent Cursor Overlay: \(cursorActive ? "active" : "inactive")\n"
    text += "Agent Cursor Duration: \(cursorDurationMs)ms\n"
    text += "Agent Cursor Glide: \(cursorGlideMs)ms\n"
    text += "Locked Computer Use: \(lockSupport)\n"
    text += "Locked Computer Use Installer: \(installerStatus.state)\n"
    text += "Locked Computer Use Authorization Service: \(daemonActive ? "active" : "inactive")\n"
    text += lockSupportMessage

    var details = [
        "screenLocked": locked ? "true" : "false",
        "frontmostApp": frontmostApp,
        "accessibility": accessibilityGranted ? "granted" : "denied",
        "screenRecording": screenRecordingGranted,
        "cursorVisible": cursorVisible ? "1" : "0",
        "cursorActive": cursorActive ? "active" : "inactive",
        "cursorDurationMs": cursorDurationMs,
        "cursorGlideMs": cursorGlideMs,
        "lockedUse": lockSupport,
        "lockedUseAuthorizationService": daemonActive ? "active" : "inactive",
        "lockedUseInstaller": installerStatus.state,
        "lockedUseMessage": lockSupportMessage,
    ]
    if let path = installerStatus.path {
        details["lockedUseInstallerPath"] = path
    }

    return Response(
        ok: true,
        content: [.text(text)],
        details: details,
        error: nil
    )
}

func isAgentCursorOverlayVisible() -> Bool {
    ProcessInfo.processInfo.environment[cursorOverlayShowEnv] != cursorOverlayDisabledValue
}

func frontmostAppName() -> String {
    let app = NSWorkspace.shared.frontmostApplication
    if let name = app?.localizedName, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return name
    }
    if let bundleIdentifier = app?.bundleIdentifier, !bundleIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return bundleIdentifier
    }
    return "unknown"
}

func hideCursor() -> Response {
    if let pid = readAgentCursorOverlayPid(), pid > 0, isAgentCursorOverlayDaemonProcess(pid) {
        Darwin.kill(pid, SIGTERM)
    }
    try? FileManager.default.removeItem(at: agentCursorPidFile)
    try? FileManager.default.removeItem(at: agentCursorPositionFile)
    return Response(
        ok: true,
        content: [.text("Computer Use agent cursor hidden.")],
        details: nil,
        error: nil
    )
}

func lockedUseMessage(for installerStatus: LockedUseInstallerStatus) -> String {
    switch installerStatus.state {
    case "installed":
        return "Locked Computer Use is enabled. When the Mac is locked, pi-gui will use a guarded active-turn authorization service and relock when the turn ends."
    case "partial":
        return "Locked Computer Use authorization plug-in setup is partially installed. Reinstall or uninstall it before enabling locked computer use."
    case "not-installed":
        return "Locked Computer Use requires a guarded macOS authorization plug-in. pi-gui packages the installer now, but locked app control is not enabled yet."
    case "not-configured":
        return "Locked Computer Use requires a guarded macOS authorization plug-in. The installer path is not configured, so app control pauses while the desktop is locked."
    default:
        return installerStatus.message
    }
}

func lockedUseUnavailableMessage(for installerStatus: LockedUseInstallerStatus) -> String {
    if installerStatus.state == "partial" {
        return "Computer Use is unavailable while the Mac is locked because Locked Computer Use is partially installed. \(installerStatus.message) Reinstall or uninstall Locked Computer Use, then retry."
    }
    return "Computer Use is unavailable while the Mac is locked because Locked Computer Use is not enabled. Enable the locked Computer Use authorization plug-in, then retry."
}

func lockedUseInstallerStatus() -> LockedUseInstallerStatus {
    if let forcedState = ProcessInfo.processInfo.environment[testLockedUseInstallerStateEnv],
       ["installed", "partial", "not-installed"].contains(forcedState) {
        return LockedUseInstallerStatus(
            state: forcedState,
            message: "Forced test locked-use installer state: \(forcedState).",
            path: nil
        )
    }

    guard let installerPath = ProcessInfo.processInfo.environment[lockedUseInstallerPathEnv],
          !installerPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return LockedUseInstallerStatus(
            state: "not-configured",
            message: "Missing \(lockedUseInstallerPathEnv).",
            path: nil
        )
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: installerPath)
    process.arguments = ["status"]

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    do {
        try process.run()
    } catch {
        return LockedUseInstallerStatus(
            state: "not-configured",
            message: "Unable to launch locked-use installer at \(installerPath): \(error)",
            path: installerPath
        )
    }

    let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
    let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()

    let output = String(decoding: stdoutData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    let errorOutput = String(decoding: stderrData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    if process.terminationStatus != 0 {
        return LockedUseInstallerStatus(
            state: "unknown",
            message: errorOutput.isEmpty ? "Locked-use installer status failed." : errorOutput,
            path: installerPath
        )
    }

    if output.contains("OK: installed") {
        if let configuredPath = configuredLockedUseHelperExecutablePath(),
           !lockedUseHelperSupportsActiveTurnProtocol(configuredPath) {
            return LockedUseInstallerStatus(
                state: "partial",
                message: "Installed Locked Computer Use helper is stale and must be reinstalled to support active-turn authorization.",
                path: installerPath
            )
        }
        return LockedUseInstallerStatus(state: "installed", message: output, path: installerPath)
    }
    if output.contains("OK: partial") {
        return LockedUseInstallerStatus(state: "partial", message: output, path: installerPath)
    }
    if output.contains("OK: not-installed") {
        return LockedUseInstallerStatus(state: "not-installed", message: output, path: installerPath)
    }

    return LockedUseInstallerStatus(
        state: "unknown",
        message: output.isEmpty ? "Locked-use installer returned no status." : output,
        path: installerPath
    )
}

func requireUnlockedDesktop() throws {
    if isScreenLocked() {
        throw HelperError.message("Computer Use is unavailable while the Mac is locked. Unlock the desktop and retry.")
    }
}

func beginLockedUse(_ request: Request) throws -> Response {
    if !isScreenLocked() {
        return Response(
            ok: true,
            content: [.text("Desktop is already unlocked.")],
            details: [
                "lockedUseLease": "not_needed",
                "screenLocked": "false",
            ],
            error: nil
        )
    }

    let installerStatus = lockedUseInstallerStatus()
    let lockedUseEnabled = installerStatus.state == "installed"
    guard lockedUseEnabled else {
        throw HelperError.message(lockedUseUnavailableMessage(for: installerStatus))
    }

    try requireTrustedLockedUseLauncher(request)
    let turnToken = try requireLockedUseTurnToken(request)
    try ensureLockedUseAuthorizationDaemon(turnToken: turnToken)
    postLockScreenUnlockReturnKey()
    if waitForDesktopUnlockOrTestAuthorization(timeout: lockedUseUnlockTimeout()) {
        let didAuthorizeUnlock = lockedUseDaemonState() == "authorized"
        if didAuthorizeUnlock {
            writeLockedUseDaemonState("auto_unlocked")
        } else {
            stopLockedUseAuthorizationDaemon()
        }
        return lockedUseLeaseResponse(
            state: didAuthorizeUnlock ? "auto_unlocked" : "user_unlocked",
            message: didAuthorizeUnlock
                ? "Locked Computer Use unlocked the desktop for this active turn."
                : "The desktop was unlocked manually before Locked Computer Use authorization completed.",
            installerStatus: installerStatus,
            screenLocked: false,
            lockedUseEnabled: true
        )
    }

    stopLockedUseAuthorizationDaemon()
    throw HelperError.message(
        "The Mac is locked and automatic Locked Computer Use unlock did not complete. Ask the user to unlock the Mac manually before continuing."
    )
}

func endLockedUse(_ request: Request) throws -> Response {
    try requireTrustedLockedUseLauncher(request)
    let turnToken = try requireLockedUseTurnToken(request)
    if let activeTurnToken = lockedUseTurnToken(), activeTurnToken != turnToken {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the turn token does not match the active lease.")
    }

    let shouldRelock = shouldRelockAutoUnlockedDesktop()
    stopLockedUseAuthorizationDaemon()
    if shouldRelock {
        lockDesktop()
    }

    return Response(
        ok: true,
        content: [.text("Locked Computer Use lease ended.")],
        details: [
            "lockedUseLease": "ended",
            "relockRequested": shouldRelock ? "true" : "false",
        ],
        error: nil
    )
}

func probeLockedUseAuthorizationServer(_ request: Request) throws -> Response {
    try requireTrustedLockedUseLauncher(request)
    let turnToken = UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    try ensureLockedUseAuthorizationDaemon(turnToken: turnToken)
    defer {
        stopLockedUseAuthorizationDaemon()
    }
    let response = try requestLockedUseAuthorization(turnToken: turnToken)
    guard response == "ALLOW" else {
        throw HelperError.message("Locked Computer Use authorization service returned \(response) instead of ALLOW.")
    }
    return Response(
        ok: true,
        content: [.text("Locked Computer Use authorization service accepted a guarded authorization probe.")],
        details: [
            "lockedUseAuthorizationService": "ok",
            "authorizationResponse": response,
            "socketPath": lockedUseSocketPath,
        ],
        error: nil
    )
}

func lockedUseLeaseResponse(
    state: String,
    message: String,
    installerStatus: LockedUseInstallerStatus,
    screenLocked: Bool,
    lockedUseEnabled: Bool
) -> Response {
    var details = [
        "lockedUse": lockedUseEnabled ? "enabled" : "not_enabled",
        "lockedUseInstaller": installerStatus.state,
        "lockedUseLease": state,
        "screenLocked": screenLocked ? "true" : "false",
    ]
    if let path = installerStatus.path {
        details["lockedUseInstallerPath"] = path
    }
    return Response(ok: true, content: [.text(message)], details: details, error: nil)
}

func requireTrustedLockedUseLauncher(_ request: Request) throws {
    let appToken = try requireLockedUseAppToken(request)
    try requireTrustedLockedUseDesktopAncestor()
    try requireDesktopLockedUseAuthorization(appToken: appToken)
}

func requireLockedUseAppToken(_ request: Request) throws -> String {
    guard let token = request.locked_use_app_token,
          isValidLockedUseToken(token) else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the app token is missing or invalid.")
    }
    return token
}

func requireLockedUseTurnToken(_ request: Request) throws -> String {
    guard let token = request.locked_use_turn_token,
          isValidLockedUseToken(token) else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the turn token is missing or invalid.")
    }
    return token
}

func isValidLockedUseToken(_ token: String) -> Bool {
    token.count >= 32 && token.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
}

func requireTrustedLockedUseAuthorizationDaemonLaunch(_ invocation: LockedUseAuthorizationDaemonInvocation) throws {
    guard invocation.launcherPid == getppid() else {
        throw HelperError.message("Locked Computer Use authorization daemon rejected a launch from an unexpected parent process.")
    }
    guard let launcherPath = processPath(pid: invocation.launcherPid),
          standardizedPath(launcherPath) == standardizedPath(invocation.launcherPath) else {
        throw HelperError.message("Locked Computer Use authorization daemon rejected an untrusted launcher path.")
    }
    guard URL(fileURLWithPath: launcherPath).lastPathComponent == helperExecutableName,
          processSatisfiesCodeRequirement(pid: invocation.launcherPid, identifier: helperBundleIdentifier) else {
        throw HelperError.message("Locked Computer Use authorization daemon rejected an untrusted launcher process.")
    }
    try requireTrustedLockedUseDesktopAncestor()
}

func requireTrustedLockedUseDesktopAncestor() throws {
    guard let rawPid = ProcessInfo.processInfo.environment[lockedUseDesktopPidEnv],
          let desktopPid = pid_t(rawPid.trimmingCharacters(in: .whitespacesAndNewlines)),
          desktopPid > 1 else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the trusted pi-gui desktop process is missing.")
    }
    guard processHasAncestor(pid: getppid(), ancestorPid: desktopPid) else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the helper was not launched from pi-gui.")
    }
    guard let desktopPath = processPath(pid: desktopPid),
          isTrustedPiGuiDesktopPath(desktopPath),
          desktopPathMatchesExpectedEnvironment(desktopPath),
          processSatisfiesCodeRequirement(pid: desktopPid, identifier: desktopBundleIdentifier) else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the trusted pi-gui desktop process could not be verified.")
    }
}

func processHasAncestor(pid: pid_t, ancestorPid: pid_t) -> Bool {
    var currentPid = pid
    for _ in 0..<48 {
        if currentPid == ancestorPid {
            return true
        }
        guard let parentPid = parentPid(of: currentPid),
              parentPid > 1,
              parentPid != currentPid else {
            return false
        }
        currentPid = parentPid
    }
    return false
}

func parentPid(of pid: pid_t) -> pid_t? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-o", "ppid=", "-p", "\(pid)"]

    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = FileHandle(forWritingAtPath: "/dev/null")

    do {
        try process.run()
    } catch {
        return nil
    }
    let output = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    process.waitUntilExit()
    guard process.terminationStatus == 0,
          let parentPid = pid_t(output) else {
        return nil
    }
    return parentPid
}

func isTrustedPiGuiDesktopPath(_ path: String) -> Bool {
    let standardized = standardizedPath(path)
    return standardized.contains(".app/Contents/MacOS/")
        && URL(fileURLWithPath: standardized).lastPathComponent == "pi-gui"
}

func desktopPathMatchesExpectedEnvironment(_ actualPath: String) -> Bool {
    guard let expectedPath = ProcessInfo.processInfo.environment[lockedUseDesktopPathEnv]?.trimmingCharacters(in: .whitespacesAndNewlines),
          !expectedPath.isEmpty else {
        return false
    }
    return standardizedPath(actualPath) == standardizedPath(expectedPath)
}

func processSatisfiesCodeRequirement(pid: pid_t, identifier: String) -> Bool {
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    let codeStatus = SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code)
    guard codeStatus == errSecSuccess, let code else {
        return false
    }

    var requirement: SecRequirement?
    let requirementText = "identifier \"\(identifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(expectedTeamIdentifier)\"" as CFString
    let requirementStatus = SecRequirementCreateWithString(requirementText, SecCSFlags(), &requirement)
    guard requirementStatus == errSecSuccess, let requirement else {
        return false
    }

    return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
}

func requireDesktopLockedUseAuthorization(appToken: String) throws {
    let response = try requestDesktopLockedUseAuthorization(appToken: appToken)
    guard response == "ALLOW" else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the app token is not active.")
    }
}

func requestDesktopLockedUseAuthorization(appToken: String) throws -> String {
    guard let socketPath = ProcessInfo.processInfo.environment[lockedUseAuthorizationSocketEnv]?.trimmingCharacters(in: .whitespacesAndNewlines),
          !socketPath.isEmpty else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the trusted pi-gui desktop authorization service is missing.")
    }

    let clientFd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard clientFd >= 0 else {
        throw HelperError.message("Could not create Locked Computer Use desktop authorization socket.")
    }
    defer {
        close(clientFd)
    }

    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(clientFd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(clientFd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    guard writeUnixSocketPath(socketPath, to: &address) else {
        throw HelperError.message("Locked Computer Use desktop authorization socket path is too long.")
    }

    let connectStatus = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(clientFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connectStatus == 0 else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the trusted pi-gui desktop authorization service could not be reached.")
    }
    guard socketPeerSatisfiesCodeRequirement(clientFd, identifier: desktopBundleIdentifier) else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the desktop authorization service is untrusted.")
    }

    let request = "authorize \(appToken)\n"
    request.withCString { pointer in
        _ = write(clientFd, pointer, strlen(pointer))
    }

    var buffer = [UInt8](repeating: 0, count: 64)
    let count = read(clientFd, &buffer, buffer.count - 1)
    guard count > 0 else {
        throw HelperError.message("Locked Computer Use active-turn authorization is unavailable because the trusted pi-gui desktop authorization service did not return a response.")
    }
    return String(decoding: buffer.prefix(Int(count)), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func socketPeerSatisfiesCodeRequirement(_ fd: Int32, identifier: String) -> Bool {
    var token = audit_token_t()
    var tokenLength = socklen_t(MemoryLayout<audit_token_t>.size)
    let tokenStatus = withUnsafeMutablePointer(to: &token) { pointer in
        pointer.withMemoryRebound(to: UInt8.self, capacity: MemoryLayout<audit_token_t>.size) { reboundPointer in
            getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, reboundPointer, &tokenLength)
        }
    }
    guard tokenStatus == 0, tokenLength == socklen_t(MemoryLayout<audit_token_t>.size) else {
        return false
    }

    let tokenData = withUnsafeBytes(of: token) { rawBuffer in
        Data(rawBuffer)
    }
    let attributes = [kSecGuestAttributeAudit as String: tokenData] as CFDictionary
    var code: SecCode?
    let codeStatus = SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code)
    guard codeStatus == errSecSuccess, let code else {
        return false
    }

    var requirement: SecRequirement?
    let requirementText = "identifier \"\(identifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(expectedTeamIdentifier)\"" as CFString
    let requirementStatus = SecRequirementCreateWithString(requirementText, SecCSFlags(), &requirement)
    guard requirementStatus == errSecSuccess, let requirement else {
        return false
    }

    return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
}

func processPath(pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4096)
    let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard count > 0 else {
        return nil
    }
    return String(cString: buffer)
}

func standardizedPath(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
}

func waitForDesktopUnlockOrTestAuthorization(timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if ProcessInfo.processInfo.environment[testAssumeUnlockedAfterAuthorizationEnv] == "1",
           lockedUseDaemonState() == "authorized" {
            return true
        }
        if !isScreenLocked() {
            return true
        }
        Thread.sleep(forTimeInterval: 0.08)
    }
    return !isScreenLocked()
}

func lockedUseUnlockTimeout() -> TimeInterval {
    let rawValue = ProcessInfo.processInfo.environment[lockedUseUnlockTimeoutMsEnv] ?? ""
    if let milliseconds = Double(rawValue), milliseconds > 0 {
        return milliseconds / 1000
    }
    return defaultLockedUseUnlockTimeout
}

func isScreenLocked() -> Bool {
    if ProcessInfo.processInfo.environment[testForceLockedEnv] == "1" {
        return true
    }
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return false
    }
    return (session["CGSSessionScreenIsLocked"] as? Bool) == true
}

func helperErrorDetails(for error: Error) -> [String: String]? {
    let message = String(describing: error)
    if message.contains("Locked Computer Use is not enabled") {
        return [
            "errorCode": "desktop_locked",
            "screenLocked": "true",
            "lockedUse": "not_enabled",
        ]
    }
    if message.contains("Locked Computer Use is partially installed")
        || message.contains("must be reinstalled") {
        return [
            "errorCode": "desktop_locked",
            "screenLocked": "true",
            "lockedUse": "partial",
        ]
    }
    if message.contains("automatic Locked Computer Use unlock did not complete") {
        return [
            "errorCode": "desktop_locked",
            "screenLocked": "true",
            "lockedUse": "enabled",
        ]
    }
    if message.contains("active-turn authorization is unavailable") {
        return [
            "errorCode": "desktop_locked",
            "screenLocked": "true",
            "lockedUse": "enabled",
        ]
    }
    if message.contains("Mac is locked") {
        return [
            "errorCode": "desktop_locked",
            "screenLocked": "true",
        ]
    }
    if message.contains("Accessibility permission is not granted") {
        return [
            "errorCode": "accessibility_denied",
            "accessibility": "denied",
        ]
    }
    if message.contains("Screen Recording permission") {
        return [
            "errorCode": "screen_recording_denied",
            "screenRecording": "denied",
        ]
    }
    if message.contains("Could not find app:") {
        return [
            "errorCode": "app_not_found",
        ]
    }
    if message.contains("target window screenshot is unavailable") {
        return [
            "errorCode": "screenshot_unavailable",
            "screenshot": "unavailable",
        ]
    }
    if message.contains("would require moving the user's physical mouse")
        || message.contains("would require foreground physical input")
        || message.contains("would require foreground keyboard input") {
        return [
            "errorCode": "physical_input_required",
        ]
    }
    return nil
}

func screenRecordingStatus() -> String {
    if ProcessInfo.processInfo.environment[testForceScreenRecordingDeniedEnv] == "1" {
        return "denied"
    }
    if #available(macOS 10.15, *) {
        return CGPreflightScreenCaptureAccess() ? "granted" : "denied"
    }
    return "unknown"
}

func listApps() throws -> Response {
    var records: [String] = []
    let runningBundleIds = Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier))

    for app in NSWorkspace.shared.runningApplications
        .filter({ $0.activationPolicy == .regular })
        .sorted(by: { ($0.localizedName ?? "").localizedCaseInsensitiveCompare($1.localizedName ?? "") == .orderedAscending }) {
        let name = app.localizedName ?? app.bundleIdentifier ?? "Unknown"
        let path = app.bundleURL?.path ?? ""
        let bundleId = app.bundleIdentifier ?? "unknown"
        let frontmost = app.isActive ? " [frontmost, running]" : " [running]"
        records.append("\(name) — \(path) — \(bundleId)\(frontmost)")
    }

    for appUrl in discoverInstalledApps() {
        guard let bundle = Bundle(url: appUrl) else {
            continue
        }
        let bundleId = bundle.bundleIdentifier ?? appUrl.lastPathComponent
        if runningBundleIds.contains(bundleId) {
            continue
        }
        let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? appUrl.deletingPathExtension().lastPathComponent
        records.append("\(name) — \(appUrl.path) — \(bundleId)")
    }

    return Response(ok: true, content: [.text(records.joined(separator: "\n"))], details: nil, error: nil)
}

func getAppState(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    return try stateResponse(for: app)
}

func click(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let clickCount = max(1, request.click_count ?? 1)
    let button = request.mouse_button ?? "left"

    if let element = try indexedElement(request, app: app) {
        if button == "left", copyActionNames(element).contains(kAXPressAction as String) {
            try withAgentCursorPress(for: element) {
                try pressElement(element, count: clickCount, failureContext: "AXPress failed for element \(request.element_index ?? "")")
            }
            return try stateResponse(for: app)
        }
        if let center = elementCenter(element) {
            throw physicalPointerClickRequired(app: app, point: center)
        }
        throw HelperError.message("Element \(request.element_index ?? "") has no clickable position.")
    }

    let point = try screenshotPoint(request, app: app, x: request.x, y: request.y)
    if button == "left",
       let element = accessibilityElement(at: point, in: app),
       copyActionNames(element).contains(kAXPressAction as String) {
        try withAgentCursorPress(at: elementCenter(element) ?? point) {
            try pressElement(element, count: clickCount, failureContext: "AXPress failed for coordinate click")
        }
        return try stateResponse(for: app)
    }
    throw physicalPointerClickRequired(app: app, point: point)
}

func physicalPointerClickRequired(app: ResolvedApp, point: CGPoint) -> HelperError {
    physicalInputRequired(
        app: app,
        action: "click",
        pointDescription: "at \(Int(point.x)),\(Int(point.y))",
        guidance: "Use a pressable element_index or a coordinate over a pressable accessibility element to keep Computer Use in the background."
    )
}

func requirePhysicalInputAllowed(
    app: ResolvedApp,
    action: String,
    pointDescription: String?,
    guidance: String
) throws {
    if ProcessInfo.processInfo.environment[allowPhysicalInputEnv] == "1" {
        return
    }
    throw physicalInputRequired(
        app: app,
        action: action,
        pointDescription: pointDescription,
        guidance: guidance
    )
}

func physicalInputRequired(
    app: ResolvedApp,
    action: String,
    pointDescription: String?,
    guidance: String
) -> HelperError {
    let location = pointDescription.map { " \($0)" } ?? ""
    let inputDetail = pointDescription == nil ? "" : " by moving the user's physical mouse"
    return HelperError.message(
        "Computer Use blocked: this \(action) in \(app.displayName) would require foreground physical input\(inputDetail)\(location). \(guidance)"
    )
}

func performSecondaryAction(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let element = try requireIndexedElement(request, app: app)
    let action = try require(request.action, "action")
    let axAction = canonicalActionName(action)
    try withAgentCursorPress(for: element) {
        let error = AXUIElementPerformAction(element, axAction as CFString)
        if error != .success {
            throw HelperError.message("Could not perform action \(action) on element \(request.element_index ?? ""): \(error.rawValue)")
        }
    }
    return try stateResponse(for: app)
}

func setValue(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let element = try requireIndexedElement(request, app: app)
    let value = try require(request.value, "value")
    showAgentCursorAndWait(for: element, pressed: false)
    let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
    if error != .success {
        throw HelperError.message("Could not set value on element \(request.element_index ?? ""): \(error.rawValue)")
    }
    return try stateResponse(for: app)
}

func selectText(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let element = try requireIndexedElement(request, app: app)
    let target = try require(request.text, "text")
    let value = describeValue(element) ?? ""
    let range = findTextRange(in: value, target: target, prefix: request.prefix, suffix: request.suffix)
    if range.location == NSNotFound {
        throw HelperError.message("Could not find requested text in element \(request.element_index ?? "").")
    }

    let selection = request.selection ?? "text"
    var cfRange: CFRange
    switch selection {
    case "cursor_before":
        cfRange = CFRange(location: range.location, length: 0)
    case "cursor_after":
        cfRange = CFRange(location: range.location + range.length, length: 0)
    default:
        cfRange = CFRange(location: range.location, length: range.length)
    }
    guard let axRange = AXValueCreate(.cfRange, &cfRange) else {
        throw HelperError.message("Could not create selected text range.")
    }
    showAgentCursorAndWait(for: element, pressed: false)
    let error = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
    if error != .success {
        throw HelperError.message("Could not select text in element \(request.element_index ?? ""): \(error.rawValue)")
    }
    return try stateResponse(for: app)
}

func scroll(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let direction = try require(request.direction, "direction").lowercased()
    let pages = request.pages ?? 1
    let element = try indexedElement(request, app: app)
    let absolutePages = abs(pages)

    if absolutePages >= 1,
       absolutePages.rounded(.towardZero) == absolutePages,
       let element,
        let action = accessibilityScrollAction(direction: direction, element: element) {
        let repeats = max(1, min(4, Int(absolutePages)))
        showAgentCursorAndWait(for: element, pressed: false)
        var didScroll = false
        for _ in 0..<repeats {
            let error = AXUIElementPerformAction(element, action as CFString)
            if error != .success {
                if didScroll {
                    throw HelperError.message("Accessibility scroll action failed after a partial scroll: \(error.rawValue)")
                }
                break
            }
            didScroll = true
            Thread.sleep(forTimeInterval: 0.06)
        }
        if didScroll {
            return try stateResponse(for: app)
        }
    }

    let magnitude = Int32(max(1, min(2400, abs(pages) * 720)))
    var deltaX: Int32 = 0
    var deltaY: Int32 = 0

    switch direction {
    case "up":
        deltaY = magnitude
    case "down":
        deltaY = -magnitude
    case "left":
        deltaX = magnitude
    case "right":
        deltaX = -magnitude
    default:
        throw HelperError.message("Unsupported scroll direction: \(direction)")
    }

    let cursorPoint = element.flatMap(elementCenter) ?? targetWindowCenter(for: app)
    try requirePhysicalInputAllowed(
        app: app,
        action: "scroll",
        pointDescription: cursorPoint.map { "at \(Int($0.x)),\(Int($0.y))" },
        guidance: "Use an element_index with a supported accessibility scroll action to keep Computer Use in the background."
    )
    return try withTemporaryActivation(app, cursorPoint: cursorPoint) {
        if let cursorPoint {
            moveMouse(to: cursorPoint)
        }
        postScroll(deltaX: deltaX, deltaY: deltaY)
        return try stateResponse(for: app)
    }
}

func drag(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    try requirePhysicalInputAllowed(
        app: app,
        action: "drag",
        pointDescription: "for the requested coordinates",
        guidance: "Use background-safe accessibility actions where available; drag currently requires foreground physical input."
    )
    let from = try screenshotPoint(request, app: app, x: request.from_x, y: request.from_y)
    let to = try screenshotPoint(request, app: app, x: request.to_x, y: request.to_y)
    return try withTemporaryActivation(app, cursorPoint: from) {
        postDrag(from: from, to: to)
        showAgentCursor(at: to, pressed: false)
        return try stateResponse(for: app)
    }
}

func pressKey(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let key = try require(request.key, "key")
    if try pressAccessibleKey(key, app: app) {
        return try stateResponse(for: app)
    }
    try requirePhysicalInputAllowed(
        app: app,
        action: "press key \(key)",
        pointDescription: nil,
        guidance: "Use an element_index, set_value, select_text, type_text, or an app-specific accessible control to keep Computer Use in the background."
    )
    return try withTemporaryActivation(app, cursorPoint: nil) {
        try postKey(key)
        return try stateResponse(for: app)
    }
}

func typeText(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let text = try require(request.text, "text")
    if let element = try indexedElement(request, app: app) {
        if typeTextIntoElement(element, text: text) {
            return try stateResponse(for: app)
        }
        if let center = elementCenter(element) {
            try requirePhysicalInputAllowed(
                app: app,
                action: "type text",
                pointDescription: "at \(Int(center.x)),\(Int(center.y))",
                guidance: "Use an editable text element whose accessibility value can be set to keep Computer Use in the background."
            )
            return try withTemporaryActivation(app, cursorPoint: center) {
                moveMouse(to: center)
                postClick(at: center, button: "left", count: 1)
                for character in text {
                    postUnicode(String(character))
                    Thread.sleep(forTimeInterval: 0.01)
                }
                return try stateResponse(for: app)
            }
        }
        throw HelperError.message("Element \(request.element_index ?? "") does not support background text insertion and has no typing position.")
    }
    if try typeAccessibleText(text, app: app) {
        return try stateResponse(for: app)
    }
    try requirePhysicalInputAllowed(
        app: app,
        action: "type text",
        pointDescription: nil,
        guidance: "Use element_index for an editable text field or a background-safe app control before retrying."
    )
    return try withTemporaryActivation(app, cursorPoint: nil) {
        for character in text {
            postUnicode(String(character))
            Thread.sleep(forTimeInterval: 0.01)
        }
        return try stateResponse(for: app)
    }
}

func stateResponse(for app: ResolvedApp) throws -> Response {
    if !AXIsProcessTrusted() {
        requestAccessibilityPermission()
        throw HelperError.message(
            "Accessibility permission is not granted for \(permissionAppName()). In macOS System Settings > Privacy & Security > Accessibility, enable pi-gui and pi-gui Computer Use. If either entry is already enabled after replacing or rebuilding the app, toggle it off and back on, then relaunch pi-gui."
        )
    }
    Thread.sleep(forTimeInterval: 0.08)
    let appElement = AXUIElementCreateApplication(app.running.processIdentifier)
    let window = targetWindow(for: appElement) ?? appElement
    let title = copyStringAttribute(window, kAXTitleAttribute) ?? app.displayName
    let builder = TreeBuilder()
    let tree = builder.build(from: window)
    let capture = windowCapture(for: app, title: title)
    let screenRecording = requestScreenRecordingPermissionIfNeeded()
    let screenshot = screenRecording == "denied" ? nil : capture.windowId.flatMap { captureWindowImage(windowId: $0) }

    var text = "Computer Use state (Pi GUI)\n<app_state>\n"
    text += "App=\(app.path) (bundleID \(app.bundleIdentifier), pid \(app.running.processIdentifier))\n"
    text += "Window: \"\(clean(title))\", App: \(clean(app.displayName)).\n"
    text += tree
    text += "\n</app_state>"
    if screenshot == nil {
        text += "\n\nScreenshot unavailable. Check Screen Recording permission for pi-gui and its helper."
    }

    var content: [ContentItem] = [.text(text)]
    if let screenshot {
        content.append(.image(data: screenshot, mimeType: "image/png"))
    }

    return Response(
        ok: true,
        content: content,
        details: [
            "app": app.displayName,
            "bundleIdentifier": app.bundleIdentifier,
            "focusMode": "background",
            "pid": String(app.running.processIdentifier),
            "screenRecording": screenRecording,
            "screenshot": screenshot == nil ? "unavailable" : "available",
            "windowTitle": title,
        ],
        error: nil
    )
}

func requestAccessibilityPermission() {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
}

func permissionAppName() -> String {
    if let bundleName = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String,
       !bundleName.isEmpty {
        return bundleName
    }
    return "pi-gui Computer Use"
}

func indexedElement(_ request: Request, app: ResolvedApp) throws -> AXUIElement? {
    guard request.element_index != nil else {
        return nil
    }
    return try requireIndexedElement(request, app: app)
}

func requireIndexedElement(_ request: Request, app: ResolvedApp) throws -> AXUIElement {
    let indexText = try require(request.element_index, "element_index")
    guard let index = Int(indexText) else {
        throw HelperError.message("Element index must be an integer: \(indexText)")
    }
    let appElement = AXUIElementCreateApplication(app.running.processIdentifier)
    let window = targetWindow(for: appElement) ?? appElement
    let builder = TreeBuilder()
    _ = builder.build(from: window)
    guard index >= 0 && index < builder.elements.count else {
        throw HelperError.message("Element index \(index) is not present in the current app state.")
    }
    return builder.elements[index]
}

func screenshotPoint(_ request: Request, app: ResolvedApp, x: Double?, y: Double?) throws -> CGPoint {
    let x = try require(x, "x")
    let y = try require(y, "y")
    guard x.isFinite, y.isFinite else {
        throw HelperError.message("Screenshot coordinates must be finite numbers.")
    }
    try requireScreenshotCoordinatesAvailable()
    let appElement = AXUIElementCreateApplication(app.running.processIdentifier)
    let window = targetWindow(for: appElement) ?? appElement
    let title = copyStringAttribute(window, kAXTitleAttribute) ?? app.displayName
    let capture = windowCapture(for: app, title: title)
    guard capture.windowId != nil else {
        throw HelperError.message(
            "Cannot use screenshot coordinates because the target window screenshot is unavailable for \(app.displayName). Call get_app_state and use an element_index from the accessibility tree instead."
        )
    }
    let frame = capture.frame ?? windowFrame(window)
    guard let frame else {
        throw HelperError.message("Cannot translate screenshot coordinates without a window frame.")
    }
    let screenshotScale = backingScaleFactor(for: frame)
    let maxX = frame.width * screenshotScale
    let maxY = frame.height * screenshotScale
    guard x >= 0, y >= 0, x < maxX, y < maxY else {
        throw HelperError.message(
            "Screenshot coordinate (\(formatCoordinate(x)), \(formatCoordinate(y))) is outside the target window screenshot bounds 0...\(formatCoordinate(maxX)) x 0...\(formatCoordinate(maxY)) for \(app.displayName). Call get_app_state again and use coordinates within the returned screenshot."
        )
    }
    return CGPoint(x: frame.origin.x + (x / screenshotScale), y: frame.origin.y + (y / screenshotScale))
}

func requireScreenshotCoordinatesAvailable() throws {
    if requestScreenRecordingPermissionIfNeeded() == "denied" {
        throw HelperError.message(
            "Screen Recording permission is required before using screenshot coordinates. In macOS System Settings > Privacy & Security > Screen Recording, enable pi-gui and pi-gui Computer Use, then retry."
        )
    }
}

func requestScreenRecordingPermissionIfNeeded() -> String {
    let status = screenRecordingStatus()
    if status != "denied" {
        return status
    }
    if ProcessInfo.processInfo.environment[testForceScreenRecordingDeniedEnv] == "1" {
        return "denied"
    }
    if #available(macOS 10.15, *) {
        return CGRequestScreenCaptureAccess() ? "granted" : "denied"
    }
    return status
}

func resolveApp(_ appQuery: String?) throws -> ResolvedApp {
    let query = try require(appQuery, "app").trimmingCharacters(in: .whitespacesAndNewlines)
    if query.isEmpty {
        throw HelperError.message("app is required.")
    }

    if query.hasPrefix("/") || query.hasSuffix(".app") {
        let url = URL(fileURLWithPath: query)
        return try resolveAppUrl(url, query: query)
    }

    if query.contains("."),
       let running = NSRunningApplication.runningApplications(withBundleIdentifier: query).first {
        return resolved(running, query: query)
    }

    if let running = NSWorkspace.shared.runningApplications.first(where: {
        ($0.localizedName ?? "").localizedCaseInsensitiveCompare(query) == .orderedSame
            || ($0.bundleIdentifier ?? "").localizedCaseInsensitiveCompare(query) == .orderedSame
    }) {
        return resolved(running, query: query)
    }

    for url in discoverInstalledApps() {
        let name = url.deletingPathExtension().lastPathComponent
        if name.localizedCaseInsensitiveCompare(query) == .orderedSame {
            return try resolveAppUrl(url, query: query)
        }
    }

    throw HelperError.message("Could not find app: \(query)")
}

func resolveAppUrl(_ url: URL, query: String) throws -> ResolvedApp {
    guard FileManager.default.fileExists(atPath: url.path) else {
        throw HelperError.message("App path does not exist: \(url.path)")
    }
    let bundle = Bundle(url: url)
    let bundleId = bundle?.bundleIdentifier
    if let bundleId,
       let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
        return resolved(running, query: query)
    }

    let opened = NSWorkspace.shared.open(url)
    if !opened {
        throw HelperError.message("Could not launch app at \(url.path)")
    }

    let deadline = Date().addingTimeInterval(8)
    while Date() < deadline {
        if let bundleId,
           let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
            return resolved(running, query: query)
        }
        if let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleURL?.path == url.path }) {
            return resolved(running, query: query)
        }
        Thread.sleep(forTimeInterval: 0.1)
    }

    throw HelperError.message("App launched but no running process was found for \(url.path)")
}

func resolved(_ running: NSRunningApplication, query: String) -> ResolvedApp {
    let displayName = running.localizedName ?? running.bundleIdentifier ?? query
    let bundleIdentifier = running.bundleIdentifier ?? "unknown"
    let path = running.bundleURL?.path ?? query
    return ResolvedApp(running: running, query: query, displayName: displayName, bundleIdentifier: bundleIdentifier, path: path)
}

func activate(_ app: ResolvedApp) {
    app.running.activate(options: [.activateAllWindows])
}

func withTemporaryActivation<T>(
    _ app: ResolvedApp,
    cursorPoint: CGPoint?,
    restoreFocus: Bool = true,
    _ body: () throws -> T
) throws -> T {
    let previousApp = NSWorkspace.shared.frontmostApplication
    let previousMouseLocation = cursorPoint == nil ? nil : currentMouseLocation()
    if let cursorPoint {
        showAgentCursorAndWait(at: cursorPoint, pressed: true)
    }
    activate(app)
    if !waitForFrontmost(processIdentifier: app.running.processIdentifier, timeout: 0.6),
       app.bundleIdentifier != "unknown" {
        openApplication(bundleIdentifier: app.bundleIdentifier)
    }
    guard waitForFrontmost(processIdentifier: app.running.processIdentifier, timeout: 0.8) else {
        throw HelperError.message("Could not bring \(app.displayName) to the front for physical Computer Use input.")
    }
    defer {
        if restoreFocus {
            Thread.sleep(forTimeInterval: 0.16)
            restoreUserFocus(previousApp, mouseLocation: previousMouseLocation, targetPid: app.running.processIdentifier)
        }
    }
    return try body()
}

func restoreUserFocus(_ previousApp: NSRunningApplication?, mouseLocation: CGPoint?, targetPid: pid_t) {
    let deadline = Date().addingTimeInterval(0.45)
    while Date() < deadline {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid {
            break
        }
        Thread.sleep(forTimeInterval: 0.02)
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid else {
        return
    }
    if let previousApp,
       previousApp.processIdentifier != targetPid,
       let stillRunning = NSRunningApplication(processIdentifier: previousApp.processIdentifier) {
        stillRunning.activate(options: [.activateAllWindows])
        _ = waitForFrontmost(processIdentifier: stillRunning.processIdentifier, timeout: 0.35)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid,
           let bundleIdentifier = stillRunning.bundleIdentifier {
            openApplication(bundleIdentifier: bundleIdentifier)
            waitForNotFrontmost(processIdentifier: targetPid, timeout: 0.35)
        }
    }
    if let mouseLocation {
        moveMouse(to: mouseLocation)
    }
}

func waitForFrontmost(processIdentifier: pid_t, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == processIdentifier {
            return true
        }
        Thread.sleep(forTimeInterval: 0.02)
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == processIdentifier
}

func waitForNotFrontmost(processIdentifier: pid_t, timeout: TimeInterval) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != processIdentifier {
            return
        }
        Thread.sleep(forTimeInterval: 0.02)
    }
}

func openApplication(bundleIdentifier: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-b", bundleIdentifier]
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return
    }
}

func currentMouseLocation() -> CGPoint? {
    CGEvent(source: nil)?.location
}

func discoverInstalledApps() -> [URL] {
    let roots = [
        "/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
    ]
    var urls: [URL] = []
    let fileManager = FileManager.default
    for root in roots {
        guard let entries = try? fileManager.contentsOfDirectory(
            at: URL(fileURLWithPath: root),
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            continue
        }
        urls.append(contentsOf: entries.filter { $0.pathExtension == "app" })
    }
    return urls.sorted { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }
}

func targetWindow(for appElement: AXUIElement) -> AXUIElement? {
    if let focused: AXUIElement = copyAttribute(appElement, kAXFocusedWindowAttribute) {
        return focused
    }
    let windows: [AXUIElement]? = copyAttribute(appElement, kAXWindowsAttribute)
    return windows?.max(by: { windowArea($0) < windowArea($1) })
}

func windowArea(_ element: AXUIElement) -> CGFloat {
    guard let frame = windowFrame(element) else {
        return 0
    }
    return frame.width * frame.height
}

func targetWindowCenter(for app: ResolvedApp) -> CGPoint? {
    let appElement = AXUIElementCreateApplication(app.running.processIdentifier)
    if let window = targetWindow(for: appElement),
       let frame = windowFrame(window) {
        return CGPoint(x: frame.midX, y: frame.midY)
    }
    if let frame = windowCapture(for: app, title: nil).frame {
        return CGPoint(x: frame.midX, y: frame.midY)
    }
    return nil
}

func windowFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = cgPointAttribute(element, kAXPositionAttribute),
          let size = cgSizeAttribute(element, kAXSizeAttribute) else {
        return nil
    }
    return CGRect(origin: position, size: size)
}

func windowCapture(for app: ResolvedApp, title: String?) -> WindowCapture {
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return WindowCapture(windowId: nil, frame: nil)
    }
    let pid = app.running.processIdentifier
    let candidates = windows.filter { info in
        guard let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t else {
            return false
        }
        return ownerPid == pid
    }
    let selected = candidates.first(where: { info in
        guard let title,
              let windowName = info[kCGWindowName as String] as? String else {
            return false
        }
        return windowName == title
    }) ?? candidates.max(by: { windowArea($0) < windowArea($1) })

    guard let selected else {
        return WindowCapture(windowId: nil, frame: nil)
    }
    let id = selected[kCGWindowNumber as String] as? UInt32
    let frame = rectFromWindowBounds(selected[kCGWindowBounds as String])
    return WindowCapture(windowId: id, frame: frame)
}

func windowArea(_ info: [String: Any]) -> Double {
    guard let frame = rectFromWindowBounds(info[kCGWindowBounds as String]) else {
        return 0
    }
    return Double(frame.width * frame.height)
}

func captureWindowImage(windowId: CGWindowID) -> String? {
    let tempUrl = FileManager.default.temporaryDirectory
        .appendingPathComponent("pi-gui-computer-use-\(UUID().uuidString)")
        .appendingPathExtension("png")
    defer {
        try? FileManager.default.removeItem(at: tempUrl)
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-o", "-l\(windowId)", tempUrl.path]

    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return nil
    }

    guard process.terminationStatus == 0,
          let data = try? Data(contentsOf: tempUrl),
          !data.isEmpty else {
        return nil
    }

    return data.base64EncodedString()
}

func rectFromWindowBounds(_ rawValue: Any?) -> CGRect? {
    guard let dictionary = rawValue as? [String: Any],
          let x = numberValue(dictionary["X"]),
          let y = numberValue(dictionary["Y"]),
          let width = numberValue(dictionary["Width"]),
          let height = numberValue(dictionary["Height"]) else {
        return nil
    }
    return CGRect(x: x, y: y, width: width, height: height)
}

func numberValue(_ value: Any?) -> Double? {
    if let number = value as? NSNumber {
        return number.doubleValue
    }
    return value as? Double
}

func copyAttribute<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if error != .success {
        return nil
    }
    return value as? T
}

func copyStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    if let string: String = copyAttribute(element, attribute) {
        return string
    }
    if let number: NSNumber = copyAttribute(element, attribute) {
        return number.stringValue
    }
    return nil
}

func describeValue(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
    if error != .success {
        return nil
    }
    if let string = value as? String {
        return string
    }
    if let number = value as? NSNumber {
        return number.stringValue
    }
    if let attributed = value as? NSAttributedString {
        return attributed.string
    }
    return value.map { String(describing: $0) }
}

func copyActionNames(_ element: AXUIElement) -> [String] {
    var actions: CFArray?
    let error = AXUIElementCopyActionNames(element, &actions)
    if error != .success {
        return []
    }
    return (actions as? [String]) ?? []
}

func cgPointAttribute(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
    guard let value: AXValue = copyAttribute(element, attribute) else {
        return nil
    }
    var point = CGPoint.zero
    guard AXValueGetValue(value, .cgPoint, &point) else {
        return nil
    }
    return point
}

func cgSizeAttribute(_ element: AXUIElement, _ attribute: String) -> CGSize? {
    guard let value: AXValue = copyAttribute(element, attribute) else {
        return nil
    }
    var size = CGSize.zero
    guard AXValueGetValue(value, .cgSize, &size) else {
        return nil
    }
    return size
}

func elementCenter(_ element: AXUIElement) -> CGPoint? {
    guard let frame = windowFrame(element) else {
        return nil
    }
    return CGPoint(x: frame.midX, y: frame.midY)
}

func accessibilityElement(at point: CGPoint, in app: ResolvedApp) -> AXUIElement? {
    let systemWide = AXUIElementCreateSystemWide()
    var rawElement: AXUIElement?
    let error = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &rawElement)
    guard error == .success,
          let element = rawElement else {
        return nil
    }

    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success,
          pid == app.running.processIdentifier else {
        return nil
    }
    return element
}

func backingScaleFactor(for frame: CGRect) -> Double {
    for screen in NSScreen.screens {
        if let quartzBounds = quartzBounds(for: screen),
           quartzBounds.intersects(frame) {
            return Double(screen.backingScaleFactor)
        }
    }
    for screen in NSScreen.screens {
        if screen.frame.intersects(frame) {
            return Double(screen.backingScaleFactor)
        }
    }
    return Double(NSScreen.main?.backingScaleFactor ?? 1)
}

@discardableResult
func showAgentCursor(for element: AXUIElement, pressed: Bool) -> Bool {
    if let center = elementCenter(element) {
        return showAgentCursor(at: center, pressed: pressed)
    }
    return false
}

@discardableResult
func showAgentCursor(at point: CGPoint, pressed: Bool) -> Bool {
    guard ProcessInfo.processInfo.environment[cursorOverlayShowEnv] != cursorOverlayDisabledValue,
          agentCursorFrame(for: point) != nil else {
        return false
    }

    writeAgentCursorRequest(point, pressed: pressed)
    if !ensureAgentCursorOverlayDaemon() {
        showTransientAgentCursor(at: point, pressed: pressed)
    }
    return true
}

func showAgentCursorAndWait(for element: AXUIElement, pressed: Bool) {
    if showAgentCursor(for: element, pressed: pressed) {
        waitForAgentCursorGlide()
    }
}

func showAgentCursorAndWait(at point: CGPoint, pressed: Bool) {
    if showAgentCursor(at: point, pressed: pressed) {
        waitForAgentCursorGlide()
    }
}

func showAgentCursorPressAndWait(for element: AXUIElement) -> CGPoint? {
    guard let center = elementCenter(element) else {
        return nil
    }
    return showAgentCursorPressAndWait(at: center)
}

func showAgentCursorPressAndWait(at point: CGPoint) -> CGPoint {
    showAgentCursorAndWait(at: point, pressed: true)
    return point
}

func withAgentCursorPress<T>(for element: AXUIElement, _ body: () throws -> T) rethrows -> T {
    let cursorPoint = showAgentCursorPressAndWait(for: element)
    defer { releaseAgentCursor(at: cursorPoint) }
    return try body()
}

func withAgentCursorPress<T>(at point: CGPoint, _ body: () throws -> T) rethrows -> T {
    let cursorPoint = showAgentCursorPressAndWait(at: point)
    defer { releaseAgentCursor(at: cursorPoint) }
    return try body()
}

func releaseAgentCursor(at point: CGPoint?) {
    guard let point else {
        return
    }
    Thread.sleep(forTimeInterval: 0.12)
    _ = showAgentCursor(at: point, pressed: false)
}

func waitForAgentCursorGlide() {
    guard ProcessInfo.processInfo.environment[cursorOverlayShowEnv] != cursorOverlayDisabledValue else {
        return
    }
    let delay = min(cursorOverlayGlideDuration(), 0.35)
    guard delay > 0 else {
        return
    }
    RunLoop.current.run(until: Date().addingTimeInterval(delay))
}

func ensureLockedUseAuthorizationDaemon(turnToken: String) throws {
    if isLockedUseAuthorizationDaemonRunning(),
       FileManager.default.fileExists(atPath: lockedUseSocketPath),
       lockedUseTurnToken() == turnToken {
        return
    }

    stopLockedUseAuthorizationDaemon()
    cleanupLockedUseAuthorizationSocket()

    let daemonExecutablePath = try lockedUseAuthorizationDaemonExecutablePath()
    let launcherPid = getpid()
    let launcherPath = CommandLine.arguments[0]
    let process = Process()
    process.executableURL = URL(fileURLWithPath: daemonExecutablePath)
    process.arguments = [
        lockedUseAuthorizationDaemonArgument,
        "\(launcherPid)",
        launcherPath,
    ]
    var environment = ProcessInfo.processInfo.environment
    environment.removeValue(forKey: lockedUseAppTokenEnv)
    process.environment = environment
    let input = Pipe()
    process.standardInput = input
    process.standardOutput = FileHandle(forWritingAtPath: "/dev/null")
    process.standardError = FileHandle(forWritingAtPath: "/dev/null")
    try process.run()
    input.fileHandleForWriting.write(Data("\(turnToken)\n".utf8))
    try? input.fileHandleForWriting.close()
    try "\(process.processIdentifier)".write(to: lockedUseDaemonPidFile, atomically: true, encoding: .utf8)

    let deadline = Date().addingTimeInterval(1.5)
    while Date() < deadline {
        if isLockedUseAuthorizationDaemonRunning(),
           FileManager.default.fileExists(atPath: lockedUseSocketPath),
           lockedUseTurnToken() == turnToken {
            return
        }
        Thread.sleep(forTimeInterval: 0.03)
    }

    throw HelperError.message("Locked Computer Use authorization service did not start.")
}

func lockedUseAuthorizationDaemonExecutablePath() throws -> String {
    if let configuredPath = configuredLockedUseHelperExecutablePath(),
       FileManager.default.isExecutableFile(atPath: configuredPath) {
        guard lockedUseHelperSupportsActiveTurnProtocol(configuredPath) else {
            throw HelperError.message(
                "Locked Computer Use authorization service must be reinstalled because the installed helper does not support active-turn authorization."
            )
        }
        return configuredPath
    }
    if ProcessInfo.processInfo.environment[testLockedUseInstallerStateEnv] == "installed"
        || lockedUseInstallerStatus().state != "installed" {
        return CommandLine.arguments[0]
    }
    throw HelperError.message("Locked Computer Use authorization service is not installed correctly because the configured helper copy is unavailable.")
}

func configuredLockedUseHelperExecutablePath() -> String? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: lockedUseConfigurationPath)),
          let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
          let dictionary = plist as? [String: Any],
          let path = dictionary["helperExecutablePath"] as? String else {
        return nil
    }
    let trimmedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmedPath.isEmpty ? nil : trimmedPath
}

func lockedUseHelperSupportsActiveTurnProtocol(_ helperPath: String) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: helperPath)
    process.arguments = [lockedUseAuthorizationProtocolVersionArgument]
    process.standardInput = FileHandle(forReadingAtPath: "/dev/null")
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    do {
        try process.run()
    } catch {
        return false
    }
    let deadline = Date().addingTimeInterval(2)
    while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
    }
    if process.isRunning {
        process.terminate()
        process.waitUntilExit()
        return false
    }

    let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
    _ = stderr.fileHandleForReading.readDataToEndOfFile()

    guard process.terminationStatus == 0 else {
        return false
    }
    let output = String(decoding: stdoutData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return output == lockedUseAuthorizationProtocolVersion
}

func runLockedUseAuthorizationDaemon(turnToken: String) -> Never {
    let currentPid = getpid()
    try? "\(currentPid)".write(to: lockedUseDaemonPidFile, atomically: true, encoding: .utf8)
    try? FileManager.default.createDirectory(
        atPath: lockedUseSocketDirectory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    _ = chmod(lockedUseSocketDirectory, 0o700)
    cleanupLockedUseAuthorizationSocket()
    writeLockedUseTurnToken(turnToken)

    let serverFd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard serverFd >= 0 else {
        exitLockedUseAuthorizationDaemon(status: EXIT_FAILURE, serverFd: nil, currentPid: currentPid)
    }
    guard makeSocketNonBlocking(serverFd) else {
        exitLockedUseAuthorizationDaemon(status: EXIT_FAILURE, serverFd: serverFd, currentPid: currentPid)
    }

    var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
    setsockopt(serverFd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    guard writeUnixSocketPath(lockedUseSocketPath, to: &address) else {
        exitLockedUseAuthorizationDaemon(status: EXIT_FAILURE, serverFd: serverFd, currentPid: currentPid)
    }

    let bindStatus = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(serverFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard bindStatus == 0, listen(serverFd, 4) == 0 else {
        exitLockedUseAuthorizationDaemon(status: EXIT_FAILURE, serverFd: serverFd, currentPid: currentPid)
    }

    let expiresAt = Date().addingTimeInterval(lockedUseLeaseSeconds())
    while Date() < expiresAt {
        let clientFd = accept(serverFd, nil, nil)
        if clientFd < 0 {
            if errno == EAGAIN || errno == EWOULDBLOCK {
                Thread.sleep(forTimeInterval: 0.05)
                continue
            }
            if errno == EINTR {
                continue
            }
            continue
        }
        if makeSocketBlocking(clientFd), setLockedUseClientSocketTimeout(clientFd) {
            handleLockedUseAuthorizationClient(clientFd, turnToken: turnToken)
        }
        close(clientFd)
    }

    exitLockedUseAuthorizationDaemon(status: EXIT_SUCCESS, serverFd: serverFd, currentPid: currentPid)
}

func makeSocketNonBlocking(_ fd: Int32) -> Bool {
    let flags = fcntl(fd, F_GETFL, 0)
    guard flags >= 0 else {
        return false
    }
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0
}

func makeSocketBlocking(_ fd: Int32) -> Bool {
    let flags = fcntl(fd, F_GETFL, 0)
    guard flags >= 0 else {
        return false
    }
    return fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) == 0
}

func setLockedUseClientSocketTimeout(_ fd: Int32) -> Bool {
    var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
    let readStatus = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    let writeStatus = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    return readStatus == 0 && writeStatus == 0
}

func exitLockedUseAuthorizationDaemon(status: Int32, serverFd: Int32?, currentPid: pid_t) -> Never {
    relockAutoUnlockedDesktopIfNeeded()
    if let serverFd, serverFd >= 0 {
        close(serverFd)
    }
    cleanupLockedUseAuthorizationSocket()
    clearLockedUseAuthorizationDaemonPid(currentPid)
    try? FileManager.default.removeItem(at: lockedUseDaemonStateFile)
    try? FileManager.default.removeItem(atPath: lockedUseTurnTokenPath)
    exit(status)
}

@discardableResult
func relockAutoUnlockedDesktopIfNeeded() -> Bool {
    let shouldRelock = shouldRelockAutoUnlockedDesktop()
    if shouldRelock {
        lockDesktop()
    }
    return shouldRelock
}

func shouldRelockAutoUnlockedDesktop() -> Bool {
    lockedUseDaemonStateRequiresRelock(lockedUseDaemonState())
        && ProcessInfo.processInfo.environment[testSkipRelockEnv] != "1"
        && !isScreenLocked()
}

func lockedUseDaemonStateRequiresRelock(_ state: String?) -> Bool {
    state == "auto_unlocked" || state == "authorized"
}

func handleLockedUseAuthorizationClient(_ clientFd: Int32, turnToken: String) {
    var buffer = [UInt8](repeating: 0, count: 160)
    let count = read(clientFd, &buffer, buffer.count - 1)
    guard count > 0 else {
        return
    }
    let request = String(decoding: buffer.prefix(Int(count)), as: UTF8.self)
    guard request.trimmingCharacters(in: .whitespacesAndNewlines) == "authorize \(turnToken)" else {
        writeLockedUseAuthorizationResponse("DENY\n", to: clientFd)
        return
    }

    writeLockedUseDaemonState("authorized")
    writeLockedUseAuthorizationResponse("ALLOW\n", to: clientFd)
}

func writeLockedUseAuthorizationResponse(_ response: String, to clientFd: Int32) {
    response.withCString { pointer in
        _ = write(clientFd, pointer, strlen(pointer))
    }
}

func requestLockedUseAuthorization(turnToken: String) throws -> String {
    let clientFd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard clientFd >= 0 else {
        throw HelperError.message("Could not create Locked Computer Use authorization probe socket.")
    }
    defer {
        close(clientFd)
    }

    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(clientFd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(clientFd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    guard writeUnixSocketPath(lockedUseSocketPath, to: &address) else {
        throw HelperError.message("Locked Computer Use authorization probe socket path is too long.")
    }

    let connectStatus = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(clientFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connectStatus == 0 else {
        throw HelperError.message("Could not connect to Locked Computer Use authorization service.")
    }

    let request = "authorize \(turnToken)\n"
    request.withCString { pointer in
        _ = write(clientFd, pointer, strlen(pointer))
    }

    var buffer = [UInt8](repeating: 0, count: 64)
    let count = read(clientFd, &buffer, buffer.count - 1)
    guard count > 0 else {
        throw HelperError.message("Locked Computer Use authorization service did not return a response.")
    }
    return String(decoding: buffer.prefix(Int(count)), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func writeUnixSocketPath(_ path: String, to address: inout sockaddr_un) -> Bool {
    let maxLength = MemoryLayout.size(ofValue: address.sun_path)
    guard path.utf8.count < maxLength else {
        return false
    }

    return path.withCString { pathPointer in
        withUnsafeMutablePointer(to: &address.sun_path) { tuplePointer in
            tuplePointer.withMemoryRebound(to: CChar.self, capacity: maxLength) { destination in
                strncpy(destination, pathPointer, maxLength)
                destination[maxLength - 1] = 0
            }
        }
        return true
    }
}

func postLockScreenUnlockReturnKey() {
    if ProcessInfo.processInfo.environment[testSkipUnlockReturnKeyEnv] == "1" {
        return
    }

    let returnKeyCode: CGKeyCode = 36
    let source = CGEventSource(stateID: .hidSystemState)
    let keyDown = CGEvent(keyboardEventSource: source, virtualKey: returnKeyCode, keyDown: true)
    let keyUp = CGEvent(keyboardEventSource: source, virtualKey: returnKeyCode, keyDown: false)
    keyDown?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.04)
    keyUp?.post(tap: .cghidEventTap)
}

func stopLockedUseAuthorizationDaemon() {
    if let pid = readLockedUseAuthorizationDaemonPid(), pid > 0 {
        if isLockedUseAuthorizationDaemonProcess(pid) {
            Darwin.kill(pid, SIGTERM)
        }
    }
    cleanupLockedUseAuthorizationSocket()
    try? FileManager.default.removeItem(at: lockedUseDaemonPidFile)
    try? FileManager.default.removeItem(at: lockedUseDaemonStateFile)
    try? FileManager.default.removeItem(atPath: lockedUseTurnTokenPath)
}

func cleanupLockedUseAuthorizationSocket() {
    try? FileManager.default.removeItem(atPath: lockedUseSocketPath)
}

func isLockedUseAuthorizationDaemonRunning() -> Bool {
    guard let pid = readLockedUseAuthorizationDaemonPid(), pid > 0 else {
        return false
    }
    if Darwin.kill(pid, 0) == 0 || errno == EPERM {
        if isLockedUseAuthorizationDaemonProcess(pid) {
            return true
        }
        try? FileManager.default.removeItem(at: lockedUseDaemonPidFile)
        return false
    }
    try? FileManager.default.removeItem(at: lockedUseDaemonPidFile)
    return false
}

func isLockedUseAuthorizationDaemonProcess(_ pid: pid_t) -> Bool {
    guard let executablePath = processPath(pid: pid),
          URL(fileURLWithPath: executablePath).lastPathComponent == helperExecutableName,
          let command = processCommand(pid: pid) else {
        return false
    }
    return command.contains(lockedUseAuthorizationDaemonArgument)
}

func processCommand(pid: pid_t) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-o", "command=", "-p", "\(pid)"]

    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = FileHandle(forWritingAtPath: "/dev/null")

    do {
        try process.run()
    } catch {
        return nil
    }
    let output = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    process.waitUntilExit()
    guard process.terminationStatus == 0, !output.isEmpty else {
        return nil
    }
    return output
}

func readLockedUseAuthorizationDaemonPid() -> pid_t? {
    guard let rawValue = try? String(contentsOf: lockedUseDaemonPidFile, encoding: .utf8),
          let pid = pid_t(rawValue.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        return nil
    }
    return pid
}

func clearLockedUseAuthorizationDaemonPid(_ pid: pid_t) {
    if readLockedUseAuthorizationDaemonPid() == pid {
        try? FileManager.default.removeItem(at: lockedUseDaemonPidFile)
    }
}

func writeLockedUseDaemonState(_ state: String) {
    try? state.write(to: lockedUseDaemonStateFile, atomically: true, encoding: .utf8)
}

func writeLockedUseTurnToken(_ token: String) {
    FileManager.default.createFile(atPath: lockedUseTurnTokenPath, contents: Data(token.utf8), attributes: [
        .posixPermissions: 0o600,
    ])
    _ = chmod(lockedUseTurnTokenPath, 0o600)
}

func lockedUseTurnToken() -> String? {
    try? String(contentsOfFile: lockedUseTurnTokenPath, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func lockedUseDaemonState() -> String? {
    try? String(contentsOf: lockedUseDaemonStateFile, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func lockedUseLeaseSeconds() -> TimeInterval {
    let rawValue = ProcessInfo.processInfo.environment[lockedUseLeaseSecondsEnv] ?? ""
    if let seconds = Double(rawValue), seconds > 0 {
        return seconds
    }
    return defaultLockedUseLeaseSeconds
}

func lockDesktop() {
    let lockCommand = "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: lockCommand)
    process.arguments = ["-suspend"]
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return
    }
}

func showTransientAgentCursor(at point: CGPoint, pressed: Bool) {
    guard let targetFrame = agentCursorFrame(for: point) else {
        return
    }
    NSApplication.shared.setActivationPolicy(.accessory)
    let (panel, cursorView) = makeAgentCursorPanel(frame: targetFrame, pressed: false)
    panel.orderFrontRegardless()
    cursorView.pressed = pressed
    RunLoop.current.run(until: Date().addingTimeInterval(transientCursorOverlayDuration()))
    panel.orderOut(nil)
}

func runAgentCursorOverlayDaemon() -> Never {
    let currentPid = getpid()
    try? "\(currentPid)".write(to: agentCursorPidFile, atomically: true, encoding: .utf8)

    NSApplication.shared.setActivationPolicy(.accessory)
    var panel: NSPanel?
    var cursorView: AgentCursorView?
    var currentFrame: NSRect?
    var startFrame: NSRect?
    var targetFrame: NSRect?
    var animationStartedAt = Date()
    var activeRequestTimestamp: TimeInterval = 0
    var lastRequestObservedAt = Date()

    while true {
        autoreleasepool {
            if let request = readAgentCursorRequest(),
               request.timestamp > activeRequestTimestamp {
                activeRequestTimestamp = request.timestamp
                lastRequestObservedAt = Date()

                if let nextTargetFrame = agentCursorFrame(for: request.point) {
                    if panel == nil {
                        let cursorPanel = makeAgentCursorPanel(frame: nextTargetFrame, pressed: request.pressed)
                        panel = cursorPanel.panel
                        cursorView = cursorPanel.cursorView
                        currentFrame = nextTargetFrame
                        panel?.orderFrontRegardless()
                    }

                    startFrame = currentFrame ?? panel?.frame ?? nextTargetFrame
                    targetFrame = nextTargetFrame
                    animationStartedAt = Date()
                    cursorView?.pressed = request.pressed
                }
            }

            if let panel, let targetFrame {
                let duration = cursorOverlayGlideDuration()
                let frame: NSRect
                if duration > 0, let startFrame, hypot(startFrame.midX - targetFrame.midX, startFrame.midY - targetFrame.midY) >= 2 {
                    let progress = min(1, Date().timeIntervalSince(animationStartedAt) / duration)
                    frame = interpolatedRect(from: startFrame, to: targetFrame, progress: easeInOut(progress))
                } else {
                    frame = targetFrame
                }
                panel.setFrame(frame, display: true)
                currentFrame = frame
            }
        }

        if Date().timeIntervalSince(lastRequestObservedAt) > cursorOverlayDuration() {
            break
        }
        RunLoop.current.run(until: Date().addingTimeInterval(cursorOverlayFrameInterval))
    }

    panel?.orderOut(nil)
    clearAgentCursorOverlayPid(currentPid)
    exit(EXIT_SUCCESS)
}

func ensureAgentCursorOverlayDaemon() -> Bool {
    if isAgentCursorOverlayDaemonRunning() {
        return true
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    process.arguments = [cursorOverlayDaemonArgument]
    process.standardInput = FileHandle(forReadingAtPath: "/dev/null")
    process.standardOutput = FileHandle(forWritingAtPath: "/dev/null")
    process.standardError = FileHandle(forWritingAtPath: "/dev/null")
    do {
        try process.run()
        try? "\(process.processIdentifier)".write(to: agentCursorPidFile, atomically: true, encoding: .utf8)
        return true
    } catch {
        return false
    }
}

func isAgentCursorOverlayDaemonRunning() -> Bool {
    guard let pid = readAgentCursorOverlayPid(), pid > 0 else {
        return false
    }
    if Darwin.kill(pid, 0) == 0 || errno == EPERM {
        if isAgentCursorOverlayDaemonProcess(pid) {
            return true
        }
        try? FileManager.default.removeItem(at: agentCursorPidFile)
        return false
    }
    try? FileManager.default.removeItem(at: agentCursorPidFile)
    return false
}

func isAgentCursorOverlayDaemonProcess(_ pid: pid_t) -> Bool {
    guard let executablePath = processPath(pid: pid),
          URL(fileURLWithPath: executablePath).lastPathComponent == helperExecutableName,
          let command = processCommand(pid: pid) else {
        return false
    }
    return command.contains(cursorOverlayDaemonArgument)
}

func readAgentCursorOverlayPid() -> pid_t? {
    guard let rawValue = try? String(contentsOf: agentCursorPidFile, encoding: .utf8),
          let pid = pid_t(rawValue.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        return nil
    }
    return pid
}

func clearAgentCursorOverlayPid(_ pid: pid_t) {
    if readAgentCursorOverlayPid() == pid {
        try? FileManager.default.removeItem(at: agentCursorPidFile)
    }
}

func makeAgentCursorPanel(frame: NSRect, pressed: Bool) -> (panel: NSPanel, cursorView: AgentCursorView) {
    let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isReleasedWhenClosed = true
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let cursorView = AgentCursorView(frame: NSRect(origin: .zero, size: frame.size), pressed: pressed)
    panel.contentView = cursorView
    return (panel, cursorView)
}

func glideAgentCursor(_ panel: NSPanel, from startFrame: NSRect, to targetFrame: NSRect) {
    let duration = cursorOverlayGlideDuration()
    guard duration > 0,
          hypot(startFrame.midX - targetFrame.midX, startFrame.midY - targetFrame.midY) >= 2 else {
        panel.setFrame(targetFrame, display: true)
        return
    }

    let started = Date()
    while true {
        let elapsed = Date().timeIntervalSince(started)
        let progress = min(1, elapsed / duration)
        let eased = easeInOut(progress)
        panel.setFrame(interpolatedRect(from: startFrame, to: targetFrame, progress: eased), display: true)
        if progress >= 1 {
            break
        }
        RunLoop.current.run(until: Date().addingTimeInterval(cursorOverlayFrameInterval))
    }
}

func cursorOverlayDuration() -> TimeInterval {
    guard let rawValue = ProcessInfo.processInfo.environment[cursorOverlayDurationEnv],
          let milliseconds = Double(rawValue),
          milliseconds.isFinite,
          milliseconds > 0 else {
        return defaultCursorOverlayDuration
    }
    return min(milliseconds / 1000, maxCursorOverlayDuration)
}

func transientCursorOverlayDuration() -> TimeInterval {
    min(cursorOverlayDuration(), 1.4)
}

func cursorOverlayGlideDuration() -> TimeInterval {
    guard let rawValue = ProcessInfo.processInfo.environment[cursorOverlayGlideDurationEnv],
          let milliseconds = Double(rawValue),
          milliseconds.isFinite,
          milliseconds >= 0 else {
        return defaultCursorOverlayGlideDuration
    }
    return min(milliseconds / 1000, 2)
}

func interpolatedRect(from start: NSRect, to end: NSRect, progress: Double) -> NSRect {
    NSRect(
        x: start.origin.x + ((end.origin.x - start.origin.x) * progress),
        y: start.origin.y + ((end.origin.y - start.origin.y) * progress),
        width: start.width + ((end.width - start.width) * progress),
        height: start.height + ((end.height - start.height) * progress)
    )
}

func easeInOut(_ progress: Double) -> Double {
    let clamped = max(0, min(1, progress))
    return clamped * clamped * (3 - (2 * clamped))
}

func readAgentCursorRequest() -> AgentCursorRequest? {
    guard let rawValue = try? String(contentsOf: agentCursorPositionFile, encoding: .utf8) else {
        return nil
    }
    let parts = rawValue.split(separator: ",")
    guard parts.count == 4,
          let x = Double(parts[0]),
          let y = Double(parts[1]),
          let timestamp = Double(parts[2]),
          x.isFinite,
          y.isFinite,
          timestamp.isFinite,
          Date().timeIntervalSince1970 - timestamp <= maxSavedAgentCursorPositionAge else {
        return nil
    }
    return AgentCursorRequest(point: CGPoint(x: x, y: y), pressed: parts[3] == "1", timestamp: timestamp)
}

func writeAgentCursorRequest(_ point: CGPoint, pressed: Bool) {
    let pressedValue = pressed ? "1" : "0"
    try? "\(point.x),\(point.y),\(Date().timeIntervalSince1970),\(pressedValue)".write(to: agentCursorPositionFile, atomically: true, encoding: .utf8)
}

func agentCursorFrame(for quartzPoint: CGPoint) -> NSRect? {
    let size = CGSize(width: 34, height: 38)
    let tip = CGPoint(x: 5, y: 31)
    guard let cocoaPoint = cocoaPoint(fromQuartz: quartzPoint) else {
        return nil
    }
    return NSRect(
        x: cocoaPoint.x - tip.x,
        y: cocoaPoint.y - tip.y,
        width: size.width,
        height: size.height
    )
}

func cocoaPoint(fromQuartz point: CGPoint) -> CGPoint? {
    for screen in NSScreen.screens {
        guard let displayBounds = quartzBounds(for: screen),
              displayBounds.contains(point) else {
            continue
        }
        return CGPoint(
            x: screen.frame.minX + point.x - displayBounds.minX,
            y: screen.frame.maxY - (point.y - displayBounds.minY)
        )
    }
    guard let screen = NSScreen.main else {
        return nil
    }
    return CGPoint(x: point.x, y: screen.frame.maxY - point.y)
}

func quartzBounds(for screen: NSScreen) -> CGRect? {
    guard let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
        return nil
    }
    return CGDisplayBounds(CGDirectDisplayID(screenNumber.uint32Value))
}

func accessibilityScrollAction(direction: String, element: AXUIElement) -> String? {
    let candidates: [String]
    switch direction {
    case "up":
        candidates = ["AXScrollUp"]
    case "down":
        candidates = ["AXScrollDown"]
    case "left":
        candidates = ["AXScrollLeft"]
    case "right":
        candidates = ["AXScrollRight"]
    default:
        return nil
    }

    let actions = Set(copyActionNames(element))
    return candidates.first(where: { actions.contains($0) })
}

func pressAccessibleKey(_ rawKey: String, app: ResolvedApp) throws -> Bool {
    guard supportsKeypadButtonEmulation(app) else {
        return false
    }
    let labels = accessibleLabels(forKey: rawKey)
    guard !labels.isEmpty else {
        return false
    }
    guard let element = waitForPressableElement(in: app, labels: labels) else {
        return false
    }
    try withAgentCursorPress(for: element) {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        Thread.sleep(forTimeInterval: 0.06)
        guard error == .success else {
            throw HelperError.message("AXPress failed for \(app.displayName) key \(rawKey): \(error.rawValue)")
        }
    }
    return true
}

func pressElement(_ element: AXUIElement, count: Int, failureContext: String) throws {
    for _ in 0..<count {
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard error == .success else {
            throw HelperError.message("\(failureContext): \(error.rawValue)")
        }
        Thread.sleep(forTimeInterval: 0.08)
    }
}

func typeAccessibleText(_ text: String, app: ResolvedApp) throws -> Bool {
    guard supportsKeypadButtonEmulation(app) else {
        return false
    }
    let keys = text.map { String($0) }
    guard !keys.isEmpty else {
        return true
    }

    var elements: [AXUIElement] = []
    for key in keys {
        let labels = accessibleLabels(forKey: key)
        guard !labels.isEmpty else {
            return false
        }
        guard let element = waitForPressableElement(in: app, labels: labels) else {
            return false
        }
        elements.append(element)
    }

    for element in elements {
        showAgentCursor(for: element, pressed: true)
        let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
        guard error == .success else {
            throw HelperError.message("AXPress failed while typing text.")
        }
        Thread.sleep(forTimeInterval: 0.06)
    }
    return true
}

func typeTextIntoElement(_ element: AXUIElement, text: String) -> Bool {
    guard isEditableTextElement(element),
          let currentValue = editableTextValue(element) else {
        return false
    }

    let nsValue = currentValue as NSString
    let selectedRange = selectedTextRange(element) ?? CFRange(location: nsValue.length, length: 0)
    let start = max(0, min(selectedRange.location, nsValue.length))
    let length = max(0, min(selectedRange.length, nsValue.length - start))
    let replacementRange = NSRange(location: start, length: length)
    let nextValue = nsValue.replacingCharacters(in: replacementRange, with: text)

    showAgentCursorAndWait(for: element, pressed: false)
    let error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, nextValue as CFString)
    if error != .success {
        return false
    }

    let cursorLocation = start + (text as NSString).length
    var cursorRange = CFRange(location: cursorLocation, length: 0)
    if let axRange = AXValueCreate(.cfRange, &cursorRange) {
        AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axRange)
    }
    Thread.sleep(forTimeInterval: 0.04)
    return true
}

func isEditableTextElement(_ element: AXUIElement) -> Bool {
    guard let role = copyStringAttribute(element, kAXRoleAttribute) else {
        return false
    }
    return ["AXTextField", "AXTextArea", "AXComboBox"].contains(role)
}

func editableTextValue(_ element: AXUIElement) -> String? {
    if let value = copyStringAttribute(element, kAXValueAttribute) {
        return value
    }
    return nil
}

func selectedTextRange(_ element: AXUIElement) -> CFRange? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value)
    guard error == .success,
          let value,
          CFGetTypeID(value) == AXValueGetTypeID() else {
        return nil
    }
    let axValue = value as! AXValue
    var range = CFRange(location: 0, length: 0)
    guard AXValueGetValue(axValue, .cfRange, &range) else {
        return nil
    }
    return range
}

func supportsKeypadButtonEmulation(_ app: ResolvedApp) -> Bool {
    app.bundleIdentifier == "com.apple.calculator" || app.displayName.caseInsensitiveCompare("Calculator") == .orderedSame
}

func pressableElement(in app: ResolvedApp, labels: [String]) -> AXUIElement? {
    let expected = Set(labels.map(normalizeLookupLabel))
    guard !expected.isEmpty else {
        return nil
    }

    let appElement = AXUIElementCreateApplication(app.running.processIdentifier)
    let root = targetWindow(for: appElement) ?? appElement
    let builder = TreeBuilder()
    _ = builder.build(from: root)
    return builder.elements.first { element in
        copyActionNames(element).contains(kAXPressAction as String) && elementLabels(element).contains { label in
            expected.contains(normalizeLookupLabel(label))
        }
    }
}

func waitForPressableElement(in app: ResolvedApp, labels: [String]) -> AXUIElement? {
    let deadline = Date().addingTimeInterval(accessibleKeyTargetTimeout)
    while Date() < deadline {
        if let element = pressableElement(in: app, labels: labels) {
            return element
        }
        Thread.sleep(forTimeInterval: 0.06)
    }
    return pressableElement(in: app, labels: labels)
}

func elementLabels(_ element: AXUIElement) -> [String] {
    [
        copyStringAttribute(element, kAXTitleAttribute),
        copyStringAttribute(element, kAXDescriptionAttribute),
        describeValue(element),
        copyStringAttribute(element, kAXHelpAttribute),
        copyStringAttribute(element, kAXIdentifierAttribute),
    ].compactMap { $0 }.filter { !$0.isEmpty }
}

func normalizeLookupLabel(_ value: String) -> String {
    clean(value)
        .lowercased()
        .replacingOccurrences(of: "−", with: "-")
        .replacingOccurrences(of: "×", with: "*")
        .replacingOccurrences(of: "÷", with: "/")
}

func accessibleLabels(forKey rawKey: String) -> [String] {
    let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch key {
    case "0", "kp_0", "numpad_0":
        return ["0"]
    case "1", "kp_1", "numpad_1":
        return ["1"]
    case "2", "kp_2", "numpad_2":
        return ["2"]
    case "3", "kp_3", "numpad_3":
        return ["3"]
    case "4", "kp_4", "numpad_4":
        return ["4"]
    case "5", "kp_5", "numpad_5":
        return ["5"]
    case "6", "kp_6", "numpad_6":
        return ["6"]
    case "7", "kp_7", "numpad_7":
        return ["7"]
    case "8", "kp_8", "numpad_8":
        return ["8"]
    case "9", "kp_9", "numpad_9":
        return ["9"]
    case ".", "decimal", "kp_decimal", "numpad_decimal":
        return [".", "decimal"]
    case "+", "plus", "add", "kp_add", "numpad_add":
        return ["+", "add", "plus"]
    case "-", "subtract", "kp_subtract", "numpad_subtract":
        return ["-", "subtract", "minus"]
    case "*", "multiply", "kp_multiply", "numpad_multiply":
        return ["*", "multiply"]
    case "/", "divide", "kp_divide", "numpad_divide":
        return ["/", "divide"]
    case "=", "equal", "equals", "kp_equal", "numpad_equal", "kp_enter", "numpad_enter":
        return ["=", "equals"]
    case "clear", "kp_clear", "numpad_clear":
        return ["clear", "all clear", "ac", "c"]
    default:
        return []
    }
}

func postClick(at point: CGPoint, button: String, count: Int) {
    let mouseButton = cgMouseButton(button)
    let downType = mouseDownType(mouseButton)
    let upType = mouseUpType(mouseButton)
    for _ in 0..<count {
        moveMouse(to: point)
        CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.04)
        CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: mouseButton)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.08)
    }
}

func moveMouse(to point: CGPoint) {
    if ProcessInfo.processInfo.environment[testForbidMouseWarpEnv] == "1" {
        fputs("Computer Use test blocked physical mouse movement to \(Int(point.x)),\(Int(point.y)).\n", stderr)
        exit(EXIT_FAILURE)
    }
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func postDrag(from: CGPoint, to: CGPoint) {
    moveMouse(to: from)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
    let steps = 16
    for step in 1...steps {
        let progress = CGFloat(step) / CGFloat(steps)
        let point = CGPoint(x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress)
        CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.012)
    }
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func postScroll(deltaX: Int32, deltaY: Int32) {
    CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: deltaY,
        wheel2: deltaX,
        wheel3: 0
    )?.post(tap: .cghidEventTap)
}

func postUnicode(_ text: String) {
    var utf16 = Array(text.utf16)
    guard !utf16.isEmpty else {
        return
    }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    up?.post(tap: .cghidEventTap)
}

func postKey(_ rawKey: String) throws {
    let trimmedKey = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
    if let stroke = keyStrokeByName[trimmedKey.lowercased()] {
        postKeyCode(stroke.keyCode, flags: stroke.flags)
        return
    }

    let pieces = trimmedKey.split(separator: "+").map { String($0).lowercased() }
    guard let keyName = pieces.last else {
        throw HelperError.message("key is required.")
    }
    var flags: CGEventFlags = []
    for modifier in pieces.dropLast() {
        switch modifier {
        case "super", "cmd", "command", "meta":
            flags.insert(.maskCommand)
        case "ctrl", "control":
            flags.insert(.maskControl)
        case "shift":
            flags.insert(.maskShift)
        case "alt", "option":
            flags.insert(.maskAlternate)
        default:
            throw HelperError.message("Unsupported key modifier: \(modifier)")
        }
    }

    if keyName.count == 1,
       let scalar = keyName.unicodeScalars.first,
       keyCodeByCharacter[String(scalar)] == nil {
        postUnicode(keyName)
        return
    }

    if let stroke = keyStrokeByName[keyName] {
        postKeyCode(stroke.keyCode, flags: flags.union(stroke.flags))
        return
    }

    guard let keyCode = keyCodeByCharacter[keyName] else {
        throw HelperError.message("Unsupported key: \(rawKey)")
    }
    postKeyCode(keyCode, flags: flags)
}

struct KeyStroke {
    let keyCode: CGKeyCode
    let flags: CGEventFlags
}

func keyStroke(_ keyCode: CGKeyCode, flags: CGEventFlags = []) -> KeyStroke {
    KeyStroke(keyCode: keyCode, flags: flags)
}

let keyCodeByCharacter: [String: CGKeyCode] = [
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07,
    "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10,
    "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
    "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E, "o": 0x1F, "u": 0x20,
    "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
    "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, " ": 0x31, "`": 0x32,
]

let keyStrokeByName: [String: KeyStroke] = [
    "+": keyStroke(0x18, flags: .maskShift),
    "plus": keyStroke(0x18, flags: .maskShift),
    "add": keyStroke(0x45),
    "kp_add": keyStroke(0x45),
    "numpad_add": keyStroke(0x45),
    "equal": keyStroke(0x18),
    "equals": keyStroke(0x18),
    "subtract": keyStroke(0x4E),
    "kp_subtract": keyStroke(0x4E),
    "numpad_subtract": keyStroke(0x4E),
    "multiply": keyStroke(0x43),
    "kp_multiply": keyStroke(0x43),
    "numpad_multiply": keyStroke(0x43),
    "divide": keyStroke(0x4B),
    "kp_divide": keyStroke(0x4B),
    "numpad_divide": keyStroke(0x4B),
    "decimal": keyStroke(0x41),
    "kp_decimal": keyStroke(0x41),
    "numpad_decimal": keyStroke(0x41),
    "clear": keyStroke(0x47),
    "kp_clear": keyStroke(0x47),
    "kp_enter": keyStroke(0x4C),
    "numpad_enter": keyStroke(0x4C),
    "kp_equal": keyStroke(0x51),
    "numpad_equal": keyStroke(0x51),
    "return": keyStroke(0x24),
    "enter": keyStroke(0x24),
    "tab": keyStroke(0x30),
    "space": keyStroke(0x31),
    "delete": keyStroke(0x33),
    "backspace": keyStroke(0x33),
    "escape": keyStroke(0x35),
    "esc": keyStroke(0x35),
    "left": keyStroke(0x7B),
    "right": keyStroke(0x7C),
    "down": keyStroke(0x7D),
    "up": keyStroke(0x7E),
    "home": keyStroke(0x73),
    "end": keyStroke(0x77),
    "page_up": keyStroke(0x74),
    "pageup": keyStroke(0x74),
    "page_down": keyStroke(0x79),
    "pagedown": keyStroke(0x79),
    "kp_0": keyStroke(0x52),
    "kp_1": keyStroke(0x53),
    "kp_2": keyStroke(0x54),
    "kp_3": keyStroke(0x55),
    "kp_4": keyStroke(0x56),
    "kp_5": keyStroke(0x57),
    "kp_6": keyStroke(0x58),
    "kp_7": keyStroke(0x59),
    "kp_8": keyStroke(0x5B),
    "kp_9": keyStroke(0x5C),
]

func postKeyCode(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    up?.post(tap: .cghidEventTap)
}

func cgMouseButton(_ button: String) -> CGMouseButton {
    switch button {
    case "right":
        return .right
    case "middle":
        return .center
    default:
        return .left
    }
}

func mouseDownType(_ button: CGMouseButton) -> CGEventType {
    switch button {
    case .right:
        return .rightMouseDown
    case .center:
        return .otherMouseDown
    default:
        return .leftMouseDown
    }
}

func mouseUpType(_ button: CGMouseButton) -> CGEventType {
    switch button {
    case .right:
        return .rightMouseUp
    case .center:
        return .otherMouseUp
    default:
        return .leftMouseUp
    }
}

func findTextRange(in value: String, target: String, prefix: String?, suffix: String?) -> NSRange {
    let ns = value as NSString
    var searchStart = 0
    if let prefix, !prefix.isEmpty {
        let prefixRange = ns.range(of: prefix)
        if prefixRange.location == NSNotFound {
            return NSRange(location: NSNotFound, length: 0)
        }
        searchStart = prefixRange.location + prefixRange.length
    }

    let targetRange = ns.range(of: target, options: [], range: NSRange(location: searchStart, length: ns.length - searchStart))
    if targetRange.location == NSNotFound {
        return targetRange
    }

    if let suffix, !suffix.isEmpty {
        let suffixStart = targetRange.location + targetRange.length
        let suffixRange = ns.range(of: suffix, options: [], range: NSRange(location: suffixStart, length: ns.length - suffixStart))
        if suffixRange.location == NSNotFound {
            return NSRange(location: NSNotFound, length: 0)
        }
    }

    return targetRange
}

func normalizeRole(_ role: String) -> String {
    role
        .replacingOccurrences(of: "AX", with: "")
        .replacingOccurrences(of: "UIElement", with: "element")
        .splitCamelCase()
        .lowercased()
}

func normalizeActionName(_ action: String) -> String {
    action
        .replacingOccurrences(of: "AX", with: "")
        .replacingOccurrences(of: "Action", with: "")
        .splitCamelCase()
}

func canonicalActionName(_ action: String) -> String {
    if action.hasPrefix("AX") {
        return action
    }
    let collapsed = action.replacingOccurrences(of: " ", with: "")
    return "AX\(collapsed)Action"
}

func clean(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\r", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func require<T>(_ value: T?, _ name: String) throws -> T {
    guard let value else {
        throw HelperError.message("\(name) is required.")
    }
    return value
}

func formatCoordinate(_ value: Double) -> String {
    if value.rounded() == value {
        return String(format: "%.0f", value)
    }
    return String(format: "%.1f", value)
}

func formatMilliseconds(_ seconds: TimeInterval) -> String {
    String(format: "%.0f", seconds * 1000)
}

func emit(_ response: Response) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try! encoder.encode(response)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
    exit(response.ok ? EXIT_SUCCESS : EXIT_FAILURE)
}

extension String {
    func splitCamelCase() -> String {
        var result = ""
        for scalar in unicodeScalars {
            if CharacterSet.uppercaseLetters.contains(scalar), !result.isEmpty {
                result.append(" ")
            }
            result.unicodeScalars.append(scalar)
        }
        return result
    }
}

main()
