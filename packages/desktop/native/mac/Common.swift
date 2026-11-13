import ApplicationServices
import CoreGraphics
import Foundation

// Shared types for pimi-desktop-helper (macOS). The helper mirrors native/win: JSON lines on stdin
// and stdout, one request at a time, the same verbs and error codes. Coordinates are global points
// with the origin at the top left of the primary display (what Accessibility, CGWindowList and
// CGEvent all use); screenshots are pixels and each agent's last screenshot defines the mapping.

struct HelperError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

typealias JSON = [String: Any]

private func isBoolean(_ number: NSNumber) -> Bool {
    CFGetTypeID(number) == CFBooleanGetTypeID()
}

extension Dictionary where Key == String, Value == Any {
    func str(_ key: String) -> String? { self[key] as? String }

    func int(_ key: String, _ fallback: Int) -> Int {
        if let n = self[key] as? NSNumber, !isBoolean(n), n.doubleValue.isFinite {
            return Int(n.doubleValue.rounded())
        }
        return fallback
    }

    func dbl(_ key: String) -> Double {
        if let n = self[key] as? NSNumber, !isBoolean(n) { return n.doubleValue }
        return 0
    }

    func bool(_ key: String, _ fallback: Bool) -> Bool {
        if let n = self[key] as? NSNumber, isBoolean(n) { return n.boolValue }
        return fallback
    }

    func obj(_ key: String) -> JSON? { self[key] as? JSON }

    func strs(_ key: String) -> [String] {
        (self[key] as? [Any])?.compactMap { $0 as? String } ?? []
    }
}

func logErr(_ message: String) {
    if let data = (message + "\n").data(using: .utf8) { FileHandle.standardError.write(data) }
}

func nowMs() -> Int { Int(DispatchTime.now().uptimeNanoseconds / 1_000_000) }

func sleepMs(_ ms: Int) {
    if ms > 0 { Thread.sleep(forTimeInterval: Double(ms) / 1000) }
}

/// The window the helper was told to drive: the guard, as the main process built it.
struct Target {
    var appId = ""
    var windowTitle = ""
    var windowId: UInt32?
    var pid: Int32?
    var started: String?
    var allowInput = false
    var allowRelaunch = false
    var disposable = false
    var launchArgs = ""

    init(_ d: JSON) {
        appId = d.str("appId") ?? ""
        windowTitle = d.str("windowTitle") ?? ""
        if let h = d.str("hwnd"), let n = UInt32(h) { windowId = n }
        if let p = d["pid"] as? NSNumber { pid = p.int32Value }
        started = d.str("processStartedAt")
        allowInput = d.bool("allowInput", false)
        allowRelaunch = d.bool("allowRelaunch", false)
        disposable = d.bool("disposable", false)
        launchArgs = d.str("launchArgs") ?? ""
    }
}

/// Where an agent's last screenshot sits: image pixels per point, and the image's top left in
/// points from the window's top left. Pixel arguments from the agent are mapped back through it.
struct FrameInfo {
    var scale: Double
    var originX: Double
    var originY: Double
}

final class Agent {
    var next = 1
    var refs: [Int: Node] = [:]
    var frame: FrameInfo?
}

enum Agents {
    private static var table: [String: Agent] = [:]
    static func get(_ id: String?) -> Agent {
        let key = id ?? "default"
        if let a = table[key] { return a }
        let a = Agent()
        table[key] = a
        return a
    }
}
