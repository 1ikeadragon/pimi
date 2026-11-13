using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text;
using Interop.UIAutomationClient;

namespace PimiDesktopHelper
{
    class Node
    {
        public IUIAutomationElement El;
        public int Ct;
        public string Name = "", AutoId = "", Cls = "", Fw = "", AccessKey = "", Accel = "", Status = "";
        public RECT R;
        public bool Enabled = true, Offscreen, Focused, Focusable, Password;
        public bool Invoke, Toggle, Expand, SelItem, Value, Range, Scroll, Text, ScrollItem;
        public int ToggleState = -1, ExpandState = -1;
        public bool Selected;
        public int[] Rid;
        public List<Node> Kids = new List<Node>();
        public int Depth, Ref, OffscreenKids, MoreKids;
        public bool Interactive;
    }

    class FrameInfo { public double Scale = 1; public int OriginX, OriginY; }

    class Agent
    {
        public int Next = 1;
        public Dictionary<int, Node> Refs = new Dictionary<int, Node>();
        public Dictionary<int, Node> Prev = new Dictionary<int, Node>();
        public FrameInfo Frame;
    }

    static class Agents
    {
        static readonly Dictionary<string, Agent> d = new Dictionary<string, Agent>();
        public static Agent Get(string id)
        {
            id = id ?? "default";
            Agent a;
            if (!d.TryGetValue(id, out a)) { a = new Agent(); d[id] = a; }
            return a;
        }
    }

    static class U
    {
        public static readonly string[] Roles = {
            "button","calendar","checkbox","combobox","edit","hyperlink","image","listitem","list","menu","menubar","menuitem","progressbar","radiobutton","scrollbar","slider","spinner","statusbar","tab","tabitem","text","toolbar","tooltip","tree","treeitem","custom","group","thumb","datagrid","dataitem","document","splitbutton","window","pane","header","headeritem","table","titlebar","separator","semanticzoom","appbar" };
        const int CtButton = 50000, CtCheckBox = 50002, CtComboBox = 50003, CtEdit = 50004, CtHyperlink = 50005, CtImage = 50006, CtListItem = 50007, CtList = 50008, CtMenuItem = 50011,
            CtRadio = 50013, CtSlider = 50015, CtSpinner = 50016, CtTabItem = 50019, CtText = 50020, CtTree = 50023, CtTreeItem = 50024, CtCustom = 50025, CtGroup = 50026,
            CtDataGrid = 50028, CtDocument = 50030, CtSplitButton = 50031, CtWindow = 50032, CtPane = 50033, CtHeader = 50034, CtTable = 50036, CtTitleBar = 50037;

        static IUIAutomation6 a;
        static IUIAutomationCacheRequest cr;
        public static IUIAutomation6 A
        {
            get
            {
                if (a == null)
                {
                    a = (IUIAutomation6)new CUIAutomation8();
                    try { a.ConnectionTimeout = 2000; a.TransactionTimeout = 3000; } catch { }
                }
                return a;
            }
        }

        static readonly int[] CachedProps = { 30000, 30003, 30004, 30005, 30001, 30010, 30022, 30008, 30009, 30019, 30011, 30012, 30024, 30007, 30006, 30026,
            30031, 30028, 30041, 30036, 30043, 30033, 30034, 30040, 30035, 30086, 30070, 30079 };

        public static IUIAutomationCacheRequest CR
        {
            get
            {
                if (cr == null)
                {
                    var c = A.CreateCacheRequest();
                    foreach (var p in CachedProps) c.AddProperty(p);
                    c.TreeScope = (TreeScope)1;
                    c.AutomationElementMode = (AutomationElementMode)1;
                    cr = c;
                }
                return cr;
            }
        }

        static bool B(IUIAutomationElement e, int id)
        {
            try { object o = e.GetCachedPropertyValue(id); return o is bool && (bool)o; } catch { return false; }
        }
        static int I(IUIAutomationElement e, int id, int def)
        {
            try { object o = e.GetCachedPropertyValue(id); if (o is int) return (int)o; } catch { }
            return def;
        }

        public static Node ToNode(IUIAutomationElement e, int depth)
        {
            var n = new Node { El = e, Depth = depth };
            try { n.Ct = e.CachedControlType; } catch { }
            try { n.Name = e.CachedName ?? ""; } catch { }
            try { n.AutoId = e.CachedAutomationId ?? ""; } catch { }
            try { n.Cls = e.CachedClassName ?? ""; } catch { }
            try { n.Fw = e.CachedFrameworkId ?? ""; } catch { }
            try { n.AccessKey = e.CachedAccessKey ?? ""; } catch { }
            try { n.Accel = e.CachedAcceleratorKey ?? ""; } catch { }
            try { n.Status = e.CachedItemStatus ?? ""; } catch { }
            try { var r = e.CachedBoundingRectangle; n.R = new RECT { Left = r.left, Top = r.top, Right = r.right, Bottom = r.bottom }; } catch { }
            try { n.Enabled = e.CachedIsEnabled != 0; } catch { }
            try { n.Offscreen = e.CachedIsOffscreen != 0; } catch { }
            try { n.Focused = e.CachedHasKeyboardFocus != 0; } catch { }
            try { n.Focusable = e.CachedIsKeyboardFocusable != 0; } catch { }
            try { n.Password = e.CachedIsPassword != 0; } catch { }
            try { n.Rid = e.GetCachedPropertyValue(30000) as int[]; } catch { }
            n.Invoke = B(e, 30031); n.Expand = B(e, 30028); n.Toggle = B(e, 30041); n.SelItem = B(e, 30036); n.Value = B(e, 30043);
            n.Range = B(e, 30033); n.Scroll = B(e, 30034); n.Text = B(e, 30040); n.ScrollItem = B(e, 30035);
            if (n.Toggle) n.ToggleState = I(e, 30086, -1);
            if (n.Expand) n.ExpandState = I(e, 30070, -1);
            if (n.SelItem) n.Selected = B(e, 30079);
            n.Interactive = ComputeInteractive(n);
            return n;
        }

        static bool HasActions(Node n) { return n.Invoke || n.Toggle || n.Expand || n.SelItem || n.Value || n.Range; }

        static bool ComputeInteractive(Node n)
        {
            if (n.Offscreen || n.R.Empty) return false;
            if (n.Ct == CtWindow || n.Ct == CtTitleBar) return false;
            if (HasActions(n)) return true;
            if (n.Focusable)
            {
                switch (n.Ct)
                {
                    case CtButton: case CtCheckBox: case CtComboBox: case CtEdit: case CtHyperlink: case CtListItem: case CtMenuItem: case CtRadio:
                    case CtSlider: case CtSpinner: case CtTabItem: case CtTreeItem: case CtSplitButton: case CtDocument: return true;
                }
            }
            return false;
        }

        public static string Role(int ct) { int i = ct - 50000; return i >= 0 && i < Roles.Length ? Roles[i] : "element"; }
        public static int RoleId(string r)
        {
            if (string.IsNullOrEmpty(r)) return -1;
            int i = Array.IndexOf(Roles, r.ToLowerInvariant().Replace("-", "").Replace(" ", ""));
            return i < 0 ? -1 : 50000 + i;
        }

        public static double DefaultScale(RECT frame) { int m = Math.Max(frame.W, frame.H); return m <= 1280 ? 1.0 : 1280.0 / m; }

        // ---- Chromium wake-up ----
        static readonly HashSet<uint> awake = new HashSet<uint>();
        static readonly Guid IidAccessible = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");

        static void WakeChromium(Win w, IUIAutomationElement root)
        {
            if (awake.Contains(w.Pid)) return;
            var widgets = new List<IntPtr>();
            N.EnumChildWindows(w.Hwnd, (h, l) => { if (N.Class(h) == "Chrome_RenderWidgetHostHWND") widgets.Add(h); return true; }, IntPtr.Zero);
            foreach (var h in widgets)
            {
                try
                {
                    object o;
                    Guid iid = IidAccessible;
                    if (N.AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, out o) == 0 && o != null)
                    {
                        var acc = (Accessibility.IAccessible)o;
                        try { int c = acc.accChildCount; } catch { }
                        try { string nm = acc.get_accName(0); } catch { }
                    }
                }
                catch { }
                try
                {
                    var el = A.ElementFromHandleBuildCache(h, CR);
                    var kids = el.FindAllBuildCache((TreeScope)2, A.ControlViewCondition, CR);
                    int len = kids.Length;
                }
                catch { }
            }
            var sw = Stopwatch.StartNew();
            var cond = A.CreatePropertyCondition(30003, CtDocument);
            while (sw.ElapsedMilliseconds < 1500)
            {
                try
                {
                    var doc = root.FindFirst((TreeScope)4, cond);
                    if (doc != null)
                    {
                        var kid = A.ControlViewWalker.GetFirstChildElement(doc);
                        if (kid != null) { awake.Add(w.Pid); return; }
                    }
                }
                catch { }
                System.Threading.Thread.Sleep(100);
            }
        }

        // ---- walk ----
        public class Walked { public Node Root; public bool Truncated; public int Count; }

        public static Walked Walk(Win w, int maxNodes, int deadlineMs, bool wake)
        {
            IUIAutomationElement rootEl;
            try { rootEl = A.ElementFromHandle(w.Hwnd); }
            catch (Exception) { throw new HelperError("failed", "UI Automation could not open this window."); }
            if (wake && w.Class.StartsWith("Chrome_WidgetWin_")) WakeChromium(w, rootEl);
            var frame = N.FrameRect(w.Hwnd);
            var sw = Stopwatch.StartNew();
            var rootC = rootEl.BuildUpdatedCache(CR);
            var root = ToNode(rootC, 0);
            var res = new Walked { Root = root, Count = 1 };
            var q = new Queue<Node>();
            q.Enqueue(root);
            while (q.Count > 0)
            {
                if (sw.ElapsedMilliseconds > deadlineMs || res.Count >= maxNodes) { res.Truncated = true; break; }
                var p = q.Dequeue();
                if (p.Depth >= 40) continue;
                IUIAutomationElementArray arr;
                try { arr = p.El.FindAllBuildCache((TreeScope)2, A.ControlViewCondition, CR); } catch { continue; }
                int len = 0;
                try { len = arr.Length; } catch { }
                for (int i = 0; i < len; i++)
                {
                    if (res.Count >= maxNodes) { res.Truncated = true; p.MoreKids = len - i; break; }
                    IUIAutomationElement ce;
                    try { ce = arr.GetElement(i); } catch { continue; }
                    var c = ToNode(ce, p.Depth + 1);
                    bool off = c.Offscreen && (c.R.Empty || !Intersects(c.R, frame));
                    if (off) { p.OffscreenKids++; continue; }
                    p.Kids.Add(c);
                    res.Count++;
                    q.Enqueue(c);
                }
            }
            return res;
        }

        static bool Intersects(RECT a, RECT b) { return a.Left < b.Right && a.Right > b.Left && a.Top < b.Bottom && a.Bottom > b.Top; }

        // ---- quality ----
        static bool IsSysButton(Node n)
        {
            if (n.Ct != CtButton) return false;
            string s = n.Name.ToLowerInvariant();
            return s == "minimize" || s == "maximize" || s == "restore" || s == "close" || s == "system" || s.Contains("minimi") || s.Contains("maximi") || s.Contains("close") || s.Contains("restore");
        }

        public static string Quality(Node root)
        {
            int content = 0; bool interactive = false; bool opaqueOnly = true;
            Action<Node, bool> rec = null;
            rec = (n, inTitle) =>
            {
                foreach (var k in n.Kids)
                {
                    bool t = inTitle || k.Ct == CtTitleBar;
                    if (!t && !IsSysButton(k))
                    {
                        content++;
                        if (k.Interactive || (k.Ct != CtPane && k.Ct != CtCustom && k.Ct != CtDocument && k.Ct != CtGroup && !(k.Ct == CtText))) opaqueOnly = false;
                        if (k.Interactive) interactive = true;
                    }
                    rec(k, t);
                }
            };
            rec(root, false);
            if (content == 0) return "none";
            if (!interactive && opaqueOnly && content <= 3) return "weak";
            if (!interactive && content <= 2) return "weak";
            return "full";
        }

        // ---- rendering ----
        public class Ctx
        {
            public StringBuilder Sb = new StringBuilder();
            public double Scale; public int OX, OY;
            public bool InteractiveOnly, Register;
            public int Next = 1;
            public Dictionary<int, Node> Table = new Dictionary<int, Node>();
            public List<Node> Marked = new List<Node>();
        }

        static bool Container(int ct) { return ct == CtPane || ct == CtGroup || ct == CtCustom || ct == CtWindow || ct == CtHeader || ct == CtTable; }

        static bool Show(Node n, Ctx c)
        {
            if (c.InteractiveOnly) return n.Interactive;
            if (n.Ct == CtText) return n.Name.Length > 0 || HasActions(n);
            if (n.Ct == CtImage) return n.Name.Length > 0;
            if (Container(n.Ct) && n.Name.Length == 0 && !HasActions(n) && !n.Focused) return false;
            return true;
        }

        static string Esc(string s)
        {
            if (s == null) return "";
            if (s.Length > 80) s = s.Substring(0, 80) + "...";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
        }

        static string LiveValue(Node n)
        {
            if (!n.Value || n.Password) return null;
            switch (n.Ct) { case CtEdit: case CtComboBox: case CtDocument: case CtSpinner: break; default: return null; }
            try
            {
                var vp = (IUIAutomationValuePattern)n.El.GetCurrentPattern(10002);
                string v = vp.CurrentValue;
                return v == null ? null : v;
            }
            catch { return null; }
        }

        public static string Line(Node n, Ctx c)
        {
            var sb = new StringBuilder();
            string role = Role(n.Ct);
            if (n.Ct == CtText && !HasActions(n)) return "- text: \"" + Esc(n.Name) + "\"";
            sb.Append("- ").Append(role);
            if (n.Name.Length > 0) sb.Append(" \"").Append(Esc(n.Name)).Append('"');
            var at = new List<string>();
            bool wantRef = n.Name.Length > 0 || HasActions(n) || n.Interactive;
            if (wantRef && c.Register)
            {
                n.Ref = c.Next++;
                c.Table[n.Ref] = n;
                at.Add("ref=@d" + n.Ref);
                c.Marked.Add(n);
            }
            if (n.Focused) at.Add("focused");
            if (!n.Enabled) at.Add("disabled");
            if (n.Toggle && n.ToggleState >= 0) at.Add("toggle=" + (n.ToggleState == 1 ? "on" : n.ToggleState == 0 ? "off" : "mixed"));
            if (n.Expand && n.ExpandState >= 0) at.Add(n.ExpandState == 1 ? "expanded" : n.ExpandState == 0 ? "collapsed" : "partial");
            if (n.SelItem && n.Selected) at.Add("selected");
            string val = LiveValue(n);
            if (val != null) at.Add("value=\"" + Esc(val) + "\"");
            var ac = new List<string>();
            if (n.Invoke) ac.Add("invoke"); if (n.Toggle) ac.Add("toggle"); if (n.Expand) ac.Add("expand"); if (n.SelItem) ac.Add("select");
            if (n.Value) ac.Add("value"); if (n.Range) ac.Add("range"); if (n.Scroll) ac.Add("scroll"); if (n.Text) ac.Add("text");
            if (ac.Count > 0) at.Add("actions=" + string.Join(",", ac));
            if (n.Accel.Length > 0) at.Add("key=\"" + Esc(n.Accel) + "\"");
            if (!n.R.Empty)
                at.Add(string.Format(CultureInfo.InvariantCulture, "rect={0},{1},{2},{3}",
                    (int)Math.Round((n.R.Left - c.OX) * c.Scale), (int)Math.Round((n.R.Top - c.OY) * c.Scale), (int)Math.Round(n.R.W * c.Scale), (int)Math.Round(n.R.H * c.Scale)));
            if (at.Count > 0) sb.Append(" [").Append(string.Join(" ", at)).Append(']');
            return sb.ToString();
        }

        static void Render(Node n, int indent, Ctx c)
        {
            bool show = Show(n, c);
            if (show) { c.Sb.Append(' ', indent * 2).Append(Line(n, c)).Append('\n'); }
            int ci = show ? indent + 1 : indent;
            foreach (var k in n.Kids) Render(k, ci, c);
            if (!c.InteractiveOnly)
            {
                if (n.OffscreenKids > 0) c.Sb.Append(' ', ci * 2).Append("- ... ").Append(n.OffscreenKids).Append(" offscreen items\n");
                if (n.MoreKids > 0) c.Sb.Append(' ', ci * 2).Append("- ... ").Append(n.MoreKids).Append(" more items not read (node limit)\n");
            }
        }

        public static Dictionary<string, object> Snapshot(Win w, Dictionary<string, object> args, Agent ag, bool register, bool interactiveOverride = false)
        {
            var sw = Stopwatch.StartNew();
            bool inter = interactiveOverride || J.B(args, "interactiveOnly", false);
            int max = Math.Max(10, Math.Min(2000, J.I(args, "maxNodes", 800)));
            var walked = Walk(w, max, 2000, true);
            var frame = N.FrameRect(w.Hwnd);
            var c = new Ctx { Scale = DefaultScale(frame), OX = frame.Left, OY = frame.Top, InteractiveOnly = inter, Register = register };
            Node start = walked.Root;
            string rootRef = J.S(args, "root");
            if (rootRef != null) { start = GetRef(ag, rootRef); }
            string q = Quality(walked.Root);
            if (register && rootRef == null) c.Next = 1; else if (register) c.Next = ag.Next;
            string fw = Wn.FrameworkOf(w, walked.Root.Fw);
            var sb = c.Sb;
            sb.AppendFormat(CultureInfo.InvariantCulture, "window \"{0}\" [framework={1} dpi={2} scale={3:0.###} size={4}x{5} tree={6}]\n", Esc(w.Title), fw, N.Dpi(w.Hwnd), c.Scale, frame.W, frame.H, q);
            if (rootRef != null) { Render(start, 1, c); }
            else foreach (var k in walked.Root.Kids) Render(k, 1, c);
            if (walked.Root.OffscreenKids > 0) sb.Append("  - ... ").Append(walked.Root.OffscreenKids).Append(" offscreen items\n");
            if (walked.Truncated) sb.Append("(truncated: node or time limit reached)\n");
            if (q == "none") sb.Append("No accessibility tree. Use desktop_screenshot (grid: true) and click coordinates.\n");
            if (register)
            {
                if (rootRef == null) { ag.Prev = ag.Refs; ag.Refs = c.Table; }
                else foreach (var kv in c.Table) ag.Refs[kv.Key] = kv.Value;
                ag.Next = c.Next;
            }
            Lastctx = c;
            return new Dictionary<string, object> { { "tree", sb.ToString().TrimEnd('\n') }, { "truncated", walked.Truncated }, { "treeQuality", q }, { "nodeCount", walked.Count } };
        }
        public static Ctx Lastctx;

        // ---- refs ----
        public static Node GetRef(Agent ag, string r)
        {
            int n;
            if (r == null || !r.StartsWith("@d") || !int.TryParse(r.Substring(2), out n)) throw new HelperError("failed", "Bad ref; refs look like @d12.");
            Node nd;
            if (!ag.Refs.TryGetValue(n, out nd)) throw new HelperError("stale_ref", "Unknown ref " + r + "; take a new snapshot.");
            if (!Alive(nd)) throw new HelperError("stale_ref", "Ref " + r + " no longer matches the element; take a new snapshot.");
            return nd;
        }

        public static bool Alive(Node nd)
        {
            try
            {
                int ct = nd.El.CurrentControlType;
                if (ct != nd.Ct) return false;
                var rid = nd.El.GetCurrentPropertyValue(30000) as int[];
                if (nd.Rid != null && rid != null && !nd.Rid.SequenceEqual(rid)) return false;
                if (nd.Ct != CtText && nd.Ct != CtDocument && nd.Ct != CtEdit && nd.Ct != CtPane && nd.Ct != CtWindow && nd.Ct != CtTitleBar && nd.Ct != 50017)
                    if ((nd.El.CurrentName ?? "") != nd.Name) return false;
                return true;
            }
            catch { return false; }
        }

        // ---- find ----
        public static object Find(Win w, Dictionary<string, object> a, Agent ag)
        {
            var frame = N.FrameRect(w.Hwnd);
            IUIAutomationElement root = A.ElementFromHandle(w.Hwnd);
            IUIAutomationCondition cond = A.ControlViewCondition;
            string name = J.S(a, "name"), contains = J.S(a, "nameContains"), role = J.S(a, "role"), aid = J.S(a, "automationId");
            if (name != null) cond = A.CreateAndCondition(cond, A.CreatePropertyCondition(30005, name));
            if (aid != null) cond = A.CreateAndCondition(cond, A.CreatePropertyCondition(30011, aid));
            if (role != null)
            {
                int id = RoleId(role);
                if (id < 0) throw new HelperError("failed", "Unknown role '" + role + "'.");
                cond = A.CreateAndCondition(cond, A.CreatePropertyCondition(30003, id));
            }
            int limit = Math.Max(1, Math.Min(50, J.I(a, "limit", 20)));
            var arr = root.FindAllBuildCache((TreeScope)4, cond, CR);
            var c = new Ctx { Scale = DefaultScale(frame), OX = frame.Left, OY = frame.Top, Register = true, Next = ag.Next, Table = ag.Refs };
            var sb = new StringBuilder();
            int found = 0;
            for (int i = 0; i < arr.Length && found < limit; i++)
            {
                var n = ToNode(arr.GetElement(i), 0);
                if (contains != null && n.Name.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0) continue;
                sb.Append(Line(n, c)).Append('\n');
                found++;
            }
            ag.Next = c.Next;
            return new Dictionary<string, object> { { "matches", found == 0 ? "(no matches)" : sb.ToString().TrimEnd('\n') } };
        }

        // ---- element ----
        public static object Element(Win w, Dictionary<string, object> a, Agent ag, Func<POINT, bool> pointOk)
        {
            Node n;
            if (J.S(a, "element") != null) n = GetRef(ag, J.S(a, "element"));
            else
            {
                var pt = J.O(a, "point");
                if (pt == null) throw new HelperError("failed", "element needs a ref or a point.");
                POINT sp = In.MapPoint(w, ag, J.D(pt, "x"), J.D(pt, "y"));
                if (!pointOk(sp)) throw new HelperError("refused", "That point is outside the target window.");
                n = ToNode(A.ElementFromPointBuildCache(new tagPOINT { x = sp.X, y = sp.Y }, CR), 0);
            }
            var e = n.El;
            var sb = new StringBuilder();
            Action<string, object> kv = (k, v) => sb.Append(k).Append(": ").Append(v).Append('\n');
            kv("role", Role(n.Ct)); kv("name", n.Name);
            try { kv("localizedControlType", e.CurrentLocalizedControlType); } catch { }
            kv("automationId", n.AutoId); kv("className", n.Cls); kv("frameworkId", n.Fw);
            try { kv("helpText", e.CurrentHelpText); } catch { }
            kv("rect(physical)", n.R.Left + "," + n.R.Top + "," + n.R.W + "," + n.R.H);
            kv("enabled", n.Enabled); kv("offscreen", n.Offscreen); kv("focused", n.Focused); kv("focusable", n.Focusable); kv("password", n.Password);
            kv("accessKey", n.AccessKey); kv("acceleratorKey", n.Accel); kv("itemStatus", n.Status);
            try { kv("nativeWindowHandle", e.CurrentNativeWindowHandle); } catch { }
            var ac = new List<string>();
            if (n.Invoke) ac.Add("invoke"); if (n.Toggle) ac.Add("toggle"); if (n.Expand) ac.Add("expandcollapse"); if (n.SelItem) ac.Add("selectionitem");
            if (n.Value) ac.Add("value"); if (n.Range) ac.Add("rangevalue"); if (n.Scroll) ac.Add("scroll"); if (n.Text) ac.Add("text"); if (n.ScrollItem) ac.Add("scrollitem");
            kv("patterns", string.Join(",", ac));
            if (n.Toggle) kv("toggleState", n.ToggleState == 1 ? "on" : n.ToggleState == 0 ? "off" : "indeterminate");
            if (n.Expand) kv("expandState", n.ExpandState);
            if (n.SelItem) kv("selected", n.Selected);
            if (n.Range)
            {
                try { var rp = (IUIAutomationRangeValuePattern)e.GetCurrentPattern(10003); kv("range", rp.CurrentValue + " [" + rp.CurrentMinimum + ".." + rp.CurrentMaximum + "]"); } catch { }
            }
            if (n.Value && !n.Password)
            {
                try { var vp = (IUIAutomationValuePattern)e.GetCurrentPattern(10002); kv("readOnly", vp.CurrentIsReadOnly != 0); kv("value", Esc(vp.CurrentValue)); } catch { }
            }
            if (J.B(a, "text", false) && !n.Password)
            {
                string t = null;
                try { if (n.Text) t = ((IUIAutomationTextPattern)e.GetCurrentPattern(10014)).DocumentRange.GetText(4000); } catch { }
                if (t == null && n.Value) { try { t = ((IUIAutomationValuePattern)e.GetCurrentPattern(10002)).CurrentValue; } catch { } }
                if (t != null) { if (t.Length > 4000) t = t.Substring(0, 4000); sb.Append("text:\n").Append(t).Append('\n'); }
            }
            return new Dictionary<string, object> { { "details", sb.ToString().TrimEnd('\n') } };
        }

        // ---- audit ----
        public static object Audit(Win w)
        {
            var frame = N.FrameRect(w.Hwnd);
            int dpi = N.Dpi(w.Hwnd);
            double min = 24.0 * dpi / 96.0;
            var walked = Walk(w, 2500, 3500, true);
            var all = new List<Node>();
            Action<Node> rec = null;
            rec = n => { all.Add(n); foreach (var k in n.Kids) rec(k); };
            rec(walked.Root);
            var sb = new StringBuilder();
            Func<Node, string> d = n => Role(n.Ct) + " \"" + Esc(n.Name) + "\"" + (n.AutoId.Length > 0 ? " id=" + n.AutoId : "") + " rect=" + n.R.Left + "," + n.R.Top + "," + n.R.W + "," + n.R.H;
            sb.AppendFormat("Audit of \"{0}\": {1} nodes read{2}, dpi {3}\n", Esc(w.Title), walked.Count, walked.Truncated ? " (truncated)" : "", dpi);
            var l1 = all.Where(n => n.Focusable && n.Enabled && n.Name.Length == 0 && n.Ct != CtWindow && n.Ct != CtPane && n.Ct != CtDocument).Take(30).ToList();
            sb.Append("\nFocusable elements with no name (" + l1.Count + "):\n"); foreach (var n in l1) sb.Append("  ").Append(d(n)).Append('\n');
            var l2 = all.Where(n => n.Interactive && n.Enabled && n.Ct != CtDocument && n.Ct != CtEdit && (n.R.W < min || n.R.H < min)).Take(30).ToList();
            sb.Append("\nInteractive elements smaller than 24x24 DIP (" + min.ToString("0") + " px at this DPI) (" + l2.Count + "):\n");
            foreach (var n in l2) sb.Append("  ").Append(d(n)).Append(string.Format("  size={0}x{1}px = {2:0}x{3:0}dip\n", n.R.W, n.R.H, n.R.W * 96.0 / dpi, n.R.H * 96.0 / dpi));
            var l3 = all.Where(n => n.Enabled && !n.R.Empty && (n.Interactive || HasActions(n)) && n != walked.Root &&
                (n.Offscreen || n.R.Left < frame.Left - 2 || n.R.Top < frame.Top - 2 || n.R.Right > frame.Right + 2 || n.R.Bottom > frame.Bottom + 2)).Take(30).ToList();
            sb.Append("\nEnabled elements clipped or offscreen (" + l3.Count + "):\n"); foreach (var n in l3) sb.Append("  ").Append(d(n)).Append(n.Offscreen ? " [offscreen]" : " [outside window]").Append('\n');
            var l4 = all.Where(n => n.Ct == CtImage && n.Name.Length == 0 && !n.R.Empty).Take(30).ToList();
            sb.Append("\nImages with no name (" + l4.Count + "):\n"); foreach (var n in l4) sb.Append("  ").Append(d(n)).Append('\n');
            var dup = all.Where(n => n.AccessKey.Length > 0).GroupBy(n => n.AccessKey.ToLowerInvariant()).Where(g => g.Count() > 1).ToList();
            sb.Append("\nDuplicate access keys (" + dup.Count + "):\n"); foreach (var g in dup) sb.Append("  ").Append(g.Key).Append(": ").Append(string.Join("; ", g.Take(6).Select(x => Role(x.Ct) + " \"" + Esc(x.Name) + "\""))).Append('\n');
            var tab = all.Where(n => n.Focusable && n.Enabled && !n.Offscreen && !n.R.Empty).Take(60).ToList();
            sb.Append("\nTab order (first " + tab.Count + " focusable elements, tree order):\n");
            int i = 1; foreach (var n in tab) sb.Append("  ").Append(i++).Append(". ").Append(Role(n.Ct)).Append(" \"").Append(Esc(n.Name)).Append("\"\n");
            return new Dictionary<string, object> { { "report", sb.ToString().TrimEnd('\n') } };
        }
    }
}
