import Foundation

var count = 0
func check(_ value: Bool, _ message: String) {
    if !value { fatalError(message) }
    count += 1
}
for label in ["新工作任务", "新工作任务 ⌘ N", "新工作任务⌘n"] {
    check(isNewTaskControlLabel(label), "observed exact new task label")
}
for label in ["新工作任务 ⌘ M", "新工作任务菜单", "恢复新工作任务", ""] {
    check(!isNewTaskControlLabel(label), "reject unobserved control label")
}
let blankURL = "chrome://doubaowork-chat/chat"
check(desktopURLString(blankURL) == blankURL, "String AXURL")
check(desktopURLString(URL(string: blankURL)!) == blankURL, "Swift URL AXURL")
check(desktopURLString(NSURL(string: blankURL)!) == blankURL, "NSURL AXURL")
let coreFoundationURL = CFURLCreateWithString(kCFAllocatorDefault, blankURL as CFString, nil)!
check(desktopURLString(coreFoundationURL) == blankURL, "CFURL AXURL")
check(desktopURLString(nil) == nil, "missing AXURL")
check(desktopURLString(123) == nil, "invalid AXURL type")
check(isNewTaskDocumentURL("chrome://doubaowork-chat/chat"), "exact blank task")
check(isNewTaskDocumentURL("chrome://doubaowork-chat/chat/"), "blank trailing slash")
for url in ["chrome://doubaowork-chat/skills", "chrome://doubaowork-chat/chat/skills", "chrome://doubaowork-chat/chat/123", "chrome://doubaowork-chat/chat?task=1", "https://doubao.com/chat", ""] {
    check(!isNewTaskDocumentURL(url), "reject nonblank route")
}
check(!isNewTaskDocumentURL(nil), "unknown URL is not blank task")
check(submittedTaskReference("chrome://doubaowork-chat/chat/123") != nil, "numeric task reference")
for url in ["chrome://doubaowork-chat/chat", "chrome://doubaowork-chat/chat/", "chrome://doubaowork-chat/chat/abc", "https://doubao.com/chat/123"] {
    check(submittedTaskReference(url) == nil, "reject ambiguous task reference")
}
check(!isUniqueWindowCount(0), "no window is unavailable")
check(isUniqueWindowCount(1), "one target window")
check(!isUniqueWindowCount(2), "two windows are ambiguous")
check(isSupportedTaskWindow(role: "AXWindow", subrole: "AXStandardWindow", documentURL: blankURL, composerCount: 1), "blank task is a candidate")
check(isSupportedTaskWindow(role: "AXWindow", subrole: "AXStandardWindow", documentURL: "chrome://doubaowork-chat/chat/123", composerCount: 1), "existing task is a candidate")
check(!isSupportedTaskWindow(role: "AXWindow", subrole: "AXStandardWindow", documentURL: nil, composerCount: 0), "empty launcher shell is excluded")
check(!isSupportedTaskWindow(role: "AXWindow", subrole: "AXDialog", documentURL: blankURL, composerCount: 1), "dialog is excluded")
check(!isSupportedTaskWindow(role: "AXMenu", subrole: "", documentURL: blankURL, composerCount: 1), "menu is excluded")
check(!isSupportedTaskWindow(role: "AXWindow", subrole: "AXStandardWindow", documentURL: "chrome://doubaowork-chat/skills", composerCount: 1), "non-task document is excluded")
check(!isSupportedTaskWindow(role: "AXWindow", subrole: "AXStandardWindow", documentURL: blankURL, composerCount: 2), "ambiguous composer is excluded")
let withShell = [
    isSupportedTaskWindow(role: "AXWindow", subrole: "AXStandardWindow", documentURL: nil, composerCount: 0),
    isSupportedTaskWindow(role: "AXWindow", subrole: "AXStandardWindow", documentURL: blankURL, composerCount: 1)
]
check(isUniqueWindowCount(withShell.filter { $0 }.count), "one shell plus one actual task is unique")
let withTwoTasks = withShell + [isSupportedTaskWindow(role: "AXWindow", subrole: "AXStandardWindow", documentURL: "chrome://doubaowork-chat/chat/456", composerCount: 1)]
check(!isUniqueWindowCount(withTwoTasks.filter { $0 }.count), "two real tasks remain ambiguous despite a shell")
check(isTaskComposerCandidate(role: "AXTextArea", enabled: true, valueSettable: true, inTaskWebArea: true, hasSkillsAnchor: true), "composer identified independent of text")
check(!isTaskComposerCandidate(role: "AXTextField", enabled: true, valueSettable: true, inTaskWebArea: true, hasSkillsAnchor: true), "search field excluded")
check(!isTaskComposerCandidate(role: "AXTextArea", enabled: true, valueSettable: false, inTaskWebArea: true, hasSkillsAnchor: true), "read-only answer text excluded")
check(!isTaskComposerCandidate(role: "AXTextArea", enabled: false, valueSettable: true, inTaskWebArea: true, hasSkillsAnchor: true), "disabled textarea excluded")
check(!isTaskComposerCandidate(role: "AXTextArea", enabled: true, valueSettable: true, inTaskWebArea: false, hasSkillsAnchor: true), "unrelated window textarea excluded")
check(!isTaskComposerCandidate(role: "AXTextArea", enabled: true, valueSettable: true, inTaskWebArea: true, hasSkillsAnchor: false), "unverified toolbar blocks")
check(composerContentState(value: "", characterCount: nil) == .empty, "actual empty value")
check(composerContentState(value: "", characterCount: 0) == .empty, "empty with zero characters")
check(composerContentState(value: "", characterCount: 2) == .uncertain, "contradictory count blocks")
check(composerContentState(value: nil, characterCount: 0) == .uncertain, "missing value not silently empty")
check(composerContentState(value: "", characterCount: -1) == .uncertain, "invalid character count")
check(composerContentState(value: observedComposerPlaceholder, characterCount: 0) == .empty, "observed placeholder and independent zero count")
check(composerContentState(value: observedComposerPlaceholder, characterCount: nil) == .uncertain, "placeholder alone insufficient")
check(composerContentState(value: observedComposerPlaceholder, characterCount: observedComposerPlaceholder.utf16.count) == .draft, "real draft spelling the placeholder is preserved")
check(composerContentState(value: "用户草稿", characterCount: 0) == .draft, "other text never treated as placeholder")
check(composerContentState(value: observedComposerPlaceholder + "用户内容", characterCount: 0) == .draft, "placeholder plus real text is draft")
check(composerContentState(value: "发消息或创建任务", characterCount: 0) == .draft, "partial placeholder is not empty")
check(diagnosticTextClass("私人内容") == "other-text", "diagnostic redacts actual text")
check(diagnosticTextClass(observedComposerPlaceholder) == "observed-placeholder", "diagnostic known placeholder")
check(diagnosticTextClass(nil) == "missing", "diagnostic missing attribute")
check(diagnosticTaskURLClass([blankURL]) == "new-task", "diagnostic blank URL category")
check(diagnosticTaskURLClass(["chrome://doubaowork-chat/chat/123"]) == "existing-task", "diagnostic never emits task ID")
check(diagnosticTaskURLClass([blankURL, "chrome://doubaowork-chat/chat/123"]) == "multiple", "diagnostic ambiguity")
let prompt = "OHAO TASK\n请只生成一张图片。"
check(isExactComposerPrompt(prompt, prompt: prompt), "full exact prompt accepted")
check(!isExactComposerPrompt("OHAO TASK", prompt: prompt), "partial input cannot be sent")
check(!isExactComposerPrompt(prompt + "\n用户内容", prompt: prompt), "extra input cannot be sent")
check(!isExactComposerPrompt(nil, prompt: prompt), "missing input cannot be sent")
for role in ["AXStaticText", "AXText", "AXTextArea"] {
    check(isSubmittedPromptText(role: role, values: [prompt], prompt: prompt, isComposer: false), "supported full text")
}
check(!isSubmittedPromptText(role: "AXTextArea", values: [prompt], prompt: prompt, isComposer: true), "input is not sent message")
check(!isSubmittedPromptText(role: "AXStaticText", values: ["OHAO TASK..."], prompt: prompt, isComposer: false), "truncated message stays unknown")
check(!isSubmittedPromptText(role: "AXButton", values: [prompt], prompt: prompt, isComposer: false), "button not message")
check(!isSubmittedPromptText(role: "AXStaticText", values: ["其他任务 " + prompt], prompt: prompt, isComposer: false), "only exact message")
print("\(count) native pure guard assertions passed; no UI access.")
