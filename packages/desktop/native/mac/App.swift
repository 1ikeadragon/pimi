import AppKit
import Darwin
import Foundation

// The `app` and `deeplink` verbs. They only ever touch the pinned app: its pid (checked against the
// recorded start time) for status and quitting, its bundle id for starting it again, and the app
// bundle itself as the one receiver of a deep link.

enum Apps {
    // ---- status ----

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    /// The process is alive and is the one the target recorded (a recycled pid has another start time).
    static func same(_ pid: pid_t, _ started: String?) -> Bool {
        guard let p = procLite(pid) else { return false }
        return started == nil || p.started == started
    }

    static func status(_ t: Target) throws -> JSON {
        guard let pid = t.pid else { throw HelperError("failed", "The target has no recorded process.") }
        let running = same(pid, t.started)
        var d: JSON = ["running": running, "status": running ? "running" : "exited"]
        let crashes = crashReports(t, since: t.started.flatMap { UInt64($0) }.map { Date(timeIntervalSince1970: Double($0) / 1_000_000) })
        if !crashes.isEmpty { d["crashReports"] = crashes }
        guard running else { return d }
        var info = proc_taskinfo()
        let size = Int32(MemoryLayout<proc_taskinfo>.size)
        if proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &info, size) == size {
            d["workingSetMB"] = (Double(info.pti_resident_size) / 1_048_576 * 10).rounded() / 10
            let ticks = info.pti_total_user + info.pti_total_system
            let ns = Double(ticks) * Double(timebase.numer) / Double(timebase.denom)
            d["cpuSeconds"] = (ns / 1e7).rounded() / 100
        }
        if let p = procLite(pid), let micros = UInt64(p.started) {
            d["uptimeSeconds"] = ((Date().timeIntervalSince1970 - Double(micros) / 1_000_000) * 10).rounded() / 10
        }
        if AXIsProcessTrusted() { d["responding"] = Ax.responding(pid) }
        d["windows"] = Wn.windows(onScreenOnly: true).filter { $0.pid == pid && Wn.isEligible($0) }.count
        return d
    }

    /// Crash reports the system wrote for this executable since the process started (or in the last
    /// ten minutes when the start time is unknown).
    private static func crashReports(_ t: Target, since: Date?) -> [String] {
        let exe = t.pid.flatMap { Wn.app(pid: $0)?.exeName } ?? NSRunningApplication.runningApplications(withBundleIdentifier: t.appId).first?.executableURL?.lastPathComponent
        let name = exe ?? lastKnownExe(t)
        guard !name.isEmpty else { return [] }
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/DiagnosticReports")
        let floor = since ?? Date().addingTimeInterval(-600)
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files.filter { url in
            let base = url.lastPathComponent
            guard base.hasPrefix(name + "-") || base.hasPrefix(name + "_"), url.pathExtension == "ips" || url.pathExtension == "crash" else { return false }
            let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return mtime > floor
        }.map(\.lastPathComponent).sorted().suffix(3).map { $0 }
    }

    private static func lastKnownExe(_ t: Target) -> String {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: t.appId), let bundle = Bundle(url: url) else { return "" }
        return bundle.executableURL?.lastPathComponent ?? ""
    }

    // ---- launch and relaunch ----

    private static func appURL(_ t: Target) throws -> URL {
        if t.appId.isEmpty { throw HelperError("failed", "The target has no recorded app.") }
        if Safety.denied(bundleId: t.appId) { throw HelperError("blocked", "This app is on the never-drive list.") }
        if Safety.isOwn(pid: -1, bundleId: t.appId) { throw HelperError("refused", "This is Pimi itself.") }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: t.appId) else {
            throw HelperError("failed", "The app is not installed any more.")
        }
        return url
    }

    /// The app's windows, eligible ones only, whether or not they are on this Space.
    private static func windowsOf(_ t: Target) -> [Win] {
        Wn.resetCaches()
        return Wn.windows(onScreenOnly: false).filter(Wn.isEligible).compactMap { info -> Win? in
            guard let win = Wn.make(info), win.app.bundleId.caseInsensitiveCompare(t.appId) == .orderedSame else { return nil }
            return win
        }
    }

    /// One window to pin: the only one, or the only one with the recorded title.
    private static func pick(_ list: [Win], _ t: Target) -> Win? {
        if list.count == 1 { return list[0] }
        let exact = list.filter { $0.info.title == t.windowTitle }
        return exact.count == 1 ? exact[0] : nil
    }

    private static func pin(_ w: Win) -> JSON {
        ["hwnd": String(w.number), "pid": Int(w.pid), "processStartedAt": w.started]
    }

    /// Splits the owner's launch arguments the way a shell would: spaces separate, quotes group.
    static func splitArgs(_ s: String) -> [String] {
        var out: [String] = []
        var cur = ""
        var quote: Character?
        var has = false
        var escaped = false
        for ch in s {
            if escaped {
                cur.append(ch)
                escaped = false
            } else if ch == "\\" && quote != "'" {
                escaped = true
                has = true
            } else if let q = quote {
                if ch == q { quote = nil } else { cur.append(ch) }
            } else if ch == "\"" || ch == "'" {
                quote = ch
                has = true
            } else if ch == " " || ch == "\t" {
                if has { out.append(cur) }
                cur = ""
                has = false
            } else {
                cur.append(ch)
                has = true
            }
        }
        if has { out.append(cur) }
        return out
    }

    private static func start(_ t: Target, _ url: URL) throws {
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = splitArgs(t.launchArgs)
        config.activates = true
        let sem = DispatchSemaphore(value: 0)
        var failure: Error?
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            failure = error
            sem.signal()
        }
        if sem.wait(timeout: .now() + 20) == .timedOut { throw HelperError("failed", "macOS did not start the app in time.") }
        if failure != nil { throw HelperError("failed", "macOS would not start the app.") }
    }

    static func run(_ a: JSON, _ t: Target?) throws -> JSON {
        guard let t else { throw HelperError("refused", "This verb needs a target.") }
        let action = a.str("action") ?? "status"
        if action == "status" { return try status(t) }
        if action != "launch" && action != "relaunch" { throw HelperError("failed", "Unknown app action.") }
        if !t.allowRelaunch { throw HelperError("refused", "The owner has not allowed launching or relaunching this app.") }
        let url = try appURL(t)
        var res: JSON = [:]
        if action == "relaunch" {
            if let pid = t.pid, same(pid, t.started) {
                let running = NSRunningApplication(processIdentifier: pid)
                running?.terminate()
                var gone = waitGone(pid, t.started, 3000)
                if !gone {
                    if !t.disposable {
                        throw HelperError(
                            "failed",
                            "The app did not close within 3 seconds (it may be asking to save), and this target is not marked disposable, so it was left running.")
                    }
                    running?.forceTerminate()
                    gone = waitGone(pid, t.started, 3000)
                    res["terminated"] = true
                    if !gone { throw HelperError("failed", "The app would not exit.") }
                }
            }
            sleepMs(300)
        } else {
            let list = windowsOf(t)
            if !list.isEmpty {
                res["launched"] = false
                res["running"] = true
                if let w = pick(list, t) { res["repinned"] = pin(w) }
                return res
            }
        }
        try start(t, url)
        let begin = nowMs()
        var found: Win?
        var many = false
        while nowMs() - begin < 15_000 {
            sleepMs(250)
            let list = windowsOf(t)
            if list.isEmpty { continue }
            found = pick(list, t)
            many = found == nil
            if found != nil || list.count > 1 && nowMs() - begin > 3000 { break }
        }
        if let found {
            res["launched"] = true
            res["repinned"] = pin(found)
            return res
        }
        if many {
            throw HelperError("refused", "The app came back with more than one window; close the extra ones so the run can pin one.")
        }
        throw HelperError("failed", "The app started but no window of it appeared within 15 seconds.")
    }

    private static func waitGone(_ pid: pid_t, _ started: String?, _ ms: Int) -> Bool {
        let end = nowMs() + ms
        while nowMs() < end {
            if !same(pid, started) { return true }
            sleepMs(100)
        }
        return !same(pid, started)
    }

    // ---- deeplink ----

    private static func schemes(_ bundlePath: String) -> [String] {
        guard let plist = NSDictionary(contentsOfFile: bundlePath + "/Contents/Info.plist"),
            let types = plist["CFBundleURLTypes"] as? [[String: Any]]
        else { return [] }
        return types.flatMap { ($0["CFBundleURLSchemes"] as? [String]) ?? [] }
    }

    static func deeplink(_ w: Win, _ a: JSON, _ t: Target) throws -> JSON {
        guard let url = a.str("url"), !url.isEmpty, url.count <= 2000 else {
            throw HelperError("failed", "url must be 1..2000 characters.")
        }
        if url.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) {
            throw HelperError("refused", "The url contains control characters.")
        }
        guard let colon = url.firstIndex(of: ":"), colon != url.startIndex,
            url[url.startIndex].isLetter, url[..<colon].allSatisfy({ $0.isLetter || $0.isNumber || "+.-".contains($0) })
        else { throw HelperError("failed", "The url has no scheme.") }
        let scheme = String(url[..<colon])
        guard schemes(w.app.bundlePath).contains(where: { $0.caseInsensitiveCompare(scheme) == .orderedSame }) else {
            var other = ""
            if let probe = URL(string: scheme + "://x"), let handler = NSWorkspace.shared.urlForApplication(toOpen: probe) {
                other = " (its handler is \(handler.deletingPathExtension().lastPathComponent))"
            }
            throw HelperError("refused", "The scheme '\(scheme)' is not registered to the target app\(other).")
        }
        let rest = String(url[url.index(after: colon)...])
        let lowered = rest.lowercased()
        let mutating = rest.count > 400 || rest.contains("\"") || rest.contains(" ") || lowered.contains("%22") || lowered.contains("%20--")
            || rest.contains("--") || rest.contains("^") || rest.contains("|") || rest.contains("&&") || rest.contains("`")
            || rest.contains(";") || lowered.contains("../") || lowered.contains("file:")
            || [".sh", ".command", ".app", ".py", ".scpt", ".pkg", ".dmg"].contains(where: { lowered.contains($0) })
        if mutating && !t.disposable {
            throw HelperError("refused", "This payload is more than a bare navigation. It is only sent to a target the owner marked disposable.")
        }
        try Input.checkSession()
        try Input.checkUserActive()
        guard let target = URL(string: url) else { throw HelperError("failed", "The url is not valid.") }
        let appURL = URL(fileURLWithPath: w.app.bundlePath)
        let before = try? Cap.hash(w)
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let sem = DispatchSemaphore(value: 0)
        var failure: Error?
        NSWorkspace.shared.open([target], withApplicationAt: appURL, configuration: config) { _, error in
            failure = error
            sem.signal()
        }
        if sem.wait(timeout: .now() + 10) == .timedOut || failure != nil {
            throw HelperError("failed", "macOS would not open the URL in the app.")
        }
        sleepMs(1500)
        var changed = false
        if let before, let after = try? Cap.hash(w) { changed = Cap.different(before, after) }
        return [
            "launched": true, "handler": appURL.lastPathComponent, "scheme": scheme, "payloadLength": url.count,
            "mutatingPayload": mutating, "focusLeft": Input.focusLeft(w) ?? NSNull(), "changed": changed,
        ]
    }
}
