import CoreGraphics
import CoreText
import Foundation

// Drawing on screenshots: numbered boxes over the interactive elements of a snapshot ("marks") and
// a 100 px grid. Both draw on a copy of the image with CoreGraphics; the numbers are the @dN refs
// the agent can click or type into.

enum Marks {
    private static let palette: [(CGFloat, CGFloat, CGFloat)] = [
        (230, 25, 75), (60, 180, 75), (0, 130, 200), (245, 130, 48), (145, 30, 180), (0, 150, 150), (200, 30, 200),
        (128, 100, 0),
    ]

    private static func color(for role: String) -> (CGFloat, CGFloat, CGFloat) {
        switch role {
        case "button", "menubutton", "popupbutton", "disclosuretriangle": return palette[0]
        case "textfield", "textarea", "searchfield", "combobox": return palette[1]
        case "checkbox", "radiobutton", "switch": return palette[2]
        case "slider", "incrementor", "colorwell": return palette[3]
        case "link": return palette[4]
        case "tab", "segmentedcontrol": return palette[5]
        case "menuitem", "menubaritem": return palette[6]
        default: return palette[7]
        }
    }

    private static func context(for image: CGImage) -> CGContext? {
        let ctx = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        ctx?.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return ctx
    }

    private static func line(_ text: String, size: CGFloat, color: CGColor) -> CTLine {
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
        let attrs: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        ]
        return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
    }

    /// Draws a box and a tag for each interactive element on a native-resolution image. `px` is image
    /// pixels per point and (originX, originY) the image's top left in global points. `plannedScale`
    /// is the scale the image will end up at, so tags stay legible after downscaling. Returns the
    /// image and the legend ("12 button \"Save\"" per line).
    static func draw(
        _ image: CGImage, nodes: [Node], px: Double, originX: Double, originY: Double, plannedScale: Double
    ) -> (CGImage, String) {
        guard let ctx = context(for: image) else { return (image, "") }
        let w = CGFloat(image.width), h = CGFloat(image.height)
        let fontPx = CGFloat(max(11, min(40, 13 / max(plannedScale, 0.05))))
        let pen = CGFloat(max(2, (2 / max(plannedScale, 0.05)).rounded()))
        ctx.setShouldAntialias(true)
        var used: [CGRect] = []  // tags, in top-left pixel space
        var legend: [String] = []
        for n in nodes where n.ref > 0 && n.interactive {
            let x = (n.rect.minX - CGFloat(originX)) * CGFloat(px), y = (n.rect.minY - CGFloat(originY)) * CGFloat(px)
            let box = CGRect(x: x, y: y, width: n.rect.width * CGFloat(px), height: n.rect.height * CGFloat(px))
            if box.maxX < 0 || box.maxY < 0 || box.minX > w || box.minY > h { continue }
            let c = color(for: n.role)
            let col = CGColor(red: c.0 / 255, green: c.1 / 255, blue: c.2 / 255, alpha: 1)
            // CoreGraphics draws with the origin at the bottom left.
            func flip(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height) }
            ctx.setStrokeColor(col)
            ctx.setLineWidth(pen)
            ctx.stroke(flip(box).insetBy(dx: pen / 2, dy: pen / 2))
            let label = line(String(n.ref), size: fontPx, color: CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            let bounds = CTLineGetBoundsWithOptions(label, [])
            let tw = bounds.width + 4, th = fontPx * 1.2
            var tag = CGRect(x: max(0, min(w - tw, box.minX)), y: max(0, box.minY), width: tw, height: th)
            for _ in 0..<6 {
                guard let u = used.first(where: { $0.intersects(tag) }) else { break }
                tag.origin.y = u.maxY
            }
            if tag.maxY > h { tag.origin.y = max(0, h - th) }
            used.append(tag)
            ctx.setFillColor(col)
            ctx.fill(flip(tag))
            ctx.textPosition = CGPoint(x: tag.minX + 2, y: h - tag.maxY + fontPx * 0.28)
            CTLineDraw(label, ctx)
            var entry = "\(n.ref) \(n.role)"
            if !n.name.isEmpty {
                let name = n.name.count > 60 ? String(n.name.prefix(60)) : n.name
                entry += " \"" + name.replacingOccurrences(of: "\"", with: "'").replacingOccurrences(of: "\n", with: " ") + "\""
            }
            legend.append(entry)
        }
        return (ctx.makeImage() ?? image, legend.joined(separator: "\n"))
    }

    /// Magenta lines every 100 pixels, labelled with the pixel coordinate.
    static func grid(_ image: CGImage) -> CGImage {
        guard let ctx = context(for: image) else { return image }
        let w = image.width, h = image.height
        let magenta = CGColor(red: 1, green: 0, blue: 1, alpha: 1)
        ctx.setStrokeColor(CGColor(red: 1, green: 0, blue: 1, alpha: 0.6))
        ctx.setLineWidth(1)
        ctx.setShouldAntialias(false)
        var x = 100
        while x < w {
            ctx.move(to: CGPoint(x: CGFloat(x) + 0.5, y: 0))
            ctx.addLine(to: CGPoint(x: CGFloat(x) + 0.5, y: CGFloat(h)))
            x += 100
        }
        var y = 100
        while y < h {
            ctx.move(to: CGPoint(x: 0, y: CGFloat(h - y) - 0.5))
            ctx.addLine(to: CGPoint(x: CGFloat(w), y: CGFloat(h - y) - 0.5))
            y += 100
        }
        ctx.strokePath()
        ctx.setShouldAntialias(true)
        x = 100
        while x < w {
            ctx.textPosition = CGPoint(x: CGFloat(x + 2), y: CGFloat(h) - 11)
            CTLineDraw(line(String(x), size: 11, color: magenta), ctx)
            x += 100
        }
        y = 100
        while y < h {
            ctx.textPosition = CGPoint(x: 2, y: CGFloat(h - y) - 11)
            CTLineDraw(line(String(y), size: 11, color: magenta), ctx)
            y += 100
        }
        return ctx.makeImage() ?? image
    }
}
