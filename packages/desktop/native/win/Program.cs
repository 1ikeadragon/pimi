using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace PimiDesktopHelper
{
    static class J
    {
        public static string S(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : null; }
        public static int I(Dictionary<string, object> d, string k, int def) { object v; if (d != null && d.TryGetValue(k, out v) && v != null) { try { return (int)Math.Round(Convert.ToDouble(v, CultureInfo.InvariantCulture)); } catch { } } return def; }
        public static double D(Dictionary<string, object> d, string k) { object v; if (d != null && d.TryGetValue(k, out v) && v != null) { try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { } } return 0; }
        public static bool B(Dictionary<string, object> d, string k, bool def) { object v; if (d != null && d.TryGetValue(k, out v) && v is bool) return (bool)v; return def; }
        public static Dictionary<string, object> O(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null; }
        public static string[] SA(Dictionary<string, object> d, string k)
        {
            object v; if (d == null || !d.TryGetValue(k, out v)) return new string[0];
            var arr = v as IEnumerable; if (arr == null || v is string) return new string[0];
            return arr.Cast<object>().Select(x => Convert.ToString(x)).ToArray();
        }
    }

    static class Program
    {
        static StreamWriter stdout;
        static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };

        static void Log(string s) { try { Console.Error.WriteLine(s); } catch { } }

        [MTAThread]
        static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--selftest")
            {
                try { var a = U.A; Console.WriteLine("{\"ok\":true,\"version\":\"1\",\"uia\":true,\"wgc\":" + (Wgc.Available() ? "true" : "false") + "}"); return 0; }
                catch (Exception ex) { Console.WriteLine("{\"ok\":false,\"version\":\"1\",\"uia\":false,\"error\":\"" + ex.GetType().Name + "\"}"); return 1; }
            }
            if (args.Length > 1 && args[0] == "--anticheat")
            {
                Console.WriteLine(Safety.AntiCheatStatic(args[1].ToLowerInvariant()) ?? "clear");
                return 0;
            }
            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            In.Init();
            AppDomain.CurrentDomain.ProcessExit += (s, e) => In.ReleaseAll();
            Console.CancelKeyPress += (s, e) => In.ReleaseAll();
            try
            {
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    string resp = Handle(line);
                    stdout.WriteLine(resp);
                }
            }
            finally { In.ReleaseAll(); Wgc.Shutdown(); }
            return 0;
        }

        static string Err(string id, string code, string msg)
        {
            return json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "code", code }, { "message", msg } });
        }

        static string Handle(string line)
        {
            string id = null;
            var sw = Stopwatch.StartNew();
            string verb = "?";
            try
            {
                var req = json.DeserializeObject(line) as Dictionary<string, object>;
                if (req == null) return Err(null, "failed", "Request is not a JSON object.");
                id = J.S(req, "id");
                verb = J.S(req, "verb") ?? "";
                var a = J.O(req, "args") ?? new Dictionary<string, object>();
                var ag = Agents.Get(J.S(req, "agent"));
                Procs.Reset();
                Target t = ParseTarget(J.O(req, "target"));
                var res = Dispatch(verb, a, t, ag);
                var resd = res as Dictionary<string, object>;
                if (resd != null && repin != null) { resd["repinned"] = repin; }
                repin = null;
                Log(verb + " ok " + sw.ElapsedMilliseconds + "ms");
                return json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", res } });
            }
            catch (HelperError e) { In.ReleaseAll(); repin = null; Log(verb + " " + e.Code + " " + sw.ElapsedMilliseconds + "ms"); return Err(id, e.Code, e.Message); }
            catch (COMException e) { In.ReleaseAll(); repin = null; Log(verb + " com 0x" + e.HResult.ToString("x")); return Err(id, "failed", "A Windows API call failed (0x" + e.HResult.ToString("x") + ")."); }
            catch (Exception e) { In.ReleaseAll(); repin = null; Log(verb + " exception " + e.GetType().Name); return Err(id, "failed", "The helper hit an internal error (" + e.GetType().Name + ")."); }
        }

        static Target ParseTarget(Dictionary<string, object> d)
        {
            if (d == null) return null;
            var t = new Target { AppId = J.S(d, "appId"), WindowTitle = J.S(d, "windowTitle"), WindowClass = J.S(d, "windowClass"), Started = J.S(d, "processStartedAt"),
                AllowInput = J.B(d, "allowInput", false), AllowRelaunch = J.B(d, "allowRelaunch", false), Disposable = J.B(d, "disposable", false), LaunchArgs = J.S(d, "launchArgs") };
            long h; if (long.TryParse(J.S(d, "hwnd") ?? "", out h)) t.Hwnd = new IntPtr(h);
            long p; if (long.TryParse(J.S(d, "pid") ?? "", out p)) { t.Pid = p; t.HasPid = true; }
            return t;
        }

        static Dictionary<string, object> repin;

        enum Lvl { Read, Uia, Input }

        static Win Prep(Target t, Lvl lvl, bool screenshot = false)
        {
            bool rp;
            var w = Wn.Resolve(t, out rp);
            if (rp) repin = new Dictionary<string, object> { { "hwnd", ((long)w.Hwnd).ToString() }, { "pid", (long)w.Pid }, { "processStartedAt", w.Started } };
            if (lvl >= Lvl.Uia && w.Elevated) throw new HelperError("elevated_target", Wn.ElevatedMessage);
            if (lvl >= Lvl.Input && !t.AllowInput) throw new HelperError("refused", "Input is not enabled for this run.");
            if (lvl >= Lvl.Uia && N.IsHungAppWindow(w.Hwnd)) throw new HelperError("target_hung", "The target window is not responding.");
            Apps.Track(w);
            if (lvl >= Lvl.Input && w.Elevated) throw new HelperError("elevated_target", Wn.ElevatedMessage);
            return w;
        }

        static object Dispatch(string verb, Dictionary<string, object> a, Target t, Agent ag)
        {
            switch (verb)
            {
                case "list": return Wn.List();
                case "app": return Apps.Run(a, t);
                case "inspect": { var w = Prep(t, Lvl.Read); return Sec.Inspect(w, a); }
                case "scope": { var w = Prep(t, Lvl.Read); return Sec.Scope(w); }
                case "ipc": { bool probe = (J.S(a, "action") ?? "list") == "probe"; var w = Prep(t, probe ? Lvl.Input : Lvl.Read); return Sec.Ipc(w, a, t); }
                case "deeplink": { var w = Prep(t, Lvl.Input); return Sec.Deeplink(w, a, t); }
                case "screenshot": { var w = Prep(t, Lvl.Read); return Screenshot(w, a, ag, t); }
                case "snapshot": { var w = Prep(t, Lvl.Uia); return U.Snapshot(w, a, ag, true); }
                case "find": { var w = Prep(t, Lvl.Uia); return U.Find(w, a, ag); }
                case "element": { var w = Prep(t, Lvl.Uia); return U.Element(w, a, ag, p => { try { In.HitTest(w, p); return true; } catch (HelperError) { return false; } }); }
                case "audit": { var w = Prep(t, Lvl.Uia); return U.Audit(w); }
                case "window":
                    {
                        bool state = (J.S(a, "action") ?? "state") == "state";
                        var w = Prep(t, state ? Lvl.Read : Lvl.Input);
                        return Wn.Window(w, a, t, ag);
                    }
                case "wait": { var w = Prep(t, Lvl.Read); return Wait(w, a, ag); }
                case "click": case "type": case "key": case "scroll": case "drag": case "hover": case "mouse":
                    {
                        var w = Prep(t, Lvl.Input);
                        return InputVerb(verb, w, a, ag, t);
                    }
                default: throw new HelperError("unsupported", "Unknown verb '" + verb + "'.");
            }
        }

        // ---------- screenshot ----------
        public static Dictionary<string, object> Screenshot(Win w, Dictionary<string, object> a, Agent ag, Target t)
        {
            int maxEdge = Math.Max(256, Math.Min(1920, J.I(a, "maxEdge", 1280)));
            if (N.IsIconic(w.Hwnd))
            {
                if (!t.AllowInput) throw new HelperError("window_minimized", "The window is minimized. Ask the owner to restore it.");
                N.ShowWindow(w.Hwnd, N.SW_SHOWNOACTIVATE);
                Thread.Sleep(250);
            }
            bool marks = J.B(a, "marks", false), grid = J.B(a, "grid", false);
            if (marks && w.Elevated) throw new HelperError("elevated_target", Wn.ElevatedMessage);
            Cap.Forced = J.S(a, "method");
            Shot shot;
            try { shot = Cap.Grab(w, true); } finally { Cap.Forced = null; }
            string legend = null;
            try
            {
                var frame = shot.Frame;
                int cox = shot.Canvas.Left - frame.Left, coy = shot.Canvas.Top - frame.Top;
                Bitmap img = shot.Bmp;
                int ox = cox, oy = coy;
                var region = J.O(a, "region");
                double estScale = Math.Min(1.0, maxEdge / (double)Math.Max(img.Width, img.Height));
                if (marks)
                {
                    U.Snapshot(w, new Dictionary<string, object>(), ag, true, true);
                    legend = Marks.Draw(img, shot.Canvas, U.Lastctx.Marked, region != null ? 1.0 : estScale);
                }
                if (region != null)
                {
                    double s0 = ag.Frame != null ? ag.Frame.Scale : U.DefaultScale(frame);
                    int fx = ag.Frame != null ? ag.Frame.OriginX : 0, fy = ag.Frame != null ? ag.Frame.OriginY : 0;
                    int rx = (int)Math.Round(fx + J.D(region, "x") / s0), ry = (int)Math.Round(fy + J.D(region, "y") / s0);
                    int rw = (int)Math.Round(J.D(region, "width") / s0), rh = (int)Math.Round(J.D(region, "height") / s0);
                    var crop = new Rectangle(rx - cox, ry - coy, Math.Max(1, rw), Math.Max(1, rh));
                    crop.Intersect(new Rectangle(0, 0, img.Width, img.Height));
                    if (crop.Width < 1 || crop.Height < 1) throw new HelperError("failed", "The region is outside the window.");
                    var c = img.Clone(crop, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
                    img.Dispose(); img = c; ox = crop.X + cox; oy = crop.Y + coy;
                }
                double scale = Math.Min(1.0, maxEdge / (double)Math.Max(img.Width, img.Height));
                img = Cap.Scale(img, scale);
                if (grid) Marks.Grid(img);
                ag.Frame = new FrameInfo { Scale = scale, OriginX = ox, OriginY = oy };
                var res = new Dictionary<string, object>
                {
                    {"mimeType","image/png"}, {"dataBase64", Convert.ToBase64String(Cap.Png(img))}, {"width", img.Width}, {"height", img.Height},
                    {"scale", scale}, {"origin", new Dictionary<string, object>{{"x", ox},{"y", oy}}}, {"windowWidth", frame.W}, {"windowHeight", frame.H},
                    {"dpi", N.Dpi(w.Hwnd)}, {"method", shot.Method}, {"suspectBlank", shot.Suspect}
                };
                if (legend != null) res["legend"] = legend;
                img.Dispose();
                shot.Bmp = null;
                return res;
            }
            finally { shot.Dispose(); }
        }

        // ---------- wait ----------
        static object Wait(Win w, Dictionary<string, object> a, Agent ag)
        {
            var sw = Stopwatch.StartNew();
            int ms = Math.Max(0, Math.Min(10000, J.I(a, "ms", 0)));
            string until = J.S(a, "until");
            if (until == null) { Thread.Sleep(ms); return new Dictionary<string, object> { { "satisfied", true }, { "waitedMs", (int)sw.ElapsedMilliseconds } }; }
            int timeout = Math.Max(100, Math.Min(10000, J.I(a, "timeoutMs", 5000)));
            bool ok = false;
            byte[] baseH = null;
            if (until == "stable" || until == "change") baseH = Cap.Hash(w);
            long stableSince = sw.ElapsedMilliseconds;
            string text = J.S(a, "text");
            while (sw.ElapsedMilliseconds < timeout)
            {
                if (until == "stable")
                {
                    var cur = Cap.Hash(w);
                    if (Cap.Different(baseH, cur)) { baseH = cur; stableSince = sw.ElapsedMilliseconds; }
                    else if (sw.ElapsedMilliseconds - stableSince >= 300) { ok = true; break; }
                    Thread.Sleep(60);
                }
                else if (until == "change")
                {
                    if (Cap.Different(baseH, Cap.Hash(w))) { ok = true; break; }
                    Thread.Sleep(80);
                }
                else if (until == "text")
                {
                    if (w.Elevated) throw new HelperError("elevated_target", Wn.ElevatedMessage);
                    var r = U.Snapshot(w, new Dictionary<string, object> { { "maxNodes", 600 } }, ag, false);
                    if (text != null && ((string)r["tree"]).IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0) { ok = true; break; }
                    Thread.Sleep(250);
                }
                else if (until == "gone")
                {
                    string er = J.S(a, "element");
                    int n; Node nd;
                    if (er == null || !er.StartsWith("@d") || !int.TryParse(er.Substring(2), out n) || !ag.Refs.TryGetValue(n, out nd) || !U.Alive(nd)) { ok = true; break; }
                    Thread.Sleep(150);
                }
                else throw new HelperError("failed", "Unknown wait condition.");
            }
            return new Dictionary<string, object> { { "satisfied", ok }, { "waitedMs", (int)sw.ElapsedMilliseconds } };
        }

        // ---------- input verbs ----------
        static POINT ResolveEnd(Win w, Agent ag, Dictionary<string, object> e, out Node node)
        {
            node = null;
            if (e == null) throw new HelperError("failed", "Missing element or point.");
            string er = J.S(e, "element");
            if (er != null) { node = U.GetRef(ag, er); return In.NodePoint(node, true); }
            var pt = J.O(e, "point");
            if (pt == null) throw new HelperError("failed", "Give an element ref or a point.");
            return In.MapPoint(w, ag, J.D(pt, "x"), J.D(pt, "y"));
        }

        static object InputVerb(string verb, Win w, Dictionary<string, object> a, Agent ag, Target t)
        {
            byte[] before = null;
            try { before = Cap.Hash(w); } catch { }
            Dictionary<string, object> res;
            try
            {
                switch (verb)
                {
                    case "click": res = Click(w, a, ag); break;
                    case "type": res = Type(w, a, ag); break;
                    case "key": res = Key(w, a); break;
                    case "scroll": res = ScrollV(w, a, ag); break;
                    case "drag": res = DragV(w, a, ag); break;
                    case "hover": res = HoverV(w, a, ag); break;
                    default: res = MouseV(w, a); break;
                }
            }
            catch { In.ReleaseAll(); throw; }
            Thread.Sleep(250);
            bool changed = false;
            try { if (before != null) changed = Cap.Different(before, Cap.Hash(w)); } catch { }
            res["changed"] = changed;
            res["focusLeft"] = In.FocusLeft(w);
            if (J.B(a, "screenshotAfter", false))
            {
                try { res["screenshot"] = Screenshot(w, new Dictionary<string, object>(), ag, t); } catch (HelperError e) { res["screenshotError"] = e.Message; }
            }
            return res;
        }

        static string[] Mods(Dictionary<string, object> a)
        {
            var m = J.SA(a, "modifiers").Select(x => x.ToLowerInvariant()).ToArray();
            foreach (var x in m) if (x != "ctrl" && x != "alt" && x != "shift") throw new HelperError("refused", "Only ctrl, alt and shift modifiers are allowed.");
            return m;
        }

        static Dictionary<string, object> RelPoint(Win w, POINT p)
        {
            var fr = N.FrameRect(w.Hwnd);
            return new Dictionary<string, object> { { "x", p.X - fr.Left }, { "y", p.Y - fr.Top } };
        }

        static Dictionary<string, object> Click(Win w, Dictionary<string, object> a, Agent ag)
        {
            string button = J.S(a, "button") ?? "left";
            int count = Math.Max(1, Math.Min(3, J.I(a, "count", 1)));
            string via = J.S(a, "via") ?? "auto";
            var mods = Mods(a);
            string er = J.S(a, "element");
            Node n = null; POINT sp;
            string used = "input", role = null, label = null;
            if (er != null)
            {
                n = U.GetRef(ag, er);
                role = U.Role(n.Ct); label = n.Name;
                if (!n.Enabled) throw new HelperError("failed", "The element is disabled.");
                if (via == "pattern")
                {
                    if (!In.PatternClick(n)) throw new HelperError("unsupported", "The element has no pattern that can click it.");
                    used = "pattern";
                    return Res(role, label, RelPoint(w, new POINT(n.R.Left + n.R.W / 2, n.R.Top + n.R.H / 2)), used);
                }
                try
                {
                    sp = In.NodePoint(n, true);
                    In.ClickAt(w, sp, button, count, mods);
                }
                catch (HelperError e) when (via == "auto" && (e.Code == "occluded" || e.Code == "refused" || (e.Code == "failed" && e.Message.Contains("rectangle"))))
                {
                    if (!In.PatternClick(n)) throw;
                    used = "pattern";
                    return Res(role, label, RelPoint(w, new POINT(n.R.Left + n.R.W / 2, n.R.Top + n.R.H / 2)), used);
                }
            }
            else
            {
                var pt = J.O(a, "point");
                if (pt == null) throw new HelperError("failed", "click needs element or point.");
                sp = In.MapPoint(w, ag, J.D(pt, "x"), J.D(pt, "y"));
                In.ClickAt(w, sp, button, count, mods);
                try { var hit = U.ToNode(U.A.ElementFromPointBuildCache(new Interop.UIAutomationClient.tagPOINT { x = sp.X, y = sp.Y }, U.CR), 0); role = U.Role(hit.Ct); label = hit.Name; } catch { }
            }
            return Res(role, label, RelPoint(w, sp), used);
        }

        static Dictionary<string, object> Res(string role, string label, Dictionary<string, object> point, string via)
        {
            return new Dictionary<string, object> { { "role", role }, { "label", label }, { "point", point }, { "via", via } };
        }

        static Dictionary<string, object> Type(Win w, Dictionary<string, object> a, Agent ag)
        {
            string text = J.S(a, "text");
            if (string.IsNullOrEmpty(text)) throw new HelperError("failed", "type needs text.");
            if (text.Length > 2000) throw new HelperError("failed", "Text is limited to 2000 characters.");
            string mode = J.S(a, "mode") ?? "unicode";
            bool clear = J.B(a, "clear", false), submit = J.B(a, "submit", false);
            string er = J.S(a, "element");
            Node n = er != null ? U.GetRef(ag, er) : null;
            if (mode == "set")
            {
                if (n == null) throw new HelperError("failed", "mode set needs an element ref.");
                if (n.Password) throw new HelperError("refused", "Password fields are not written.");
                try
                {
                    n.El.SetFocus();
                    var vp = (Interop.UIAutomationClient.IUIAutomationValuePattern)n.El.GetCurrentPattern(10002);
                    if (vp.CurrentIsReadOnly != 0) throw new HelperError("failed", "The field is read-only.");
                    string cur = clear ? "" : (vp.CurrentValue ?? "");
                    vp.SetValue(cur + text);
                }
                catch (HelperError) { throw; }
                catch (COMException) { throw new HelperError("unsupported", "The element does not support ValuePattern.SetValue."); }
                return new Dictionary<string, object> { { "via", "pattern" }, { "sent", text.Length } };
            }
            if (mode != "unicode" && mode != "scancode") throw new HelperError("failed", "Unknown type mode.");
            if (n != null) { var sp = In.NodePoint(n, true); In.ClickAt(w, sp, "left", 1, new string[0]); }
            else In.Gate(w);
            if (clear) { In.Chord(w, Keys.ParseChord("ctrl+a", null), 0, 1, "press"); In.Chord(w, Keys.ParseChord("delete", null), 0, 1, "press"); }
            int sent = In.TypeText(w, text, mode, null);
            if (submit) In.Chord(w, Keys.ParseChord("return", null), 0, 1, "press");
            return new Dictionary<string, object> { { "via", "input" }, { "sent", sent } };
        }

        static Dictionary<string, object> Key(Win w, Dictionary<string, object> a)
        {
            var keys = Keys.ParseChord(J.S(a, "chord"), J.SA(a, "keys"));
            int hold = Math.Max(0, Math.Min(5000, J.I(a, "holdMs", 0)));
            int rep = Math.Max(1, Math.Min(20, J.I(a, "repeat", 1)));
            string action = J.S(a, "action") ?? "press";
            if (action != "press" && action != "down" && action != "up") throw new HelperError("failed", "Unknown key action.");
            In.Gate(w);
            In.Chord(w, keys, hold, rep, action);
            return new Dictionary<string, object>();
        }

        static Dictionary<string, object> ScrollV(Win w, Dictionary<string, object> a, Agent ag)
        {
            int dx = Math.Max(-30, Math.Min(30, J.I(a, "dx", 0))), dy = Math.Max(-30, Math.Min(30, J.I(a, "dy", 0)));
            POINT p;
            Node n;
            if (J.S(a, "element") != null || J.O(a, "point") != null) p = ResolveEnd(w, ag, a, out n);
            else { var fr = N.FrameRect(w.Hwnd); p = new POINT(fr.Left + fr.W / 2, fr.Top + fr.H / 2); }
            In.Scroll(w, p, dx, dy);
            return new Dictionary<string, object>();
        }

        static Dictionary<string, object> DragV(Win w, Dictionary<string, object> a, Agent ag)
        {
            Node n1, n2;
            var p1 = ResolveEnd(w, ag, J.O(a, "from"), out n1);
            var p2 = ResolveEnd(w, ag, J.O(a, "to"), out n2);
            In.Drag(w, p1, p2, J.S(a, "button") ?? "left", Math.Max(100, Math.Min(3000, J.I(a, "durationMs", 400))), Mods(a));
            return new Dictionary<string, object>();
        }

        static Dictionary<string, object> HoverV(Win w, Dictionary<string, object> a, Agent ag)
        {
            Node n;
            var p = ResolveEnd(w, ag, a, out n);
            In.Hover(w, p, Math.Max(0, Math.Min(3000, J.I(a, "dwellMs", 500))));
            return new Dictionary<string, object>();
        }

        static Dictionary<string, object> MouseV(Win w, Dictionary<string, object> a)
        {
            string action = J.S(a, "action");
            string button = J.S(a, "button") ?? "left";
            if (action == "down" || action == "up") In.MouseButton(w, action, button);
            else if (action == "move_rel") In.MoveRel(w, Math.Max(-2000, Math.Min(2000, J.I(a, "dx", 0))), Math.Max(-2000, Math.Min(2000, J.I(a, "dy", 0))), Math.Max(0, Math.Min(2000, J.I(a, "durationMs", 0))));
            else throw new HelperError("failed", "Unknown mouse action.");
            return new Dictionary<string, object>();
        }
    }
}


