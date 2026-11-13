using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Interop.UIAutomationClient;

namespace PimiDesktopHelper
{
    struct K { public ushort Vk, Scan; public bool Ext; }

    static class In
    {
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

        static readonly object lk = new object();
        public static int LastInject;
        static readonly List<K> heldKeys = new List<K>();
        static readonly List<uint> heldButtons = new List<uint>();
        static Win heldWin;
        static int heldSince;
        static Timer timer;

        public static void Init()
        {
            timer = new Timer(_ =>
            {
                try
                {
                    lock (lk)
                    {
                        if (heldKeys.Count == 0 && heldButtons.Count == 0) return;
                        bool lost = heldWin == null || !Wn.IsMember(heldWin, N.GetForegroundWindow());
                        if (lost || Environment.TickCount - heldSince > 5000) ReleaseAllLocked();
                    }
                }
                catch { }
            }, null, 200, 200);
        }

        // ---- raw send ----
        static void Send(IEnumerable<INPUT> inputs)
        {
            var arr = inputs.ToArray();
            if (arr.Length == 0) return;
            N.SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
            LastInject = Environment.TickCount;
        }

        static INPUT Mouse(uint flags, int dx = 0, int dy = 0, uint data = 0)
        {
            var i = new INPUT { type = 0 };
            i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags };
            return i;
        }

        static INPUT Key(K k, bool up)
        {
            var i = new INPUT { type = 1 };
            i.u.ki = new KEYBDINPUT { wVk = 0, wScan = k.Scan, dwFlags = 0x8 | (up ? 0x2u : 0) | (k.Ext ? 0x1u : 0) };
            return i;
        }

        static INPUT Uni(ushort unit, bool up)
        {
            var i = new INPUT { type = 1 };
            i.u.ki = new KEYBDINPUT { wVk = 0, wScan = unit, dwFlags = 0x4 | (up ? 0x2u : 0) };
            return i;
        }

        static INPUT Abs(int x, int y)
        {
            int vx = N.GetSystemMetrics(76), vy = N.GetSystemMetrics(77), vw = N.GetSystemMetrics(78), vh = N.GetSystemMetrics(79);
            int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
            int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
            return Mouse(0x1 | 0x8000 | 0x4000, nx, ny);
        }

        static uint BtnDown(string b) { return b == "right" ? 0x8u : b == "middle" ? 0x20u : 0x2u; }
        static uint BtnUp(string b) { return b == "right" ? 0x10u : b == "middle" ? 0x40u : 0x4u; }

        // ---- gate ----
        public static void CheckDesktop()
        {
            IntPtr d = N.OpenInputDesktop(0, false, 0x100);
            if (d == IntPtr.Zero) throw new HelperError("secure_desktop", "A secure desktop (UAC prompt, lock screen) is showing; nothing is sent.");
            try
            {
                var sb = new StringBuilder(64); int need;
                if (N.GetUserObjectInformation(d, 2, sb, 128, out need) && !sb.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase))
                    throw new HelperError("secure_desktop", "A secure desktop is showing; nothing is sent.");
            }
            finally { N.CloseDesktop(d); }
        }

        public static void CheckUserActive()
        {
            var li = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
            if (!N.GetLastInputInfo(ref li)) return;
            int now = Environment.TickCount;
            int since = unchecked(now - (int)li.dwTime);
            int ahead = unchecked((int)li.dwTime - LastInject);
            if (since >= 0 && since < 1500 && (LastInject == 0 || ahead > 50))
                throw new HelperError("user_active", "The owner is using the mouse or keyboard right now. Try again in a moment.");
        }

        static bool FgOk(Win w) { return Wn.IsMember(w, N.GetForegroundWindow()); }

        static bool Poll(Win w, int ms)
        {
            var end = Environment.TickCount + ms;
            do { if (FgOk(w)) return true; Thread.Sleep(15); } while (unchecked(end - Environment.TickCount) > 0);
            return FgOk(w);
        }

        public static void EnsureForeground(Win w)
        {
            if (FgOk(w)) return;
            if (!N.IsWindow(w.Hwnd)) throw new HelperError("window_gone", "The target window is gone.");
            if (N.IsIconic(w.Hwnd)) N.ShowWindow(w.Hwnd, N.SW_RESTORE);
            N.SetForegroundWindow(w.Hwnd);
            if (Poll(w, 80)) return;
            Send(new[] { Mouse(0x1, 0, 0) });
            N.SetForegroundWindow(w.Hwnd);
            if (Poll(w, 80)) return;
            IntPtr fg = N.GetForegroundWindow();
            if (fg != IntPtr.Zero && !N.IsHungAppWindow(fg))
            {
                uint ft = N.Tid(fg), me = GetCurrentThreadId();
                bool at = N.AttachThreadInput(me, ft, true);
                try { N.BringWindowToTop(w.Hwnd); N.SetForegroundWindow(w.Hwnd); }
                finally { if (at) N.AttachThreadInput(me, ft, false); }
            }
            if (Poll(w, 300)) return;
            string fgExe = Wn.ExeOfWindow(N.GetForegroundWindow());
            throw new HelperError("foreground_denied", "Windows would not let the helper bring the target window to the foreground" + (fgExe != null ? " (the foreground window belongs to " + fgExe + ")" : "") + ".");
        }

        public static void Gate(Win w)
        {
            CheckDesktop();
            CheckUserActive();
            EnsureForeground(w);
        }

        public static string FocusLeft(Win w)
        {
            IntPtr fg = N.GetForegroundWindow();
            if (fg == IntPtr.Zero || Wn.IsMember(w, fg)) return null;
            return Wn.ExeOfWindow(fg);
        }

        // ---- coordinates ----
        public static POINT MapPoint(Win w, Agent ag, double x, double y)
        {
            var fr = N.FrameRect(w.Hwnd);
            double scale = ag.Frame != null ? ag.Frame.Scale : U.DefaultScale(fr);
            int ox = ag.Frame != null ? ag.Frame.OriginX : 0, oy = ag.Frame != null ? ag.Frame.OriginY : 0;
            return new POINT((int)Math.Round(fr.Left + ox + x / scale), (int)Math.Round(fr.Top + oy + y / scale));
        }

        public static void HitTest(Win w, POINT p)
        {
            int vx = N.GetSystemMetrics(76), vy = N.GetSystemMetrics(77), vw = N.GetSystemMetrics(78), vh = N.GetSystemMetrics(79);
            if (p.X < vx || p.Y < vy || p.X >= vx + vw || p.Y >= vy + vh)
                throw new HelperError("refused", "That point is off the screen. Run window fit first.");
            for (int attempt = 0; attempt < 2; attempt++)
            {
                IntPtr h = N.WindowFromPoint(p);
                IntPtr root = h == IntPtr.Zero ? IntPtr.Zero : N.Root(h);
                if (root != IntPtr.Zero && Wn.IsMember(w, root) && N.FrameRect(root).Contains(p.X, p.Y)) return;
                if (attempt == 0) { EnsureForeground(w); Thread.Sleep(40); continue; }
                string exe = Wn.ExeOfWindow(h);
                throw new HelperError("occluded", "Another window" + (exe != null ? " (" + exe + ")" : "") + " covers that point. Nothing was sent.");
            }
        }

        static void MoveTo(POINT p)
        {
            Send(new[] { Abs(p.X, p.Y) });
            POINT c;
            N.GetCursorPos(out c);
            if (Math.Abs(c.X - p.X) > 1 || Math.Abs(c.Y - p.Y) > 1) N.SetCursorPos(p.X, p.Y);
        }

        static void Mods(IEnumerable<string> mods, bool up, List<K> held)
        {
            foreach (var m in mods)
            {
                K k = Keys.Mod(m);
                Send(new[] { Key(k, up) });
                if (!up) { lock (lk) { heldKeys.Add(k); } held.Add(k); }
            }
        }

        static void Register(Win w) { lock (lk) { heldWin = w; heldSince = Environment.TickCount; } }

        public static void ReleaseAll()
        {
            lock (lk) { ReleaseAllLocked(); }
        }

        static void ReleaseAllLocked()
        {
            var ins = new List<INPUT>();
            foreach (var b in heldButtons) ins.Add(Mouse(b));
            for (int i = heldKeys.Count - 1; i >= 0; i--) ins.Add(Key(heldKeys[i], true));
            heldButtons.Clear(); heldKeys.Clear();
            if (ins.Count > 0) { try { Send(ins); } catch { } }
        }

        // ---- verbs ----
        public static void ClickAt(Win w, POINT p, string button, int count, string[] mods)
        {
            Gate(w);
            MoveTo(p);
            HitTest(w, p);
            Register(w);
            var held = new List<K>();
            try
            {
                Mods(mods, false, held);
                var ins = new List<INPUT> { Abs(p.X, p.Y) };
                for (int i = 0; i < count; i++) { ins.Add(Mouse(BtnDown(button))); ins.Add(Mouse(BtnUp(button))); }
                Send(ins);
            }
            finally
            {
                Mods(mods.Reverse(), true, held);
                lock (lk) { foreach (var k in held) heldKeys.Remove(k); }
            }
        }

        public static bool PatternClick(Node n)
        {
            var e = n.El;
            try
            {
                if (n.Invoke)
                {
                    var t = Task.Run(() => { try { ((IUIAutomationInvokePattern)e.GetCurrentPattern(10000)).Invoke(); } catch { } });
                    t.Wait(500);
                    return true;
                }
                if (n.Toggle) { ((IUIAutomationTogglePattern)e.GetCurrentPattern(10015)).Toggle(); return true; }
                if (n.SelItem) { ((IUIAutomationSelectionItemPattern)e.GetCurrentPattern(10010)).Select(); return true; }
                if (n.Expand)
                {
                    var p = (IUIAutomationExpandCollapsePattern)e.GetCurrentPattern(10005);
                    if (n.ExpandState == 1) p.Collapse(); else p.Expand();
                    return true;
                }
            }
            catch { }
            return false;
        }

        public static POINT NodePoint(Node n, bool scroll)
        {
            RECT r = n.R;
            try
            {
                if (scroll && n.Offscreen && n.ScrollItem) { ((IUIAutomationScrollItemPattern)n.El.GetCurrentPattern(10017)).ScrollIntoView(); Thread.Sleep(100); }
                var b = n.El.CurrentBoundingRectangle;
                r = new RECT { Left = b.left, Top = b.top, Right = b.right, Bottom = b.bottom };
            }
            catch { }
            if (r.Empty) throw new HelperError("failed", "The element has no on-screen rectangle.");
            try
            {
                tagPOINT cp;
                int got = n.El.GetClickablePoint(out cp);
                if (got != 0 && r.Contains(cp.x, cp.y)) return new POINT(cp.x, cp.y);
            }
            catch { }
            return new POINT(r.Left + r.W / 2, r.Top + r.H / 2);
        }

        public static void Scroll(Win w, POINT p, int dx, int dy)
        {
            Gate(w);
            MoveTo(p);
            HitTest(w, p);
            Register(w);
            for (int i = 0; i < Math.Abs(dy); i++) { Send(new[] { Mouse(0x800, 0, 0, unchecked((uint)(dy > 0 ? -120 : 120))) }); Thread.Sleep(12); }
            for (int i = 0; i < Math.Abs(dx); i++) { Send(new[] { Mouse(0x1000, 0, 0, unchecked((uint)(dx > 0 ? 120 : -120))) }); Thread.Sleep(12); }
        }

        static IEnumerable<POINT> Path(POINT a, POINT b, int steps)
        {
            for (int i = 1; i <= steps; i++)
            {
                double t = (double)i / steps;
                t = t * t * (3 - 2 * t);
                yield return new POINT((int)Math.Round(a.X + (b.X - a.X) * t), (int)Math.Round(a.Y + (b.Y - a.Y) * t));
            }
        }

        public static void Hover(Win w, POINT p, int dwell)
        {
            Gate(w);
            POINT cur; N.GetCursorPos(out cur);
            var fr = N.FrameRect(w.Hwnd);
            POINT start = fr.Contains(cur.X, cur.Y) ? cur : new POINT(Math.Max(fr.Left + 1, Math.Min(fr.Right - 2, p.X - 40)), Math.Max(fr.Top + 1, Math.Min(fr.Bottom - 2, p.Y - 40)));
            if (start.X != cur.X || start.Y != cur.Y) { HitTest(w, start); MoveTo(start); }
            HitTest(w, p);
            foreach (var q in Path(start, p, 10)) { Send(new[] { Abs(q.X, q.Y) }); Thread.Sleep(15); }
            POINT c2; N.GetCursorPos(out c2);
            if (Math.Abs(c2.X - p.X) > 1 || Math.Abs(c2.Y - p.Y) > 1) N.SetCursorPos(p.X, p.Y);
            Thread.Sleep(dwell);
        }

        public static void Drag(Win w, POINT a, POINT b, string button, int durationMs, string[] mods)
        {
            Gate(w);
            var fr = N.FrameRect(w.Hwnd);
            if (!fr.Contains(a.X, a.Y) || !fr.Contains(b.X, b.Y)) throw new HelperError("refused", "Both ends of a drag must be inside the target window.");
            MoveTo(a); HitTest(w, a);
            HitTest(w, b);
            Register(w);
            var held = new List<K>();
            try
            {
                Mods(mods, false, held);
                Send(new[] { Mouse(BtnDown(button)) });
                lock (lk) { heldButtons.Add(BtnUp(button)); }
                int steps = Math.Max(6, Math.Min(60, durationMs / 16));
                int delay = Math.Max(4, durationMs / steps);
                int dxs = Math.Abs(b.X - a.X) + Math.Abs(b.Y - a.Y);
                if (dxs > 12) { Send(new[] { Abs(a.X + Math.Sign(b.X - a.X) * 6, a.Y + Math.Sign(b.Y - a.Y) * 6) }); Thread.Sleep(delay); }
                foreach (var q in Path(a, b, steps))
                {
                    var c = new POINT(Math.Max(fr.Left, Math.Min(fr.Right - 1, q.X)), Math.Max(fr.Top, Math.Min(fr.Bottom - 1, q.Y)));
                    if (!FgOk(w)) throw new HelperError("failed", "The target lost the foreground during the drag.");
                    Send(new[] { Abs(c.X, c.Y) });
                    Thread.Sleep(delay);
                }
                Send(new[] { Mouse(BtnUp(button)) });
                lock (lk) { heldButtons.Clear(); }
            }
            finally
            {
                ReleaseAllLocked2();
                Mods(mods.Reverse(), true, held);
                lock (lk) { foreach (var k in held) heldKeys.Remove(k); }
            }
        }

        static void ReleaseAllLocked2() { lock (lk) { if (heldButtons.Count > 0) ReleaseAllLocked(); } }

        public static void MouseButton(Win w, string action, string button)
        {
            if (action == "down")
            {
                Gate(w);
                POINT cur; N.GetCursorPos(out cur);
                HitTest(w, cur);
                Register(w);
                Send(new[] { Mouse(BtnDown(button)) });
                lock (lk) { heldButtons.Add(BtnUp(button)); }
            }
            else
            {
                Send(new[] { Mouse(BtnUp(button)) });
                lock (lk) { heldButtons.Remove(BtnUp(button)); }
            }
        }

        public static void MoveRel(Win w, int dx, int dy, int durationMs)
        {
            Gate(w);
            if (!FgOk(w)) throw new HelperError("foreground_denied", "The target is not the foreground window.");
            int steps = Math.Max(1, (int)Math.Ceiling(Math.Max(Math.Abs(dx), Math.Abs(dy)) / 40.0));
            int sx = 0, sy = 0;
            int delay = Math.Max(0, durationMs / steps);
            for (int i = 1; i <= steps; i++)
            {
                int tx = dx * i / steps, ty = dy * i / steps;
                if (!FgOk(w)) throw new HelperError("failed", "The target lost the foreground during the move.");
                Send(new[] { Mouse(0x1, tx - sx, ty - sy) });
                sx = tx; sy = ty;
                if (delay > 0) Thread.Sleep(delay); else Thread.Sleep(4);
            }
        }

        // ---- keyboard ----
        public static int TypeText(Win w, string text, string mode, Func<bool> keepGoing)
        {
            if (mode == "scancode") return TypeScan(w, text);
            Register(w);
            int sent = 0;
            for (int i = 0; i < text.Length; i++)
            {
                char ch = text[i];
                if (i % 20 == 0 && i > 0 && !FgOk(w))
                    throw new HelperError("failed", "The target lost the foreground after " + sent + " characters were sent.");
                if (ch == '\r') { if (i + 1 < text.Length && text[i + 1] == '\n') continue; ch = '\n'; }
                if (ch == '\n') { var k = Keys.Named("return"); Send(new[] { Key(k, false), Key(k, true) }); }
                else if (ch == '\t') { var k = Keys.Named("tab"); Send(new[] { Key(k, false), Key(k, true) }); }
                else Send(new[] { Uni(ch, false), Uni(ch, true) });
                sent++;
                Thread.Sleep(4);
            }
            return sent;
        }

        static int TypeScan(Win w, string text)
        {
            IntPtr layout = N.GetKeyboardLayout(w.Tid);
            var plan = new List<Tuple<K, int>>();
            foreach (char c0 in text)
            {
                char ch = c0 == '\r' ? '\n' : c0;
                if (ch == '\n') { plan.Add(Tuple.Create(Keys.Named("return"), 0)); continue; }
                if (ch == '\t') { plan.Add(Tuple.Create(Keys.Named("tab"), 0)); continue; }
                short r = N.VkKeyScanEx(ch, layout);
                if (r == -1) throw new HelperError("failed", "This keyboard layout cannot produce one of the characters in scancode mode. Nothing was sent.");
                int vk = r & 0xFF, st = (r >> 8) & 0xFF;
                if ((st & ~1) != 0) throw new HelperError("failed", "A character needs Ctrl or Alt on this layout and cannot be typed in scancode mode. Nothing was sent.");
                plan.Add(Tuple.Create(Keys.FromVk((ushort)vk, layout), st));
            }
            Register(w);
            K shift = Keys.Mod("shift");
            int sent = 0;
            foreach (var p in plan)
            {
                if (sent % 20 == 0 && sent > 0 && !FgOk(w)) throw new HelperError("failed", "The target lost the foreground after " + sent + " characters were sent.");
                if (p.Item2 == 1) Send(new[] { Key(shift, false), Key(p.Item1, false), Key(p.Item1, true), Key(shift, true) });
                else Send(new[] { Key(p.Item1, false), Key(p.Item1, true) });
                sent++;
                Thread.Sleep(6);
            }
            return sent;
        }

        public static void Chord(Win w, List<K> keys, int holdMs, int repeat, string action)
        {
            Register(w);
            if (action == "up")
            {
                Send(keys.AsEnumerable().Reverse().Select(k => Key(k, true)));
                lock (lk) { foreach (var k in keys) heldKeys.RemoveAll(x => x.Vk == k.Vk && x.Scan == k.Scan); }
                return;
            }
            if (action == "down")
            {
                Send(keys.Select(k => Key(k, false)));
                lock (lk) { heldKeys.AddRange(keys); heldSince = Environment.TickCount; }
                return;
            }
            for (int r = 0; r < repeat; r++)
            {
                if (!FgOk(w)) throw new HelperError("failed", "The target lost the foreground.");
                Send(keys.Select(k => Key(k, false)));
                lock (lk) { heldKeys.AddRange(keys); heldSince = Environment.TickCount; }
                try
                {
                    int end = Environment.TickCount + holdMs;
                    while (unchecked(end - Environment.TickCount) > 0)
                    {
                        Thread.Sleep(Math.Min(50, Math.Max(1, unchecked(end - Environment.TickCount))));
                        if (!FgOk(w)) throw new HelperError("failed", "The target lost the foreground during the key hold.");
                    }
                }
                finally
                {
                    Send(keys.AsEnumerable().Reverse().Select(k => Key(k, true)));
                    lock (lk) { foreach (var k in keys) heldKeys.RemoveAll(x => x.Vk == k.Vk && x.Scan == k.Scan); }
                }
                Thread.Sleep(15);
            }
        }
    }

    static class Keys
    {
        static readonly Dictionary<string, ushort> names = BuildNames();
        static readonly HashSet<ushort> ext = new HashSet<ushort> { 0x25, 0x26, 0x27, 0x28, 0x21, 0x22, 0x23, 0x24, 0x2D, 0x2E };

        static Dictionary<string, ushort> BuildNames()
        {
            var d = new Dictionary<string, ushort>
            {
                {"return",0x0D},{"enter",0x0D},{"tab",9},{"space",0x20},{"backspace",8},{"delete",0x2E},{"del",0x2E},{"escape",0x1B},{"esc",0x1B},
                {"left",0x25},{"up",0x26},{"right",0x27},{"down",0x28},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},{"insert",0x2D},
                {"shift",0x10},{"ctrl",0x11},{"control",0x11},{"alt",0x12},{"option",0x12},
                {";",0xBA},{"=",0xBB},{",",0xBC},{"-",0xBD},{".",0xBE},{"/",0xBF},{"`",0xC0},{"[",0xDB},{"\\",0xDC},{"]",0xDD},{"'",0xDE},
                {"plus",0xBB},{"minus",0xBD},{"comma",0xBC},{"period",0xBE},{"slash",0xBF},{"semicolon",0xBA},{"equals",0xBB}
            };
            for (char c = 'a'; c <= 'z'; c++) d[c.ToString()] = (ushort)(0x41 + (c - 'a'));
            for (char c = '0'; c <= '9'; c++) d[c.ToString()] = (ushort)(0x30 + (c - '0'));
            for (int i = 1; i <= 24; i++) d["f" + i] = (ushort)(0x6F + i);
            for (int i = 0; i <= 9; i++) d["numpad" + i] = (ushort)(0x60 + i);
            return d;
        }

        public static K FromVk(ushort vk, IntPtr layout)
        {
            if (layout == IntPtr.Zero) layout = N.GetKeyboardLayout(0);
            uint sc = N.MapVirtualKeyEx(vk, 4, layout);
            bool e = (sc & 0xFF00) == 0xE000 || ext.Contains(vk);
            return new K { Vk = vk, Scan = (ushort)(sc & 0xFF), Ext = e };
        }

        public static K Named(string n)
        {
            ushort vk;
            if (!names.TryGetValue(n.ToLowerInvariant(), out vk)) throw new HelperError("failed", "Unknown key name '" + n + "'.");
            return FromVk(vk, IntPtr.Zero);
        }

        public static K Mod(string m)
        {
            m = m.ToLowerInvariant();
            if (m == "win" || m == "cmd" || m == "meta" || m == "super" || m == "lwin" || m == "rwin") throw new HelperError("refused", "That chord acts on the system, not the window.");
            if (m != "ctrl" && m != "alt" && m != "shift") throw new HelperError("failed", "Unknown modifier '" + m + "'.");
            return Named(m);
        }

        static bool IsMod(string n) { n = n.ToLowerInvariant(); return n == "ctrl" || n == "control" || n == "alt" || n == "option" || n == "shift"; }

        public static List<K> ParseChord(string chord, string[] keys)
        {
            var toks = new List<string>();
            if (keys != null && keys.Length > 0) toks.AddRange(keys);
            else
            {
                string c = (chord ?? "").Trim();
                if (c == "+") c = "plus";
                c = c.Replace("++", "+plus");
                toks.AddRange(c.Split('+').Where(s => s.Length > 0));
            }
            if (toks.Count == 0) throw new HelperError("failed", "key needs a chord or keys.");
            var low = toks.Select(t => t.Trim().ToLowerInvariant()).ToList();
            foreach (var t in low)
                if (t == "win" || t == "cmd" || t == "meta" || t == "super" || t == "lwin" || t == "rwin" || t == "windows")
                    throw new HelperError("refused", "That chord acts on the system, not the window (win/cmd/meta/super is refused).");
            bool alt = low.Contains("alt") || low.Contains("option"), ctrl = low.Contains("ctrl") || low.Contains("control"), shift = low.Contains("shift");
            bool other = low.Any(t => !IsMod(t));
            if (alt && low.Contains("tab")) throw new HelperError("refused", "alt+tab acts on the system, not the window.");
            if (alt && low.Contains("f4")) throw new HelperError("refused", "alt+f4 closes the window; it is refused.");
            if (alt && (low.Contains("esc") || low.Contains("escape"))) throw new HelperError("refused", "alt+esc acts on the system, not the window.");
            if (alt && low.Contains("space")) throw new HelperError("refused", "alt+space opens the system menu; it is refused.");
            if (ctrl && (low.Contains("esc") || low.Contains("escape"))) throw new HelperError("refused", "ctrl+esc opens Start; it is refused.");
            if (ctrl && alt && other) throw new HelperError("refused", "ctrl+alt chords act on the system, not the window.");
            if (low.Contains("delete") && ctrl && alt) throw new HelperError("refused", "ctrl+alt+delete cannot be sent.");
            var mods = toks.Where(IsMod).Select(t => Named(t)).ToList();
            var rest = toks.Where(t => !IsMod(t)).Select(t => Named(t.Trim())).ToList();
            mods.AddRange(rest);
            return mods;
        }
    }
}
