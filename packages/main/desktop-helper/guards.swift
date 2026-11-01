import Foundation

// Pure guards kept separate so offline tests need no Accessibility/UI access.
func isNewTaskControlLabel(_ value: String) -> Bool {
    let normalized = value.filter { !$0.isWhitespace }.lowercased()
    return normalized == "新工作任务" || normalized == "新工作任务⌘n"
}
func desktopURLString(_ value: Any?) -> String? {
    // AXURL is allowed to be a CFURL, toll-free bridged NSURL, Swift URL, or
    // string depending on the app's accessibility implementation.
    if let url = value as? URL { return url.absoluteString }
    if let url = value as? NSURL { return url.absoluteString }
    return value as? String
}
func isNewTaskDocumentURL(_ value: String?) -> Bool {
    value == "chrome://doubaowork-chat/chat" || value == "chrome://doubaowork-chat/chat/"
}
func submittedTaskReference(_ value: String?) -> String? {
    guard let value = value,
        value.range(of: "^chrome://doubaowork-chat/chat/[0-9]+$", options: .regularExpression) != nil else { return nil }
    return value
}
func isSupportedTaskWindow(role: String, subrole: String, documentURL: String?, composerCount: Int) -> Bool {
    role == "AXWindow" && subrole == "AXStandardWindow" && composerCount == 1
        && (isNewTaskDocumentURL(documentURL) || submittedTaskReference(documentURL) != nil)
}
func isUniqueWindowCount(_ count: Int) -> Bool { count == 1 }
func isTaskComposerCandidate(role: String, enabled: Bool, valueSettable: Bool, inTaskWebArea: Bool, hasSkillsAnchor: Bool) -> Bool {
    role == "AXTextArea" && enabled && valueSettable && inTaskWebArea && hasSkillsAnchor
}
let observedComposerPlaceholder = "发消息或创建任务... / 使用技能 @ 添加资料"
func isObservedComposerPlaceholder(_ value: String?) -> Bool {
    value?.trimmingCharacters(in: .whitespacesAndNewlines) == observedComposerPlaceholder
}
enum ComposerContentState: String { case empty, draft, uncertain }
func composerContentState(value: String?, characterCount: Int?) -> ComposerContentState {
    guard let value = value, characterCount == nil || characterCount! >= 0 else { return .uncertain }
    if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return characterCount == nil || characterCount == 0 ? .empty : .uncertain
    }
    if isObservedComposerPlaceholder(value) {
        // The client exposes its visual placeholder as AXValue. It is empty
        // only with the independent zero-character signal, not merely a label
        // match: a user could really type the same words into their draft.
        guard let count = characterCount else { return .uncertain }
        return count == 0 ? .empty : .draft
    }
    return .draft
}
func isExactComposerPrompt(_ value: String?, prompt: String) -> Bool {
    !prompt.isEmpty && value?.trimmingCharacters(in: .whitespacesAndNewlines) == prompt
}
func diagnosticTextClass(_ value: String?) -> String {
    guard let value = value else { return "missing" }
    if value.isEmpty { return "empty" }
    return isObservedComposerPlaceholder(value) ? "observed-placeholder" : "other-text"
}
func diagnosticTaskURLClass(_ values: [String]) -> String {
    let unique = Set(values)
    guard unique.count == 1, let value = unique.first else { return unique.isEmpty ? "missing" : "multiple" }
    if isNewTaskDocumentURL(value) { return "new-task" }
    if submittedTaskReference(value) != nil { return "existing-task" }
    return "other"
}
func isSubmittedPromptText(role: String, values: [String], prompt: String, isComposer: Bool) -> Bool {
    guard !isComposer, !prompt.isEmpty, ["AXStaticText", "AXText", "AXTextArea"].contains(role) else { return false }
    // Full exact message only. Truncated or split text yields unknown, never a
    // false acknowledgement from a tooltip, menu option, or the input itself.
    return values.contains { $0.trimmingCharacters(in: .whitespacesAndNewlines) == prompt }
}
