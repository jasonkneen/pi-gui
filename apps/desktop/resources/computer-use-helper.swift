import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

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
private let cursorOverlayDurationEnv = "PI_GUI_COMPUTER_USE_CURSOR_DURATION_MS"
private let cursorOverlayGlideDurationEnv = "PI_GUI_COMPUTER_USE_CURSOR_GLIDE_MS"
private let defaultCursorOverlayDuration = 1.4
private let defaultCursorOverlayGlideDuration = 0.22
private let agentCursorPositionFile = FileManager.default.temporaryDirectory.appendingPathComponent("pi-gui-computer-use-agent-cursor-position")
private let agentCursorPidFile = FileManager.default.temporaryDirectory.appendingPathComponent("pi-gui-computer-use-agent-cursor.pid")
private let maxSavedAgentCursorPositionAge: TimeInterval = 300
private let cursorOverlayFrameInterval: TimeInterval = 1.0 / 60.0

struct AgentCursorRequest {
    let point: CGPoint
    let pressed: Bool
    let timestamp: TimeInterval
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
    if CommandLine.arguments.contains(cursorOverlayDaemonArgument) {
        runAgentCursorOverlayDaemon()
    }

    do {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let request = try JSONDecoder().decode(Request.self, from: input)
        let response = try handle(request)
        emit(response)
    } catch {
        emit(Response(ok: false, content: nil, details: nil, error: String(describing: error)))
    }
}

func handle(_ request: Request) throws -> Response {
    if request.command != "list_apps" {
        try requireUnlockedDesktop()
    }

    switch request.command {
    case "list_apps":
        return try listApps()
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

func requireUnlockedDesktop() throws {
    if isScreenLocked() {
        throw HelperError.message("Computer Use is unavailable while the Mac is locked. Unlock the desktop and retry.")
    }
}

func isScreenLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return false
    }
    return (session["CGSSessionScreenIsLocked"] as? Bool) == true
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
            showAgentCursor(for: element, pressed: true)
            try pressElement(element, count: clickCount, failureContext: "AXPress failed for element \(request.element_index ?? "")")
            return try stateResponse(for: app)
        }
        if let center = elementCenter(element) {
            withTemporaryActivation(app, cursorPoint: center) {
                postClick(at: center, button: button, count: clickCount)
            }
            return try stateResponse(for: app)
        }
        throw HelperError.message("Element \(request.element_index ?? "") has no clickable position.")
    }

    let point = try screenshotPoint(request, app: app, x: request.x, y: request.y)
    if button == "left",
       let element = accessibilityElement(at: point, in: app),
       copyActionNames(element).contains(kAXPressAction as String) {
        showAgentCursor(at: elementCenter(element) ?? point, pressed: true)
        try pressElement(element, count: clickCount, failureContext: "AXPress failed for coordinate click")
        return try stateResponse(for: app)
    }
    withTemporaryActivation(app, cursorPoint: point) {
        postClick(at: point, button: button, count: clickCount)
    }
    return try stateResponse(for: app)
}

func performSecondaryAction(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let element = try requireIndexedElement(request, app: app)
    let action = try require(request.action, "action")
    let axAction = canonicalActionName(action)
    showAgentCursor(for: element, pressed: true)
    let error = AXUIElementPerformAction(element, axAction as CFString)
    if error != .success {
        throw HelperError.message("Could not perform action \(action) on element \(request.element_index ?? ""): \(error.rawValue)")
    }
    return try stateResponse(for: app)
}

func setValue(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let element = try requireIndexedElement(request, app: app)
    let value = try require(request.value, "value")
    showAgentCursor(for: element, pressed: false)
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
    showAgentCursor(for: element, pressed: false)
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
        showAgentCursor(for: element, pressed: false)
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
    withTemporaryActivation(app, cursorPoint: cursorPoint) {
        if let cursorPoint {
            moveMouse(to: cursorPoint)
        }
        postScroll(deltaX: deltaX, deltaY: deltaY)
    }
    return try stateResponse(for: app)
}

func drag(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let from = try screenshotPoint(request, app: app, x: request.from_x, y: request.from_y)
    let to = try screenshotPoint(request, app: app, x: request.to_x, y: request.to_y)
    withTemporaryActivation(app, cursorPoint: from) {
        postDrag(from: from, to: to)
        showAgentCursor(at: to, pressed: false)
    }
    return try stateResponse(for: app)
}

func pressKey(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let key = try require(request.key, "key")
    if try pressAccessibleKey(key, app: app) {
        return try stateResponse(for: app)
    }
    try withTemporaryActivation(app, cursorPoint: nil) {
        try postKey(key)
    }
    return try stateResponse(for: app)
}

func typeText(_ request: Request) throws -> Response {
    let app = try resolveApp(request.app)
    let text = try require(request.text, "text")
    if let element = try indexedElement(request, app: app) {
        if typeTextIntoElement(element, text: text) {
            return try stateResponse(for: app)
        }
        if let center = elementCenter(element) {
            withTemporaryActivation(app, cursorPoint: center) {
                moveMouse(to: center)
                postClick(at: center, button: "left", count: 1)
                for character in text {
                    postUnicode(String(character))
                    Thread.sleep(forTimeInterval: 0.01)
                }
            }
            return try stateResponse(for: app)
        }
        throw HelperError.message("Element \(request.element_index ?? "") does not support background text insertion and has no typing position.")
    }
    if try typeAccessibleText(text, app: app) {
        return try stateResponse(for: app)
    }
    withTemporaryActivation(app, cursorPoint: nil) {
        for character in text {
            postUnicode(String(character))
            Thread.sleep(forTimeInterval: 0.01)
        }
    }
    return try stateResponse(for: app)
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
    let screenshot = capture.windowId.flatMap { captureWindowImage(windowId: $0) }

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
    let appElement = AXUIElementCreateApplication(app.running.processIdentifier)
    let window = targetWindow(for: appElement) ?? appElement
    let frame = windowFrame(window) ?? windowCapture(for: app, title: nil).frame
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
) rethrows -> T {
    let previousApp = NSWorkspace.shared.frontmostApplication
    let previousMouseLocation = currentMouseLocation()
    activate(app)
    Thread.sleep(forTimeInterval: 0.08)
    if let cursorPoint {
        showAgentCursor(at: cursorPoint, pressed: true)
    }
    defer {
        if restoreFocus {
            restoreUserFocus(previousApp, mouseLocation: previousMouseLocation, targetPid: app.running.processIdentifier)
        }
    }
    return try body()
}

func restoreUserFocus(_ previousApp: NSRunningApplication?, mouseLocation: CGPoint?, targetPid: pid_t) {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid else {
        return
    }
    if let previousApp,
       previousApp.processIdentifier != targetPid,
       let stillRunning = NSRunningApplication(processIdentifier: previousApp.processIdentifier) {
        stillRunning.activate(options: [.activateAllWindows])
        waitForFrontmost(processIdentifier: stillRunning.processIdentifier, timeout: 0.35)
    }
    if let mouseLocation {
        moveMouse(to: mouseLocation)
    }
}

func waitForFrontmost(processIdentifier: pid_t, timeout: TimeInterval) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == processIdentifier {
            return
        }
        Thread.sleep(forTimeInterval: 0.02)
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
        if screen.frame.intersects(frame) {
            return Double(screen.backingScaleFactor)
        }
    }
    return Double(NSScreen.main?.backingScaleFactor ?? 1)
}

func showAgentCursor(for element: AXUIElement, pressed: Bool) {
    if let center = elementCenter(element) {
        showAgentCursor(at: center, pressed: pressed)
    }
}

func showAgentCursor(at point: CGPoint, pressed: Bool) {
    guard ProcessInfo.processInfo.environment["PI_GUI_COMPUTER_USE_SHOW_CURSOR"] != cursorOverlayDisabledValue,
          agentCursorFrame(for: point) != nil else {
        return
    }

    writeAgentCursorRequest(point, pressed: pressed)
    if !ensureAgentCursorOverlayDaemon() {
        showTransientAgentCursor(at: point, pressed: pressed)
    }
}

func showTransientAgentCursor(at point: CGPoint, pressed: Bool) {
    guard let targetFrame = agentCursorFrame(for: point) else {
        return
    }
    let startPoint = currentMouseLocation() ?? point
    let startFrame = agentCursorFrame(for: startPoint) ?? targetFrame
    NSApplication.shared.setActivationPolicy(.accessory)
    let (panel, cursorView) = makeAgentCursorPanel(frame: startFrame, pressed: false)
    panel.orderFrontRegardless()
    glideAgentCursor(panel, from: startFrame, to: targetFrame)
    cursorView.pressed = pressed
    RunLoop.current.run(until: Date().addingTimeInterval(cursorOverlayDuration()))
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
                        let initialPoint = currentMouseLocation() ?? request.point
                        let initialFrame = agentCursorFrame(for: initialPoint) ?? nextTargetFrame
                        let cursorPanel = makeAgentCursorPanel(frame: initialFrame, pressed: request.pressed)
                        panel = cursorPanel.panel
                        cursorView = cursorPanel.cursorView
                        currentFrame = initialFrame
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
        return true
    }
    try? FileManager.default.removeItem(at: agentCursorPidFile)
    return false
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
    return min(milliseconds / 1000, 2)
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
    guard let element = pressableElement(in: app, labels: labels) else {
        return false
    }
    showAgentCursor(for: element, pressed: true)
    let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
    Thread.sleep(forTimeInterval: 0.06)
    guard error == .success else {
        throw HelperError.message("AXPress failed for \(app.displayName) key \(rawKey): \(error.rawValue)")
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
        guard let element = pressableElement(in: app, labels: labels) else {
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

    showAgentCursor(for: element, pressed: false)
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
