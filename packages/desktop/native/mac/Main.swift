import AppKit
import ApplicationServices
import Foundation

// pimi-desktop-helper (macOS). One long-lived process, JSON lines on stdin and stdout, one request at
// a time; the contract is the one native/win speaks. Requests run on a background thread while the
// main thread runs the run loop, which services the SIGTERM/SIGINT sources that release held keys
// and buttons before the process exits.

@main
enum Main {
    static let version = "1"

    static func main() {
        let args = CommandLine.arguments
        if args.contains("--selftest") {
            let out: JSON = [
                "ok": true, "version": version, "ax": AXIsProcessTrusted(),
                "screen": CGPreflightScreenCaptureAccess(),
            ]
            print(String(data: (try? JSONSerialization.data(withJSONObject: out)) ?? Data(), encoding: .utf8) ?? "{}")
            exit(0)
        }
        signal(SIGPIPE, SIG_IGN)
        Input.start()
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                finish()
                exit(0)
            }
            source.resume()
            signalSources.append(source)
        }
        let reader = Thread {
            while let line = readLine(strippingNewline: true) {
                if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
                let reply = handle(line)
                if let data = (reply + "\n").data(using: .utf8) { FileHandle.standardOutput.write(data) }
            }
            // stdin closed: the main process is gone or is stopping the helper.
            finish()
            exit(0)
        }
        reader.stackSize = 8 << 20
        reader.start()
        RunLoop.main.run()
    }

    static var signalSources: [DispatchSourceSignal] = []

    /// Everything that must be undone before the process ends.
    static func finish() { Input.releaseAll() }

    // ---- protocol ----

    static func encode(_ obj: JSON) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
            let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]),
            let s = String(data: data, encoding: .utf8)
        else { return "{\"ok\":false,\"code\":\"failed\",\"message\":\"The helper produced an invalid reply.\"}" }
        return s
    }

    static func fail(_ id: Any?, _ code: String, _ message: String) -> String {
        encode(["id": id ?? NSNull(), "ok": false, "code": code, "message": message])
    }

    static func handle(_ line: String) -> String {
        var id: Any?
        var verb = "?"
        let started = nowMs()
        do {
            guard let data = line.data(using: .utf8), let req = try JSONSerialization.jsonObject(with: data) as? JSON else {
                return fail(nil, "failed", "Request is not a JSON object.")
            }
            id = req["id"]
            verb = req.str("verb") ?? ""
            let args = req.obj("args") ?? [:]
            let agent = Agents.get(req.str("agent"))
            let target = req.obj("target").map(Target.init)
            Wn.resetCaches()
            var repin: JSON?
            let result = try dispatch(verb, args, target, agent, &repin)
            var res = result
            if let repin { res["repinned"] = repin }
            logErr("\(verb) ok \(nowMs() - started)ms")
            return encode(["id": id ?? NSNull(), "ok": true, "result": res])
        } catch let e as HelperError {
            logErr("\(verb) \(e.code) \(nowMs() - started)ms")
            return fail(id, e.code, e.message)
        } catch {
            logErr("\(verb) exception")
            return fail(id, "failed", "The helper hit an internal error.")
        }
    }

    enum Level: Int { case read, ax, input }

    /// Resolves the target window and applies the gates every verb of that level needs.
    static func prep(_ t: Target?, _ level: Level, _ repin: inout JSON?) throws -> Win {
        let (win, repinned) = try Wn.resolve(t)
        if repinned {
            repin = ["hwnd": String(win.number), "pid": Int(win.pid), "processStartedAt": win.started]
        }
        if level.rawValue >= Level.input.rawValue, !(t?.allowInput ?? false) {
            throw HelperError("refused", "Input is not enabled for this run.")
        }
        if level.rawValue >= Level.ax.rawValue {
            try Ax.trusted()
            if !Ax.responding(win.pid) { throw HelperError("target_hung", "The target window is not responding.") }
        }
        return win
    }

    static func dispatch(_ verb: String, _ a: JSON, _ t: Target?, _ ag: Agent, _ repin: inout JSON?) throws -> JSON {
        switch verb {
        case "list":
            return try Wn.list()
        case "screenshot":
            let w = try prep(t, .read, &repin)
            return try screenshot(w, a, ag, t!)
        case "snapshot":
            let w = try prep(t, .ax, &repin)
            return try Ax.snapshot(w, a, ag, register: true)
        case "find":
            let w = try prep(t, .ax, &repin)
            return try Ax.find(w, a, ag)
        case "element":
            let w = try prep(t, .ax, &repin)
            return try Ax.element(w, a, ag)
        case "audit":
            let w = try prep(t, .ax, &repin)
            return try Ax.audit(w)
        case "app":
            return try Apps.run(a, t)
        case "deeplink":
            // Opening a URL needs the owner's input consent but no Accessibility.
            let w = try prep(t, .read, &repin)
            if !(t?.allowInput ?? false) { throw HelperError("refused", "Input is not enabled for this run.") }
            return try Apps.deeplink(w, a, t!)
        case "window":
            let state = (a.str("action") ?? "state") == "state"
            let w = try prep(t, state ? .read : .input, &repin)
            return try Wn.window(w, a, t!, ag)
        case "wait":
            let w = try prep(t, .read, &repin)
            return try wait(w, a, ag)
        case "click", "type", "key", "scroll", "drag", "hover", "mouse":
            let w = try prep(t, .input, &repin)
            return try inputVerb(verb, w, a, ag, t!)
        default:
            throw HelperError("unsupported", "Unknown verb '\(verb)'.")
        }
    }

    // ---- wait ----

    static func wait(_ w: Win, _ a: JSON, _ ag: Agent) throws -> JSON {
        let start = nowMs()
        let ms = max(0, min(10_000, a.int("ms", 0)))
        guard let until = a.str("until") else {
            sleepMs(ms)
            return ["satisfied": true, "waitedMs": nowMs() - start]
        }
        let timeout = max(100, min(10_000, a.int("timeoutMs", 5000)))
        var ok = false
        var base: [UInt8] = []
        if until == "stable" || until == "change" { base = try Cap.hash(w) }
        var stableSince = nowMs()
        let text = a.str("text")
        if until == "text" || until == "gone" { try Ax.trusted() }
        while nowMs() - start < timeout {
            switch until {
            case "stable":
                let cur = try Cap.hash(w)
                if Cap.different(base, cur) {
                    base = cur
                    stableSince = nowMs()
                } else if nowMs() - stableSince >= 300 {
                    ok = true
                }
                if !ok { sleepMs(60) }
            case "change":
                if Cap.different(base, try Cap.hash(w)) { ok = true } else { sleepMs(80) }
            case "text":
                let r = try Ax.snapshot(w, ["maxNodes": 600], ag, register: false)
                if let text, ((r["tree"] as? String) ?? "").range(of: text, options: .caseInsensitive) != nil { ok = true } else { sleepMs(250) }
            case "gone":
                if let er = a.str("element"), er.hasPrefix("@d"), let n = Int(er.dropFirst(2)), let node = ag.refs[n], Ax.alive(node) {
                    sleepMs(150)
                } else {
                    ok = true
                }
            default:
                throw HelperError("failed", "Unknown wait condition.")
            }
            if ok { break }
        }
        return ["satisfied": ok, "waitedMs": nowMs() - start]
    }
}
