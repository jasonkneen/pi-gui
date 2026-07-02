import Foundation
import Darwin

private let pluginBundleName = "PiGuiComputerUseAuthorizationPlugin.bundle"
private let pluginExecutableName = "PiGuiComputerUseAuthorizationPlugin"
private let helperAppName = "pi-gui Computer Use.app"
private let helperExecutableName = "pi-gui-computer-use-helper"
private let mechanismName = "PiGuiComputerUseAuthorizationPlugin:allow"
private let remoteRightName = "com.pi-gui.desktop.ComputerUse.AuthorizationPlugin.remote"
private let originalScreensaverRightName = "com.pi-gui.desktop.ComputerUse.AuthorizationPlugin.original-screensaver"
private let screensaverRightName = "system.login.screensaver"
private let supportDirectory = "/Library/Application Support/PiGuiComputerUseAuthorizationPlugin"
private let installedHelperAppPath = "\(supportDirectory)/\(helperAppName)"
private let installedPluginPath = "/Library/Security/SecurityAgentPlugins/\(pluginBundleName)"
private let backupManifestName = "latest-backup-manifest.plist"
private let configurationName = "configuration.plist"
private let confirmFlag = "--confirm-system-login-change"

enum InstallerError: Error, CustomStringConvertible {
    case usage
    case missingConfirmFlag
    case requiresRoot
    case missingBundledPlugin(String)
    case commandFailed(String)
    case invalidAuthorizationRule(String)

    var description: String {
        switch self {
        case .usage:
            return "usage: pi-gui-computer-use-locked-use-installer status|install|uninstall [RESOURCE_DIR] \(confirmFlag)"
        case .missingConfirmFlag:
            return "install and uninstall modify macOS login authorization state and require \(confirmFlag)."
        case .requiresRoot:
            return "install and uninstall must run with administrator privileges."
        case .missingBundledPlugin(let path):
            return "missing bundled authorization plug-in at \(path)"
        case .commandFailed(let message):
            return message
        case .invalidAuthorizationRule(let message):
            return message
        }
    }
}

struct CommandResult {
    let stdout: String
    let stderr: String
    let status: Int32
}

let arguments = Array(CommandLine.arguments.dropFirst())

do {
    guard let action = arguments.first else {
        throw InstallerError.usage
    }

    switch action {
    case "status":
        print("OK: \(try lockedUseStatus())")
    case "install":
        try requireConfirmedSystemChange(arguments)
        let resourceDirectory = try resourceDirectoryArgument(arguments)
        try install(resourceDirectory: resourceDirectory)
        print("OK: installed")
    case "uninstall":
        try requireConfirmedSystemChange(arguments)
        try uninstall()
        print("OK: uninstalled")
    default:
        throw InstallerError.usage
    }
} catch {
    fputs("ERROR: \(error)\n", stderr)
    exit(1)
}

func lockedUseStatus() throws -> String {
    let pluginInstalled = FileManager.default.fileExists(atPath: installedPluginPath)
    let configurationInstalled = FileManager.default.fileExists(atPath: configurationPath())
    let helperInstalled = FileManager.default.fileExists(atPath: installedHelperAppPath)
    let helperCurrent = installedHelperMatchesBundled()
    let screensaverRule = try authorizationRule(named: screensaverRightName)
    let screensaverHasPiGuiDelegates = currentScreensaverHasPiGuiDelegates(screensaverRule)
    let screensaverUsesPiGuiWrapper = isPiGuiScreensaverWrapper(screensaverRule)
    let remoteRule = try? authorizationRule(named: remoteRightName)
    let remoteContainsMechanism = remoteRule.flatMap { stringArray(in: $0, key: "mechanisms").contains(mechanismName) } ?? false
    let originalRuleInstalled = (try? authorizationRule(named: originalScreensaverRightName)) != nil

    if pluginInstalled && configurationInstalled && helperInstalled && helperCurrent && screensaverUsesPiGuiWrapper && remoteContainsMechanism && originalRuleInstalled {
        return "installed"
    }
    if !pluginInstalled && !configurationInstalled && !helperInstalled && !screensaverHasPiGuiDelegates && !remoteContainsMechanism && !originalRuleInstalled {
        return "not-installed"
    }
    return "partial"
}

func install(resourceDirectory: String) throws {
    try requireRoot()
    let sourcePluginPath = URL(fileURLWithPath: resourceDirectory).appendingPathComponent(pluginBundleName).path
    guard FileManager.default.fileExists(atPath: sourcePluginPath) else {
        throw InstallerError.missingBundledPlugin(sourcePluginPath)
    }
    let sourceExecutablePath = URL(fileURLWithPath: sourcePluginPath)
        .appendingPathComponent("Contents")
        .appendingPathComponent("MacOS")
        .appendingPathComponent(pluginExecutableName)
        .path
    guard FileManager.default.fileExists(atPath: sourceExecutablePath) else {
        throw InstallerError.missingBundledPlugin(sourceExecutablePath)
    }
    let sourceHelperAppPath = try bundledHelperAppPath(resourceDirectory: resourceDirectory)

    try FileManager.default.createDirectory(
        atPath: supportDirectory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o755],
    )
    try runChecked("/usr/sbin/chown", ["root:wheel", supportDirectory])
    try runChecked("/bin/chmod", ["755", supportDirectory])
    try backupScreensaverRule()

    try installHelperApp(sourceHelperAppPath: sourceHelperAppPath)
    if FileManager.default.fileExists(atPath: installedPluginPath) {
        try FileManager.default.removeItem(atPath: installedPluginPath)
    }
    try FileManager.default.copyItem(atPath: sourcePluginPath, toPath: installedPluginPath)
    try runChecked("/usr/sbin/chown", ["-R", "root:wheel", installedPluginPath])
    try runChecked("/bin/chmod", ["-R", "go-w", installedPluginPath])
    let installedExecutablePath = URL(fileURLWithPath: installedPluginPath)
        .appendingPathComponent("Contents")
        .appendingPathComponent("MacOS")
        .appendingPathComponent(pluginExecutableName)
        .path
    try runChecked("/bin/chmod", ["755", installedExecutablePath])
    try writeConfiguration()

    try writeAuthorizationRule(named: remoteRightName, rule: remoteAuthorizationRule())
    try installRemoteRuleBranch()
}

func uninstall() throws {
    try requireRoot()
    try uninstallRemoteRuleBranch()
    _ = try? run("/usr/bin/security", ["authorizationdb", "remove", remoteRightName])
    _ = try? run("/usr/bin/security", ["authorizationdb", "remove", originalScreensaverRightName])
    if FileManager.default.fileExists(atPath: installedPluginPath) {
        try FileManager.default.removeItem(atPath: installedPluginPath)
    }
    let configPath = configurationPath()
    if FileManager.default.fileExists(atPath: configPath) {
        try FileManager.default.removeItem(atPath: configPath)
    }
    if FileManager.default.fileExists(atPath: installedHelperAppPath) {
        try FileManager.default.removeItem(atPath: installedHelperAppPath)
    }
}

func installRemoteRuleBranch() throws {
    var rule = try authorizationRule(named: screensaverRightName)
    var rules = stringArray(in: rule, key: "rule")
    if isPiGuiScreensaverWrapper(rule),
       (try? authorizationRule(named: originalScreensaverRightName)) != nil {
        return
    }

    if rules.contains(remoteRightName) || rules.contains(originalScreensaverRightName) {
        rules = rules.filter { $0 != remoteRightName && $0 != originalScreensaverRightName }
        setRuleDelegatesPreservingQuorum(&rule, rules.isEmpty ? ["use-login-window-ui"] : rules)
    }

    try writeAuthorizationRule(named: originalScreensaverRightName, rule: rule)
    rule["class"] = "rule"
    rule["comment"] = "Allow active pi-gui Computer Use lock-screen authorizations or the original screensaver unlock policy."
    rule["modified"] = Date().timeIntervalSinceReferenceDate
    rule["rule"] = [remoteRightName, originalScreensaverRightName]
    rule["k-of-n"] = 1
    try writeAuthorizationRule(named: screensaverRightName, rule: rule)
}

func uninstallRemoteRuleBranch() throws {
    let currentRule = try authorizationRule(named: screensaverRightName)
    if isPiGuiScreensaverWrapper(currentRule),
       let originalRule = try? authorizationRule(named: originalScreensaverRightName) {
        try writeAuthorizationRule(named: screensaverRightName, rule: originalRule)
        return
    }

    guard currentScreensaverHasPiGuiDelegates(currentRule) else {
        return
    }

    var rule = currentRule
    let rules = stringArray(in: rule, key: "rule").filter { $0 != remoteRightName && $0 != originalScreensaverRightName }
    setRuleDelegatesPreservingQuorum(&rule, rules.isEmpty ? ["use-login-window-ui"] : rules)
    try writeAuthorizationRule(named: screensaverRightName, rule: rule)
}

func isPiGuiScreensaverWrapper(_ rule: [String: Any]) -> Bool {
    let expectedDelegates = [remoteRightName, originalScreensaverRightName]
    return (rule["class"] as? String) == "rule"
        && stringArray(in: rule, key: "rule") == expectedDelegates
        && integerValue(in: rule, key: "k-of-n") == 1
}

func currentScreensaverHasPiGuiDelegates(_ rule: [String: Any]) -> Bool {
    let rules = stringArray(in: rule, key: "rule")
    return rules.contains(remoteRightName) || rules.contains(originalScreensaverRightName)
}

func setRuleDelegatesPreservingQuorum(_ rule: inout [String: Any], _ delegates: [String]) {
    if delegates.count == 1, let delegate = delegates.first {
        rule["rule"] = delegate
        rule.removeValue(forKey: "k-of-n")
        return
    }

    rule["rule"] = delegates
    if let quorum = integerValue(in: rule, key: "k-of-n") {
        rule["k-of-n"] = min(quorum, delegates.count)
    }
}

func backupScreensaverRule() throws {
    let rule = try authorizationRule(named: screensaverRightName)
    let backupName = "system.login.screensaver.\(Int(Date().timeIntervalSince1970)).plist"
    let backupPath = URL(fileURLWithPath: supportDirectory).appendingPathComponent(backupName).path
    let data = try PropertyListSerialization.data(fromPropertyList: rule, format: .xml, options: 0)
    try data.write(to: URL(fileURLWithPath: backupPath), options: .atomic)
    let manifest = ["screenSaverRuleBackupPath": backupPath]
    let manifestData = try PropertyListSerialization.data(fromPropertyList: manifest, format: .xml, options: 0)
    let manifestPath = URL(fileURLWithPath: supportDirectory).appendingPathComponent(backupManifestName)
    try manifestData.write(to: manifestPath, options: .atomic)
}

func bundledHelperAppPath(resourceDirectory: String) throws -> String {
    let sourceHelperAppPath = helperAppPath(resourceDirectory: resourceDirectory)
    let sourceHelperExecutablePath = URL(fileURLWithPath: sourceHelperAppPath)
        .appendingPathComponent("Contents")
        .appendingPathComponent("MacOS")
        .appendingPathComponent(helperExecutableName)
        .path
    guard FileManager.default.fileExists(atPath: sourceHelperExecutablePath) else {
        throw InstallerError.commandFailed("missing bundled Computer Use helper at \(sourceHelperExecutablePath)")
    }
    return sourceHelperAppPath
}

func installedHelperMatchesBundled() -> Bool {
    let resourceDirectory = (try? resourceDirectoryArgument(arguments))
        ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().path
    let sourceHelperExecutablePath = URL(fileURLWithPath: helperAppPath(resourceDirectory: resourceDirectory))
        .appendingPathComponent("Contents")
        .appendingPathComponent("MacOS")
        .appendingPathComponent(helperExecutableName)
        .path
    let installedHelperExecutablePath = helperExecutablePath()
    guard FileManager.default.fileExists(atPath: sourceHelperExecutablePath),
          FileManager.default.fileExists(atPath: installedHelperExecutablePath),
          let sourceData = try? Data(contentsOf: URL(fileURLWithPath: sourceHelperExecutablePath)),
          let installedData = try? Data(contentsOf: URL(fileURLWithPath: installedHelperExecutablePath)) else {
        return false
    }
    return sourceData == installedData
}

func installHelperApp(sourceHelperAppPath: String) throws {
    if sameFileSystemPath(sourceHelperAppPath, installedHelperAppPath) {
        try hardenInstalledHelperApp()
        return
    }

    if FileManager.default.fileExists(atPath: installedHelperAppPath) {
        try FileManager.default.removeItem(atPath: installedHelperAppPath)
    }
    try FileManager.default.copyItem(atPath: sourceHelperAppPath, toPath: installedHelperAppPath)
    try hardenInstalledHelperApp()
}

func hardenInstalledHelperApp() throws {
    try runChecked("/usr/sbin/chown", ["-R", "root:wheel", installedHelperAppPath])
    try runChecked("/bin/chmod", ["-R", "go-w", installedHelperAppPath])
    try runChecked("/bin/chmod", ["755", helperExecutablePath()])
}

func sameFileSystemPath(_ lhs: String, _ rhs: String) -> Bool {
    URL(fileURLWithPath: lhs).standardizedFileURL.path == URL(fileURLWithPath: rhs).standardizedFileURL.path
}

func writeConfiguration() throws {
    let helperPath = helperExecutablePath()
    guard FileManager.default.fileExists(atPath: helperPath) else {
        throw InstallerError.commandFailed("missing installed Computer Use helper at \(helperPath)")
    }

    let configuration = [
        "helperExecutablePath": helperPath,
        "helperCodePath": helperCodePath(),
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: configuration, format: .xml, options: 0)
    try data.write(to: URL(fileURLWithPath: configurationPath()), options: .atomic)
    try runChecked("/usr/sbin/chown", ["root:wheel", configurationPath()])
    try runChecked("/bin/chmod", ["644", configurationPath()])
}

func configurationPath() -> String {
    URL(fileURLWithPath: supportDirectory).appendingPathComponent(configurationName).path
}

func helperAppPath(resourceDirectory: String) -> String {
    let resourceURL = URL(fileURLWithPath: resourceDirectory).standardizedFileURL
    let siblingHelperAppPath = resourceURL.appendingPathComponent(helperAppName).path
    if FileManager.default.fileExists(atPath: siblingHelperAppPath) {
        return siblingHelperAppPath
    }

    let enclosingAppURL = resourceURL
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    if enclosingAppURL.pathExtension == "app" {
        return enclosingAppURL.path
    }

    return siblingHelperAppPath
}

func helperExecutablePath() -> String {
    URL(fileURLWithPath: installedHelperAppPath)
        .appendingPathComponent("Contents")
        .appendingPathComponent("MacOS")
        .appendingPathComponent(helperExecutableName)
        .path
}

func helperCodePath() -> String {
    installedHelperAppPath
}

func authorizationRule(named name: String) throws -> [String: Any] {
    let result = try run("/usr/bin/security", ["authorizationdb", "read", name])
    guard result.status == 0 else {
        throw InstallerError.commandFailed(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    let data = Data(result.stdout.utf8)
    let value = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
    guard let dictionary = value as? [String: Any] else {
        throw InstallerError.invalidAuthorizationRule("\(name) did not return a property-list dictionary.")
    }
    return dictionary
}

func writeAuthorizationRule(named name: String, rule: [String: Any]) throws {
    let data = try PropertyListSerialization.data(fromPropertyList: rule, format: .xml, options: 0)
    let result = try run("/usr/bin/security", ["authorizationdb", "write", name], input: data)
    guard result.status == 0 else {
        throw InstallerError.commandFailed(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

func remoteAuthorizationRule() -> [String: Any] {
    [
        "class": "evaluate-mechanisms",
        "comment": "Screen-unlock branch that asks pi-gui Computer Use whether an active locked-use authorization is pending.",
        "created": Date().timeIntervalSinceReferenceDate,
        "modified": Date().timeIntervalSinceReferenceDate,
        "mechanisms": [mechanismName],
        "shared": false,
        "tries": 1,
        "version": 1,
    ]
}

func stringArray(in dictionary: [String: Any], key: String) -> [String] {
    if let values = dictionary[key] as? [String] {
        return values
    }
    if let value = dictionary[key] as? String {
        return [value]
    }
    return []
}

func integerValue(in dictionary: [String: Any], key: String) -> Int? {
    if let value = dictionary[key] as? Int {
        return value
    }
    if let value = dictionary[key] as? NSNumber {
        return value.intValue
    }
    return nil
}

func run(_ executable: String, _ arguments: [String], input: Data? = nil) throws -> CommandResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments

    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    if let input {
        let stdin = Pipe()
        process.standardInput = stdin
        try process.run()
        stdin.fileHandleForWriting.write(input)
        try stdin.fileHandleForWriting.close()
    } else {
        try process.run()
    }

    let stdoutData = stdout.fileHandleForReading.readDataToEndOfFile()
    let stderrData = stderr.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()

    return CommandResult(
        stdout: String(decoding: stdoutData, as: UTF8.self),
        stderr: String(decoding: stderrData, as: UTF8.self),
        status: process.terminationStatus,
    )
}

func runChecked(_ executable: String, _ arguments: [String], input: Data? = nil) throws {
    let result = try run(executable, arguments, input: input)
    guard result.status == 0 else {
        let message = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if message.isEmpty {
            throw InstallerError.commandFailed("\(executable) failed with status \(result.status).")
        }
        throw InstallerError.commandFailed(message)
    }
}

func requireConfirmedSystemChange(_ arguments: [String]) throws {
    guard arguments.contains(confirmFlag) else {
        throw InstallerError.missingConfirmFlag
    }
}

func requireRoot() throws {
    guard geteuid() == 0 else {
        throw InstallerError.requiresRoot
    }
}

func resourceDirectoryArgument(_ arguments: [String]) throws -> String {
    if let explicitPath = arguments.dropFirst().first(where: { $0 != confirmFlag }) {
        return explicitPath
    }

    return URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().path
}
