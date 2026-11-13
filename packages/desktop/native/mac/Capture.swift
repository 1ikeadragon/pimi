import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Window capture. `screencapture -l <window id>` reads one window by its window-server id even when
// other windows cover it; it needs Screen Recording for the process that spawned it (Pimi). The
// helper decodes the PNG with ImageIO, scales with CoreGraphics and answers base64 PNG.

struct Shot {
    let image: CGImage
    let method: String
    let suspectBlank: Bool
}

enum Cap {
    static func grab(_ w: Win) throws -> Shot {
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
    /// Chunk 1 screenshot: the whole window, scaled so the longer edge is at most maxEdge.
    static func screenshot(_ w: Win, _ a: JSON, _ ag: Agent, _ t: Target) throws -> JSON {
        let maxEdge = max(256, min(1920, a.int("maxEdge", 1280)))
        if !w.info.onScreen {
            throw HelperError("failed", "The target window is not on screen (minimized, hidden or on another Space).")
        }
        let frame = try Wn.frame(w)
        let shot = try Cap.grab(w)
        let rawW = shot.image.width, rawH = shot.image.height
        let s = min(1.0, Double(maxEdge) / Double(max(rawW, rawH)))
        let outW = max(1, Int((Double(rawW) * s).rounded())), outH = max(1, Int((Double(rawH) * s).rounded()))
        guard let out = Cap.scaled(shot.image, to: (outW, outH)) else {
            throw HelperError("failed", "The screenshot could not be scaled.")
        }
        let scale = Double(outW) / Double(max(frame.width, 1))
        ag.frame = FrameInfo(scale: scale, originX: 0, originY: 0)
        let data = try Cap.png(out)
        return [
            "mimeType": "image/png", "dataBase64": data.base64EncodedString(), "width": outW, "height": outH,
            "scale": scale, "origin": ["x": 0, "y": 0], "windowWidth": frame.width, "windowHeight": frame.height,
            "dpi": 72 * Wn.backingScale(of: frame), "method": shot.method, "suspectBlank": shot.suspectBlank,
        ]
    }
}
