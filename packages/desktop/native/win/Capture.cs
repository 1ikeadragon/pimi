using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Threading;

namespace PimiDesktopHelper
{
    class Shot : IDisposable
    {
        public void Dispose() { if (Bmp != null) Bmp.Dispose(); Bmp = null; }
        public Bitmap Bmp;           // native resolution canvas
        public RECT Canvas;          // screen rect of the canvas
        public RECT Frame;           // screen rect of the pinned window
        public string Method;
        public bool Suspect;
    }

    static class Cap
    {
        static readonly Dictionary<IntPtr, string> methods = new Dictionary<IntPtr, string>();
        public static string LastWgcError;
        public static string Forced;

        public static Bitmap PrintWin(IntPtr h, RECT frame)
        {
            var wr = N.WinRect(h);
            if (wr.W <= 0 || wr.H <= 0) return null;
            var bmp = new Bitmap(wr.W, wr.H, PixelFormat.Format32bppRgb);
            bool ok;
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Black);
                IntPtr hdc = g.GetHdc();
                try { ok = N.PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); }
            }
            if (!ok) { bmp.Dispose(); return null; }
            return CropTo(bmp, new Rectangle(frame.Left - wr.Left, frame.Top - wr.Top, frame.W, frame.H));
        }

        static Bitmap CropTo(Bitmap src, Rectangle r)
        {
            r.Intersect(new Rectangle(0, 0, src.Width, src.Height));
            if (r.Width <= 0 || r.Height <= 0) { src.Dispose(); return null; }
            if (r.Width == src.Width && r.Height == src.Height) return src;
            var c = src.Clone(r, PixelFormat.Format32bppRgb);
            src.Dispose();
            return c;
        }

        public static Bitmap Screen(RECT frame)
        {
            var bmp = new Bitmap(frame.W, frame.H, PixelFormat.Format32bppRgb);
            using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(frame.Left, frame.Top, 0, 0, new Size(frame.W, frame.H), CopyPixelOperation.SourceCopy);
            return bmp;
        }

        static bool Uncovered(Win w, RECT frame)
        {
            if (!Wn.IsMember(w, N.GetForegroundWindow())) return false;
            for (int i = 0; i < 3; i++)
                for (int j = 0; j < 3; j++)
                {
                    int x = frame.Left + (int)((i + 0.5) * frame.W / 3), y = frame.Top + (int)((j + 0.5) * frame.H / 3);
                    IntPtr h = N.WindowFromPoint(new POINT(x, y));
                    if (h == IntPtr.Zero || !Wn.IsMember(w, h)) return false;
                }
            return true;
        }

        // 64x64 luma samples
        public static byte[] Samples(Bitmap b)
        {
            var res = new byte[64 * 64];
            var data = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                unsafe
                {
                    byte* p0 = (byte*)data.Scan0;
                    for (int j = 0; j < 64; j++)
                        for (int i = 0; i < 64; i++)
                        {
                            int x = Math.Min(b.Width - 1, (int)((i + 0.5) * b.Width / 64)), y = Math.Min(b.Height - 1, (int)((j + 0.5) * b.Height / 64));
                            byte* px = p0 + y * data.Stride + x * 4;
                            res[j * 64 + i] = (byte)((px[2] * 299 + px[1] * 587 + px[0] * 114) / 1000);
                        }
                }
            }
            finally { b.UnlockBits(data); }
            return res;
        }

        public static bool Blank(byte[] s, Bitmap b)
        {
            int dark = s.Count(v => v < 8);
            if (dark >= s.Length * 0.995) return true;
            if (s.Max() - s.Min() <= 2) return true;
            return false;
        }

        public static bool Different(byte[] a, byte[] b)
        {
            if (a == null || b == null) return true;
            int diff = 0;
            for (int i = 0; i < a.Length; i++) if (Math.Abs(a[i] - b[i]) > 6) diff++;
            return diff >= 2;
        }

        static Bitmap Try(string m, Win w, RECT frame, ref bool apiFail)
        {
            try
            {
                Bitmap b = null;
                if (m == "wgc") { b = Wgc.Capture(w.Hwnd, frame); if (b == null) apiFail = true; }
                else if (m == "printwindow") b = PrintWin(w.Hwnd, frame);
                else if (m == "screen") { if (Uncovered(w, frame)) b = Screen(frame); }
                return b;
            }
            catch (Exception ex) { if (m == "wgc") LastWgcError = ex.GetType().Name + ": " + ex.Message; apiFail = true; return null; }
        }

        public static Shot Grab(Win w, bool popups)
        {
            var frame = N.FrameRect(w.Hwnd);
            if (frame.Empty) throw new HelperError("failed", "The window has no size.");
            string cached;
            methods.TryGetValue(w.Hwnd, out cached);
            var order = new List<string>();
            bool game = w.Framework == "unity" || w.Framework == "unreal" || w.Framework == "sdl";
            if (cached != null) order.Add(cached);
            var def = game ? new[] { "screen", "wgc", "printwindow" } : new[] { "wgc", "printwindow", "screen" };
            foreach (var m in def) if (!order.Contains(m)) order.Add(m);
            if (Forced != null) { order.Clear(); order.Add(Forced); }

            Bitmap best = null; string bestMethod = null; bool apiFailAny = false;
            foreach (var m in order)
            {
                bool apiFail = false;
                var b = Try(m, w, frame, ref apiFail);
                if (apiFail) apiFailAny = true;
                if (b == null) continue;
                var s = Samples(b);
                bool bad = Blank(s, b);
                if (!bad && m == "printwindow" && game && !apiFailAny)
                {
                    // PrintWindow on games can return one stale frame forever
                    Thread.Sleep(120);
                    var b2 = Try(m, w, frame, ref apiFail);
                    if (b2 != null) { bool same = !Different(s, Samples(b2)); b2.Dispose(); if (same && order.IndexOf(m) < order.Count - 1) { if (best == null) { best = b; bestMethod = m; } else b.Dispose(); continue; } }
                }
                if (!bad)
                {
                    if (best != null && best != b) best.Dispose();
                    methods[w.Hwnd] = m;
                    return Finish(w, b, frame, m, false, popups);
                }
                if (best != null) best.Dispose();
                best = b; bestMethod = m;
            }
            if (best == null) throw new HelperError("failed", "No capture method could read this window.");
            return Finish(w, best, frame, bestMethod, true, popups);
        }

        static Shot Finish(Win w, Bitmap main, RECT frame, string method, bool suspect, bool popups)
        {
            var shot = new Shot { Frame = frame, Canvas = frame, Method = method, Suspect = suspect, Bmp = main };
            if (!popups) return shot;
            var fam = Wn.Family(w);
            if (fam.Count == 0) return shot;
            var union = frame;
            var rects = new List<Tuple<IntPtr, RECT>>();
            foreach (var h in fam)
            {
                var r = N.FrameRect(h);
                rects.Add(Tuple.Create(h, r));
                union.Left = Math.Min(union.Left, r.Left); union.Top = Math.Min(union.Top, r.Top);
                union.Right = Math.Max(union.Right, r.Right); union.Bottom = Math.Max(union.Bottom, r.Bottom);
            }
            // keep the canvas sane
            if (union.W > frame.W + 1200 || union.H > frame.H + 1200) return shot;
            var canvas = new Bitmap(union.W, union.H, PixelFormat.Format32bppRgb);
            using (var g = Graphics.FromImage(canvas))
            {
                g.Clear(Color.Black);
                g.DrawImageUnscaled(main, frame.Left - union.Left, frame.Top - union.Top);
                // fam is in z-order top to bottom; draw bottom first
                for (int i = rects.Count - 1; i >= 0; i--)
                {
                    try
                    {
                        var pb = PrintWin(rects[i].Item1, rects[i].Item2);
                        if (pb != null) { g.DrawImageUnscaled(pb, rects[i].Item2.Left - union.Left, rects[i].Item2.Top - union.Top); pb.Dispose(); }
                    }
                    catch { }
                }
            }
            main.Dispose();
            shot.Bmp = canvas; shot.Canvas = union;
            return shot;
        }

        public static byte[] Hash(Win w)
        {
            var frame = N.FrameRect(w.Hwnd);
            string cached; methods.TryGetValue(w.Hwnd, out cached);
            using (var s = Grab(w, true)) { return Samples(s.Bmp); }
        }

        public static byte[] Png(Bitmap b)
        {
            using (var ms = new MemoryStream()) { b.Save(ms, ImageFormat.Png); return ms.ToArray(); }
        }

        public static Bitmap Scale(Bitmap src, double scale)
        {
            if (scale >= 0.999) return src;
            int w = Math.Max(1, (int)Math.Round(src.Width * scale)), h = Math.Max(1, (int)Math.Round(src.Height * scale));
            var dst = new Bitmap(w, h, PixelFormat.Format32bppRgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(src, new Rectangle(0, 0, w, h), new Rectangle(0, 0, src.Width, src.Height), GraphicsUnit.Pixel);
            }
            src.Dispose();
            return dst;
        }
    }
}


