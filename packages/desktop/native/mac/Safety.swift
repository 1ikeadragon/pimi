import AppKit
import Darwin
import Foundation

// What the helper refuses no matter what the main process sent: Pimi's own windows and the chords
// that act on the system. The main process checks the same rules first (mac/guard.ts); this is the
// backstop.

struct ProcLite {
    let pid: pid_t
    let ppid: pid_t
    let uid: uid_t
    let started: String
}

func procLite(_ pid: pid_t) -> ProcLite? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    let micros = UInt64(info.pbi_start_tvsec) * 1_000_000 + UInt64(info.pbi_start_tvusec)
    return ProcLite(pid: pid, ppid: pid_t(info.pbi_ppid), uid: info.pbi_uid, started: String(micros))
}

enum Safety {
    /// The helper's own process and every ancestor (the Electron main process that spawned it).
    static let ownPids: Set<pid_t> = {
        var set: Set<pid_t> = [getpid()]
        var pid = getppid()
        var hops = 0
        while pid > 1, hops < 16 {
            set.insert(pid)
            guard let p = procLite(pid) else { break }
            pid = p.ppid
            hops += 1
        }
        return set
    }()

    private static let deniedBundleIds: Set<String> = []

    static func isOwn(pid: pid_t, bundleId: String) -> Bool {
        ownPids.contains(pid) || bundleId.lowercased().hasPrefix("com.pimi.")
    }

    static func denied(bundleId: String) -> Bool {
        deniedBundleIds.contains(bundleId)
    }

    // ---- chords ----

    enum Mod: String { case command, control, option, shift }

    struct Chord {
        var modifiers: [Mod]
        var keys: [String]
    }

    private static let modAliases: [String: Mod] = [
        "cmd": .command, "command": .command, "meta": .command, "super": .command,
        "ctrl": .control, "control": .control,
        "opt": .option, "option": .option, "alt": .option,
        "shift": .shift,
    ]

    /// Tokens ("cmd", "shift", "s") into modifiers and keys.
    static func parse(chord: String?, keys: [String]) throws -> Chord {
        var tokens: [String] = []
        if !keys.isEmpty {
            tokens = keys
        } else {
            var c = (chord ?? "").trimmingCharacters(in: .whitespaces)
            if c == "+" { c = "plus" }
            c = c.replacingOccurrences(of: "++", with: "+plus")
            tokens = c.split(separator: "+").map(String.init)
        }
        tokens = tokens.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty }
        if tokens.isEmpty { throw HelperError("failed", "key needs a chord or keys.") }
        var mods: [Mod] = []
        var rest: [String] = []
        for token in tokens {
            if let m = modAliases[token] {
                if !mods.contains(m) { mods.append(m) }
            } else if token == "fn" || token == "function" {
                throw HelperError("refused", "The fn key is not available.")
            } else {
                rest.append(token == "plus" ? "+" : token)
            }
        }
        return Chord(modifiers: mods, keys: rest)
    }

    /// Chords that act on the system or the app instead of the window. A deny list: an unlisted
    /// chord still only reaches the target window's process.
    static func refusal(_ chord: Chord) -> String? {
        let cmd = chord.modifiers.contains(.command)
        let ctrl = chord.modifiers.contains(.control)
        let opt = chord.modifiers.contains(.option)
        let shift = chord.modifiers.contains(.shift)
        let desc = (chord.modifiers.map(\.rawValue) + chord.keys).joined(separator: "+")
        for key in chord.keys {
            if cmd && ["tab", "`", "~", "space", "q", "h", "m", "w"].contains(key) {
                return "The chord \(desc) acts on the system or the app, not the window."
            }
            if cmd && shift && ["3", "4", "5", "6"].contains(key) { return "Screenshot chords are refused." }
            if cmd && opt && ["escape", "esc", "h", "m", "d", "w"].contains(key) {
                return "The chord \(desc) acts on the system or the app, not the window."
            }
            if ctrl && ["left", "right", "up", "down", "space", "tab"].contains(key) {
                return "Mission Control and space-switching chords are refused."
            }
            if cmd && shift && ["tab", "`", "~", "q"].contains(key) {
                return "The chord \(desc) acts on the system or the app, not the window."
            }
        }
        if ctrl && cmd { return "Control-command chords are refused." }
        return nil
    }
}
