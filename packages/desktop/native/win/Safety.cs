using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace PimiDesktopHelper
{
    class HelperError : Exception
    {
        public string Code;
        public HelperError(string code, string message) : base(message) { Code = code; }
    }

    class ProcInfo
    {
        public uint Pid;
        public string Path = "", Exe = "", Aumid, Started;
        public bool Elevated, OpenFailed;
    }

    class ProcEntry { public uint Pid, Parent; public string Exe; }

    static class Procs
    {
        static readonly Dictionary<uint, ProcInfo> cache = new Dictionary<uint, ProcInfo>();
        static Dictionary<uint, ProcEntry> snap;
        static int myIntegrity = -1;
        public static readonly uint Self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;

        public static void Reset() { cache.Clear(); snap = null; }

        public static Dictionary<uint, ProcEntry> Snapshot()
        {
            if (snap != null) return snap;
            var d = new Dictionary<uint, ProcEntry>();
            IntPtr s = N.CreateToolhelp32Snapshot(2, 0);
            if (s != IntPtr.Zero && s != new IntPtr(-1))
            {
                var e = new PROCESSENTRY32 { dwSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(PROCESSENTRY32)) };
                bool ok = N.Process32FirstW(s, ref e);
                while (ok)
                {
                    d[e.th32ProcessID] = new ProcEntry { Pid = e.th32ProcessID, Parent = e.th32ParentProcessID, Exe = (e.szExeFile ?? "").ToLowerInvariant() };
                    ok = N.Process32NextW(s, ref e);
                }
                N.CloseHandle(s);
            }
            snap = d;
            return d;
        }

        static int Integrity(IntPtr tok, out bool elevated)
        {
            elevated = true;
            int ret;
            IntPtr buf = System.Runtime.InteropServices.Marshal.AllocHGlobal(64);
            try
            {
                if (N.GetTokenInformation(tok, 20, buf, 4, out ret)) elevated = System.Runtime.InteropServices.Marshal.ReadInt32(buf) != 0;
                else return -1;
                IntPtr big = System.Runtime.InteropServices.Marshal.AllocHGlobal(256);
                try
                {
                    if (!N.GetTokenInformation(tok, 25, big, 256, out ret)) return -1;
                    IntPtr sid = System.Runtime.InteropServices.Marshal.ReadIntPtr(big);
                    IntPtr cnt = N.GetSidSubAuthorityCount(sid);
                    int n = System.Runtime.InteropServices.Marshal.ReadByte(cnt);
                    IntPtr last = N.GetSidSubAuthority(sid, (uint)(n - 1));
                    return System.Runtime.InteropServices.Marshal.ReadInt32(last);
                }
                finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(big); }
            }
            finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(buf); }
        }

        // Integrity RID of a process (0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system), or -1 when it cannot be read.
        public static int IntegrityRid(uint pid)
        {
            IntPtr h = N.OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return -1;
            try
            {
                IntPtr tok;
                if (!N.OpenProcessToken(h, 8, out tok)) return -1;
                bool el;
                int r = Integrity(tok, out el);
                N.CloseHandle(tok);
                return r;
            }
            finally { N.CloseHandle(h); }
        }

        public static int MyIntegrity
        {
            get
            {
                if (myIntegrity >= 0) return myIntegrity;
                IntPtr tok;
                bool el;
                if (N.OpenProcessToken(N.GetCurrentProcess(), 8, out tok)) { myIntegrity = Math.Max(0, Integrity(tok, out el)); MyElevated = el; N.CloseHandle(tok); }
                else myIntegrity = 0x2000;
                return myIntegrity;
            }
        }
        public static bool MyElevated;

        public static ProcInfo Get(uint pid)
        {
            ProcInfo p;
            if (cache.TryGetValue(pid, out p)) return p;
            p = new ProcInfo { Pid = pid };
            cache[pid] = p;
            IntPtr h = N.OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) { p.OpenFailed = true; p.Elevated = true; return p; }
            try
            {
                var sb = new StringBuilder(1024);
                uint n = 1024;
                if (N.QueryFullProcessImageName(h, 0, sb, ref n))
                {
                    p.Path = sb.ToString().ToLowerInvariant();
                    p.Exe = System.IO.Path.GetFileName(p.Path);
                }
                long c, e, k, u;
                if (N.GetProcessTimes(h, out c, out e, out k, out u)) p.Started = c.ToString();
                uint len = 512;
                var sb2 = new StringBuilder(512);
                if (N.GetApplicationUserModelId(h, ref len, sb2) == 0) p.Aumid = sb2.ToString();
                IntPtr tok;
                if (N.OpenProcessToken(h, 8, out tok))
                {
                    bool el;
                    int il = Integrity(tok, out el);
                    N.CloseHandle(tok);
                    int mine = MyIntegrity;
                    p.Elevated = il < 0 ? true : (il > mine || (el && !MyElevated));
                }
                else p.Elevated = true;
            }
            finally { N.CloseHandle(h); }
            return p;
        }
    }

    static class Safety
    {
        static readonly HashSet<string> DenyExe = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static readonly HashSet<string> DenyClass = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public static string Denied(Win w)
        {
            string exe = w.Exe ?? "";
            if (DenyExe.Contains(exe)) return "deny";
            if (DenyClass.Contains(w.Class)) return "deny";
            return null;
        }

        static string installDir;
        public static string InstallDir
        {
            get
            {
                if (installDir != null) return installDir;
                string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
                var parent = Directory.GetParent(dir);
                if (parent != null && parent.Name.Equals("resources", StringComparison.OrdinalIgnoreCase) && Directory.GetParent(parent.FullName) != null)
                    dir = Directory.GetParent(parent.FullName).FullName;
                installDir = dir.ToLowerInvariant().TrimEnd('\\') + "\\";
                return installDir;
            }
        }

        static string parentPath;
        public static bool IsOwn(Win w)
        {
            if (w.Pid == Procs.Self) return true;
            if (w.Aumid != null && w.Aumid.StartsWith("com.pimi.", StringComparison.OrdinalIgnoreCase)) return true;
            if (!string.IsNullOrEmpty(w.Path) && w.Path.StartsWith(InstallDir)) return true;
            if (w.Exe == "pimi.exe" || w.Exe == "pimi-desktop-helper.exe") return true;
            if (parentPath == null)
            {
                parentPath = "";
                ProcEntry me;
                if (Procs.Snapshot().TryGetValue(Procs.Self, out me)) parentPath = Procs.Get(me.Parent).Path ?? "";
            }
            if (parentPath.Length > 0 && w.Path == parentPath) return true;
            return false;
        }

    }
}

