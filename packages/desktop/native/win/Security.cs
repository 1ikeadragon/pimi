using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

namespace PimiDesktopHelper
{
    // Read-only forensic verbs: inspect, ipc, deeplink, scope. Nothing here opens a file, pipe, key or process for write.
    using D = Dictionary<string, object>;

    static class SecN
    {
        [DllImport("wintrust.dll", CharSet = CharSet.Unicode)] public static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, IntPtr data);
        [DllImport("kernel32.dll")] public static extern bool GetProcessMitigationPolicy(IntPtr h, int policy, byte[] buf, UIntPtr len);
        [DllImport("kernel32.dll")] public static extern bool GetProcessHandleCount(IntPtr h, out uint count);
        [DllImport("kernel32.dll")] public static extern bool IsWow64Process(IntPtr h, out bool wow);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetFinalPathNameByHandle(IntPtr h, StringBuilder sb, uint n, uint flags);
        [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
        [DllImport("kernel32.dll")] public static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, uint access, bool inherit, uint opts);
        [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
        [DllImport("psapi.dll", SetLastError = true)] public static extern bool EnumProcessModulesEx(IntPtr h, [Out] IntPtr[] mods, int cb, out int needed, uint filter);
        [DllImport("psapi.dll", CharSet = CharSet.Unicode)] public static extern uint GetModuleFileNameEx(IntPtr h, IntPtr mod, StringBuilder sb, int n);
        [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
        [DllImport("ntdll.dll")] public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
        [DllImport("ntdll.dll")] public static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int len, out int ret);
        [DllImport("ntdll.dll")] public static extern int NtQueryInformationFile(IntPtr h, out IOSB iosb, IntPtr buf, uint len, int cls);
        [DllImport("advapi32.dll")] public static extern uint GetSecurityInfo(IntPtr h, int objType, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
        [DllImport("advapi32.dll")] public static extern uint GetSecurityDescriptorLength(IntPtr sd);
        [DllImport("iphlpapi.dll")] public static extern int GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int cls, int reserved);
        [DllImport("iphlpapi.dll")] public static extern int GetExtendedUdpTable(IntPtr table, ref int size, bool order, int af, int cls, int reserved);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CommandLineToArgvW(string cmd, out int argc);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ShellExecuteEx(ref SHELLEXECUTEINFO i);

        [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr ExitStatus, PebBaseAddress, AffinityMask, BasePriority, UniqueProcessId, InheritedFromUniqueProcessId; }
        [StructLayout(LayoutKind.Sequential)] public struct IOSB { public IntPtr Status, Information; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct SHELLEXECUTEINFO
        {
            public int cbSize; public uint fMask; public IntPtr hwnd; public string lpVerb, lpFile, lpParameters, lpDirectory;
            public int nShow; public IntPtr hInstApp, lpIDList; public string lpClass; public IntPtr hkeyClass; public uint dwHotKey, hIconOrMonitor_pad; public IntPtr hIcon, hProcess;
        }
        [StructLayout(LayoutKind.Sequential)] public struct WTFILE { public uint cb; public IntPtr path, hFile, known; }
        [StructLayout(LayoutKind.Sequential)]
        public struct WTDATA
        {
            public uint cb; public IntPtr policyCb, sipCb; public uint ui, revoke, unionChoice; public IntPtr file; public uint stateAction; public IntPtr stateData, urlRef;
            public uint provFlags, uiContext; public IntPtr sigSettings;
        }
    }

    static class Fmt
    {
        static bool Scalar(object o) { return o == null || o is string || o is bool || o is int || o is long || o is double || o is uint || o is ulong || o is ushort; }

        static string One(object o)
        {
            if (o == null) return "null";
            var s = Convert.ToString(o, System.Globalization.CultureInfo.InvariantCulture);
            return s.Length > 300 ? s.Substring(0, 300) + "..." : s;
        }

        public static string Text(object o)
        {
            var sb = new StringBuilder();
            Write(sb, o, 0);
            return sb.ToString().TrimEnd('\n');
        }

        static void Write(StringBuilder sb, object o, int ind)
        {
            string pad = new string(' ', ind * 2);
            var d = o as D;
            if (d != null)
            {
                foreach (var kv in d)
                {
                    if (Scalar(kv.Value)) sb.Append(pad).Append(kv.Key).Append(": ").Append(One(kv.Value)).Append('\n');
                    else
                    {
                        var l = kv.Value as System.Collections.IList;
                        if (l != null && l.Count == 0) { sb.Append(pad).Append(kv.Key).Append(": (none)\n"); continue; }
                        sb.Append(pad).Append(kv.Key).Append(":\n");
                        Write(sb, kv.Value, ind + 1);
                    }
                }
                return;
            }
            var list = o as System.Collections.IEnumerable;
            if (list != null && !(o is string))
            {
                foreach (var it in list)
                {
                    var dd = it as D;
                    if (dd != null && dd.Values.All(Scalar))
                        sb.Append(pad).Append("- ").Append(string.Join(" ", dd.Select(kv => kv.Key + "=" + One(kv.Value)))).Append('\n');
                    else if (Scalar(it)) sb.Append(pad).Append("- ").Append(One(it)).Append('\n');
                    else { sb.Append(pad).Append("-\n"); Write(sb, it, ind + 1); }
                }
                return;
            }
            sb.Append(pad).Append(One(o)).Append('\n');
        }
    }

    static class Redact
    {
        static readonly Regex SecretKey = new Regex("(token|secret|passw|pwd|key|auth|bearer|cookie|credential|sig)", RegexOptions.IgnoreCase);
        static readonly Regex TokenLike = new Regex("^[A-Za-z0-9_\\-+/=.~]{20,}$");

        public static string Value(string key, string v)
        {
            if (v == null) return "";
            if (SecretKey.IsMatch(key ?? "") && v.Length > 0) return "<redacted len " + v.Length + ">";
            if (TokenLike.IsMatch(v)) return v.Substring(0, 4) + "...<len " + v.Length + ">";
            return v.Length > 80 ? v.Substring(0, 80) + "..." : v;
        }

        public static string Arg(string a)
        {
            if (a == null) return "";
            int eq = a.IndexOf('=');
            if (a.StartsWith("-") && eq < 0) return a.Length > 60 ? a.Substring(0, 60) + "..." : a;
            if (a.StartsWith("-") && eq > 0) return a.Substring(0, eq + 1) + Value(a.Substring(0, eq), a.Substring(eq + 1));
            if (a.Contains("://"))
            {
                try { var u = new Uri(a); return u.Scheme + "://" + u.Host + (u.IsDefaultPort ? "" : ":" + u.Port) + (u.AbsolutePath.Length > 40 ? u.AbsolutePath.Substring(0, 40) + "..." : u.AbsolutePath) + (u.Query.Length > 0 ? "?<" + u.Query.Length + " chars>" : ""); }
                catch { }
            }
            return Value("", a);
        }
    }

    static class Pe
    {
        public class Info
        {
            public bool Valid, Is64;
            public ushort Machine, DllChar, FileChar;
            public uint ClrRva, ClrSize, LoadCfgRva;
            public uint ClrFlags;
            public bool StrongNameDir;
        }

        public static Info Read(string path)
        {
            var pe = new Info();
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    var b = new byte[8192];
                    int n = fs.Read(b, 0, b.Length);
                    if (n < 0x100 || b[0] != 'M' || b[1] != 'Z') return pe;
                    int lfa = BitConverter.ToInt32(b, 0x3C);
                    if (lfa < 0 || lfa + 0x108 > n || b[lfa] != 'P' || b[lfa + 1] != 'E') return pe;
                    pe.Machine = BitConverter.ToUInt16(b, lfa + 4);
                    int nsec = BitConverter.ToUInt16(b, lfa + 6);
                    int optSize = BitConverter.ToUInt16(b, lfa + 20);
                    pe.FileChar = BitConverter.ToUInt16(b, lfa + 22);
                    int opt = lfa + 24;
                    ushort magic = BitConverter.ToUInt16(b, opt);
                    pe.Is64 = magic == 0x20B;
                    pe.DllChar = BitConverter.ToUInt16(b, opt + 70);
                    int dd = opt + (pe.Is64 ? 112 : 96);
                    if (dd + 15 * 8 > n) { pe.Valid = true; return pe; }
                    pe.LoadCfgRva = BitConverter.ToUInt32(b, dd + 10 * 8);
                    pe.ClrRva = BitConverter.ToUInt32(b, dd + 14 * 8);
                    pe.ClrSize = BitConverter.ToUInt32(b, dd + 14 * 8 + 4);
                    pe.Valid = true;
                    if (pe.ClrRva != 0)
                    {
                        int sec = opt + optSize;
                        for (int i = 0; i < nsec && sec + 40 <= n; i++, sec += 40)
                        {
                            uint va = BitConverter.ToUInt32(b, sec + 12), vs = BitConverter.ToUInt32(b, sec + 8), raw = BitConverter.ToUInt32(b, sec + 20);
                            if (pe.ClrRva >= va && pe.ClrRva < va + Math.Max(vs, 1))
                            {
                                long off = raw + (pe.ClrRva - va);
                                var c = new byte[48];
                                fs.Seek(off, SeekOrigin.Begin);
                                if (fs.Read(c, 0, 48) == 48)
                                {
                                    pe.ClrFlags = BitConverter.ToUInt32(c, 16);
                                    pe.StrongNameDir = BitConverter.ToUInt32(c, 32) != 0;
                                }
                                break;
                            }
                        }
                    }
                }
            }
            catch { }
            return pe;
        }

        public static D Mitigations(Info pe)
        {
            var d = new D();
            if (!pe.Valid) { d["valid"] = false; return d; }
            d["arch"] = pe.Machine == 0x8664 ? "x64" : pe.Machine == 0x14c ? "x86" : pe.Machine == 0xAA64 ? "arm64" : "0x" + pe.Machine.ToString("x");
            d["dynamicBase(ASLR)"] = (pe.DllChar & 0x40) != 0;
            d["relocsStripped"] = (pe.FileChar & 0x1) != 0;
            d["highEntropyVA"] = (pe.DllChar & 0x20) != 0;
            d["nxCompat(DEP)"] = (pe.DllChar & 0x100) != 0;
            d["controlFlowGuard"] = (pe.DllChar & 0x4000) != 0;
            d["forceIntegrity"] = (pe.DllChar & 0x80) != 0;
            if (!pe.Is64) d["noSEH"] = (pe.DllChar & 0x400) != 0;
            d["appContainer"] = (pe.DllChar & 0x1000) != 0;
            return d;
        }
    }

    static class Scan
    {
        static int IndexOf(byte[] buf, byte[] nd, int start, int total)
        {
            int last = total - nd.Length;
            int i = start;
            while (i <= last)
            {
                i = Array.IndexOf(buf, nd[0], i, last - i + 1);
                if (i < 0) return -1;
                int k = 1;
                while (k < nd.Length && buf[i + k] == nd[k]) k++;
                if (k == nd.Length) return i;
                i++;
            }
            return -1;
        }

        public static List<long>[] Multi(string path, byte[][] nd, int maxHits, long maxBytes)
        {
            var res = nd.Select(_ => new List<long>()).ToArray();
            try
            {
                int maxLen = nd.Max(n => n.Length);
                const int chunk = 4 << 20;
                var buf = new byte[chunk + maxLen];
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16))
                {
                    long limit = Math.Min(fs.Length, maxBytes), pos = 0;
                    int carry = 0;
                    while (pos < limit)
                    {
                        int read = fs.Read(buf, carry, chunk);
                        if (read <= 0) break;
                        int total = carry + read;
                        for (int i = 0; i < nd.Length; i++)
                        {
                            int s = 0;
                            while (res[i].Count < maxHits && (s = IndexOf(buf, nd[i], s, total)) >= 0)
                            {
                                if (carry == 0 || s + nd[i].Length > carry) res[i].Add(pos - carry + s);
                                s++;
                            }
                        }
                        carry = Math.Min(maxLen - 1, total);
                        Buffer.BlockCopy(buf, total - carry, buf, 0, carry);
                        pos += read;
                    }
                }
            }
            catch { }
            return res;
        }

        public static byte[] Ascii(string s) { return Encoding.ASCII.GetBytes(s); }
        public static byte[] Utf16(string s) { return Encoding.Unicode.GetBytes(s); }
    }

    static class Canon
    {
        // Final path of an existing file or directory, with symlinks and junctions resolved. Opens for attribute query only.
        public static string Of(string path)
        {
            try
            {
                IntPtr h = SecN.CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
                if (h == new IntPtr(-1)) return null;
                try
                {
                    var sb = new StringBuilder(1024);
                    uint n = SecN.GetFinalPathNameByHandle(h, sb, 1024, 0);
                    if (n == 0 || n > 1024) return null;
                    string s = sb.ToString();
                    if (s.StartsWith("\\\\?\\UNC\\")) s = "\\\\" + s.Substring(8);
                    else if (s.StartsWith("\\\\?\\")) s = s.Substring(4);
                    return s.TrimEnd('\\');
                }
                finally { N.CloseHandle(h); }
            }
            catch { return null; }
        }

        public static bool Under(string path, string root)
        {
            if (path == null || root == null) return false;
            string p = path.TrimEnd('\\').ToLowerInvariant(), r = root.TrimEnd('\\').ToLowerInvariant();
            return p == r || p.StartsWith(r + "\\");
        }
    }

    static class AclUtil
    {
        static readonly string[] LowPrivSids = { "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-4", "S-1-15-2-1" };
        const int WriteMask = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

        static string Name(SecurityIdentifier sid)
        {
            try { return sid.Translate(typeof(NTAccount)).Value; } catch { return sid.Value; }
        }

        public static D Check(string dir, string kind)
        {
            var d = new D { { "path", dir }, { "kind", kind } };
            try
            {
                if (!Directory.Exists(dir)) { d["exists"] = false; return d; }
                var sec = new DirectoryInfo(dir).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
                var me = WindowsIdentity.GetCurrent();
                var mine = new HashSet<string>();
                if (me.User != null) mine.Add(me.User.Value);
                if (me.Groups != null) foreach (var g in me.Groups) mine.Add(g.Value);
                try { d["owner"] = Name((SecurityIdentifier)sec.GetOwner(typeof(SecurityIdentifier))); } catch { }
                var writers = new List<string>();
                int allowTok = 0, denyTok = 0;
                var denyBy = new Dictionary<string, int>();
                var rules = sec.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>().ToList();
                foreach (var r in rules)
                {
                    if ((r.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                    var sid = (SecurityIdentifier)r.IdentityReference;
                    int rights = (int)r.FileSystemRights;
                    if (r.AccessControlType == AccessControlType.Deny)
                    {
                        int cur; denyBy.TryGetValue(sid.Value, out cur); denyBy[sid.Value] = cur | rights;
                        if (mine.Contains(sid.Value)) denyTok |= rights;
                    }
                    else if (mine.Contains(sid.Value)) allowTok |= rights;
                }
                foreach (var r in rules)
                {
                    if (r.AccessControlType != AccessControlType.Allow || (r.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                    var sid = (SecurityIdentifier)r.IdentityReference;
                    bool lowPriv = LowPrivSids.Contains(sid.Value) || (me.User != null && sid.Value == me.User.Value);
                    if (!lowPriv) continue;
                    int eff = (int)r.FileSystemRights & WriteMask;
                    int den; if (denyBy.TryGetValue(sid.Value, out den)) eff &= ~den;
                    if (eff != 0) writers.Add(Name(sid) + " (0x" + ((int)r.FileSystemRights).ToString("x") + ")");
                }
                d["exists"] = true;
                d["writableByUnprivileged"] = writers.Count > 0;
                d["writers"] = writers.Distinct().ToList();
                d["writableByHelperToken"] = ((allowTok & ~denyTok) & WriteMask) != 0;
            }
            catch (Exception ex) { d["error"] = ex.GetType().Name; }
            return d;
        }

        public static bool LowPrivWritable(string dir, Dictionary<string, D> cache)
        {
            D d;
            if (!cache.TryGetValue(dir, out d)) { d = Check(dir, "module"); cache[dir] = d; }
            object v; return d.TryGetValue("writableByUnprivileged", out v) && v is bool && (bool)v;
        }
    }

    static class NetTables
    {
        public class Row { public string Proto, Local, Remote, State; public int LPort, RPort; public uint Pid; public string Bind; }

        static int Port(uint raw) { return (int)(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF)); }
        static readonly string[] States = { "", "CLOSED", "LISTEN", "SYN_SENT", "SYN_RCVD", "ESTABLISHED", "FIN_WAIT1", "FIN_WAIT2", "CLOSE_WAIT", "CLOSING", "LAST_ACK", "TIME_WAIT", "DELETE_TCB" };

        static string Bind(string addr)
        {
            if (addr == "0.0.0.0" || addr == "::") return "any";
            if (addr == "127.0.0.1" || addr == "::1") return "loopback";
            return "lan";
        }

        public static List<Row> All(HashSet<uint> pids)
        {
            var rows = new List<Row>();
            Tcp(2, pids, rows); Tcp(23, pids, rows); Udp(2, pids, rows); Udp(23, pids, rows);
            return rows;
        }

        static void Tcp(int af, HashSet<uint> pids, List<Row> rows)
        {
            int size = 0;
            SecN.GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 5, 0);
            for (int attempt = 0; attempt < 4; attempt++)
            {
                size += 8192;
                IntPtr buf = Marshal.AllocHGlobal(size);
                try
                {
                    int rc = SecN.GetExtendedTcpTable(buf, ref size, false, af, 5, 0);
                    if (rc == 122) continue;
                    if (rc != 0) return;
                    int n = Marshal.ReadInt32(buf);
                    IntPtr p = buf + 4;
                    int rowSize = af == 2 ? 24 : 56;
                    for (int i = 0; i < n; i++, p += rowSize)
                    {
                        uint pid, state; IPAddress la, ra; int lp, rp;
                        if (af == 2)
                        {
                            state = (uint)Marshal.ReadInt32(p); la = new IPAddress((uint)Marshal.ReadInt32(p, 4)); lp = Port((uint)Marshal.ReadInt32(p, 8));
                            ra = new IPAddress((uint)Marshal.ReadInt32(p, 12)); rp = Port((uint)Marshal.ReadInt32(p, 16)); pid = (uint)Marshal.ReadInt32(p, 20);
                        }
                        else
                        {
                            var lb = new byte[16]; Marshal.Copy(p, lb, 0, 16); la = new IPAddress(lb);
                            lp = Port((uint)Marshal.ReadInt32(p, 20));
                            var rb = new byte[16]; Marshal.Copy(p + 24, rb, 0, 16); ra = new IPAddress(rb);
                            rp = Port((uint)Marshal.ReadInt32(p, 44));
                            state = (uint)Marshal.ReadInt32(p, 48); pid = (uint)Marshal.ReadInt32(p, 52);
                        }
                        if (!pids.Contains(pid)) continue;
                        string l = la.IsIPv4MappedToIPv6 ? la.MapToIPv4().ToString() : la.ToString();
                        rows.Add(new Row { Proto = af == 2 ? "tcp" : "tcp6", Local = l, LPort = lp, Remote = ra.ToString(), RPort = rp, State = state < States.Length ? States[state] : state.ToString(), Pid = pid, Bind = Bind(l) });
                    }
                    return;
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
        }

        static void Udp(int af, HashSet<uint> pids, List<Row> rows)
        {
            int size = 0;
            SecN.GetExtendedUdpTable(IntPtr.Zero, ref size, false, af, 1, 0);
            for (int attempt = 0; attempt < 4; attempt++)
            {
                size += 8192;
                IntPtr buf = Marshal.AllocHGlobal(size);
                try
                {
                    int rc = SecN.GetExtendedUdpTable(buf, ref size, false, af, 1, 0);
                    if (rc == 122) continue;
                    if (rc != 0) return;
                    int n = Marshal.ReadInt32(buf);
                    IntPtr p = buf + 4;
                    int rowSize = af == 2 ? 12 : 28;
                    for (int i = 0; i < n; i++, p += rowSize)
                    {
                        uint pid; IPAddress la; int lp;
                        if (af == 2) { la = new IPAddress((uint)Marshal.ReadInt32(p)); lp = Port((uint)Marshal.ReadInt32(p, 4)); pid = (uint)Marshal.ReadInt32(p, 8); }
                        else { var lb = new byte[16]; Marshal.Copy(p, lb, 0, 16); la = new IPAddress(lb); lp = Port((uint)Marshal.ReadInt32(p, 20)); pid = (uint)Marshal.ReadInt32(p, 24); }
                        if (!pids.Contains(pid)) continue;
                        string l = la.ToString();
                        rows.Add(new Row { Proto = af == 2 ? "udp" : "udp6", Local = l, LPort = lp, Remote = "", State = "BOUND", Pid = pid, Bind = Bind(l) });
                    }
                    return;
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
        }
    }

    static class Sec
    {
        // ---------- process tree ----------
        class PTree { public List<uint> InScope = new List<uint>(); public List<ProcEntry> Foreign = new List<ProcEntry>(); public string InstallDir; }

        static string DirOf(string p) { try { return Path.GetDirectoryName(p) ?? ""; } catch { return ""; } }

        static PTree TreeOf(Win w)
        {
            var snap = Procs.Snapshot();
            var t = new PTree { InstallDir = DirOf(w.Path) };
            var seen = new HashSet<uint> { w.Pid };
            var q = new Queue<uint>();
            q.Enqueue(w.Pid); t.InScope.Add(w.Pid);
            while (q.Count > 0)
            {
                uint p = q.Dequeue();
                foreach (var e in snap.Values.ToList())
                {
                    if (e.Parent != p || seen.Contains(e.Pid) || e.Pid == p) continue;
                    seen.Add(e.Pid);
                    var pi = Procs.Get(e.Pid);
                    if (pi.Path == w.Path || Canon.Under(pi.Path, t.InstallDir)) { t.InScope.Add(e.Pid); q.Enqueue(e.Pid); }
                    else t.Foreign.Add(e);
                }
            }
            return t;
        }

        static string IntegrityName(int rid)
        {
            if (rid < 0) return "unknown";
            if (rid >= 0x4000) return "system";
            if (rid >= 0x3000) return "high";
            if (rid >= 0x2000) return "medium";
            if (rid >= 0x1000) return "low";
            return "untrusted";
        }

        // ---------- sections ----------
        static object Process(Win w, PTree t)
        {
            var rows = new List<object>();
            var snap = Procs.Snapshot();
            foreach (uint pid in t.InScope.Concat(t.Foreign.Select(e => e.Pid)))
            {
                var pi = Procs.Get(pid);
                ProcEntry e; snap.TryGetValue(pid, out e);
                var d = new D { { "pid", (long)pid }, { "parent", e != null ? (long)e.Parent : 0L }, { "exe", pi.Exe }, { "path", pi.Path }, { "inScope", t.InScope.Contains(pid) },
                    { "integrity", IntegrityName(Procs.IntegrityRid(pid)) }, { "elevated", pi.Elevated } };
                if (pi.Started != null) { try { d["startedAt"] = DateTime.FromFileTimeUtc(long.Parse(pi.Started)).ToString("o"); } catch { } }
                IntPtr h = N.OpenProcess(0x1000, false, pid);
                if (h != IntPtr.Zero)
                {
                    uint hc; if (SecN.GetProcessHandleCount(h, out hc)) d["handles"] = (long)hc;
                    N.CloseHandle(h);
                }
                try { using (var pr = System.Diagnostics.Process.GetProcessById((int)pid)) d["workingSetMB"] = Math.Round(pr.WorkingSet64 / 1048576.0, 1); } catch { }
                rows.Add(d);
            }
            return new D { { "root", (long)w.Pid }, { "installDir", t.InstallDir }, { "image", w.Path }, { "aumid", w.Aumid }, { "processes", rows } };
        }

        static int WinVerify(string path)
        {
            IntPtr fi = IntPtr.Zero, data = IntPtr.Zero, pp = IntPtr.Zero;
            try
            {
                pp = Marshal.StringToHGlobalUni(path);
                var f = new SecN.WTFILE { cb = (uint)Marshal.SizeOf(typeof(SecN.WTFILE)), path = pp };
                fi = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecN.WTFILE)));
                Marshal.StructureToPtr(f, fi, false);
                // WTD_UI_NONE=2, revocation none, WTD_CHOICE_FILE=1, cache-only URL retrieval (0x1000): no network
                var dd = new SecN.WTDATA { cb = (uint)Marshal.SizeOf(typeof(SecN.WTDATA)), ui = 2, revoke = 0, unionChoice = 1, file = fi, stateAction = 0, provFlags = 0x1000 };
                data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecN.WTDATA)));
                Marshal.StructureToPtr(dd, data, false);
                var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
                return SecN.WinVerifyTrust(new IntPtr(-1), ref action, data);
            }
            finally
            {
                if (pp != IntPtr.Zero) Marshal.FreeHGlobal(pp);
                if (fi != IntPtr.Zero) Marshal.FreeHGlobal(fi);
                if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
            }
        }

        public static D SignatureOf(string path)
        {
            var d = new D { { "path", path } };
            int rc;
            try { rc = WinVerify(path); } catch (Exception ex) { d["trust"] = "error:" + ex.GetType().Name; return d; }
            d["trust"] = rc == 0 ? "valid" : (uint)rc == 0x800B0100 ? "unsigned (no embedded signature; may be catalog-signed)" : "invalid (0x" + ((uint)rc).ToString("x") + ")";
            d["unsigned"] = (uint)rc == 0x800B0100;
            try
            {
                var c = X509Certificate.CreateFromSignedFile(path);
                var c2 = new X509Certificate2(c);
                d["signerSubject"] = c2.Subject; d["issuer"] = c2.Issuer; d["certNotAfter"] = c2.NotAfter.ToString("yyyy-MM-dd");
            }
            catch { }
            d["timestamp"] = "not read";
            return d;
        }

        static object Signature(Win w, PTree t)
        {
            return new List<object> { SignatureOf(w.Path) };
        }

        static object Mitigations(Win w, PTree t)
        {
            var d = new D { { "exe", Pe.Mitigations(Pe.Read(w.Path)) } };
            IntPtr h = N.OpenProcess(0x400, false, w.Pid);
            if (h == IntPtr.Zero) h = N.OpenProcess(0x1000, false, w.Pid);
            var live = new D();
            if (h != IntPtr.Zero)
            {
                Func<int, uint?> pol = id => { var b = new byte[16]; return SecN.GetProcessMitigationPolicy(h, id, b, new UIntPtr(8)) ? (uint?)BitConverter.ToUInt32(b, 0) : null; };
                var dep = pol(0); if (dep.HasValue) live["dep"] = (dep.Value & 1) != 0;
                var aslr = pol(1);
                if (aslr.HasValue) { live["aslrBottomUp"] = (aslr.Value & 1) != 0; live["aslrForceRelocate"] = (aslr.Value & 2) != 0; live["aslrHighEntropy"] = (aslr.Value & 4) != 0; live["aslrDisallowStripped"] = (aslr.Value & 8) != 0; }
                var cfg = pol(7); if (cfg.HasValue) { live["cfg"] = (cfg.Value & 1) != 0; live["cfgStrict"] = (cfg.Value & 4) != 0; }
                var dyn = pol(2); if (dyn.HasValue) live["prohibitDynamicCode"] = (dyn.Value & 1) != 0;
                var sig = pol(8); if (sig.HasValue) live["microsoftSignedOnly"] = (sig.Value & 1) != 0;
                var img = pol(10); if (img.HasValue) { live["noRemoteImages"] = (img.Value & 1) != 0; live["noLowLabelImages"] = (img.Value & 2) != 0; live["preferSystem32"] = (img.Value & 4) != 0; }
                N.CloseHandle(h);
            }
            else live["note"] = "process policy not readable (access denied)";
            d["liveProcess"] = live;
            // primary modules: dlls next to the exe
            var mods = new List<object>();
            try
            {
                foreach (var f in Directory.GetFiles(t.InstallDir, "*.dll").Take(40))
                {
                    var pe = Pe.Read(f);
                    if (!pe.Valid) continue;
                    var m = Pe.Mitigations(pe);
                    bool bad = !(bool)m["dynamicBase(ASLR)"] || !(bool)m["nxCompat(DEP)"];
                    mods.Add(new D { { "file", Path.GetFileName(f) }, { "aslr", m["dynamicBase(ASLR)"] }, { "dep", m["nxCompat(DEP)"] }, { "cfg", m["controlFlowGuard"] }, { "weak", bad } });
                }
            }
            catch { }
            d["installDirDlls"] = mods;
            return d;
        }

        static object Modules(Win w, PTree t)
        {
            var seen = new HashSet<string>();
            var rows = new List<D>();
            var cache = new Dictionary<string, D>();
            int denied = 0;
            foreach (uint pid in t.InScope.Take(12))
            {
                IntPtr h = N.OpenProcess(0x410, false, pid);
                if (h == IntPtr.Zero) { denied++; continue; }
                try
                {
                    var arr = new IntPtr[4096];
                    int need;
                    if (!SecN.EnumProcessModulesEx(h, arr, arr.Length * IntPtr.Size, out need, 3)) { denied++; continue; }
                    int n = Math.Min(arr.Length, need / IntPtr.Size);
                    for (int i = 0; i < n; i++)
                    {
                        var sb = new StringBuilder(1024);
                        if (SecN.GetModuleFileNameEx(h, arr[i], sb, 1024) == 0) continue;
                        string p = sb.ToString();
                        if (!seen.Add(p.ToLowerInvariant())) continue;
                        string dir = DirOf(p);
                        bool inInstall = Canon.Under(p, t.InstallDir);
                        bool writable = AclUtil.LowPrivWritable(dir, cache);
                        rows.Add(new D { { "path", p }, { "inInstallDir", inInstall }, { "dirWritableByUnprivileged", writable }, { "risk", writable ? (inInstall ? "install-dir-writable" : "outside-install-writable") : (inInstall || Canon.Under(p, Environment.GetFolderPath(Environment.SpecialFolder.Windows)) ? "" : "outside-install") } });
                    }
                }
                finally { N.CloseHandle(h); }
            }
            var risky = rows.Where(r => (string)r["risk"] != "").ToList();
            var ordered = rows.Where(r => (bool)r["dirWritableByUnprivileged"]).Concat(rows.Where(r => !(bool)r["dirWritableByUnprivileged"] && (string)r["risk"] != "")).Concat(rows.Where(r => (string)r["risk"] == "")).ToList();
            var plantDirs = cache.Where(kv => kv.Value.ContainsKey("writableByUnprivileged") && (bool)kv.Value["writableByUnprivileged"])
                .Select(kv => new D { { "dir", kv.Key }, { "writers", kv.Value["writers"] }, { "modules", rows.Count(r => string.Equals(DirOf((string)r["path"]), kv.Key, StringComparison.OrdinalIgnoreCase)) } }).Cast<object>().ToList();
            return new D
            {
                { "total", rows.Count }, { "shown", Math.Min(400, ordered.Count) }, { "truncated", ordered.Count > 400 }, { "processesUnreadable", denied },
                { "writableDirsThatLoadCode", plantDirs }, { "modules", ordered.Take(400).Cast<object>().ToList() }
            };
        }

        static object Ports(Win w, PTree t)
        {
            var rows = NetTables.All(new HashSet<uint>(t.InScope));
            var listening = rows.Where(r => r.State == "LISTEN" || r.State == "BOUND")
                .Select(r => (object)new D { { "proto", r.Proto }, { "address", r.Local }, { "port", r.LPort }, { "pid", (long)r.Pid }, { "bind", r.Bind }, { "reachableOffBox", r.Bind != "loopback" } }).ToList();
            var conns = rows.Where(r => r.State != "LISTEN" && r.State != "BOUND")
                .Select(r => (object)new D { { "proto", r.Proto }, { "local", r.Local + ":" + r.LPort }, { "remote", r.Remote + ":" + r.RPort }, { "state", r.State }, { "pid", (long)r.Pid } }).Take(150).ToList();
            return new D { { "listening", listening }, { "connections", conns } };
        }

        public static string CommandLine(uint pid)
        {
            IntPtr h = N.OpenProcess(0x410, false, pid);
            if (h != IntPtr.Zero)
            {
                try
                {
                    bool wow; SecN.IsWow64Process(h, out wow);
                    if (!wow)
                    {
                        var pbi = new SecN.PBI(); int ret;
                        if (SecN.NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(SecN.PBI)), out ret) == 0 && pbi.PebBaseAddress != IntPtr.Zero)
                        {
                            var b8 = new byte[8]; IntPtr rd;
                            if (SecN.ReadProcessMemory(h, pbi.PebBaseAddress + 0x20, b8, 8, out rd))
                            {
                                IntPtr pars = new IntPtr(BitConverter.ToInt64(b8, 0));
                                var us = new byte[16];
                                if (SecN.ReadProcessMemory(h, pars + 0x70, us, 16, out rd))
                                {
                                    int len = BitConverter.ToUInt16(us, 0);
                                    IntPtr buf = new IntPtr(BitConverter.ToInt64(us, 8));
                                    if (len > 0 && len < 65000)
                                    {
                                        var cb = new byte[len];
                                        if (SecN.ReadProcessMemory(h, buf, cb, len, out rd)) return Encoding.Unicode.GetString(cb);
                                    }
                                }
                            }
                        }
                    }
                }
                finally { N.CloseHandle(h); }
            }
            try
            {
                using (var s = new System.Management.ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
                    foreach (System.Management.ManagementObject o in s.Get()) return Convert.ToString(o["CommandLine"]);
            }
            catch { }
            return null;
        }

        static readonly Regex Notable = new Regex("^--?(inspect|inspect-brk|inspect-port|remote-debugging-port|remote-debugging-address|remote-allow-origins|no-sandbox|disable-web-security|ignore-certificate-errors|allow-running-insecure-content|user-data-dir|js-flags|proxy-server|disable-gpu-sandbox|enable-logging|trace-startup)", RegexOptions.IgnoreCase);

        static D Outline(string cmd)
        {
            var d = new D();
            if (cmd == null) { d["note"] = "command line not readable"; return d; }
            var args = new List<string>();
            int argc;
            IntPtr p = SecN.CommandLineToArgvW(cmd, out argc);
            if (p != IntPtr.Zero)
            {
                for (int i = 0; i < argc; i++) args.Add(Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, i * IntPtr.Size)));
                SecN.LocalFree(p);
            }
            d["exe"] = args.Count > 0 ? args[0] : "";
            d["argCount"] = Math.Max(0, args.Count - 1);
            d["args"] = args.Skip(1).Take(40).Select(Redact.Arg).Cast<object>().ToList();
            d["notable"] = args.Skip(1).Where(a => Notable.IsMatch(a) || a.Contains("://")).Select(Redact.Arg).Take(20).Cast<object>().ToList();
            return d;
        }

        static object Children(Win w, PTree t)
        {
            var snap = Procs.Snapshot();
            var rows = new List<object>();
            foreach (uint pid in t.InScope.Where(x => x != w.Pid).Concat(t.Foreign.Select(e => e.Pid)).Take(40))
            {
                var pi = Procs.Get(pid);
                ProcEntry e; snap.TryGetValue(pid, out e);
                var d = new D { { "pid", (long)pid }, { "parent", e != null ? (long)e.Parent : 0L }, { "path", pi.Path }, { "inScope", t.InScope.Contains(pid) } };
                d["commandline"] = Outline(CommandLine(pid));
                rows.Add(d);
            }
            return rows;
        }

        static object CommandLineSection(Win w, PTree t) { return Outline(CommandLine(w.Pid)); }

        // ---- protocols ----
        static string ExtractExe(string cmd)
        {
            if (string.IsNullOrWhiteSpace(cmd)) return "";
            cmd = Environment.ExpandEnvironmentVariables(cmd.Trim());
            if (cmd[0] == '"') { int e = cmd.IndexOf('"', 1); return e > 0 ? cmd.Substring(1, e - 1) : cmd.Substring(1); }
            int x = cmd.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            return x > 0 ? cmd.Substring(0, x + 4) : cmd.Split(' ')[0];
        }

        public static List<D> Protocols(Win w)
        {
            var res = new List<D>();
            var seen = new HashSet<string>();
            var roots = new[] { Tuple.Create("hkcu", Registry.CurrentUser), Tuple.Create("hklm", Registry.LocalMachine) };
            foreach (var r in roots)
            {
                try
                {
                    using (var cls = r.Item2.OpenSubKey(@"Software\Classes"))
                    {
                        if (cls == null) continue;
                        foreach (var name in cls.GetSubKeyNames())
                        {
                            if (name.Length < 2 || name[0] == '.' || seen.Contains(name.ToLowerInvariant())) continue;
                            try
                            {
                                using (var k = cls.OpenSubKey(name))
                                {
                                    if (k == null || k.GetValue("URL Protocol") == null) continue;
                                    using (var c = k.OpenSubKey(@"shell\open\command"))
                                    {
                                        string cmd = c == null ? null : c.GetValue("") as string;
                                        if (cmd == null) continue;
                                        string exe = ExtractExe(cmd);
                                        if (!string.Equals(exe, w.Path, StringComparison.OrdinalIgnoreCase)) continue;
                                        seen.Add(name.ToLowerInvariant());
                                        string ph = Regex.IsMatch(cmd, "\"%[1lL]\"") ? "quoted" : Regex.IsMatch(cmd, "%[1lL]") ? "unquoted (argument injection possible)" : "none";
                                        res.Add(new D { { "scheme", name }, { "source", r.Item1 }, { "command", cmd }, { "handlerExe", exe }, { "matchesTarget", true }, { "argumentPlaceholder", ph } });
                                    }
                                }
                            }
                            catch { }
                        }
                    }
                }
                catch { }
            }
            // packaged apps: manifest
            if (!string.IsNullOrEmpty(w.Aumid))
            {
                foreach (var dir in new[] { DirOf(w.Path), DirOf(DirOf(w.Path)) })
                {
                    try
                    {
                        string mf = Path.Combine(dir, "AppxManifest.xml");
                        if (!File.Exists(mf)) continue;
                        string xml;
                        using (var fs = new FileStream(mf, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) using (var sr = new StreamReader(fs)) xml = sr.ReadToEnd();
                        foreach (Match m in Regex.Matches(xml, "<(?:\\w+:)?Protocol\\s+Name=\"([^\"]+)\""))
                            if (seen.Add(m.Groups[1].Value.ToLowerInvariant()))
                                res.Add(new D { { "scheme", m.Groups[1].Value }, { "source", "appx-manifest" }, { "command", "(activation through the package: " + w.Aumid + ")" }, { "handlerExe", w.Path }, { "matchesTarget", true }, { "argumentPlaceholder", "package activation" } });
                        break;
                    }
                    catch { }
                }
            }
            return res;
        }

        // ---- scope ----
        static string Known(Environment.SpecialFolder f) { return Environment.GetFolderPath(f); }

        static List<string> DenyRoots()
        {
            string ad = Known(Environment.SpecialFolder.ApplicationData), la = Known(Environment.SpecialFolder.LocalApplicationData), home = Known(Environment.SpecialFolder.UserProfile);
            var l = new List<string>
            {
                Path.Combine(la, @"Google\Chrome"), Path.Combine(la, @"Microsoft\Edge"), Path.Combine(la, "Chromium"), Path.Combine(la, @"BraveSoftware"),
                Path.Combine(la, @"Vivaldi"), Path.Combine(ad, @"Opera Software"), Path.Combine(ad, @"Mozilla"), Path.Combine(la, @"Mozilla"),
                Path.Combine(ad, "Pimi"), Path.Combine(la, "Pimi"), Path.Combine(home, ".pimi"), Safety.InstallDir.TrimEnd('\\'),
                Path.Combine(ad, @"Microsoft\Credentials"), Path.Combine(la, @"Microsoft\Credentials"), Path.Combine(ad, @"Microsoft\Protect"), Path.Combine(ad, @"Microsoft\Vault"),
                Path.Combine(la, @"Microsoft\Vault"), Path.Combine(ad, @"Microsoft\Crypto"), Path.Combine(home, ".ssh"), Path.Combine(home, ".gnupg")
            };
            return l;
        }

        static string DeniedBy(string path, List<string> deny)
        {
            string c = Canon.Of(path) ?? path;
            foreach (var d in deny)
            {
                if (string.IsNullOrEmpty(d)) continue;
                string cd = Canon.Of(d) ?? d;
                if (Canon.Under(c, cd) || Canon.Under(cd, c)) return cd;
            }
            return null;
        }

        static List<string> Names(Win w)
        {
            var names = new List<string>();
            try
            {
                var vi = FileVersionInfo.GetVersionInfo(w.Path);
                if (!string.IsNullOrWhiteSpace(vi.CompanyName)) names.Add(vi.CompanyName.Trim());
                if (!string.IsNullOrWhiteSpace(vi.ProductName)) names.Add(vi.ProductName.Trim());
            }
            catch { }
            string b = Path.GetFileNameWithoutExtension(w.Path);
            if (!string.IsNullOrEmpty(b)) names.Add(b);
            return names.Where(n => n.IndexOfAny(Path.GetInvalidFileNameChars()) < 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        public static D Scope(Win w)
        {
            var deny = DenyRoots();
            var names = Names(w);
            string product = null, company = null;
            try { var vi = FileVersionInfo.GetVersionInfo(w.Path); product = vi.ProductName; company = vi.CompanyName; } catch { }
            var bases = new[] { Tuple.Create("%APPDATA%", Known(Environment.SpecialFolder.ApplicationData)), Tuple.Create("%LOCALAPPDATA%", Known(Environment.SpecialFolder.LocalApplicationData)), Tuple.Create("%PROGRAMDATA%", Known(Environment.SpecialFolder.CommonApplicationData)) };
            var cands = new List<D>();
            var refused = new List<object>();
            Action<string, string, string> add = (path, source, baseRoot) =>
            {
                if (!Directory.Exists(path)) return;
                string canon = Canon.Of(path);
                string cbase = Canon.Of(baseRoot);
                if (canon == null || cbase == null || !Canon.Under(canon, cbase) || string.Equals(canon, cbase, StringComparison.OrdinalIgnoreCase))
                { refused.Add(new D { { "path", path }, { "reason", "resolves outside its root (link) or is the root" } }); return; }
                string by = DeniedBy(path, deny);
                if (by != null) { refused.Add(new D { { "path", path }, { "reason", "deny-listed: " + by } }); return; }
                if (cands.Any(c => string.Equals((string)c["path"], canon, StringComparison.OrdinalIgnoreCase))) return;
                cands.Add(new D { { "path", canon }, { "source", source } });
            };
            foreach (var b in bases)
            {
                foreach (var n in names) add(Path.Combine(b.Item2, n), b.Item1 + "\\" + n, b.Item2);
                if (!string.IsNullOrEmpty(company) && !string.IsNullOrEmpty(product) && company.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && product.IndexOfAny(Path.GetInvalidFileNameChars()) < 0)
                    add(Path.Combine(b.Item2, company.Trim(), product.Trim()), b.Item1 + "\\" + company.Trim() + "\\" + product.Trim(), b.Item2);
            }
            if (!string.IsNullOrEmpty(product) && product.IndexOfAny(Path.GetInvalidFileNameChars()) < 0)
            {
                string ud = Path.Combine(Known(Environment.SpecialFolder.ApplicationData), product.Trim());
                if (cands.All(c => !string.Equals((string)c["path"], Canon.Of(ud), StringComparison.OrdinalIgnoreCase))) add(ud, "electron userData %APPDATA%\\" + product.Trim(), Known(Environment.SpecialFolder.ApplicationData));
            }
            string pfn = null;
            if (!string.IsNullOrEmpty(w.Aumid) && w.Aumid.Contains("!")) pfn = w.Aumid.Substring(0, w.Aumid.IndexOf('!'));
            if (pfn != null && pfn.IndexOfAny(Path.GetInvalidFileNameChars()) < 0)
                add(Path.Combine(Known(Environment.SpecialFolder.LocalApplicationData), "Packages", pfn), "package family " + pfn, Path.Combine(Known(Environment.SpecialFolder.LocalApplicationData), "Packages"));
            foreach (var c in cands) { var a = AclUtil.Check((string)c["path"], "data"); c["writableByUnprivileged"] = a.ContainsKey("writableByUnprivileged") ? a["writableByUnprivileged"] : null; }

            var regs = new List<object>();
            var regNames = new List<string>();
            if (!string.IsNullOrEmpty(company) && !string.IsNullOrEmpty(product)) regNames.Add(company.Trim() + "\\" + product.Trim());
            foreach (var n in names) regNames.Add(n);
            foreach (var rn in regNames.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (rn.StartsWith("Microsoft", StringComparison.OrdinalIgnoreCase) && rn.IndexOf('\\') < 0) continue;
                try
                {
                    using (var k = Registry.CurrentUser.OpenSubKey(@"Software\" + rn)) { if (k != null) regs.Add(new D { { "key", @"HKCU\Software\" + rn }, { "values", k.ValueCount }, { "subkeys", k.SubKeyCount } }); }
                }
                catch { }
            }
            string install = Canon.Of(DirOf(w.Path)) ?? DirOf(w.Path);
            return new D
            {
                { "exe", w.Path }, { "appId", w.AppId }, { "aumid", w.Aumid }, { "packageFamily", pfn }, { "installDir", install },
                { "installDirDenied", DeniedBy(install, deny) },
                { "dataDirCandidates", cands.Cast<object>().ToList() }, { "registryRoots", regs }, { "refused", refused }, { "denyRoots", deny.Select(d => (object)(Canon.Of(d) ?? d)).ToList() },
                { "nameSources", names.Cast<object>().ToList() }
            };
        }

        static object Acls(Win w, PTree t)
        {
            var rows = new List<object>();
            rows.Add(AclUtil.Check(t.InstallDir, "install"));
            var sc = Scope(w);
            var data = (List<object>)sc["dataDirCandidates"];
            foreach (D c in data)
            {
                string p = (string)c["path"];
                rows.Add(AclUtil.Check(p, "data"));
                try
                {
                    foreach (var sub in Directory.GetDirectories(p).Where(s => Regex.IsMatch(Path.GetFileName(s), "^(pending|updates?|updater|download(s)?|staging|temp|cache)$", RegexOptions.IgnoreCase)).Take(8))
                        rows.Add(AclUtil.Check(sub, "staging?"));
                }
                catch { }
            }
            string la = Known(Environment.SpecialFolder.LocalApplicationData);
            foreach (var n in Names(w))
                foreach (var suffix in new[] { "-updater", "_updater", "-updates" })
                {
                    string p = Path.Combine(la, n + suffix);
                    if (Directory.Exists(p) && DeniedBy(p, DenyRoots()) == null) rows.Add(AclUtil.Check(p, "update staging"));
                }
            var flagged = rows.Cast<D>().Where(r => r.ContainsKey("writableByUnprivileged") && (bool)r["writableByUnprivileged"]).Select(r => (object)new D { { "path", r["path"] }, { "kind", r["kind"] }, { "writers", r["writers"] } }).ToList();
            return new D { { "writableByUnprivilegedCount", flagged.Count }, { "flagged", flagged }, { "dirs", rows } };
        }

        // ---- electron ----
        static readonly string[] FuseNames = { "RunAsNode", "EnableCookieEncryption", "EnableNodeOptionsEnvironmentVariable", "EnableNodeCliInspectArguments", "EnableEmbeddedAsarIntegrityValidation", "OnlyLoadAppFromAsar", "LoadBrowserProcessSpecificV8Snapshot", "GrantFileProtocolExtraPrivileges" };

        static object Electron(Win w, PTree t)
        {
            string dir = t.InstallDir;
            string res = Path.Combine(dir, "resources");
            bool asar = File.Exists(Path.Combine(res, "app.asar"));
            bool appDir = Directory.Exists(Path.Combine(res, "app"));
            bool pak = File.Exists(Path.Combine(dir, "chrome_100_percent.pak")) || File.Exists(Path.Combine(dir, "resources.pak"));
            var sentinel = Scan.Ascii("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
            var integ = Scan.Utf16("ELECTRONASAR");
            var hits = Scan.Multi(w.Path, new[] { sentinel, integ }, 6, 400L << 20);
            var d = new D();
            D fuses = null;
            foreach (long off in hits[0])
            {
                try
                {
                    using (var fs = new FileStream(w.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    {
                        fs.Seek(off + sentinel.Length, SeekOrigin.Begin);
                        var hd = new byte[2];
                        if (fs.Read(hd, 0, 2) != 2 || hd[0] != 1 || hd[1] < 1 || hd[1] > 32) continue;
                        var wire = new byte[hd[1]];
                        if (fs.Read(wire, 0, wire.Length) != wire.Length) continue;
                        if (!wire.All(b => b == '0' || b == '1' || b == 'r')) continue;
                        fuses = new D { { "wireVersion", 1 } };
                        for (int i = 0; i < wire.Length; i++)
                            fuses[i < FuseNames.Length ? FuseNames[i] : "fuse" + i] = wire[i] == '1' ? "enabled" : wire[i] == '0' ? "disabled" : "removed";
                        break;
                    }
                }
                catch { }
            }
            bool isElectron = fuses != null || asar || appDir && pak;
            d["isElectron"] = isElectron;
            if (!isElectron) return d;
            d["appAsarPresent"] = asar;
            d["unpackedAppDir(resources/app)"] = appDir;
            d["asarIntegrityResourceInExe"] = hits[1].Count > 0;
            d["fuses"] = fuses ?? (object)"fuse wire not found (older Electron or stripped)";
            var versions = new D();
            try { string vf = Path.Combine(dir, "version"); if (File.Exists(vf)) versions["versionFile"] = File.ReadAllText(vf).Trim(); } catch { }
            foreach (var f in new[] { "libEGL.dll", "ffmpeg.dll", "chrome_elf.dll" })
                try { string p = Path.Combine(dir, f); if (File.Exists(p)) { var vi = FileVersionInfo.GetVersionInfo(p); versions[f] = vi.FileVersion ?? vi.ProductVersion; } } catch { }
            try { var vi = FileVersionInfo.GetVersionInfo(w.Path); versions["exeFileVersion"] = vi.FileVersion; versions["exeProductVersion"] = vi.ProductVersion; } catch { }
            foreach (uint pid in t.InScope.Skip(1).Take(6))
            {
                var cl = CommandLine(pid);
                if (cl == null) continue;
                var mv = Regex.Match(cl, "--annotation=ver=([0-9.]+)");
                if (mv.Success && Regex.IsMatch(cl, "--annotation=prod=Electron")) { versions["electronVersion(crashpad annotation)"] = mv.Groups[1].Value; break; }
            }
            d["versions"] = versions;
            var findings = new List<object>();
            if (fuses != null)
            {
                if ((string)fuses["RunAsNode"] == "enabled") findings.Add("RunAsNode enabled: the signed exe can be run as a Node interpreter (ELECTRON_RUN_AS_NODE)");
                if (fuses.ContainsKey("EnableNodeCliInspectArguments") && (string)fuses["EnableNodeCliInspectArguments"] == "enabled") findings.Add("EnableNodeCliInspectArguments enabled: --inspect works on the production binary");
                if (fuses.ContainsKey("EnableNodeOptionsEnvironmentVariable") && (string)fuses["EnableNodeOptionsEnvironmentVariable"] == "enabled") findings.Add("EnableNodeOptionsEnvironmentVariable enabled: NODE_OPTIONS is honoured");
                if (fuses.ContainsKey("OnlyLoadAppFromAsar") && (string)fuses["OnlyLoadAppFromAsar"] == "disabled") findings.Add("OnlyLoadAppFromAsar disabled: an app folder beside the asar can replace the app");
                if (fuses.ContainsKey("EnableEmbeddedAsarIntegrityValidation") && (string)fuses["EnableEmbeddedAsarIntegrityValidation"] == "disabled") findings.Add("EmbeddedAsarIntegrityValidation disabled: app.asar can be swapped without detection");
            }
            if (appDir) findings.Add("resources/app is unpacked source rather than an asar");
            d["observations"] = findings;
            return d;
        }

        // ---- dotnet ----
        static object DotNet(Win w, PTree t)
        {
            var pe = Pe.Read(w.Path);
            var d = new D { { "isManaged", pe.ClrRva != 0 } };
            var needles = new Dictionary<string, byte[]>
            {
                { "BinaryFormatter", Scan.Ascii("BinaryFormatter") }, { "TypeNameHandling", Scan.Ascii("TypeNameHandling") }, { "NetDataContractSerializer", Scan.Ascii("NetDataContractSerializer") },
                { "LosFormatter", Scan.Ascii("LosFormatter") }, { "ServerCertificateValidationCallback", Scan.Ascii("ServerCertificateValidationCallback") }, { "SoapFormatter", Scan.Ascii("SoapFormatter") },
                { ".NETFramework,Version=", Scan.Ascii(".NETFramework,Version=") }, { ".NETCoreApp,Version=", Scan.Ascii(".NETCoreApp,Version=") }
            };
            var managed = new List<string>();
            if (pe.ClrRva != 0) managed.Add(w.Path);
            try
            {
                foreach (var f in Directory.GetFiles(t.InstallDir, "*.dll").Take(300))
                {
                    if (managed.Count >= 40) break;
                    var p = Pe.Read(f);
                    if (p.Valid && p.ClrRva != 0) managed.Add(f);
                }
            }
            catch { }
            bool core = false;
            try { core = Directory.GetFiles(t.InstallDir, "*.runtimeconfig.json").Length > 0 || File.Exists(Path.Combine(t.InstallDir, "hostfxr.dll")); } catch { }
            d["runtime"] = pe.ClrRva == 0 && managed.Count == 0 ? "not managed" : (core ? ".NET (Core/5+)" : ".NET Framework");
            if (pe.ClrRva != 0) { d["authenticodeStrongNameDirectory"] = pe.StrongNameDir; d["strongNameSignedFlag"] = (pe.ClrFlags & 0x8) != 0; d["ilOnly"] = (pe.ClrFlags & 0x1) != 0; d["32bitRequired"] = (pe.ClrFlags & 0x2) != 0; }
            try { var rc = Directory.GetFiles(t.InstallDir, "*.runtimeconfig.json").FirstOrDefault(); if (rc != null) { var m = Regex.Match(File.ReadAllText(rc), "\"tfm\"\\s*:\\s*\"([^\"]+)\""); if (m.Success) d["targetFramework"] = m.Groups[1].Value; } } catch { }
            var signals = new List<object>();
            var keys = needles.Keys.ToList();
            var arr = keys.Select(k => needles[k]).ToArray();
            string tfm = null;
            foreach (var f in managed.Take(25))
            {
                var h = Scan.Multi(f, arr, 1, 40L << 20);
                for (int i = 0; i < keys.Count; i++)
                {
                    if (h[i].Count == 0) continue;
                    if (keys[i].StartsWith(".NET")) { if (tfm == null && f == w.Path) tfm = keys[i].TrimEnd('='); continue; }
                    signals.Add(new D { { "signal", keys[i] }, { "file", Path.GetFileName(f) } });
                }
            }
            if (tfm != null && !d.ContainsKey("targetFramework")) d["targetFramework"] = tfm + " (attribute present)";
            d["signals"] = signals;
            d["managedAssemblies"] = managed.Select(f => (object)Path.GetFileName(f)).ToList();
            var unsigned = new List<object>();
            foreach (var f in managed.Skip(1).Take(20)) { var pi = Pe.Read(f); if (pi.ClrRva != 0 && !pi.StrongNameDir && !Path.GetFileName(f).StartsWith("System.", StringComparison.OrdinalIgnoreCase) && !Path.GetFileName(f).StartsWith("Microsoft.", StringComparison.OrdinalIgnoreCase)) unsigned.Add(Path.GetFileName(f)); }
            d["assembliesWithoutStrongName(first 20)"] = unsigned;
            return d;
        }

        // ---------- inspect ----------
        public static object Inspect(Win w, D args)
        {
            string section = J.S(args, "section") ?? "all";
            var t = TreeOf(w);
            var all = new[] { "process", "signature", "mitigations", "modules", "ports", "children", "commandline", "protocols", "acls", "electron", "dotnet" };
            var want = section == "all" ? all : new[] { section };
            if (section != "all" && !all.Contains(section)) throw new HelperError("failed", "Unknown inspect section '" + section + "'.");
            var sw = Stopwatch.StartNew();
            var structured = new D();
            foreach (var s in want)
            {
                if (section == "all" && sw.ElapsedMilliseconds > 4000) { structured[s] = new D { { "skipped", "4 s budget used" } }; continue; }
                try
                {
                    switch (s)
                    {
                        case "process": structured[s] = Process(w, t); break;
                        case "signature": structured[s] = Signature(w, t); break;
                        case "mitigations": structured[s] = Mitigations(w, t); break;
                        case "modules": structured[s] = Modules(w, t); break;
                        case "ports": structured[s] = Ports(w, t); break;
                        case "children": structured[s] = Children(w, t); break;
                        case "commandline": structured[s] = CommandLineSection(w, t); break;
                        case "protocols": structured[s] = Protocols(w); break;
                        case "acls": structured[s] = Acls(w, t); break;
                        case "electron": structured[s] = Electron(w, t); break;
                        case "dotnet": structured[s] = DotNet(w, t); break;
                    }
                }
                catch (HelperError) { throw; }
                catch (Exception ex) { structured[s] = new D { { "error", ex.GetType().Name } }; }
            }
            var sb = new StringBuilder();
            foreach (var kv in structured) { sb.Append("== ").Append(kv.Key).Append(" ==\n").Append(Fmt.Text(kv.Value)).Append("\n\n"); }
            return new D { { "report", sb.ToString().TrimEnd() }, { "structured", structured }, { "elapsedMs", (int)sw.ElapsedMilliseconds } };
        }

        // ---------- ipc ----------
        static readonly string[] WeakSids = { "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-7", "S-1-15-2-1", "S-1-5-4", "S-1-2-1" };

        static List<D> Pipes(PTree t, Stopwatch sw, out string note)
        {
            note = null;
            var res = new Dictionary<string, D>();
            var pids = new HashSet<uint>(t.InScope);
            var own = new FileStream(Process_SelfExe(), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            // table of all handles (own handle opened first so it is in the snapshot)
            int size = 1 << 22, ret;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                int rc;
                while ((rc = SecN.NtQuerySystemInformation(64, buf, size, out ret)) == unchecked((int)0xC0000004))
                {
                    Marshal.FreeHGlobal(buf);
                    size = Math.Max(size * 2, ret + (1 << 20));
                    if (size > (256 << 20)) { note = "handle table too large"; return new List<D>(); }
                    buf = Marshal.AllocHGlobal(size);
                }
                if (rc != 0) { note = "handle table not readable (0x" + rc.ToString("x") + ")"; return new List<D>(); }
                long count = Marshal.ReadInt64(buf);
                // the File object type index is learned from one of our own file handles
                ushort fileType = 0;
                using (own)
                {
                    long mine = own.SafeFileHandle.DangerousGetHandle().ToInt64();
                    for (long i = 0; i < count; i++)
                    {
                        IntPtr e = buf + 16 + (int)(i * 40);
                        if (Marshal.ReadInt64(e, 8) == Procs.Self && Marshal.ReadInt64(e, 16) == mine) { fileType = (ushort)Marshal.ReadInt16(e, 30); break; }
                    }
                    if (fileType == 0) { note = "could not identify the file object type (entries=" + count + ", mine=" + mine + ", first=" + Marshal.ReadInt64(buf + 16, 8) + "/" + Marshal.ReadInt64(buf + 16, 16) + ", self=" + Procs.Self + ")"; return new List<D>(); }
                    var procHandles = new Dictionary<uint, IntPtr>();
                    int scanned = 0;
                    for (long i = 0; i < count; i++)
                    {
                        IntPtr e = buf + 16 + (int)(i * 40);
                        uint pid = (uint)Marshal.ReadInt64(e, 8);
                        if (!pids.Contains(pid) || (ushort)Marshal.ReadInt16(e, 30) != fileType) continue;
                        if (sw.ElapsedMilliseconds > 3000) { note = "stopped at the 3 s budget after " + scanned + " file handles"; break; }
                        IntPtr ph;
                        if (!procHandles.TryGetValue(pid, out ph)) { ph = N.OpenProcess(0x40, false, pid); procHandles[pid] = ph; }
                        if (ph == IntPtr.Zero) continue;
                        IntPtr dup;
                        if (!SecN.DuplicateHandle(ph, Marshal.ReadIntPtr(e, 16), N.GetCurrentProcess(), out dup, 0, false, 2)) continue;
                        scanned++;
                        try
                        {
                            string name = NameWithTimeout(dup);
                            const string prefix = "\\Device\\NamedPipe\\";
                            if (name == null || !name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                            string pn = name.Substring(prefix.Length);
                            if (pn.Length == 0) continue;
                            string end = PipeEnd(dup);
                            D d;
                            if (!res.TryGetValue(pn, out d))
                            {
                                d = new D { { "name", "\\\\.\\pipe\\" + pn }, { "pids", new List<object>() }, { "serverEndInTree", false } };
                                var acl = PipeAcl(dup);
                                foreach (var kv in acl) d[kv.Key] = kv.Value;
                                res[pn] = d;
                            }
                            var pl = (List<object>)d["pids"];
                            if (!pl.Contains((long)pid)) pl.Add((long)pid);
                            if (end == "server") d["serverEndInTree"] = true;
                            if (!d.ContainsKey("end") || end == "server") d["end"] = end;
                        }
                        finally { N.CloseHandle(dup); }
                    }
                    foreach (var h in procHandles.Values) if (h != IntPtr.Zero) N.CloseHandle(h);
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
            return res.Values.ToList();
        }

        static string Process_SelfExe() { return System.Reflection.Assembly.GetExecutingAssembly().Location; }

        static string NameWithTimeout(IntPtr h)
        {
            string r = null;
            var th = new Thread(() =>
            {
                IntPtr b = Marshal.AllocHGlobal(2048);
                try
                {
                    int ret;
                    if (SecN.NtQueryObject(h, 1, b, 2048, out ret) == 0)
                    {
                        int len = (ushort)Marshal.ReadInt16(b);
                        IntPtr sp = Marshal.ReadIntPtr(b, 8);
                        if (len > 0 && sp != IntPtr.Zero) r = Marshal.PtrToStringUni(sp, len / 2);
                    }
                }
                catch { }
                finally { Marshal.FreeHGlobal(b); }
            }) { IsBackground = true };
            th.Start();
            if (!th.Join(150)) return null;
            return r;
        }

        static string PipeEnd(IntPtr h)
        {
            IntPtr b = Marshal.AllocHGlobal(64);
            try
            {
                SecN.IOSB io;
                if (SecN.NtQueryInformationFile(h, out io, b, 64, 24) != 0) return "unknown";
                return Marshal.ReadInt32(b, 36) == 1 ? "server" : "client";
            }
            catch { return "unknown"; }
            finally { Marshal.FreeHGlobal(b); }
        }

        static D PipeAcl(IntPtr h)
        {
            var d = new D();
            IntPtr o, g, dacl, sacl, sd;
            if (SecN.GetSecurityInfo(h, 6, 1 | 4, out o, out g, out dacl, out sacl, out sd) != 0) { d["dacl"] = "unreadable"; return d; }
            try
            {
                uint len = SecN.GetSecurityDescriptorLength(sd);
                var bytes = new byte[len];
                Marshal.Copy(sd, bytes, 0, (int)len);
                var rsd = new RawSecurityDescriptor(bytes, 0);
                try { d["owner"] = rsd.Owner.Translate(typeof(NTAccount)).Value; } catch { if (rsd.Owner != null) d["owner"] = rsd.Owner.Value; }
                var aces = new List<object>();
                var weak = new List<object>();
                if (rsd.DiscretionaryAcl == null) { d["dacl"] = "NULL DACL (everyone has full access)"; d["weak"] = true; d["weakPrincipals"] = new List<object> { "Everyone (NULL DACL)" }; return d; }
                foreach (GenericAce a in rsd.DiscretionaryAcl)
                {
                    var q = a as QualifiedAce;
                    if (q == null) continue;
                    string nm; try { nm = q.SecurityIdentifier.Translate(typeof(NTAccount)).Value; } catch { nm = q.SecurityIdentifier.Value; }
                    bool allow = q.AceQualifier == AceQualifier.AccessAllowed;
                    aces.Add((allow ? "allow " : "deny ") + nm + " 0x" + q.AccessMask.ToString("x"));
                    if (allow && WeakSids.Contains(q.SecurityIdentifier.Value) && ((q.AccessMask & (0x2 | 0x4 | 0x40000000 | 0x10000000)) != 0 || (q.AccessMask & 0x1F01FF) == 0x1F01FF)) weak.Add(nm + " 0x" + q.AccessMask.ToString("x"));
                }
                d["dacl"] = aces; d["weak"] = weak.Count > 0; d["weakPrincipals"] = weak;
            }
            catch (Exception ex) { d["dacl"] = "error:" + ex.GetType().Name; }
            finally { SecN.LocalFree(sd); }
            return d;
        }

        public static object Ipc(Win w, D args, Target t)
        {
            string action = J.S(args, "action") ?? "list";
            var tree = TreeOf(w);
            var rows = NetTables.All(new HashSet<uint>(tree.InScope));
            if (action == "list")
            {
                var sw = Stopwatch.StartNew();
                string note;
                var pipes = Pipes(tree, sw, out note);
                var listeners = rows.Where(r => r.State == "LISTEN" || r.State == "BOUND").Select(r => (object)new D { { "proto", r.Proto }, { "address", r.Local }, { "port", r.LPort }, { "pid", (long)r.Pid }, { "bind", r.Bind }, { "reachableOffBox", r.Bind != "loopback" } }).ToList();
                var res = new D { { "pipes", pipes.OrderByDescending(p => p.ContainsKey("weak") && p["weak"] is bool && (bool)p["weak"]).Cast<object>().ToList() }, { "weakPipes", pipes.Count(p => p.ContainsKey("weak") && p["weak"] is bool && (bool)p["weak"]) }, { "listeners", listeners } };
                if (note != null) res["note"] = note;
                res["report"] = Fmt.Text(new D { { "pipes", res["pipes"] }, { "listeners", listeners }, { "note", note ?? "" } });
                return res;
            }
            if (action != "probe") throw new HelperError("failed", "Unknown ipc action.");
            if (!t.AllowInput) throw new HelperError("refused", "Input is not enabled for this run.");
            int port = J.I(args, "port", 0);
            string path = J.S(args, "path") ?? "/";
            if (port < 1 || port > 65535) throw new HelperError("failed", "port must be 1..65535.");
            if (path.Length > 200 || !path.StartsWith("/") || !Regex.IsMatch(path, "^[A-Za-z0-9/._~%?=&:@!$'()*+,;\\-]*$")) throw new HelperError("failed", "path must start with / and contain only URL characters (200 max).");
            var owner = rows.FirstOrDefault(r => r.State == "LISTEN" && r.LPort == port && r.Proto.StartsWith("tcp") && r.Bind != "lan");
            if (owner == null) throw new HelperError("refused", "No TCP listener on loopback port " + port + " is owned by the target's process tree.");
            var plain = Http(port, path, "127.0.0.1:" + port);
            var foreign = Http(port, path, "pimi-rebind-check.invalid");
            bool rebind = foreign.ContainsKey("status") && (int)foreign["status"] >= 200 && (int)foreign["status"] < 400;
            var d = new D { { "port", port }, { "bind", owner.Bind }, { "ownerPid", (long)owner.Pid }, { "normalHost", plain }, { "foreignHost", foreign },
                { "foreignHostAccepted", rebind }, { "dnsRebindingRisk", rebind ? "the server answered a request whose Host header was not localhost" : "foreign Host header was rejected or closed" } };
            d["report"] = Fmt.Text(d);
            return d;
        }

        static bool Complete(byte[] buf, int total)
        {
            string t = Encoding.ASCII.GetString(buf, 0, Math.Min(total, 8192));
            int he = t.IndexOf("\r\n\r\n");
            if (he < 0) return false;
            var m = Regex.Match(t.Substring(0, he), "(?im)^content-length:\\s*(\\d+)");
            if (!m.Success) return false;
            return total >= he + 4 + int.Parse(m.Groups[1].Value);
        }

        static D Http(int port, string path, string host)
        {
            var d = new D();
            var sw = Stopwatch.StartNew();
            try
            {
                using (var c = new TcpClient())
                {
                    var ar = c.BeginConnect(IPAddress.Loopback, port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(1500)) { d["error"] = "connect timeout"; return d; }
                    c.EndConnect(ar);
                    c.ReceiveTimeout = 1500; c.SendTimeout = 1500;
                    var ns = c.GetStream();
                    string req = "GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nUser-Agent: pimi-security-probe\r\nAccept: */*\r\nConnection: close\r\n\r\n";
                    var rb = Encoding.ASCII.GetBytes(req);
                    ns.Write(rb, 0, rb.Length);
                    var buf = new byte[16384];
                    int total = 0;
                    while (total < buf.Length && sw.ElapsedMilliseconds < 3000)
                    {
                        if (total > 0 && Complete(buf, total)) break;
                        int n;
                        try { n = ns.Read(buf, total, buf.Length - total); } catch (IOException) { break; }
                        if (n <= 0) break;
                        total += n;
                    }
                    d["bytesRead"] = total;
                    d["capped"] = total >= buf.Length;
                    string text = Encoding.UTF8.GetString(buf, 0, total);
                    if (total == 0) { d["response"] = "connection closed with no data"; return d; }
                    int he = text.IndexOf("\r\n\r\n");
                    string head = he >= 0 ? text.Substring(0, he) : text;
                    string body = he >= 0 ? text.Substring(he + 4) : "";
                    var lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
                    d["statusLine"] = lines[0].Length > 120 ? lines[0].Substring(0, 120) : lines[0];
                    var m = Regex.Match(lines[0], "HTTP/\\d\\.\\d (\\d{3})");
                    if (m.Success) d["status"] = int.Parse(m.Groups[1].Value);
                    var hdrs = new List<object>();
                    foreach (var l in lines.Skip(1))
                    {
                        int ix = l.IndexOf(':');
                        if (ix <= 0) continue;
                        string k = l.Substring(0, ix).Trim().ToLowerInvariant();
                        if (k == "server" || k == "content-type" || k == "access-control-allow-origin" || k == "www-authenticate" || k == "location" || k == "content-length" || k == "set-cookie")
                            hdrs.Add(k + ": " + (k == "set-cookie" ? "<present>" : Redact.Value(k, l.Substring(ix + 1).Trim())));
                    }
                    d["headers"] = hdrs;
                    d["bodyLength"] = body.Length;
                    string prev = body.Length > 160 ? body.Substring(0, 160) : body;
                    d["bodyPreview"] = Regex.Replace(Regex.Replace(prev, "[A-Za-z0-9_\\-+/=.]{20,}", mm => mm.Value.Substring(0, 4) + "...<len " + mm.Value.Length + ">"), "[\\x00-\\x08\\x0B-\\x1F]", "?");
                }
            }
            catch (Exception ex) { d["error"] = ex.GetType().Name; }
            return d;
        }

        // ---------- deeplink ----------
        public static object Deeplink(Win w, D args, Target t)
        {
            string url = J.S(args, "url");
            if (string.IsNullOrEmpty(url) || url.Length > 2000) throw new HelperError("failed", "url must be 1..2000 characters.");
            if (url.Any(ch => ch < 0x20 || ch == 0x7F)) throw new HelperError("refused", "The url contains control characters.");
            var m = Regex.Match(url, "^([A-Za-z][A-Za-z0-9+.\\-]*):");
            if (!m.Success) throw new HelperError("failed", "The url has no scheme.");
            string scheme = m.Groups[1].Value;
            var protos = Protocols(w);
            var p = protos.FirstOrDefault(x => string.Equals((string)x["scheme"], scheme, StringComparison.OrdinalIgnoreCase));
            if (p == null)
            {
                // name the real handler when there is one
                string other = null;
                try
                {
                    using (var k = Registry.ClassesRoot.OpenSubKey(scheme + @"\shell\open\command")) { if (k != null) other = ExtractExe(k.GetValue("") as string); }
                }
                catch { }
                throw new HelperError("refused", "The scheme '" + scheme + "' is not registered to the target app" + (other != null ? " (its handler is " + Path.GetFileName(other) + ")" : "") + ".");
            }
            // a payload that is more than a bare navigation needs a disposable target
            string rest = url.Substring(scheme.Length + 1);
            bool mutating = rest.Length > 400 || rest.Contains("\"") || rest.Contains(" ") || rest.Contains("%22") || rest.Contains("%20--") || rest.Contains("--") || rest.Contains("^") || rest.Contains("|") || rest.Contains("&&") || rest.Contains("`")
                || Regex.IsMatch(rest, "(?i)(\\.\\.[/\\\\]|file:|\\.exe|\\.bat|\\.cmd|\\.ps1)");
            if (mutating && !t.Disposable) throw new HelperError("refused", "This payload is more than a bare navigation. It is only sent to a target the owner marked disposable.");
            In.CheckDesktop();
            byte[] before = null;
            try { before = Cap.Hash(w); } catch { }
            var sei = new SecN.SHELLEXECUTEINFO { fMask = 0x100 | 0x400, lpVerb = "open", lpFile = url, nShow = 1 };
            sei.cbSize = Marshal.SizeOf(typeof(SecN.SHELLEXECUTEINFO));
            bool ok = SecN.ShellExecuteEx(ref sei);
            if (!ok) throw new HelperError("failed", "Windows would not open the URL (error " + Marshal.GetLastWin32Error() + ").");
            In.LastInject = Environment.TickCount;
            Thread.Sleep(1500);
            bool changed = false;
            try { if (before != null) changed = Cap.Different(before, Cap.Hash(w)); } catch { }
            return new D { { "launched", true }, { "handler", Path.GetFileName((string)p["handlerExe"]) }, { "scheme", scheme }, { "payloadLength", url.Length }, { "mutatingPayload", mutating }, { "focusLeft", In.FocusLeft(w) }, { "changed", changed } };
        }
    }
}








