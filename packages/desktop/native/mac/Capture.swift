import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

// Window capture. On macOS 14+ ScreenCaptureKit captures the target window together with the
// same-app surfaces that belong to it (menus, popovers, sheets), even when other apps' windows cover
// it; older systems, and any ScreenCaptureKit failure, fall back to `screencapture -l <window id>`.
// Both need Screen Recording for the process that spawned the helper (Pimi). The helper decodes,
// scales and draws with ImageIO and CoreGraphics and answers base64 PNG.

struct Shot {
    let image: CGImage
    let method: String
    let suspectBlank: Bool
}

enum Cap {
    /// `forced` ("sck" or "screencapture") pins the method; the default tries ScreenCaptureKit first.
    static func grab(_ w: Win, forced: String? = nil) throws -> Shot {
        if forced != "screencapture", #available(macOS 14.0, *) {
            do {
                let image = try sck(w)
                return Shot(image: image, method: "sck", suspectBlank: isBlank(image))
            } catch let e as HelperError where forced == "sck" || e.code == "permission_missing" || e.code == "window_gone" {
                throw e
            } catch {
                if forced == "sck" { throw HelperError("failed", "ScreenCaptureKit could not capture the window.") }
            }
        } else if forced == "sck" {
            throw HelperError("failed", "ScreenCaptureKit window capture needs macOS 14 or later.")
        }
        return try cli(w)
    }

    @available(macOS 14.0, *)
    private static func sck(_ w: Win) throws -> CGImage {
        let frame = try Wn.frame(w)
        let content: SCShareableContent = try waitFor { done in
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, e in done(c, e) }
        }
        guard content.windows.contains(where: { $0.windowID == w.number }) else {
            throw HelperError("failed", "ScreenCaptureKit does not list the window.")
        }
        let centre = CGPoint(x: frame.midX, y: frame.midY)
        guard let display = content.displays.first(where: { $0.frame.contains(centre) }),
            display.frame.insetBy(dx: -2, dy: -2).contains(frame)
        else { throw HelperError("failed", "The window is not within one display.") }
        // The window and the surfaces of the same app that sit on it: menus and popovers (other
        // layers), sheets (inside the window's frame). Other windows of the app stay out.
        let family = content.windows.filter { c in
            if c.windowID == w.number { return true }
            guard c.owningApplication?.processID == w.pid, c.isOnScreen, c.frame.intersects(frame) else { return false }
            return c.windowLayer != 0 || frame.insetBy(dx: -3, dy: -3).contains(c.frame)
        }
        let filter = SCContentFilter(display: display, including: family)
        let config = SCStreamConfiguration()
        let backing = Wn.backingScale(of: frame)
        config.sourceRect = CGRect(
            x: frame.minX - display.frame.minX, y: frame.minY - display.frame.minY, width: frame.width, height: frame.height)
        config.width = max(1, Int((frame.width * backing).rounded()))
        config.height = max(1, Int((frame.height * backing).rounded()))
        config.showsCursor = false
        config.scalesToFit = true
        return try waitFor { done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in done(image, error) }
        }
    }

    /// Blocks the helper's request thread on a ScreenCaptureKit completion handler (4 s limit).
    private static func waitFor<T>(_ start: (@escaping (T?, Error?) -> Void) -> Void) throws -> T {
        let sem = DispatchSemaphore(value: 0)
        var value: T?
        var failure: Error?
        start { v, e in
            value = v
            failure = e
            sem.signal()
        }
        if sem.wait(timeout: .now() + 4) == .timedOut { throw HelperError("failed", "ScreenCaptureKit did not answer in time.") }
        if let value { return value }
        let ns = failure as NSError?
        if ns?.domain == SCStreamErrorDomain, ns?.code == SCStreamError.userDeclined.rawValue {
            throw HelperError("permission_missing", "Pimi does not have Screen Recording access.")
        }
        throw HelperError("failed", "ScreenCaptureKit failed.")
    }

    private static func cli(_ w: Win) throws -> Shot {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pimi-desktop-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("window.png")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        proc.arguments = ["-l", String(w.number), "-x", "-o", "-t", "png", file.path]
        let errPipe = Pipe()
        proc.standardError = errPipe
        proc.standardOutput = FileHandle.nullDevice
        do { try proc.run() } catch { throw HelperError("failed", "screencapture could not start.") }
        let deadline = nowMs() + 5000
        while proc.isRunning && nowMs() < deadline { sleepMs(5) }
        if proc.isRunning {
            proc.terminate()
            throw HelperError("failed", "screencapture did not finish in time.")
        }
        guard FileManager.default.fileExists(atPath: file.path),
            let src = CGImageSourceCreateWithURL(file as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
        else {
            throw HelperError("failed", "The window could not be captured. It may be on another Space or not on screen.")
        }
        return Shot(image: image, method: "screencapture", suspectBlank: isBlank(image))
    }

    private static func rgbContext(width: Int, height: Int) -> CGContext? {
        CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    }

    static func scaled(_ image: CGImage, to size: (Int, Int)) -> CGImage? {
        if size.0 == image.width && size.1 == image.height { return image }
        guard let ctx = rgbContext(width: size.0, height: size.1) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: size.0, height: size.1))
        return ctx.makeImage()
    }

    static func png(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw HelperError("failed", "PNG encoding is unavailable.")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw HelperError("failed", "PNG encoding failed.") }
        return data as Data
    }

    /// 256x160 luma samples, enough to see a character typed or a control change.
    static func samples(_ image: CGImage) -> [UInt8] {
        let w = 256, h = 160
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return [] }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let data = ctx.data else { return [] }
        return Array(UnsafeBufferPointer(start: data.bindMemory(to: UInt8.self, capacity: w * h), count: w * h))
    }

    /// Every sample dark or every sample the same: the capture returned nothing real.
    static func isBlank(_ image: CGImage) -> Bool {
        let s = samples(image)
        guard let lo = s.min(), let hi = s.max() else { return true }
        return hi < 12 || Int(hi) - Int(lo) < 3
    }

    static func hash(_ w: Win) throws -> [UInt8] {
        samples(try grab(w).image)
    }

    static func different(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        if a.count != b.count || a.isEmpty { return true }
        var over = 0
        for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > 10 {
            over += 1
            if over >= 3 { return true }
        }
        return false
    }
}

extension Main {
    /// The whole window, or a native-resolution crop of it (`region`, in pixels of the agent's last
    /// screenshot), with marks or a grid drawn on, scaled so the longer edge is at most maxEdge.
    static func screenshot(_ w: Win, _ a: JSON, _ ag: Agent, _ t: Target) throws -> JSON {
        let maxEdge = max(256, min(1920, a.int("maxEdge", 1280)))
        if !w.info.onScreen {
            if Ax.isMinimized(w) {
                if !t.allowInput { throw HelperError("window_minimized", "The window is minimized. Ask the owner to restore it.") }
                Ax.setMinimized(w, false)
                sleepMs(450)
            } else {
                throw HelperError("failed", "The target window is not on screen (hidden or on another Space).")
            }
        }
        let wantMarks = a.bool("marks", false), wantGrid = a.bool("grid", false)
        if wantMarks {
            try Ax.trusted()
            if !Ax.responding(w.pid) { throw HelperError("target_hung", "The target window is not responding.") }
        }
        let frame = try Wn.frame(w)
        let shot = try Cap.grab(w, forced: a.str("method"))
        var img = shot.image
        var legend: String?
        // Image pixels per point at native resolution.
        let native = Double(img.width) / Double(max(frame.width, 1))
        var ox = 0.0, oy = 0.0
        let planned = min(1.0, Double(maxEdge) / Double(max(img.width, img.height)))
        let region = a.obj("region")
        if wantMarks {
            _ = try Ax.snapshot(w, [:], ag, register: true, interactiveOverride: true)
            let marked = ag.refs.values.sorted { $0.ref < $1.ref }
            (img, legend) = Marks.draw(
                img, nodes: marked, px: native, originX: Double(frame.minX), originY: Double(frame.minY),
                plannedScale: region != nil ? 1.0 : planned)
        }
        if let region {
            // The region is in pixels of the agent's last screenshot (or of a default one).
            let m = Ax.mapping(ag, frame)
            let pts = CGRect(
                x: m.ox + region.dbl("x") / m.scale, y: m.oy + region.dbl("y") / m.scale,
                width: region.dbl("width") / m.scale, height: region.dbl("height") / m.scale)
            let crop = CGRect(x: pts.minX * native, y: pts.minY * native, width: pts.width * native, height: pts.height * native)
                .integral.intersection(CGRect(x: 0, y: 0, width: img.width, height: img.height))
            guard !crop.isNull, crop.width >= 1, crop.height >= 1, let cut = img.cropping(to: crop) else {
                throw HelperError("failed", "The region is outside the window.")
            }
            img = cut
            ox = Double(crop.minX) / native
            oy = Double(crop.minY) / native
        }
        let s = min(1.0, Double(maxEdge) / Double(max(img.width, img.height)))
        let outW = max(1, Int((Double(img.width) * s).rounded())), outH = max(1, Int((Double(img.height) * s).rounded()))
        guard var out = Cap.scaled(img, to: (outW, outH)) else {
            throw HelperError("failed", "The screenshot could not be scaled.")
        }
        if wantGrid { out = Marks.grid(out) }
        let scale = native * s
        ag.frame = FrameInfo(scale: scale, originX: ox, originY: oy)
        let data = try Cap.png(out)
        var res: JSON = [
            "mimeType": "image/png", "dataBase64": data.base64EncodedString(), "width": outW, "height": outH,
            "scale": scale, "origin": ["x": ox, "y": oy], "windowWidth": frame.width, "windowHeight": frame.height,
            "dpi": 72 * Wn.backingScale(of: frame), "method": shot.method, "suspectBlank": shot.suspectBlank,
        ]
        if let legend { res["legend"] = legend }
        return res
    }
}
