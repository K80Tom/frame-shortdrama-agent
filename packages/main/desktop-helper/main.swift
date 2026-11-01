import Foundation
import AppKit
import ApplicationServices
import Darwin

// A narrow, user-initiated desktop bridge. No provider API, browser debugging,
// account storage, arbitrary scripts, or generic remote-control commands.
private let appPath = "/Applications/DoubaoWork.app"
private let allowedBundleIds = ["com.work.pc.doubao.browser", "com.work.pc.doubao"]
private let fm = FileManager.default

struct SubmitRequest: Decodable { let jobId: String; let prompt: String; let outputPath: String }
struct BridgeFailure: Error { let code: String; let message: String }

func respond(_ object: [String: Any]) -> Never {
    if let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(bytes)
        FileHandle.standardOutput.write(Data([10]))
    }
    exit(0)
}
func fail(_ code: String, _ message: String) throws -> Never { throw BridgeFailure(code: code, message: message) }
func trusted() -> Bool { AXIsProcessTrusted() }
func appVersion() -> String? { Bundle(path: appPath)?.infoDictionary?["CFBundleShortVersionString"] as? String }
func existsApp() -> Bool { Bundle(path: appPath)?.bundleIdentifier == "com.work.pc.doubao" }
func health() -> Never {
    let installed = existsApp(), access = trusted()
    var result: [String: Any] = ["available": installed && access, "installed": installed,
        "accessibilityTrusted": access,
        "code": !installed ? "DESKTOP_APP_NOT_INSTALLED" : (!access ? "DESKTOP_ACCESSIBILITY_REQUIRED" : "DESKTOP_READY"),
        "message": !installed ? "未找到已安装的豆包工作客户端。" : (!access ? "请在 macOS 系统设置的辅助功能中允许 OHAO Desktop Bridge，然后重新检测。" : "桌面桥已就绪；生成时使用豆包工作现有账号和额度。")]
    if let version = appVersion() { result["appVersion"] = version }
    respond(result)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func string(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func normalized(_ value: String) -> String { value.filter { !$0.isWhitespace }.lowercased() }
func labels(_ element: AXUIElement) -> [String] {
    [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, "AXPlaceholderValue"].map { string(element, $0) }.filter { !$0.isEmpty }
}
func matches(_ element: AXUIElement, _ value: String) -> Bool { labels(element).contains { normalized($0) == normalized(value) } }
func containsLabel(_ element: AXUIElement, _ value: String) -> Bool { labels(element).contains { $0.contains(value) } }
func isEnabled(_ element: AXUIElement) -> Bool { (attribute(element, kAXEnabledAttribute) as? Bool) != false }
func isHidden(_ element: AXUIElement) -> Bool { (attribute(element, "AXHidden") as? Bool) == true }
func tree(_ root: AXUIElement) -> [AXUIElement] {
    var result: [AXUIElement] = [], queue: [(AXUIElement, Int)] = [(root, 0)], index = 0
    while index < queue.count && result.count < 8000 {
        let (node, depth) = queue[index]; index += 1
        if isHidden(node) { continue }
        result.append(node)
        if depth < 45, let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] {
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
    }
    return result
}
func applicationWindows(_ app: NSRunningApplication) -> [AXUIElement] {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 1.5)
    return attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
}
struct TaskWindow { let app: NSRunningApplication; let window: AXUIElement; let nodes: [AXUIElement] }
func taskWindows(_ app: NSRunningApplication) -> [TaskWindow] {
    applicationWindows(app).compactMap { window in
        // The launcher and Chromium host can both expose AXWindows, including
        // non-content shell windows. Count only verified standard task windows;
        // do not merge by title/bounds, which could hide two real conversations.
        let role = string(window, kAXRoleAttribute), subrole = string(window, kAXSubroleAttribute)
        guard role == "AXWindow", subrole == "AXStandardWindow" else { return nil }
        let nodes = tree(window)
        guard isSupportedTaskWindow(role: role, subrole: subrole, documentURL: taskDocumentURL(nodes),
            composerCount: composerCandidates(nodes).count) else { return nil }
        return TaskWindow(app: app, window: window, nodes: nodes)
    }
}
func windowRoot(_ app: NSRunningApplication) -> AXUIElement? {
    let candidates = taskWindows(app)
    guard isUniqueWindowCount(candidates.count), let candidate = candidates.first,
        (attribute(candidate.window, kAXMinimizedAttribute) as? Bool) != true else { return nil }
    return candidate.window
}
func candidateApps() -> [NSRunningApplication] {
    allowedBundleIds.flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0) }.filter {
        guard let url = $0.bundleURL?.resolvingSymlinksInPath().path else { return false }
        return url == appPath || url.hasPrefix(appPath + "/Contents/Helpers/")
    }
}
func targetApp() throws -> NSRunningApplication {
    if let running = try uniqueWindowOwner() { return running }
    // Launch only the fixed installed app. This is reached only by submit, never health.
    let config = NSWorkspace.OpenConfiguration(); config.activates = true
    var finished = false
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: appPath), configuration: config) { _, _ in finished = true }
    let deadline = Date().addingTimeInterval(12)
    while Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
        if let running = try uniqueWindowOwner() { return running }
        if finished && candidateApps().isEmpty { break }
    }
    try fail("DESKTOP_APP_UNAVAILABLE", "豆包工作未能打开可操作窗口，请打开客户端后重试。")
}
func uniqueTaskWindow() throws -> TaskWindow? {
    let candidates = candidateApps().flatMap { taskWindows($0) }
    if candidates.count > 1 {
        try fail("DESKTOP_WINDOWS_AMBIGUOUS", "豆包工作有多个任务窗口，无法安全确定目标；请只保留一个工作任务窗口后重试。")
    }
    return isUniqueWindowCount(candidates.count) ? candidates.first : nil
}
func uniqueWindowOwner() throws -> NSRunningApplication? { try uniqueTaskWindow()?.app }
func snapshot(_ app: NSRunningApplication) throws -> [AXUIElement] {
    guard let target = try uniqueTaskWindow(), target.app.processIdentifier == app.processIdentifier else {
        try fail("DESKTOP_WINDOW_CHANGED", "豆包工作目标窗口已变化，已停止桌面操作。")
    }
    guard (attribute(target.window, kAXMinimizedAttribute) as? Bool) != true else {
        try fail("DESKTOP_WINDOW_UNAVAILABLE", "豆包工作任务窗口已最小化，请展开后重试；未提交生成。")
    }
    return target.nodes
}
func valueIsSettable(_ input: AXUIElement) -> Bool {
    var result: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(input, kAXValueAttribute as CFString, &result) == .success && result.boolValue
}
func taskComposerScope(_ nodes: [AXUIElement]) -> [AXUIElement] {
    let areas = nodes.filter { node in
        guard string(node, kAXRoleAttribute) == "AXWebArea" else { return false }
        let url = desktopURLString(attribute(node, kAXURLAttribute))
        return isNewTaskDocumentURL(url) || submittedTaskReference(url) != nil
    }
    guard areas.count == 1 else { return [] }
    return tree(areas[0])
}
func editableTextAreas(_ scope: [AXUIElement]) -> [AXUIElement] {
    scope.filter { string($0, kAXRoleAttribute) == kAXTextAreaRole && isEnabled($0) && valueIsSettable($0) }
}
func composerCandidates(_ nodes: [AXUIElement]) -> [AXUIElement] {
    // Identity is structural, never based on AXValue: the placeholder vanishes
    // as soon as an actual draft/prompt is entered. Search only the verified
    // task web area and require its observed fixed skills toolbar anchor.
    let scope = taskComposerScope(nodes)
    let hasSkillsAnchor = scope.contains { matches($0, "更多技能") }
    return editableTextAreas(scope).filter {
        isTaskComposerCandidate(role: string($0, kAXRoleAttribute), enabled: isEnabled($0),
            valueSettable: valueIsSettable($0), inTaskWebArea: true, hasSkillsAnchor: hasSkillsAnchor)
    }
}
func composer(_ nodes: [AXUIElement]) -> AXUIElement? {
    let candidates = composerCandidates(nodes)
    return candidates.count == 1 ? candidates[0] : nil
}
func composerValue(_ input: AXUIElement) -> String? { attribute(input, kAXValueAttribute) as? String }
func composerCharacterCount(_ input: AXUIElement) -> Int? {
    (attribute(input, "AXNumberOfCharacters") as? NSNumber)?.intValue
}
func composerState(_ input: AXUIElement) -> ComposerContentState {
    composerContentState(value: composerValue(input), characterCount: composerCharacterCount(input))
}
func diagnosticRange(_ input: AXUIElement, name: String) -> [String: Any] {
    guard let value = attribute(input, name), CFGetTypeID(value) == AXValueGetTypeID() else { return ["available": false] }
    var range = CFRange()
    guard AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cfRange, &range) else { return ["available": false] }
    return ["available": true, "location": range.location, "length": range.length]
}
func diagnosticComposer(_ input: AXUIElement) -> [String: Any] {
    let value = composerValue(input), placeholder = attribute(input, "AXPlaceholderValue") as? String
    let children = attribute(input, kAXChildrenAttribute) as? [AXUIElement] ?? []
    var childClasses: [String: Int] = [:]
    for child in children {
        let classification = diagnosticTextClass(attribute(child, kAXValueAttribute) as? String)
        childClasses[classification, default: 0] += 1
    }
    let childMetadata = children.prefix(5).map { child -> [String: Any] in
        let role = string(child, kAXRoleAttribute)
        let title = attribute(child, kAXTitleAttribute) as? String
        let description = attribute(child, kAXDescriptionAttribute) as? String
        let value = attribute(child, kAXValueAttribute) as? String
        return ["role": ["AXStaticText", "AXText", "AXGroup", "AXTextArea"].contains(role) ? role : "other",
            "titleClass": diagnosticTextClass(title), "titleLength": title?.utf16.count as Any? ?? NSNull(),
            "descriptionClass": diagnosticTextClass(description), "descriptionLength": description?.utf16.count as Any? ?? NSNull(),
            "valueClass": diagnosticTextClass(value), "valueLength": value?.utf16.count as Any? ?? NSNull()]
    }
    var valueSettable: DarwinBoolean = false
    let settableAvailable = AXUIElementIsAttributeSettable(input, kAXValueAttribute as CFString, &valueSettable) == .success
    return ["role": string(input, kAXRoleAttribute) == kAXTextAreaRole ? "AXTextArea" : "AXTextField",
        "valueClass": diagnosticTextClass(value), "valueLength": value?.utf16.count as Any? ?? NSNull(),
        "placeholderClass": diagnosticTextClass(placeholder), "placeholderLength": placeholder?.utf16.count as Any? ?? NSNull(),
        "numberOfCharacters": composerCharacterCount(input) as Any? ?? NSNull(),
        "contentState": composerState(input).rawValue,
        "valueSettable": settableAvailable ? valueSettable.boolValue as Any : NSNull(),
        "selectedTextRange": diagnosticRange(input, name: "AXSelectedTextRange"),
        "visibleCharacterRange": diagnosticRange(input, name: "AXVisibleCharacterRange"),
        "selectedTextClass": diagnosticTextClass(attribute(input, "AXSelectedText") as? String),
        "childCount": children.count, "childValueClasses": childClasses, "children": childMetadata]
}
func diagnose() -> Never {
    // Explicit read-only diagnostic, not health: no app launch, activation,
    // focus, input, title, raw text, concrete URL, task ID, or permission prompt.
    guard existsApp(), trusted() else {
        respond(["code": "DESKTOP_DIAGNOSE_UNAVAILABLE", "installed": existsApp(), "accessibilityTrusted": trusted()])
    }
    var rows: [[String: Any]] = [], totalWindows = 0, candidates = 0
    let apps = candidateApps()
    for app in apps {
        for window in applicationWindows(app) {
            totalWindows += 1
            guard rows.count < 10 else { continue }
            let role = string(window, kAXRoleAttribute), subrole = string(window, kAXSubroleAttribute)
            let nodes = tree(window), inputs = composerCandidates(nodes)
            let scope = taskComposerScope(nodes), editable = editableTextAreas(scope)
            let urls = nodes.filter { string($0, kAXRoleAttribute) == "AXWebArea" }
                .compactMap { desktopURLString(attribute($0, kAXURLAttribute)) }
            let eligible = isSupportedTaskWindow(role: role, subrole: subrole, documentURL: taskDocumentURL(nodes), composerCount: inputs.count)
            if eligible { candidates += 1 }
            rows.append(["owner": app.bundleIdentifier == "com.work.pc.doubao.browser" ? "browser" : "launcher",
                "role": role == "AXWindow" ? role : "other",
                "subrole": ["AXStandardWindow", "AXDialog", "AXSystemDialog"].contains(subrole) ? subrole : "other",
                "urlClass": diagnosticTaskURLClass(urls), "eligible": eligible,
                "composerCount": inputs.count, "skillsAnchorPresent": scope.contains { matches($0, "更多技能") },
                "editableTextAreaCount": editable.count, "editableTextAreas": editable.prefix(3).map(diagnosticComposer)])
        }
    }
    respond(["code": "DESKTOP_DIAGNOSE_COMPLETE", "appCount": apps.count, "windowCount": totalWindows,
        "reportedWindowCount": rows.count, "reportedCandidateCount": candidates, "windows": rows])
}
func taskDocumentURL(_ nodes: [AXUIElement]) -> String? {
    let urls = Set(nodes.filter { string($0, kAXRoleAttribute) == "AXWebArea" }
        .compactMap { desktopURLString(attribute($0, kAXURLAttribute)) }
        .filter { $0.hasPrefix("chrome://doubaowork-chat/") })
    return urls.count == 1 ? urls.first : nil
}
func isNewTaskSurface(_ nodes: [AXUIElement]) -> Bool {
    isNewTaskDocumentURL(taskDocumentURL(nodes))
}
func frontmostIsTarget(_ app: NSRunningApplication) -> Bool {
    guard let front = NSWorkspace.shared.frontmostApplication else { return false }
    return front.processIdentifier == app.processIdentifier || allowedBundleIds.contains(front.bundleIdentifier ?? "")
}
func requireFocus(_ app: NSRunningApplication) throws {
    guard frontmostIsTarget(app) else { try fail("DESKTOP_FOCUS_CHANGED", "桌面焦点已变化，已停止操作；没有再次提交。") }
}
func rectangle(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
        AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions),
        dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: point, size: dimensions)
}
func press(_ element: AXUIElement, app: NSRunningApplication) throws {
    try requireFocus(app)
    guard isEnabled(element) else { try fail("DESKTOP_CONTROL_DISABLED", "客户端当前控件不可用，未提交生成。") }
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return }
    // Some Chromium menu rows expose text without AXPress. The fallback uses
    // only the just-observed AX bounds of that exact labelled control.
    try clickBounds(element, app: app)
}
func clickBounds(_ element: AXUIElement, app: NSRunningApplication) throws {
    try requireFocus(app)
    guard let rect = rectangle(element), let window = windowRoot(app), let windowRect = rectangle(window),
        windowRect.contains(CGPoint(x: rect.midX, y: rect.midY)) else {
        try fail("DESKTOP_CONTROL_UNAVAILABLE", "无法安全定位客户端控件，未提交生成。")
    }
    let point = CGPoint(x: rect.midX, y: rect.midY)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        try fail("DESKTOP_INPUT_UNAVAILABLE", "无法发送桌面输入，未提交生成。")
    }
    down.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier)
}
func key(_ code: CGKeyCode, flags: CGEventFlags = [], app: NSRunningApplication) throws {
    try requireFocus(app)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        try fail("DESKTOP_INPUT_UNAVAILABLE", "无法发送桌面输入，未提交生成。")
    }
    down.flags = flags; up.flags = flags
    down.postToPid(app.processIdentifier); up.postToPid(app.processIdentifier)
}
func waitFor(_ seconds: TimeInterval, app: NSRunningApplication, predicate: ([AXUIElement]) -> Bool) throws -> [AXUIElement]? {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        let nodes = try snapshot(app)
        if predicate(nodes) { return nodes }
        RunLoop.current.run(until: Date().addingTimeInterval(0.18))
    } while Date() < deadline
    return nil
}
func emptyComposer(_ nodes: [AXUIElement]) throws -> AXUIElement {
    guard let input = composer(nodes) else { try fail("DESKTOP_COMPOSER_UNAVAILABLE", "找不到唯一的豆包任务输入框，未提交生成。") }
    if composerState(input) == .draft {
        try fail("DESKTOP_DRAFT_PRESENT", "豆包输入框有未发送内容，已保留草稿；请处理后重试。")
    }
    guard composerState(input) == .empty else { try fail("DESKTOP_COMPOSER_UNCERTAIN", "无法核对输入框是否为空，已保留当前内容；没有提交生成。") }
    return input
}
func fill(_ prompt: String, input: AXUIElement, app: NSRunningApplication) throws {
    try requireFocus(app)
    guard composerState(input) == .empty else { try fail("DESKTOP_COMPOSER_UNCERTAIN", "输入框状态已变化，已停止；没有发送生成。") }
    _ = AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, prompt as CFString)
    if try waitFor(2, app: app, predicate: { nodes in
        guard let field = composer(nodes) else { return false }
        return isExactComposerPrompt(composerValue(field), prompt: prompt)
    }) != nil { return }
    // AXValue may be unsupported, but a partial/changed input must never have
    // another copy appended. Paste fallback is allowed only after fresh empty
    // verification, not on a failed setValue return code alone.
    let current = try snapshot(app)
    let fallbackInput = try emptyComposer(current)
    try requireFocus(app)
    try clickBounds(fallbackInput, app: app)
    // Pasting triggers Chromium's normal editor events. Preserve all clipboard
    // types and never log them. No shell, JavaScript execution, or clipboard history.
    let pasteboard = NSPasteboard.general
    let saved = (pasteboard.pasteboardItems ?? []).map { item -> [(NSPasteboard.PasteboardType, Data)] in
        item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
    }
    pasteboard.clearContents(); pasteboard.setString(prompt, forType: .string)
    let ourChange = pasteboard.changeCount
    defer {
        // Do not overwrite a clipboard value the user changed during this step.
        if pasteboard.changeCount == ourChange {
            pasteboard.clearContents()
            let items = saved.map { entries -> NSPasteboardItem in
                let item = NSPasteboardItem(); for (type, bytes) in entries { item.setData(bytes, forType: type) }; return item
            }
            if !items.isEmpty { pasteboard.writeObjects(items) }
        }
    }
    try key(9, flags: .maskCommand, app: app)
    guard try waitFor(3, app: app, predicate: { nodes in
        guard let field = composer(nodes) else { return false }
        return isExactComposerPrompt(composerValue(field), prompt: prompt)
    }) != nil else { try fail("DESKTOP_PROMPT_NOT_VERIFIED", "输入内容无法核对，已停止；没有发送生成。") }
}

func validate(_ input: SubmitRequest) throws -> URL {
    guard input.jobId.range(of: "^desktop_[a-f0-9]{32}$", options: .regularExpression) != nil,
        input.prompt.utf8.count <= 32000, !input.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        !input.prompt.contains("\0"), !input.outputPath.contains("\0"), !input.outputPath.contains("\n") else {
        try fail("DESKTOP_INPUT_INVALID", "桌面任务输入不合法，未操作客户端。")
    }
    let path = URL(fileURLWithPath: input.outputPath).standardizedFileURL
    let jobDirectory = path.deletingLastPathComponent()
    guard path.path == input.outputPath, path.lastPathComponent == "result.png", jobDirectory.lastPathComponent == input.jobId,
        jobDirectory.deletingLastPathComponent().lastPathComponent == "desktop-assets",
        jobDirectory.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "private",
        jobDirectory.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "outputs",
        jobDirectory.resolvingSymlinksInPath().path == jobDirectory.path,
        fm.fileExists(atPath: jobDirectory.path), !fm.fileExists(atPath: path.path) else {
        try fail("DESKTOP_OUTPUT_PATH_INVALID", "任务输出目录无效或已有图片，未发起新的生成。")
    }
    return jobDirectory.appendingPathComponent("submit-intent.json")
}
func writeMarker(_ url: URL, jobId: String) throws {
    let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
    guard fd >= 0 else { try fail("DESKTOP_SUBMISSION_UNCERTAIN", "此任务已有提交标记或无法记录提交意图，请核对原任务；不会重复生成。") }
    defer { close(fd) }
    let data = try JSONSerialization.data(withJSONObject: ["jobId": jobId, "state": "submitting", "createdAt": ISO8601DateFormatter().string(from: Date())])
    let wrote = data.withUnsafeBytes { bytes in write(fd, bytes.baseAddress, bytes.count) }
    guard wrote == data.count, fsync(fd) == 0 else { try fail("DESKTOP_MARKER_FAILED", "无法持久保存提交标记，已停止；请核对任务，不会自动重发。") }
    let directoryFd = open(url.deletingLastPathComponent().path, O_RDONLY)
    guard directoryFd >= 0 else { try fail("DESKTOP_MARKER_FAILED", "无法持久保存提交目录，未发送生成。") }
    defer { close(directoryFd) }
    guard fsync(directoryFd) == 0 else { try fail("DESKTOP_MARKER_FAILED", "无法持久保存提交目录，未发送生成。") }
}

var submissionIntentWritten = false
do {
    guard CommandLine.arguments.count == 2 else { try fail("DESKTOP_COMMAND_INVALID", "仅支持 health、diagnose 或 submit。") }
    if CommandLine.arguments[1] == "health" { health() }
    if CommandLine.arguments[1] == "diagnose" { diagnose() }
    guard CommandLine.arguments[1] == "submit" else { try fail("DESKTOP_COMMAND_INVALID", "仅支持 health、diagnose 或 submit。") }
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    guard bytes.count <= 40000 else { try fail("DESKTOP_INPUT_INVALID", "桌面任务输入过大。") }
    let input = try JSONDecoder().decode(SubmitRequest.self, from: bytes)
    let marker = try validate(input)
    if fm.fileExists(atPath: marker.path) {
        respond(["state": "unknown", "code": "DESKTOP_SUBMISSION_UNCERTAIN", "message": "已有提交标记，需核对原任务；不会重复生成。"])
    }
    guard existsApp() else { try fail("DESKTOP_APP_NOT_INSTALLED", "未找到已安装的豆包工作客户端。") }
    guard trusted() else { try fail("DESKTOP_ACCESSIBILITY_REQUIRED", "请在 macOS 辅助功能中允许 OHAO Desktop Bridge 后重新检测；未提交生成。") }
    let app = try targetApp()
    app.activate(options: [.activateAllWindows])
    RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    let initial = try snapshot(app)
    // If an existing conversation has an unsent draft, never navigate away.
    _ = try emptyComposer(initial)
    guard let newTask = initial.first(where: { labels($0).contains(where: isNewTaskControlLabel)
        && [kAXButtonRole, "AXLink"].contains(string($0, kAXRoleAttribute)) }) else {
        try fail("DESKTOP_NEW_TASK_UNAVAILABLE", "未找到新工作任务入口，未提交生成。")
    }
    try press(newTask, app: app)
    guard let fresh = try waitFor(5, app: app, predicate: { nodes in
        isNewTaskSurface(nodes) && composer(nodes) != nil && nodes.contains { matches($0, "更多技能") }
    }) else { try fail("DESKTOP_NEW_TASK_UNAVAILABLE", "新工作任务页面未就绪，未提交生成。") }
    _ = try emptyComposer(fresh)
    guard let skills = fresh.first(where: { matches($0, "更多技能") && isEnabled($0) }) else {
        try fail("DESKTOP_SKILL_UNAVAILABLE", "未找到技能选择入口，未提交生成。")
    }
    try press(skills, app: app)
    guard let menu = try waitFor(4, app: app, predicate: { $0.contains { matches($0, "Seedream5.0Pro") } }),
        let option = menu.first(where: { matches($0, "Seedream5.0Pro") && isEnabled($0) }) else {
        try fail("DESKTOP_SEEDREAM_UNAVAILABLE", "当前客户端没有可用的 Seedream 5.0 Pro，未提交生成。")
    }
    try press(option, app: app)
    var selected = try waitFor(2, app: app, predicate: { nodes in
        nodes.contains { matches($0, "Seedream5.0Pro") && string($0, kAXRoleAttribute) == kAXButtonRole }
            && !nodes.contains { matches($0, "Seedance2.5") }
    })
    if selected == nil {
        // AXPress can report success for a non-actionable menu row. Retarget
        // only the same currently visible exact label, never a fixed coordinate.
        let current = try snapshot(app)
        if let row = current.first(where: { matches($0, "Seedream5.0Pro") && isEnabled($0) }) { try clickBounds(row, app: app) }
        selected = try waitFor(2, app: app, predicate: { nodes in
            nodes.contains { matches($0, "Seedream5.0Pro") && string($0, kAXRoleAttribute) == kAXButtonRole }
                && !nodes.contains { matches($0, "Seedance2.5") }
        })
    }
    guard let ready = selected else { try fail("DESKTOP_SEEDREAM_NOT_SELECTED", "无法核对 Seedream 5.0 Pro 已选中，未提交生成。") }
    let field = try emptyComposer(ready)
    let prompt = input.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    try fill(prompt, input: field, app: app)
    let beforeSend = try snapshot(app)
    guard isNewTaskSurface(beforeSend), let finalField = composer(beforeSend), isExactComposerPrompt(composerValue(finalField), prompt: prompt) else {
        try fail("DESKTOP_PROMPT_NOT_VERIFIED", "输入内容已变化，未发送生成。")
    }
    try requireFocus(app)
    // The marker must precede the irreversible Return key. Any interruption
    // from this point is ambiguous and must never cause automatic resubmission.
    try writeMarker(marker, jobId: input.jobId)
    submissionIntentWritten = true
    try key(36, app: app)
    let submitted = try waitFor(8, app: app, predicate: { nodes in
        guard submittedTaskReference(taskDocumentURL(nodes)) != nil, let field = composer(nodes),
            composerState(field) == .empty else { return false }
        return nodes.contains { isSubmittedPromptText(role: string($0, kAXRoleAttribute),
            values: [string($0, kAXValueAttribute), string($0, kAXTitleAttribute)], prompt: prompt, isComposer: CFEqual($0, field)) }
    })
    guard let nodes = submitted else {
        respond(["state": "unknown", "code": "DESKTOP_SUBMISSION_UNCERTAIN", "message": "提交后未能确认客户端状态；后台只等待原输出，不会再次生成。"])
    }
    var result: [String: Any] = ["state": "submitted", "code": "DESKTOP_SUBMITTED", "message": "已向桌面豆包提交一次 Seedream 生图，等待图片回传。"]
    if let taskRef = submittedTaskReference(taskDocumentURL(nodes)) { result["taskRef"] = taskRef }
    respond(result)
} catch let error as BridgeFailure {
    respond(["state": submissionIntentWritten ? "unknown" : "blocked", "code": error.code, "message": error.message])
} catch {
    respond(["state": submissionIntentWritten ? "unknown" : "blocked", "code": "DESKTOP_BRIDGE_FAILED", "message": "桌面桥未完成操作；请查看任务状态，不会自动重复生成。"])
}
