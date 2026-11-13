import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

// Input injection and the gates that keep it inside the target window.
//
// Keyboard events are posted to the target's pid (CGEventPostToPid), so they cannot land in another
// app. Mouse events go through the HID tap and move the owner's real cursor; they are posted only
// after the hit test shows the target window (or one of its own popups) is topmost at that point.
// Before any input: the session must be unlocked and on the console, the owner must not be using
// the mouse or keyboard, and the target must be frontmost. Held keys and buttons are released on
// every error path, on stdin close, on SIGTERM, and by a watchdog.

enum Input {
    // ---- state ----

    private static let lock = NSRecursiveLock()
    private static var heldKeys: [(pid: pid_t, code: CGKeyCode, modifier: Bool)] = []
    private static var heldButtons: [CGMouseButton] = []
    private static var heldFlags: CGEventFlags = []
    private static var heldWin: Win?
    private static var heldSince = 0
    private static var lastHidInject = 0
    private static var watchdog: DispatchSourceTimer?

    static let source = CGEventSource(stateID: .privateState)

    static func start() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
        timer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(200))
        timer.setEventHandler {
            lock.lock()
            defer { lock.unlock() }
            if heldKeys.isEmpty && heldButtons.isEmpty { return }
            let lost = heldWin.map { !isForeground($0) } ?? true
            if lost || nowMs() - heldSince > 5000 { releaseAllLocked() }
        }
        timer.resume()
        watchdog = timer
    }

    static func register(_ w: Win) {
        lock.lock()
        heldWin = w
        heldSince = nowMs()
        lock.unlock()
    }

    static func releaseAll() {
        lock.lock()
        releaseAllLocked()
        lock.unlock()
    }

    private static func releaseAllLocked() {
        if heldKeys.isEmpty && heldButtons.isEmpty { return }
        let loc = CGEvent(source: nil)?.location ?? .zero
        for button in heldButtons { postMouse(up(button), at: loc, button: button, clickState: 1, flags: heldFlags) }
        heldButtons.removeAll()
        for key in heldKeys.reversed() {
            if key.modifier {
                heldFlags.subtract(flag(forModifierCode: key.code))
                postFlags(pid: key.pid, code: key.code, flags: heldFlags)
            } else {
                postKey(pid: key.pid, code: key.code, down: false, flags: heldFlags)
            }
        }
        heldKeys.removeAll()
        heldFlags = []
    }

    // ---- gates ----

    static func checkSession() throws {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return }
        let locked = (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
        let onConsole = (d["kCGSSessionOnConsoleKey"] as? NSNumber)?.boolValue ?? true
        if locked || !onConsole {
            throw HelperError("secure_desktop", "The screen is locked or this session is not on the console; nothing is sent.")
        }
    }

    private static let idleTypes: [CGEventType] = [
        .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged,
        .keyDown, .keyUp, .flagsChanged, .scrollWheel,
    ]

    static func checkUserActive() throws {
        let idle = idleTypes.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 1000
        if idle >= 1.5 { return }
        // Our own mouse events reach the HID system and reset the idle clock. When the last one is
        // ours (it happened no earlier than the last event of any kind), it is not the owner.
        lock.lock()
        let ours = lastHidInject
        lock.unlock()
        let sinceOurs = Double(nowMs() - ours) / 1000
        if ours != 0 && sinceOurs <= idle + 0.08 { return }
        throw HelperError("user_active", "The owner is using the mouse or keyboard right now. Try again in a moment.")
    }

    /// Windows of the on-screen list that count as real surfaces: not the cursor or the menu bar.
    private static func surfaces() -> [WinInfo] {
        Wn.windows(onScreenOnly: true).filter { $0.alpha > 0.01 && $0.ownerName != "Window Server" }
    }

    static func frontPid() -> pid_t? {
        guard let app = Ax.copy(AXUIElementCreateSystemWide(), "AXFocusedApplication") else { return nil }
        var pid: pid_t = 0
        guard CFGetTypeID(app) == AXUIElementGetTypeID(), AXUIElementGetPid(app as! AXUIElement, &pid) == .success else { return nil }
        return pid
    }

    static func isForeground(_ w: Win) -> Bool {
        guard let top = surfaces().first(where: { $0.layer == 0 && $0.bounds.width >= 40 }), top.number == w.number else {
            return false
        }
        if let front = frontPid() { return front == w.pid }
        return true
    }

    static func focusLeft(_ w: Win) -> String? {
        guard let front = frontPid(), front != w.pid else { return nil }
        return Wn.app(pid: front)?.name ?? NSRunningApplication(processIdentifier: front)?.localizedName
    }

    static func activate(_ w: Win) {
        let app = Ax.appElement(w.pid)
        AXUIElementSetAttributeValue(app, "AXFrontmost" as CFString, kCFBooleanTrue)
        NSRunningApplication(processIdentifier: w.pid)?.activate(options: [.activateAllWindows])
        if let el = try? Ax.window(w) {
            AXUIElementPerformAction(el, "AXRaise" as CFString)
            AXUIElementSetAttributeValue(el, "AXMain" as CFString, kCFBooleanTrue)
        }
    }

    private static func pollForeground(_ w: Win, _ ms: Int) -> Bool {
        let end = nowMs() + ms
        repeat {
            if isForeground(w) { return true }
            sleepMs(15)
        } while nowMs() < end
        return isForeground(w)
    }

    static func ensureForeground(_ w: Win) throws {
        if isForeground(w) { return }
        guard Wn.info(number: w.number) != nil else { throw HelperError("window_gone", "The target window is gone.") }
        if Ax.isMinimized(w) {
            throw HelperError("window_minimized", "The window is minimized. Run window restore first.")
        }
        activate(w)
        if pollForeground(w, 300) { return }
        activate(w)
        if pollForeground(w, 300) { return }
        let other = focusLeft(w).map { " (the frontmost app is \($0))" } ?? ""
        throw HelperError("foreground_denied", "macOS would not bring the target window to the foreground\(other).")
    }

    static func gate(_ w: Win) throws {
        try checkSession()
        try checkUserActive()
        try ensureForeground(w)
    }

    // ---- coordinates and hit test ----

    static func mapPoint(_ w: Win, _ ag: Agent, _ frame: CGRect, _ x: Double, _ y: Double) -> CGPoint {
        let m = Ax.mapping(ag, frame)
        return CGPoint(x: Double(frame.minX) + m.ox + x / m.scale, y: Double(frame.minY) + m.oy + y / m.scale)
    }

    /// The topmost surface at the point must be the target window or a popup of the same process.
    static func hitTest(_ w: Win, _ p: CGPoint) throws {
        if !Wn.displayRects().contains(where: { $0.contains(p) }) {
            throw HelperError("refused", "That point is off the screen. Run window fit first.")
        }
        let frame = try Wn.frame(w)
        for attempt in 0..<2 {
            let top = surfaces().first { $0.bounds.contains(p) }
            if let top {
                if top.number == w.number { return }
                if top.pid == w.pid {
                    // A menu, popover or tooltip sits above normal windows; a sheet or drawer lies inside the target.
                    if top.layer != 0 { return }
                    if frame.insetBy(dx: -3, dy: -3).contains(top.bounds) && !top.bounds.equalTo(frame) { return }
                }
            }
            if attempt == 0 {
                try ensureForeground(w)
                sleepMs(40)
                continue
            }
            let owner = top.flatMap { Wn.app(pid: $0.pid)?.name ?? $0.ownerName }
            throw HelperError("occluded", "Another window\(owner.map { " (\($0))" } ?? "") covers that point. Nothing was sent.")
        }
    }

    // ---- raw events ----

    private static func flag(forModifierCode code: CGKeyCode) -> CGEventFlags {
        switch code {
        case 55, 54: return .maskCommand
        case 56, 60: return .maskShift
        case 58, 61: return .maskAlternate
        case 59, 62: return .maskControl
        default: return []
        }
    }

    static func postKey(pid: pid_t, code: CGKeyCode, down: Bool, flags: CGEventFlags, unicode: [UniChar]? = nil, autorepeat: Bool = false) {
        guard let ev = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
        ev.flags = flags
        if let unicode { ev.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: unicode) }
        if autorepeat { ev.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
        ev.postToPid(pid)
    }

    static func postFlags(pid: pid_t, code: CGKeyCode, flags: CGEventFlags) {
        guard let ev = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true) else { return }
        ev.type = .flagsChanged
        ev.flags = flags
        ev.postToPid(pid)
    }

    static func down(_ b: CGMouseButton) -> CGEventType { b == .left ? .leftMouseDown : b == .right ? .rightMouseDown : .otherMouseDown }
    static func up(_ b: CGMouseButton) -> CGEventType { b == .left ? .leftMouseUp : b == .right ? .rightMouseUp : .otherMouseUp }
    static func dragged(_ b: CGMouseButton) -> CGEventType { b == .left ? .leftMouseDragged : b == .right ? .rightMouseDragged : .otherMouseDragged }

    static func button(_ name: String) -> CGMouseButton { name == "right" ? .right : name == "middle" ? .center : .left }

    static func postMouse(_ type: CGEventType, at p: CGPoint, button: CGMouseButton, clickState: Int, flags: CGEventFlags) {
        guard let ev = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
        ev.flags = flags
        ev.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        ev.post(tap: .cghidEventTap)
        lock.lock()
        lastHidInject = nowMs()
        lock.unlock()
    }

    static func moveTo(_ p: CGPoint, flags: CGEventFlags = []) {
        postMouse(.mouseMoved, at: p, button: .left, clickState: 0, flags: flags)
        let c = CGEvent(source: nil)?.location ?? p
        if abs(c.x - p.x) > 1 || abs(c.y - p.y) > 1 { CGWarpMouseCursorPosition(p) }
    }

    static func modFlags(_ mods: [String]) throws -> CGEventFlags {
        var f: CGEventFlags = []
        for m in mods {
            switch m.lowercased() {
            case "ctrl": f.insert(.maskControl)
            case "alt": f.insert(.maskAlternate)
            case "shift": f.insert(.maskShift)
            case "cmd": f.insert(.maskCommand)
            default: throw HelperError("refused", "Only ctrl, alt, shift and cmd modifiers are allowed.")
            }
        }
        return f
    }

    // ---- click ----

    static func clickAt(_ w: Win, _ p: CGPoint, button name: String, count: Int, flags: CGEventFlags) throws {
        try gate(w)
        try hitTest(w, p)
        register(w)
        let b = button(name)
        moveTo(p, flags: flags)
        for i in 1...count {
            postMouse(down(b), at: p, button: b, clickState: i, flags: flags)
            sleepMs(12)
            postMouse(up(b), at: p, button: b, clickState: i, flags: flags)
            sleepMs(25)
        }
    }

    /// The centre of the element's current rectangle, after scrolling it into view when it is outside the window.
    static func nodePoint(_ n: Node, _ frame: CGRect) throws -> CGPoint {
        var rect = n.rect
        if let p = Ax.point(Ax.copy(n.el, "AXPosition")), let s = Ax.size(Ax.copy(n.el, "AXSize")) {
            rect = CGRect(origin: p, size: s)
        }
        if !frame.insetBy(dx: -2, dy: -2).intersects(rect) {
            AXUIElementPerformAction(n.el, "AXScrollToVisible" as CFString)
            sleepMs(120)
            if let p = Ax.point(Ax.copy(n.el, "AXPosition")), let s = Ax.size(Ax.copy(n.el, "AXSize")) {
                rect = CGRect(origin: p, size: s)
            }
        }
        if rect.width < 1 || rect.height < 1 { throw HelperError("failed", "The element has no on-screen rectangle.") }
        return CGPoint(x: rect.midX, y: rect.midY)
    }

    static func perform(_ n: Node, _ action: String) -> Bool {
        let e = AXUIElementPerformAction(n.el, action as CFString)
        // A press that opens a modal can outlast the messaging timeout; the action was still delivered.
        return e == .success || e == .cannotComplete
    }

    // ---- keyboard ----

    private static let named: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "forwarddelete": 117, "del": 117, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
        "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "plus": 24, "minus": 27, "comma": 43, "period": 47, "slash": 44, "semicolon": 41, "equals": 24,
    ]

    private static let modCodes: [String: CGKeyCode] = [
        "command": 55, "shift": 56, "option": 58, "control": 59,
    ]

    /// Characters the current layout types with no modifier or with shift: key code and whether shift is held.
    private static var layout: [Character: (code: CGKeyCode, shift: Bool)]?

    private static func layoutMap() -> [Character: (code: CGKeyCode, shift: Bool)] {
        if let layout { return layout }
        var map: [Character: (code: CGKeyCode, shift: Bool)] = [:]
        DispatchQueue.main.sync {
            var source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
            var data = source.flatMap { TISGetInputSourceProperty($0, kTISPropertyUnicodeKeyLayoutData) }
            if data == nil {
                source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()
                data = source.flatMap { TISGetInputSourceProperty($0, kTISPropertyUnicodeKeyLayoutData) }
            }
            guard let data else { return }
            let cf = Unmanaged<CFData>.fromOpaque(data).takeUnretainedValue()
            guard let bytes = CFDataGetBytePtr(cf) else { return }
            let layoutPtr = UnsafePointer<UCKeyboardLayout>(OpaquePointer(bytes))
            for shift in [false, true] {
                for code in 0..<128 {
                    var dead: UInt32 = 0
                    var length = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    let mods: UInt32 = shift ? UInt32(shiftKey >> 8) & 0xFF : 0
                    let status = UCKeyTranslate(
                        layoutPtr, UInt16(code), UInt16(kUCKeyActionDown), mods, UInt32(LMGetKbdType()),
                        OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, 4, &length, &chars)
                    guard status == noErr, length == 1, let scalar = Unicode.Scalar(chars[0]), chars[0] >= 0x20 else { continue }
                    let ch = Character(scalar)
                    // The first key that types a character wins; the unshifted reading beats the shifted one.
                    if map[ch] == nil { map[ch] = (CGKeyCode(code), shift) }
                }
            }
        }
        layout = map
        return map
    }

    static func keyCode(for key: String) throws -> CGKeyCode {
        if let c = named[key] { return c }
        let chars = Array(key)
        if chars.count == 1, let hit = layoutMap()[chars[0]] { return hit.code }
        throw HelperError("failed", "Unknown key name '\(key)'.")
    }

    /// Types text with real key codes from the current layout. A character the layout cannot produce
    /// with at most shift fails before anything is sent.
    static func typeScancode(_ w: Win, _ text: String) throws -> Int {
        let map = layoutMap()
        var plan: [(code: CGKeyCode, shift: Bool)] = []
        for ch in text {
            if ch == "\n" || ch == "\r\n" || ch == "\r" { plan.append((36, false)); continue }
            if ch == "\t" { plan.append((48, false)); continue }
            guard let hit = map[ch] else {
                throw HelperError("failed", "This keyboard layout cannot produce one of the characters in scancode mode. Nothing was sent.")
            }
            plan.append(hit)
        }
        register(w)
        var sent = 0
        for step in plan {
            if sent % 20 == 0, sent > 0, !isForeground(w) {
                throw HelperError("failed", "The target lost the foreground after \(sent) characters were sent.")
            }
            let flags: CGEventFlags = step.shift ? [.maskShift] : []
            if step.shift { postFlags(pid: w.pid, code: 56, flags: flags) }
            postKey(pid: w.pid, code: step.code, down: true, flags: flags)
            postKey(pid: w.pid, code: step.code, down: false, flags: flags)
            if step.shift { postFlags(pid: w.pid, code: 56, flags: []) }
            sent += 1
            sleepMs(6)
        }
        return sent
    }

    /// Types text as Unicode strings in chunks of 20 UTF-16 units, so layout and dead keys do not matter.
    static func typeUnicode(_ w: Win, _ text: String) throws -> Int {
        register(w)
        var sent = 0
        var run: [UniChar] = []
        func flush() throws {
            if run.isEmpty { return }
            if sent > 0, !isForeground(w) {
                throw HelperError("failed", "The target lost the foreground after \(sent) characters were sent.")
            }
            postKey(pid: w.pid, code: 0, down: true, flags: heldFlags, unicode: run)
            postKey(pid: w.pid, code: 0, down: false, flags: heldFlags, unicode: run)
            sent += run.count
            run.removeAll(keepingCapacity: true)
            sleepMs(4)
        }
        for ch in text {
            if ch == "\n" || ch == "\r\n" || ch == "\r" || ch == "\t" {
                try flush()
                let code: CGKeyCode = ch == "\t" ? 48 : 36
                postKey(pid: w.pid, code: code, down: true, flags: heldFlags)
                postKey(pid: w.pid, code: code, down: false, flags: heldFlags)
                sent += 1
                sleepMs(4)
                continue
            }
            let units = Array(String(ch).utf16)
            if run.count + units.count > 20 { try flush() }
            run.append(contentsOf: units)
        }
        try flush()
        return sent
    }

    /// One chord: modifiers down, each key down then up, modifiers up. holdMs and repeat are in the
    /// second part of this file; action down/up leave keys held for the watchdog and key up.
    static func press(_ w: Win, _ chord: Safety.Chord, holdMs: Int, repeatCount: Int, action: String) throws {
        register(w)
        let flags = chord.modifiers.reduce(into: CGEventFlags()) { acc, m in
            switch m {
            case .command: acc.insert(.maskCommand)
            case .control: acc.insert(.maskControl)
            case .option: acc.insert(.maskAlternate)
            case .shift: acc.insert(.maskShift)
            }
        }
        let codes = try chord.keys.map(keyCode(for:))
        for rep in 0..<repeatCount {
            if !isForeground(w) { throw HelperError("failed", "The target lost the foreground.") }
            var acc: CGEventFlags = []
            for m in chord.modifiers {
                let code = modCodes[m.rawValue]!
                acc.formUnion(flag(forModifierCode: code))
                postFlags(pid: w.pid, code: code, flags: acc)
                lock.lock()
                heldKeys.append((w.pid, code, true))
                heldFlags = acc
                lock.unlock()
            }
            for code in codes {
                postKey(pid: w.pid, code: code, down: true, flags: flags)
                lock.lock()
                heldKeys.append((w.pid, code, false))
                heldSince = nowMs()
                lock.unlock()
            }
            sleepMs(12)
            for code in codes.reversed() {
                postKey(pid: w.pid, code: code, down: false, flags: flags)
                lock.lock()
                heldKeys.removeAll { !$0.modifier && $0.code == code }
                lock.unlock()
            }
            for m in chord.modifiers.reversed() {
                let code = modCodes[m.rawValue]!
                acc.subtract(flag(forModifierCode: code))
                postFlags(pid: w.pid, code: code, flags: acc)
                lock.lock()
                heldKeys.removeAll { $0.modifier && $0.code == code }
                heldFlags = acc
                lock.unlock()
            }
            if rep < repeatCount - 1 { sleepMs(15) }
        }
    }
}

// ---- verbs ----

extension Main {
    static func inputVerb(_ verb: String, _ w: Win, _ a: JSON, _ ag: Agent, _ t: Target) throws -> JSON {
        let before = try? Cap.hash(w)
        var res: JSON
        do {
            switch verb {
            case "click": res = try click(w, a, ag)
            case "type": res = try typeVerb(w, a, ag)
            case "key": res = try keyVerb(w, a)
            default: throw HelperError("unsupported", "That desktop tool is not available on macOS yet.")
            }
        } catch {
            Input.releaseAll()
            throw error
        }
        sleepMs(250)
        var changed = false
        if let before, let after = try? Cap.hash(w) { changed = Cap.different(before, after) }
        res["changed"] = changed
        res["focusLeft"] = Input.focusLeft(w) ?? NSNull()
        return res
    }

    static func relPoint(_ frame: CGRect, _ p: CGPoint) -> JSON {
        ["x": Double(p.x - frame.minX), "y": Double(p.y - frame.minY)]
    }

    static func click(_ w: Win, _ a: JSON, _ ag: Agent) throws -> JSON {
        let button = a.str("button") ?? "left"
        let count = max(1, min(3, a.int("count", 1)))
        let via = a.str("via") ?? "auto"
        let flags = try Input.modFlags(a.strs("modifiers"))
        let frame = try Wn.frame(w)
        if let er = a.str("element") {
            let n = try Ax.getRef(ag, er)
            if !n.enabled { throw HelperError("failed", "The element is disabled.") }
            let canPress = n.actions.contains("AXPress")
            let canMenu = n.actions.contains("AXShowMenu")
            let centre = try Input.nodePoint(n, frame)
            func pattern() throws -> JSON {
                let action = button == "right" ? (canMenu ? "AXShowMenu" : nil) : (canPress ? "AXPress" : nil)
                guard let action, Input.perform(n, action) else {
                    throw HelperError("unsupported", "The element has no action that can click it.")
                }
                return ["role": n.role, "label": n.name, "point": relPoint(frame, centre), "via": "pattern"]
            }
            if via == "pattern" { return try pattern() }
            if via == "auto", button == "left", count == 1, flags.isEmpty, canPress { return try pattern() }
            do {
                try Input.clickAt(w, centre, button: button, count: count, flags: flags)
            } catch let e as HelperError where via == "auto" && (e.code == "occluded" || e.code == "refused") && (canPress || canMenu) {
                return try pattern()
            }
            return ["role": n.role, "label": n.name, "point": relPoint(frame, centre), "via": "input"]
        }
        guard let pt = a.obj("point") else { throw HelperError("failed", "click needs element or point.") }
        let p = Input.mapPoint(w, ag, frame, pt.dbl("x"), pt.dbl("y"))
        try Input.clickAt(w, p, button: button, count: count, flags: flags)
        var role: Any = NSNull(), label: Any = NSNull()
        var hit: AXUIElement?
        if AXUIElementCopyElementAtPosition(Ax.appElement(w.pid), Float(p.x), Float(p.y), &hit) == .success, let hit {
            let n = Ax.read(hit, depth: 0, frame: frame, wantActions: false)
            role = n.role
            label = n.name
        }
        return ["role": role, "label": label, "point": relPoint(frame, p), "via": "input"]
    }

    static func typeVerb(_ w: Win, _ a: JSON, _ ag: Agent) throws -> JSON {
        guard let text = a.str("text"), !text.isEmpty else { throw HelperError("failed", "type needs text.") }
        if text.count > 2000 { throw HelperError("failed", "Text is limited to 2000 characters.") }
        let mode = a.str("mode") ?? "unicode"
        let clear = a.bool("clear", false), submit = a.bool("submit", false)
        let node = try a.str("element").map { try Ax.getRef(ag, $0) }
        let frame = try Wn.frame(w)
        if mode == "set" {
            guard let node else { throw HelperError("failed", "mode set needs an element ref.") }
            if node.secure { throw HelperError("refused", "Password fields are not written.") }
            if !node.valueSettable { throw HelperError("unsupported", "The element's value cannot be set.") }
            AXUIElementSetAttributeValue(node.el, "AXFocused" as CFString, kCFBooleanTrue)
            let current = clear ? "" : (Ax.string(node.el, "AXValue") ?? "")
            let e = AXUIElementSetAttributeValue(node.el, "AXValue" as CFString, (current + text) as CFString)
            if e != .success { throw HelperError("unsupported", "The element rejected the value.") }
            return ["via": "pattern", "sent": text.utf16.count]
        }
        if mode != "unicode" && mode != "scancode" { throw HelperError("failed", "Unknown type mode.") }
        try Input.gate(w)
        if let node {
            // Focus the field itself; a click is the fallback for fields that refuse AXFocused.
            let ok = AXUIElementSetAttributeValue(node.el, "AXFocused" as CFString, kCFBooleanTrue) == .success
            if !ok { try Input.clickAt(w, try Input.nodePoint(node, frame), button: "left", count: 1, flags: []) }
        }
        if clear {
            try Input.press(w, try Safety.parse(chord: "cmd+a", keys: []), holdMs: 0, repeatCount: 1, action: "press")
            try Input.press(w, try Safety.parse(chord: "delete", keys: []), holdMs: 0, repeatCount: 1, action: "press")
        }
        let sent = mode == "scancode" ? try Input.typeScancode(w, text) : try Input.typeUnicode(w, text)
        if submit { try Input.press(w, try Safety.parse(chord: "return", keys: []), holdMs: 0, repeatCount: 1, action: "press") }
        return ["via": "input", "sent": sent]
    }

    static func keyVerb(_ w: Win, _ a: JSON) throws -> JSON {
        let chord = try Safety.parse(chord: a.str("chord"), keys: a.strs("keys"))
        if let refused = Safety.refusal(chord) { throw HelperError("refused", refused) }
        let hold = max(0, min(5000, a.int("holdMs", 0)))
        let rep = max(1, min(20, a.int("repeat", 1)))
        let action = a.str("action") ?? "press"
        if action != "press" && action != "down" && action != "up" { throw HelperError("failed", "Unknown key action.") }
        try Input.gate(w)
        try Input.press(w, chord, holdMs: hold, repeatCount: rep, action: action)
        return [:]
    }
}
