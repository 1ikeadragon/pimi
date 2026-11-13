import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Window discovery and identity. CGWindowListCopyWindowInfo names every window with its id, owner
// pid, layer, bounds and (with Screen Recording) title, in front-to-back order. A target is pinned
// by window id + pid + process start time; when the pin no longer matches, the helper looks for the
// app's one window again and tells the main process (`repinned`).

struct WinInfo {
    let number: CGWindowID
    let pid: pid_t
    let layer: Int
    let bounds: CGRect
    let title: String
    let ownerName: String
    let onScreen: Bool
    let alpha: Double
}

struct AppInfo {
    let bundleId: String
    let name: String
    let bundlePath: String
    let exeName: String
    let regular: Bool
    let framework: String
}

/// A resolved target window.
struct Win {
    let info: WinInfo
    let app: AppInfo
    let started: String
    var pid: pid_t { info.pid }
    var number: CGWindowID { info.number }
}

enum Wn {
    // ---- CGWindowList ----

    static func windows(onScreenOnly: Bool) -> [WinInfo] {
        let options: CGWindowListOption = onScreenOnly
            ? [.optionOnScreenOnly, .excludeDesktopElements]
            : [.optionAll, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
        var out: [WinInfo] = []
        out.reserveCapacity(raw.count)
        for d in raw {
            guard let number = (d[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                let boundsDict = d[kCGWindowBounds as String] as? NSDictionary,
                let bounds = CGRect(dictionaryRepresentation: boundsDict)
            else { continue }
            out.append(
                WinInfo(
                    number: number, pid: pid,
                    layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                    bounds: bounds,
                    title: d[kCGWindowName as String] as? String ?? "",
                    ownerName: d[kCGWindowOwnerName as String] as? String ?? "",
                    onScreen: (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
                    alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1))
        }
        return out
    }

    static func info(number: CGWindowID) -> WinInfo? {
        guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], number) as? [[String: Any]],
            let d = raw.first, (d[kCGWindowNumber as String] as? NSNumber)?.uint32Value == number
        else { return nil }
        guard let pid = (d[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            let boundsDict = d[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDict)
        else { return nil }
        return WinInfo(
            number: number, pid: pid,
            layer: (d[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0, bounds: bounds,
            title: d[kCGWindowName as String] as? String ?? "",
            ownerName: d[kCGWindowOwnerName as String] as? String ?? "",
            onScreen: (d[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
            alpha: (d[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }

    // ---- apps ----

    private static var appCache: [pid_t: AppInfo] = [:]
    private static var frameworkCache: [String: String] = [:]

    static func resetCaches() { appCache.removeAll() }

    static func app(pid: pid_t) -> AppInfo? {
        if let cached = appCache[pid] { return cached }
        guard let running = NSRunningApplication(processIdentifier: pid), let bundleId = running.bundleIdentifier
        else { return nil }
        let path = running.bundleURL?.path ?? ""
        let exe = running.executableURL?.lastPathComponent ?? ""
        let info = AppInfo(
            bundleId: bundleId, name: running.localizedName ?? exe, bundlePath: path, exeName: exe,
            regular: running.activationPolicy == .regular, framework: framework(bundlePath: path))
        appCache[pid] = info
        return info
    }

    /// The UI framework a bundle ships, from its Frameworks folder. A hint for the agent, not a gate.
    private static func framework(bundlePath: String) -> String {
        if let cached = frameworkCache[bundlePath] { return cached }
        var result = "native"
        let dir = bundlePath + "/Contents/Frameworks"
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        if names.contains("Electron Framework.framework") {
            result = "electron"
        } else if names.contains(where: { $0.hasPrefix("Qt") && $0.hasSuffix(".framework") }) {
            result = "qt"
        } else if names.contains("FlutterMacOS.framework") {
            result = "flutter"
        } else if names.contains(where: { $0.hasSuffix(" Framework.framework") }) {
            result = "chromium"
        } else if FileManager.default.fileExists(atPath: bundlePath + "/Contents/runtime")
            || FileManager.default.fileExists(atPath: bundlePath + "/Contents/PlugIns/jre")
        {
            result = "java"
        }
        frameworkCache[bundlePath] = result
        return result
    }

    static func isEligible(_ w: WinInfo) -> Bool {
        w.layer == 0 && w.bounds.width >= 40 && w.bounds.height >= 40 && w.alpha > 0.01
    }

    static func entry(_ w: Win) -> JSON {
        [
            "appId": w.app.bundleId, "appName": w.app.name, "windowTitle": w.info.title,
            "framework": w.app.framework, "elevated": procLite(w.pid).map { $0.uid != getuid() } ?? false,
            "blocked": NSNull(), "hwnd": String(w.number), "pid": Int(w.pid), "processStartedAt": w.started,
            "windowClass": "", "exeName": w.app.exeName,
        ]
    }

    static func make(_ info: WinInfo) -> Win? {
        guard let app = app(pid: info.pid), app.regular else { return nil }
        return Win(info: info, app: app, started: procLite(info.pid)?.started ?? "")
    }

    // ---- list ----

    static func list() throws -> JSON {
        try requireScreenRecording()
        var res: [JSON] = []
        for info in windows(onScreenOnly: true) {
            guard isEligible(info), !info.title.isEmpty, let win = make(info) else { continue }
            if Safety.isOwn(pid: info.pid, bundleId: win.app.bundleId) || Safety.denied(bundleId: win.app.bundleId) {
                continue
            }
            res.append(entry(win))
        }
        return ["windows": res]
    }

    // ---- resolve ----

    static func pinMatches(_ t: Target) -> Win? {
        guard let id = t.windowId, let info = info(number: id), let win = make(info) else { return nil }
        if let pid = t.pid, pid != win.pid { return nil }
        if let started = t.started, started != win.started { return nil }
        if !t.appId.isEmpty, t.appId.caseInsensitiveCompare(win.app.bundleId) != .orderedSame { return nil }
        return win
    }

    static func resolve(_ t: Target?) throws -> (win: Win, repinned: Bool) {
        guard let t else { throw HelperError("refused", "This verb needs a target window.") }
        try requireScreenRecording()
        var repinned = false
        var found = pinMatches(t)
        if found == nil {
            if t.appId.isEmpty { throw HelperError("window_gone", "The target window is gone.") }
            let candidates = windows(onScreenOnly: false).filter(isEligible).compactMap { info -> Win? in
                guard let win = make(info), win.app.bundleId.caseInsensitiveCompare(t.appId) == .orderedSame else { return nil }
                return win
            }
            if candidates.isEmpty {
                throw HelperError("window_gone", "The target window is gone and the app has no other window open.")
            }
            let exact = candidates.filter { $0.info.title == t.windowTitle }
            if exact.count == 1 {
                found = exact[0]
            } else if candidates.count == 1 {
                found = candidates[0]
            } else {
                throw HelperError("refused", "More than one window of this app is open; close the others.")
            }
            repinned = true
        }
        guard let win = found else { throw HelperError("window_gone", "The target window is gone.") }
        if Safety.denied(bundleId: win.app.bundleId) {
            throw HelperError("blocked", "This app is on the never-drive list.")
        }
        if Safety.isOwn(pid: win.pid, bundleId: win.app.bundleId) {
            throw HelperError("refused", "This window belongs to Pimi itself.")
        }
        return (win, repinned)
    }

    static func requireScreenRecording() throws {
        if !CGPreflightScreenCaptureAccess() {
            throw HelperError(
                "permission_missing",
                "Pimi does not have Screen Recording access, so it cannot identify the target window. Grant it in System Settings > Privacy & Security > Screen Recording.")
        }
    }

    /// The window's current bounds (it may have moved since it was resolved).
    static func frame(_ w: Win) throws -> CGRect {
        guard let now = info(number: w.number) else { throw HelperError("window_gone", "The target window is gone.") }
        return now.bounds
    }

    // ---- geometry ----

    /// Backing scale of the display that holds the rect's centre (2 on Retina).
    static func backingScale(of rect: CGRect) -> Double {
        var id: CGDirectDisplayID = 0
        var count: UInt32 = 0
        let centre = CGPoint(x: rect.midX, y: rect.midY)
        if CGGetDisplaysWithPoint(centre, 1, &id, &count) != .success || count == 0 { id = CGMainDisplayID() }
        if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 {
            return Double(mode.pixelWidth) / Double(mode.width)
        }
        return 1
    }

    /// Image pixels per point of a default (1280 px) screenshot of this window.
    static func defaultScale(_ frame: CGRect) -> Double {
        let longest = max(frame.width, frame.height)
        if longest <= 0 { return 1 }
        return min(backingScale(of: frame), 1280 / Double(longest))
    }

    static func displayRects() -> [CGRect] {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
    }

    /// The screen's usable area (no menu bar, no Dock) in the top-left global space.
    static func visibleFrame(containing rect: CGRect) -> CGRect {
        var result = CGRect.zero
        DispatchQueue.main.sync {
            let screens = NSScreen.screens
            guard let primary = screens.first else { return }
            let h = primary.frame.height
            func quartz(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height) }
            let centre = CGPoint(x: rect.midX, y: rect.midY)
            let pick = screens.first { quartz($0.frame).contains(centre) } ?? primary
            result = quartz(pick.visibleFrame)
        }
        return result
    }
}
