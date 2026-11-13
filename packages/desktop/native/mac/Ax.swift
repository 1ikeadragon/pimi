import AppKit
import ApplicationServices
import Foundation

// Accessibility: the tree walk, refs (@dN), snapshot/find/element/audit. Elements are held per agent
// between calls, so a ref that no longer matches its element answers `stale_ref`. Values of secure
// text fields are never read.

final class Node {
    let el: AXUIElement
    var rawRole = ""
    var role = ""
    var subrole = ""
    var name = ""
    var ident = ""
    var help = ""
    var roleDesc = ""
    var value: String?
    var number: Double?
    var rect = CGRect.zero
    var hasRect = false
    var enabled = true
    var focused = false
    var selected: Bool?
    var expanded: Bool?
    var toggle = -1
    var actions: [String] = []
    var valueSettable = false
    var secure = false
    var kids: [Node] = []
    var pending: [AXUIElement] = []
    var depth = 0
    var ref = 0
    var offscreenKids = 0
    var moreKids = 0
    var interactive = false
    var focusable = false

    init(_ el: AXUIElement) { self.el = el }

    var rectEmpty: Bool { !hasRect || rect.width < 1 || rect.height < 1 }
}

enum Ax {
    static let attrs: [String] = [
        "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXEnabled", "AXFocused", "AXPosition",
        "AXSize", "AXIdentifier", "AXRoleDescription", "AXSelected", "AXExpanded", "AXDisclosing",
        "AXPlaceholderValue", "AXChildren", "AXHelp",
    ]

    static func trusted() throws {
        if !AXIsProcessTrusted() {
            throw HelperError(
                "permission_missing",
                "Pimi does not have Accessibility access. Grant it in System Settings > Privacy & Security > Accessibility.")
        }
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.5)
    }

    // ---- raw attribute access ----

    static func copy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success ? v : nil
    }

    static func error(_ el: AXUIElement, _ attr: String) -> AXError {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    }

    static func string(_ el: AXUIElement, _ attr: String) -> String? { copy(el, attr) as? String }

    static func bool(_ el: AXUIElement, _ attr: String) -> Bool? { (copy(el, attr) as? NSNumber)?.boolValue }

    static func point(_ v: CFTypeRef?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func size(_ v: CFTypeRef?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    static func setPoint(_ el: AXUIElement, _ attr: String, _ p: CGPoint) {
        var p = p
        if let v = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(el, attr as CFString, v) }
    }

    static func setSize(_ el: AXUIElement, _ attr: String, _ s: CGSize) {
        var s = s
        if let v = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(el, attr as CFString, v) }
    }

    static func appElement(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

    /// The target app answers within the messaging timeout; kAXErrorCannotComplete means it does not.
    static func responding(_ pid: pid_t) -> Bool {
        let e = error(appElement(pid), "AXRole")
        return e != .cannotComplete
    }

    // ---- window lookup ----

    private static var woken = Set<pid_t>()

    /// The AX element of the CG window: AXWindows of the app, matched on frame and title.
    static func window(_ w: Win) throws -> AXUIElement {
        let app = appElement(w.pid)
        if !woken.contains(w.pid) {
            woken.insert(w.pid)
            // Electron and Chromium build their accessibility tree only when asked.
            AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            if w.app.framework == "electron" || w.app.framework == "chromium" { sleepMs(400) }
        }
        var v: CFTypeRef?
        let e = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v)
        if e == .cannotComplete { throw HelperError("target_hung", "The target window is not responding.") }
        if e == .apiDisabled { try trusted() }
        guard let list = v as? [AXUIElement], !list.isEmpty else {
            throw HelperError("failed", "The app exposes no accessibility windows.")
        }
        let frame = try Wn.frame(w)
        func geometry(_ el: AXUIElement) -> CGRect? {
            guard let p = point(copy(el, "AXPosition")), let s = size(copy(el, "AXSize")) else { return nil }
            return CGRect(origin: p, size: s)
        }
        func close(_ r: CGRect) -> Bool {
            abs(r.minX - frame.minX) < 3 && abs(r.minY - frame.minY) < 3 && abs(r.width - frame.width) < 4
                && abs(r.height - frame.height) < 4
        }
        let matches = list.filter { el in geometry(el).map(close) ?? false }
        if matches.count == 1 { return matches[0] }
        if matches.count > 1 {
            if let titled = matches.first(where: { string($0, "AXTitle") == w.info.title }) { return titled }
            return matches[0]
        }
        if let titled = list.first(where: { !w.info.title.isEmpty && string($0, "AXTitle") == w.info.title }) {
            return titled
        }
        if list.count == 1 { return list[0] }
        throw HelperError("failed", "The window's accessibility element could not be found.")
    }

    static func isMinimized(_ w: Win) -> Bool {
        guard AXIsProcessTrusted(), let el = try? window(w) else { return false }
        return bool(el, "AXMinimized") ?? false
    }

    static func setMinimized(_ w: Win, _ value: Bool) {
        guard AXIsProcessTrusted(), let el = try? window(w) else { return }
        AXUIElementSetAttributeValue(el, "AXMinimized" as CFString, value ? kCFBooleanTrue : kCFBooleanFalse)
    }

    // ---- roles ----

    static func roleName(_ raw: String) -> String {
        var s = raw
        if s.hasPrefix("AX") { s.removeFirst(2) }
        s = s.lowercased()
        return s == "statictext" ? "text" : s
    }

    static func normalizeRole(_ asked: String) -> String {
        var s = asked.lowercased().replacingOccurrences(of: "-", with: "").replacingOccurrences(of: " ", with: "")
        if s.hasPrefix("ax") { s.removeFirst(2) }
        return s == "statictext" ? "text" : s
    }

    private static let interactiveRoles: Set<String> = [
        "button", "checkbox", "radiobutton", "popupbutton", "menubutton", "menuitem", "menubaritem", "textfield",
        "textarea", "combobox", "slider", "incrementor", "link", "tab", "disclosuretriangle", "colorwell",
        "switch", "segmentedcontrol", "searchfield",
    ]
    private static let toggleRoles: Set<String> = ["checkbox", "radiobutton", "switch"]
    private static let valueRoles: Set<String> = ["textfield", "textarea", "combobox", "slider", "incrementor", "searchfield"]
    private static let containerRoles: Set<String> = [
        "group", "scrollarea", "splitgroup", "unknown", "layoutarea", "layoutitem", "window", "matte",
    ]
    private static let liveValueRoles: Set<String> = ["textfield", "textarea", "combobox", "searchfield", "popupbutton", "menubutton"]
    private static let sysSubroles: Set<String> = [
        "AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton", "AXToolbarButton",
    ]

    // ---- node reading ----

    static func read(_ el: AXUIElement, depth: Int, frame: CGRect, wantActions: Bool = true) -> Node {
        let n = Node(el)
        n.depth = depth
        var raw: CFArray?
        let e = AXUIElementCopyMultipleAttributeValues(el, attrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
        guard e == .success, let values = raw as? [Any], values.count == attrs.count else { return n }
        func v(_ i: Int) -> CFTypeRef? {
            let item = values[i] as CFTypeRef
            if CFGetTypeID(item) == AXValueGetTypeID(), AXValueGetType(item as! AXValue) == .axError { return nil }
            return item
        }
        n.rawRole = v(0) as? String ?? ""
        n.role = roleName(n.rawRole)
        n.subrole = v(1) as? String ?? ""
        let title = v(2) as? String ?? ""
        let desc = v(3) as? String ?? ""
        n.secure = n.subrole == "AXSecureTextField"
        if let s = v(4) as? String, !n.secure {
            n.value = s.count > 4096 ? String(s.prefix(4096)) : s
        } else if let num = v(4) as? NSNumber {
            n.number = num.doubleValue
        }
        n.enabled = (v(5) as? NSNumber)?.boolValue ?? true
        n.focused = (v(6) as? NSNumber)?.boolValue ?? false
        if let p = point(v(7)), let s = size(v(8)) {
            n.rect = CGRect(origin: p, size: s)
            n.hasRect = true
        }
        n.ident = v(9) as? String ?? ""
        n.roleDesc = v(10) as? String ?? ""
        n.selected = (v(11) as? NSNumber)?.boolValue
        n.expanded = (v(12) as? NSNumber)?.boolValue ?? (v(13) as? NSNumber)?.boolValue
        let placeholder = v(14) as? String ?? ""
        n.pending = (v(15) as? [AXUIElement]) ?? []
        n.help = v(16) as? String ?? ""
        if !title.isEmpty {
            n.name = title
        } else if !desc.isEmpty {
            n.name = desc
        } else if n.role == "text" {
            n.name = n.value ?? ""
        } else if !placeholder.isEmpty {
            n.name = placeholder
        }
        if toggleRoles.contains(n.role), let num = n.number { n.toggle = Int(num) }
        if wantActions, !n.rectEmpty || n.role == "menuitem" || n.role == "menubaritem" {
            var names: CFArray?
            if AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] {
                n.actions = list
            }
        }
        if valueRoles.contains(n.role) {
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(el, "AXValue" as CFString, &settable) == .success { n.valueSettable = settable.boolValue }
        }
        n.interactive = computeInteractive(n, frame: frame)
        return n
    }

    static func actionLabels(_ n: Node) -> [String] {
        var out: [String] = []
        for a in n.actions {
            switch a {
            case "AXPress": out.append("invoke")
            case "AXShowMenu": out.append("menu")
            case "AXIncrement", "AXDecrement": if !out.contains("range") { out.append("range") }
            case "AXPick": out.append("select")
            case "AXConfirm": out.append("confirm")
            case "AXCancel": out.append("cancel")
            default: break
            }
        }
        if n.toggle >= 0 { out.append("toggle") }
        if n.expanded != nil { out.append("expand") }
        if n.selected != nil, n.role == "row" || n.role == "outlinerow" || n.role == "cell" || n.role == "tab" || n.role == "radiobutton" {
            if !out.contains("select") { out.append("select") }
        }
        if n.valueSettable { out.append("value") }
        return out
    }

    static func hasActions(_ n: Node) -> Bool { !actionLabels(n).isEmpty }

    static func computeInteractive(_ n: Node, frame: CGRect) -> Bool {
        if n.rectEmpty || n.role == "window" { return false }
        if !n.rect.intersects(frame.insetBy(dx: -2, dy: -2)) { return false }
        if sysSubroles.contains(n.subrole) { return true }
        if interactiveRoles.contains(n.role) { return true }
        return hasActions(n)
    }

    // ---- menu bar ----
    // The app's menu bar is reachable through accessibility only: refs of its items press with
    // AXPress and never move the cursor. Quit, Hide, Close All, the Apple menu and anything whose
    // key equivalent the chord deny list refuses are refused here.

    /// Every window the menu bar could be under: a rect that is not clipped to the target window.
    static let anywhere = CGRect(x: -1e6, y: -1e6, width: 2e6, height: 2e6)

    static func element(_ v: CFTypeRef?) -> AXUIElement? {
        guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func menuBar(_ pid: pid_t) -> AXUIElement? { element(copy(appElement(pid), "AXMenuBar")) }

    static func inMenuBar(_ el: AXUIElement) -> Bool {
        var cur = el
        for _ in 0..<14 {
            if string(cur, "AXRole") == "AXMenuBar" { return true }
            guard let parent = element(copy(cur, "AXParent")) else { return false }
            cur = parent
        }
        return false
    }

    private static let refusedMenuNames = try! NSRegularExpression(
        pattern: "^(quit|force quit|hide|hide others|close all|log out|shut down|restart|sleep|lock screen)\\b",
        options: [.caseInsensitive])

    /// Why a menu bar element may not be pressed, or nil. Name checks are English only; the key
    /// equivalent check (cmd+q, cmd+h, cmd+w ...) holds in every language.
    static func menuRefusal(_ n: Node) -> String? {
        var cur = n.el
        for _ in 0..<14 {
            guard let parent = element(copy(cur, "AXParent")) else { break }
            if string(parent, "AXRole") == "AXMenuBar" {
                let kids = (copy(parent, "AXChildren") as? [AXUIElement]) ?? []
                if let first = kids.first, CFEqual(first, cur) { return "The Apple menu is not available." }
                break
            }
            cur = parent
        }
        let name = n.name.trimmingCharacters(in: .whitespaces)
        if refusedMenuNames.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil {
            return "\"\(name)\" quits, hides or logs out, which is not available."
        }
        if let key = string(n.el, "AXMenuItemCmdChar"), !key.isEmpty {
            let bits = (copy(n.el, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
            var mods: [Safety.Mod] = []
            if bits & 8 == 0 { mods.append(.command) }
            if bits & 1 != 0 { mods.append(.shift) }
            if bits & 2 != 0 { mods.append(.option) }
            if bits & 4 != 0 { mods.append(.control) }
            if Safety.refusal(Safety.Chord(modifiers: mods, keys: [key.lowercased()])) != nil {
                return "\"\(name)\" acts on the app or the system (it has the key equivalent \((mods.map(\.rawValue) + [key.lowercased()]).joined(separator: "+"))), which is not available."
            }
        }
        return nil
    }

    // ---- walk ----

    struct Walked {
        var root: Node
        var truncated = false
        var count = 1
    }

    static func walk(window el: AXUIElement, frame: CGRect, maxNodes: Int, deadlineMs: Int) -> Walked {
        let root = read(el, depth: 0, frame: frame)
        var res = Walked(root: root)
        var queue = [root]
        var head = 0
        let start = nowMs()
        while head < queue.count {
            if nowMs() - start > deadlineMs || res.count >= maxNodes {
                res.truncated = true
                break
            }
            let p = queue[head]
            head += 1
            if p.depth >= 40 { continue }
            let kids = p.pending
            p.pending = []
            for (i, kid) in kids.enumerated() {
                if res.count >= maxNodes {
                    res.truncated = true
                    p.moreKids = kids.count - i
                    break
                }
                let c = read(kid, depth: p.depth + 1, frame: frame)
                if c.hasRect, !c.rect.intersects(frame.insetBy(dx: -2, dy: -2)) {
                    p.offscreenKids += 1
                    continue
                }
                p.kids.append(c)
                res.count += 1
                queue.append(c)
            }
        }
        return res
    }

    // ---- quality ----

    static func quality(_ root: Node) -> String {
        var content = 0
        var interactive = false
        var opaqueOnly = true
        func rec(_ n: Node, _ inTitle: Bool) {
            for k in n.kids {
                let t = inTitle
                if !t && !sysSubroles.contains(k.subrole) {
                    content += 1
                    if k.interactive || !["group", "scrollarea", "splitgroup", "unknown", "text", "webarea"].contains(k.role) {
                        opaqueOnly = false
                    }
                    if k.interactive { interactive = true }
                }
                rec(k, t)
            }
        }
        rec(root, false)
        if content == 0 { return "none" }
        if !interactive && opaqueOnly && content <= 3 { return "weak" }
        if !interactive && content <= 2 { return "weak" }
        return "full"
    }

    // ---- rendering ----

    final class Ctx {
        var sb = ""
        var scale = 1.0
        var ox = 0.0
        var oy = 0.0
        var interactiveOnly = false
        var register = false
        var next = 1
        var table: [Int: Node] = [:]
        var menu = false
    }

    static func esc(_ s: String) -> String {
        var t = s
        if t.count > 80 { t = String(t.prefix(80)) + "..." }
        return t.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "\\n")
    }

    static func show(_ n: Node, _ c: Ctx) -> Bool {
        if c.interactiveOnly { return n.interactive }
        if n.role == "text" { return !n.name.isEmpty || hasActions(n) }
        if n.role == "image" { return !n.name.isEmpty }
        if containerRoles.contains(n.role), n.name.isEmpty, !hasActions(n), !n.focused { return false }
        return true
    }

    static func liveValue(_ n: Node) -> String? {
        if n.secure { return nil }
        if liveValueRoles.contains(n.role) { return n.value }
        if let num = n.number, n.role == "slider" || n.role == "incrementor" {
            return num == num.rounded() ? String(Int(num)) : String(num)
        }
        return nil
    }

    static func line(_ n: Node, _ c: Ctx, scale: Double? = nil) -> String {
        if n.role == "text", !hasActions(n) { return "- text: \"\(esc(n.name))\"" }
        var s = "- \(n.role)"
        if !n.name.isEmpty { s += " \"\(esc(n.name))\"" }
        var at: [String] = []
        let wantRef = !n.name.isEmpty || hasActions(n) || n.interactive
        if wantRef && c.register {
            n.ref = c.next
            c.next += 1
            c.table[n.ref] = n
            at.append("ref=@d\(n.ref)")
        }
        if n.focused { at.append("focused") }
        if !n.enabled { at.append("disabled") }
        if n.toggle >= 0 { at.append("toggle=" + (n.toggle == 1 ? "on" : n.toggle == 0 ? "off" : "mixed")) }
        if let e = n.expanded { at.append(e ? "expanded" : "collapsed") }
        if n.selected == true { at.append("selected") }
        if n.secure { at.append("secure") }
        if c.menu, n.role == "menuitem" || n.role == "menubaritem", menuRefusal(n) != nil { at.append("refused") }
        if let v = liveValue(n) { at.append("value=\"\(esc(v))\"") }
        let ac = actionLabels(n)
        if !ac.isEmpty { at.append("actions=" + ac.joined(separator: ",")) }
        if n.hasRect, !n.rectEmpty {
            let sc = scale ?? c.scale
            at.append(
                "rect=\(Int(((n.rect.minX - c.ox) * sc).rounded())),\(Int(((n.rect.minY - c.oy) * sc).rounded())),\(Int((n.rect.width * sc).rounded())),\(Int((n.rect.height * sc).rounded()))"
            )
        }
        if !at.isEmpty { s += " [" + at.joined(separator: " ") + "]" }
        return s
    }

    static func render(_ n: Node, _ indent: Int, _ c: Ctx) {
        let visible = show(n, c)
        if visible { c.sb += String(repeating: " ", count: indent * 2) + line(n, c) + "\n" }
        let ci = visible ? indent + 1 : indent
        for k in n.kids { render(k, ci, c) }
        if !c.interactiveOnly {
            let pad = String(repeating: " ", count: ci * 2)
            if n.offscreenKids > 0 { c.sb += pad + "- ... \(n.offscreenKids) offscreen items\n" }
            if n.moreKids > 0 { c.sb += pad + "- ... \(n.moreKids) more items not read (node limit)\n" }
        }
    }

    /// Where agent pixels map: the agent's last screenshot, else a default screenshot's scale.
    static func mapping(_ ag: Agent, _ frame: CGRect) -> (scale: Double, ox: Double, oy: Double) {
        if let f = ag.frame { return (f.scale, f.originX, f.originY) }
        return (Wn.defaultScale(frame), 0, 0)
    }

    static func ctx(_ ag: Agent, _ frame: CGRect) -> Ctx {
        let c = Ctx()
        let m = mapping(ag, frame)
        c.scale = m.scale
        c.ox = Double(frame.minX) + m.ox
        c.oy = Double(frame.minY) + m.oy
        return c
    }

    static func snapshot(_ w: Win, _ a: JSON, _ ag: Agent, register: Bool, interactiveOverride: Bool = false) throws -> JSON {
        let inter = interactiveOverride || a.bool("interactiveOnly", false)
        let maxNodes = max(10, min(2000, a.int("maxNodes", 800)))
        let el = try window(w)
        let frame = try Wn.frame(w)
        let rootRef = a.str("root")
        // With a root ref the walk starts at that element, so its subtree gets the whole node budget.
        let from = try rootRef.map { try getRef(ag, $0).el } ?? el
        let inMenu = rootRef != nil && inMenuBar(from)
        // A menu subtree sits outside the window, so nothing in it may be clipped to the window frame.
        let walkFrame = inMenu ? anywhere : frame
        var walked = walk(window: from, frame: walkFrame, maxNodes: maxNodes, deadlineMs: 2500)
        var q = rootRef == nil ? quality(walked.root) : "full"
        if q != "full", w.app.framework == "electron" || w.app.framework == "chromium" {
            sleepMs(800)
            walked = walk(window: from, frame: walkFrame, maxNodes: maxNodes, deadlineMs: 2500)
            q = quality(walked.root)
        }
        let c = ctx(ag, frame)
        c.interactiveOnly = inter
        c.register = register
        c.menu = inMenu
        let start = walked.root
        if rootRef != nil { c.next = ag.next }
        let backing = Wn.backingScale(of: frame)
        let m = mapping(ag, frame)
        c.sb += "window \"\(esc(w.info.title))\" [framework=\(w.app.framework) dpi=\(Int((72 * backing).rounded())) scale=\(fmt(m.scale)) size=\(Int(frame.width))x\(Int(frame.height)) tree=\(q)]\n"
        if rootRef != nil {
            render(start, 1, c)
        } else {
            for k in walked.root.kids { render(k, 1, c) }
            if walked.root.offscreenKids > 0 { c.sb += "  - ... \(walked.root.offscreenKids) offscreen items\n" }
        }
        if rootRef == nil, register, let bar = menuBar(w.pid) {
            // The menu bar's top-level items (not the Apple menu). Expand one with root: its ref.
            let items = (copy(bar, "AXChildren") as? [AXUIElement]) ?? []
            if items.count > 1 {
                c.sb += "menubar (press an item with desktop_click on its ref; snapshot root: its ref lists its items; no cursor is used)\n"
                c.menu = true
                for item in items.dropFirst() {
                    let n = read(item, depth: 0, frame: anywhere)
                    n.hasRect = false
                    c.sb += "  " + line(n, c) + "\n"
                }
                c.menu = false
            }
        }
        if walked.truncated { c.sb += "(truncated: node or time limit reached)\n" }
        if q == "none" { c.sb += "No accessibility tree. Use desktop_screenshot and click coordinates.\n" }
        if register {
            if rootRef == nil { ag.refs = c.table } else { for (k, v) in c.table { ag.refs[k] = v } }
            ag.next = c.next
        }
        lastWalked = walked
        return [
            "tree": c.sb.trimmingCharacters(in: .newlines), "truncated": walked.truncated, "treeQuality": q,
            "nodeCount": walked.count,
        ]
    }

    static var lastWalked: Walked?

    static func fmt(_ d: Double) -> String {
        let s = String(format: "%.3f", d)
        var t = s
        while t.hasSuffix("0") { t.removeLast() }
        if t.hasSuffix(".") { t.removeLast() }
        return t
    }

    // ---- refs ----

    static func getRef(_ ag: Agent, _ r: String) throws -> Node {
        guard r.hasPrefix("@d"), let n = Int(r.dropFirst(2)) else {
            throw HelperError("failed", "Bad ref; refs look like @d12.")
        }
        guard let node = ag.refs[n] else { throw HelperError("stale_ref", "Unknown ref \(r); take a new snapshot.") }
        if !alive(node) { throw HelperError("stale_ref", "Ref \(r) no longer matches the element; take a new snapshot.") }
        return node
    }

    private static let volatileNames: Set<String> = [
        "text", "textarea", "textfield", "searchfield", "window", "group", "scrollarea", "row", "cell", "outline",
        "table", "list", "image", "webarea", "heading", "splitgroup", "column", "sheet", "combobox", "slider",
        "popupbutton", "menubutton",
    ]

    static func alive(_ n: Node) -> Bool {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(n.el, "AXRole" as CFString, &v) == .success, (v as? String) == n.rawRole else {
            return false
        }
        if !volatileNames.contains(n.role) {
            let title = string(n.el, "AXTitle") ?? ""
            let desc = string(n.el, "AXDescription") ?? ""
            let now = !title.isEmpty ? title : desc
            if now != n.name { return false }
        }
        return true
    }

    // ---- find ----

    static func find(_ w: Win, _ a: JSON, _ ag: Agent) throws -> JSON {
        let el = try window(w)
        let frame = try Wn.frame(w)
        let walked = walk(window: el, frame: frame, maxNodes: 2500, deadlineMs: 3000)
        let name = a.str("name"), contains = a.str("nameContains"), role = a.str("role"), aid = a.str("automationId")
        let wanted = role.map(normalizeRole)
        let limit = max(1, min(50, a.int("limit", 20)))
        let c = ctx(ag, frame)
        c.register = true
        c.next = ag.next
        c.table = ag.refs
        var lines: [String] = []
        func rec(_ n: Node) {
            if lines.count >= limit { return }
            if n !== walked.root {
                var ok = true
                if let name, n.name != name { ok = false }
                if let contains, !n.name.lowercased().contains(contains.lowercased()) { ok = false }
                if let wanted, n.role != wanted { ok = false }
                if let aid, n.ident != aid { ok = false }
                if ok { lines.append(line(n, c)) }
            }
            for k in n.kids { rec(k) }
        }
        rec(walked.root)
        ag.next = c.next
        ag.refs = c.table
        return ["matches": lines.isEmpty ? "(no matches)" : lines.joined(separator: "\n")]
    }

    // ---- element ----

    static func element(_ w: Win, _ a: JSON, _ ag: Agent) throws -> JSON {
        let node: Node
        let frame = try Wn.frame(w)
        if let r = a.str("element") {
            node = try getRef(ag, r)
        } else {
            guard let pt = a.obj("point") else { throw HelperError("failed", "element needs a ref or a point.") }
            let p = Input.mapPoint(w, ag, frame, pt.dbl("x"), pt.dbl("y"))
            try Input.hitTest(w, p)
            var found: AXUIElement?
            AXUIElementCopyElementAtPosition(appElement(w.pid), Float(p.x), Float(p.y), &found)
            guard let found else { throw HelperError("failed", "No accessibility element at that point.") }
            let top = copy(found, "AXWindow")
            let mine = try window(w)
            if let top, CFEqual(top, mine) == false {
                throw HelperError("refused", "That point belongs to another window.")
            }
            node = read(found, depth: 0, frame: frame)
        }
        var out: [String] = []
        func kv(_ k: String, _ v: Any) { out.append("\(k): \(v)") }
        kv("role", node.role)
        kv("rawRole", node.rawRole)
        kv("subrole", node.subrole)
        kv("name", node.name)
        kv("roleDescription", node.roleDesc)
        kv("automationId", node.ident)
        kv("help", node.help)
        let r = node.rect
        kv("rect(points)", "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))")
        kv("enabled", node.enabled)
        kv("focused", node.focused)
        kv("password", node.secure)
        if let s = node.selected { kv("selected", s) }
        if let e = node.expanded { kv("expanded", e) }
        if node.toggle >= 0 { kv("toggleState", node.toggle == 1 ? "on" : node.toggle == 0 ? "off" : "mixed") }
        kv("actions", node.actions.joined(separator: ","))
        kv("valueSettable", node.valueSettable)
        if !node.secure {
            if let v = node.value { kv("value", esc(v)) }
            if let n = node.number { kv("number", n) }
        }
        if a.bool("text", false), !node.secure {
            var text: String?
            if let s = string(node.el, "AXValue") { text = s }
            if text == nil, let s = string(node.el, "AXSelectedText") { text = s }
            if let text { out.append("text:\n" + String(text.prefix(4000))) }
        }
        return ["details": out.joined(separator: "\n")]
    }

    // ---- audit ----

    static func audit(_ w: Win) throws -> JSON {
        let el = try window(w)
        let frame = try Wn.frame(w)
        let walked = walk(window: el, frame: frame, maxNodes: 2500, deadlineMs: 3500)
        var all: [Node] = []
        func rec(_ n: Node) {
            all.append(n)
            n.kids.forEach(rec)
        }
        rec(walked.root)
        for n in all where n.interactive {
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(n.el, "AXFocused" as CFString, &settable) == .success { n.focusable = settable.boolValue }
        }
        func d(_ n: Node) -> String {
            "\(n.role) \"\(esc(n.name))\"" + (n.ident.isEmpty ? "" : " id=\(n.ident)")
                + " rect=\(Int(n.rect.minX)),\(Int(n.rect.minY)),\(Int(n.rect.width)),\(Int(n.rect.height))"
        }
        var s = "Audit of \"\(esc(w.info.title))\": \(walked.count) nodes read\(walked.truncated ? " (truncated)" : ""), scale \(fmt(Wn.backingScale(of: frame)))x\n"
        let l1 = all.filter { $0.focusable && $0.enabled && $0.name.isEmpty && !["window", "group", "scrollarea", "textarea"].contains($0.role) }.prefix(30)
        s += "\nFocusable elements with no name (\(l1.count)):\n" + l1.map { "  " + d($0) + "\n" }.joined()
        let l2 = all.filter { $0.interactive && $0.enabled && $0.role != "textarea" && $0.role != "textfield" && ($0.rect.width < 24 || $0.rect.height < 24) && !sysSubroles.contains($0.subrole) }.prefix(30)
        s += "\nInteractive elements smaller than 24x24 points (\(l2.count)):\n"
            + l2.map { "  " + d($0) + "  size=\(Int($0.rect.width))x\(Int($0.rect.height))pt\n" }.joined()
        let wide = frame.insetBy(dx: -2, dy: -2)
        let l3 = all.filter { $0.enabled && !$0.rectEmpty && $0.interactive && $0 !== walked.root && !wide.contains($0.rect) }.prefix(30)
        s += "\nEnabled elements clipped or outside the window (\(l3.count)):\n" + l3.map { "  " + d($0) + " [outside window]\n" }.joined()
        let l4 = all.filter { $0.role == "image" && $0.name.isEmpty && !$0.rectEmpty }.prefix(30)
        s += "\nImages with no name (\(l4.count)):\n" + l4.map { "  " + d($0) + "\n" }.joined()
        s += "\nDuplicate access keys: not applicable on macOS.\n"
        let tab = all.filter { $0.focusable && $0.enabled && !$0.rectEmpty }.prefix(60)
        s += "\nTab order (first \(tab.count) focusable elements, tree order):\n"
        for (i, n) in tab.enumerated() { s += "  \(i + 1). \(n.role) \"\(esc(n.name))\"\n" }
        return ["report": s.trimmingCharacters(in: .newlines)]
    }
}
