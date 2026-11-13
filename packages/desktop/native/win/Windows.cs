using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace PimiDesktopHelper
{
    class Win
    {
        public IntPtr Hwnd, Core;
        public uint Pid, FramePid, Tid;
        public string Class, Title, Path, Exe, Aumid, AppId, AppName, Framework, Started;
        public bool Elevated;
        public string Blocked;
        public string ExeName { get { return Exe; } }
    }

    class Target
    {
        public string AppId, WindowTitle, WindowClass, Started;
        public IntPtr Hwnd;
        public long Pid;
        public bool AllowInput, AllowRelaunch, Disposable;
        public string LaunchArgs;
        public bool HasPid;
    }

    static class Wn
    {
        static readonly Dictionary<string, string> descCache = new Dictionary<string, string>();

        static IntPtr FindCore(IntPtr frame)
        {
            IntPtr found = IntPtr.Zero;
            N.EnumChildWindows(frame, (h, l) => { if (N.Class(h) == "Windows.UI.Core.CoreWindow") { found = h; return false; } return true; }, IntPtr.Zero);
            return found;
        }

        static bool HasChildClass(IntPtr parent, params string[] classes)
        {
            bool found = false;
            N.EnumChildWindows(parent, (h, l) => { string c = N.Class(h); foreach (var x in classes) if (c == x) { found = true; return false; } return true; }, IntPtr.Zero);
            return found;
        }

        public static string ClassFramework(IntPtr h, string cls)
        {
            if (cls == "UnityWndClass") return "unity";
            if (cls == "UnrealWindow") return "unreal";
            if (cls == "SDL_app" || cls.StartsWith("GLFW")) return "sdl";
            if (cls.StartsWith("Chrome_WidgetWin_")) return "chromium";
            if (cls.StartsWith("Qt") && cls.Contains("QWindow")) return "qt";
            if (cls.StartsWith("WindowsForms10.")) return "winforms";
            if (cls.StartsWith("HwndWrapper[")) return "wpf";
            if (cls == "SunAwtFrame") return "java";
            if (cls.StartsWith("Avalonia-")) return "unknown";
            if (cls == "ApplicationFrameWindow") return "uwp";
            if (cls == "WinUIDesktopWin32WindowClass") return "winui";
            if (cls.StartsWith("gdkWindow") || cls.StartsWith("GtkWindow")) return "gtk";
            if (h != IntPtr.Zero && HasChildClass(h, "Microsoft.UI.Content.DesktopChildSiteBridge", "Windows.UI.Composition.DesktopWindowContentBridge")) return "winui";
            return "win32";
        }

        public static Win Inspect(IntPtr h)
        {
            if (!N.IsWindow(h)) return null;
            var w = new Win { Hwnd = h, Class = N.Class(h), Title = N.Title(h) };
            w.FramePid = N.Pid(h);
            w.Tid = N.Tid(h);
            w.Pid = w.FramePid;
            if (w.Class == "ApplicationFrameWindow")
            {
                w.Core = FindCore(h);
                if (w.Core == IntPtr.Zero) return null;
                w.Pid = N.Pid(w.Core);
            }
            var p = Procs.Get(w.Pid);
            w.Path = p.Path; w.Exe = p.Exe; w.Aumid = p.Aumid; w.Started = p.Started; w.Elevated = p.Elevated;
            w.AppId = !string.IsNullOrEmpty(p.Aumid) ? p.Aumid : p.Path;
            w.Framework = ClassFramework(h, w.Class);
            w.AppName = AppName(w);
            return w;
        }

        static string AppName(Win w)
        {
            string key = w.Path ?? "";
            string d;
            if (!descCache.TryGetValue(key, out d))
            {
                d = null;
                try
                {
                    if (key.Length > 0)
                    {
                        var vi = FileVersionInfo.GetVersionInfo(key);
                        if (!string.IsNullOrWhiteSpace(vi.FileDescription)) d = vi.FileDescription.Trim();
                    }
                }
                catch { }
                descCache[key] = d;
            }
            if (d != null && w.Class != "ApplicationFrameWindow") return d;
            if (w.Class == "ApplicationFrameWindow" && !string.IsNullOrEmpty(w.Title)) return w.Title;
            if (d != null) return d;
            return string.IsNullOrEmpty(w.Exe) ? w.Title : System.IO.Path.GetFileNameWithoutExtension(w.Exe);
        }

        public static bool EligibleTopLevel(IntPtr h)
        {
            if (!N.IsWindowVisible(h)) return false;
            if (N.GetWindow(h, N.GW_OWNER) != IntPtr.Zero) return false;
            if ((N.ExStyle(h) & N.WS_EX_TOOLWINDOW) != 0) return false;
            if (N.Cloaked(h) != 0) return false;
            var r = N.WinRect(h);
            if (r.W <= 0 || r.H <= 0) return false;
            return true;
        }

        public static List<IntPtr> TopLevels()
        {
            var l = new List<IntPtr>();
            N.EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero);
            return l;
        }

        public static bool IsMember(Win pin, IntPtr h)
        {
            if (h == IntPtr.Zero) return false;
            IntPtr root = N.Root(h);
            if (root == IntPtr.Zero) root = h;
            if (root == pin.Hwnd) return true;
            if (N.Pid(root) != pin.Pid) return false;
            if (N.GetAncestor(root, N.GA_ROOTOWNER) == pin.Hwnd) return true;
            if (N.IsWindowVisible(root) && (N.Style(root) & N.WS_POPUP) != 0) return true;
            return false;
        }

        public static List<IntPtr> Family(Win pin)
        {
            var l = new List<IntPtr>();
            foreach (var h in TopLevels())
            {
                if (h == pin.Hwnd) continue;
                if (!N.IsWindowVisible(h)) continue;
                if (N.Cloaked(h) != 0) continue;
                if (N.Pid(h) != pin.Pid) continue;
                var r = N.FrameRect(h);
                if (r.Empty || r.W < 4 || r.H < 4) continue;
                if (IsMember(pin, h)) l.Add(h);
            }
            return l;
        }

        public static string ExeOfWindow(IntPtr h)
        {
            if (h == IntPtr.Zero) return null;
            var w = Inspect(N.Root(h));
            if (w != null) return w.Exe;
            var p = Procs.Get(N.Pid(h));
            return p.Exe;
        }

        // ---- resolution ----
        static Win PinMatches(Target t)
        {
            if (t.Hwnd == IntPtr.Zero || !N.IsWindow(t.Hwnd)) return null;
            if (N.Cloaked(t.Hwnd) == 2) return null;
            var w = Inspect(t.Hwnd);
            if (w == null) return null;
            if (t.HasPid && w.Pid != (uint)t.Pid) return null;
            if (t.Started != null && w.Started != t.Started) return null;
            if (t.AppId != null && !string.Equals(w.AppId, t.AppId, StringComparison.OrdinalIgnoreCase)) return null;
            if (t.WindowClass != null && w.Class != t.WindowClass) return null;
            return w;
        }

        public static Win Resolve(Target t, out bool repinned)
        {
            repinned = false;
            if (t == null) throw new HelperError("refused", "This verb needs a target window.");
            Win w = PinMatches(t);
            if (w == null)
            {
                if (string.IsNullOrEmpty(t.AppId)) throw new HelperError("window_gone", "The target window is gone.");
                var cands = new List<Win>();
                foreach (var h in TopLevels())
                {
                    if (!EligibleTopLevel(h)) continue;
                    var c = Inspect(h);
                    if (c == null) continue;
                    if (!string.Equals(c.AppId, t.AppId, StringComparison.OrdinalIgnoreCase)) continue;
                    cands.Add(c);
                }
                if (cands.Count == 0) throw new HelperError("window_gone", "The target window is gone and the app has no other window open.");
                Win pick = null;
                var sameClass = cands.Where(c => t.WindowClass == null || c.Class == t.WindowClass).ToList();
                var exact = sameClass.Where(c => c.Title == t.WindowTitle).ToList();
                if (exact.Count == 1) pick = exact[0];
                else if (sameClass.Count == 1) pick = sameClass[0];
                else if (cands.Count == 1) pick = cands[0];
                if (pick == null) throw new HelperError("refused", "More than one window of this app is open; close the others.");
                w = pick;
                repinned = true;
            }
            if (Safety.Denied(w) != null) throw new HelperError("blocked", "This app is on the never-drive list.");
            if (Safety.IsOwn(w)) throw new HelperError("refused", "This window belongs to Pimi itself.");
            return w;
        }

        // ---- verbs ----
        public static Dictionary<string, object> WinEntry(Win w)
        {
            return new Dictionary<string, object>
            {
                {"appId", w.AppId}, {"appName", w.AppName}, {"windowTitle", w.Title}, {"framework", w.Framework},
                {"elevated", w.Elevated}, {"blocked", w.Blocked}, {"hwnd", ((long)w.Hwnd).ToString()}, {"pid", (long)w.Pid},
                {"processStartedAt", w.Started}, {"windowClass", w.Class}, {"exeName", w.Exe}
            };
        }

        public static object List()
        {
            var res = new List<object>();
            foreach (var h in TopLevels())
            {
                if (!EligibleTopLevel(h)) continue;
                if (string.IsNullOrEmpty(N.Title(h))) continue;
                var w = Inspect(h);
                if (w == null) continue;
                if (Safety.Denied(w) != null || Safety.IsOwn(w)) continue;
                res.Add(WinEntry(w));
            }
            return new Dictionary<string, object> { { "windows", res } };
        }

        public static Dictionary<string, object> Rect(RECT r)
        {
            return new Dictionary<string, object> { { "x", r.Left }, { "y", r.Top }, { "width", r.W }, { "height", r.H } };
        }

        public static string FrameworkOf(Win w, string fwId)
        {
            string f = w.Framework;
            if (f == "win32" || f == "unknown")
            {
                switch ((fwId ?? "").ToLowerInvariant())
                {
                    case "wpf": return "wpf";
                    case "winform": return "winforms";
                    case "qt": return "qt";
                    case "xaml": return w.Class == "ApplicationFrameWindow" ? "uwp" : "winui";
                }
            }
            return f;
        }

        public static Dictionary<string, object> State(Win w)
        {
            var r = N.FrameRect(w.Hwnd);
            var fg = N.GetForegroundWindow();
            var surfaces = new List<object>();
            surfaces.Add(new Dictionary<string, object> { { "class", w.Class }, { "rect", Rect(r) } });
            foreach (var h in Family(w))
                surfaces.Add(new Dictionary<string, object> { { "class", N.Class(h) }, { "rect", Rect(N.FrameRect(h)) } });
            return new Dictionary<string, object>
            {
                {"title", w.Title}, {"rect", Rect(r)}, {"dpi", N.Dpi(w.Hwnd)}, {"minimized", N.IsIconic(w.Hwnd)}, {"maximized", N.IsZoomed(w.Hwnd)},
                {"foreground", IsMember(w, fg)}, {"responding", !N.IsHungAppWindow(w.Hwnd)}, {"elevated", w.Elevated}, {"framework", w.Framework}, {"surfaces", surfaces}
            };
        }

        public static object Window(Win w, Dictionary<string, object> a, Target t, Agent ag)
        {
            string act = J.S(a, "action") ?? "state";
            if (act == "state") return State(w);
            if (!t.AllowInput) throw new HelperError("refused", "Input is not enabled for this run.");
            switch (act)
            {
                case "focus":
                    In.CheckDesktop(); In.CheckUserActive(); In.EnsureForeground(w);
                    break;
                case "restore": N.ShowWindow(w.Hwnd, N.SW_RESTORE); break;
                case "maximize": N.ShowWindow(w.Hwnd, N.SW_MAXIMIZE); break;
                case "fit":
                case "resize":
                    {
                        if (N.IsIconic(w.Hwnd) || N.IsZoomed(w.Hwnd)) N.ShowWindow(w.Hwnd, N.SW_RESTORE);
                        var wr = N.WinRect(w.Hwnd);
                        var fr = N.FrameRect(w.Hwnd);
                        int padL = fr.Left - wr.Left, padT = fr.Top - wr.Top, padR = wr.Right - fr.Right, padB = wr.Bottom - fr.Bottom;
                        int fw = fr.W, fh = fr.H;
                        if (act == "resize")
                        {
                            fw = Math.Max(320, Math.Min(3840, J.I(a, "width", fw)));
                            fh = Math.Max(240, Math.Min(2160, J.I(a, "height", fh)));
                        }
                        var mi = new MONITORINFO { cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(MONITORINFO)) };
                        N.GetMonitorInfo(N.MonitorFromWindow(w.Hwnd, 2), ref mi);
                        var wa = mi.rcWork;
                        if (act == "fit") { fw = Math.Min(fw, wa.W); fh = Math.Min(fh, wa.H); }
                        int x = fr.Left, y = fr.Top;
                        if (act == "resize")
                        {
                            // keep the window on its monitor
                            fw = Math.Min(fw, wa.W); fh = Math.Min(fh, wa.H);
                        }
                        if (x + fw > wa.Right) x = wa.Right - fw;
                        if (y + fh > wa.Bottom) y = wa.Bottom - fh;
                        if (x < wa.Left) x = wa.Left;
                        if (y < wa.Top) y = wa.Top;
                        // SWP_NOZORDER | SWP_NOACTIVATE
                        N.SetWindowPos(w.Hwnd, IntPtr.Zero, x - padL, y - padT, fw + padL + padR, fh + padT + padB, 0x14);
                        break;
                    }
                default: throw new HelperError("failed", "Unknown window action.");
            }
            System.Threading.Thread.Sleep(150);
            return State(w);
        }
    }
}

