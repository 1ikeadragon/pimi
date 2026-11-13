using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

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
        static readonly HashSet<string> DenyExe = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "cmd.exe","powershell.exe","pwsh.exe","powershell_ise.exe","windowsterminal.exe","wt.exe","openconsole.exe","conhost.exe","wsl.exe","wslhost.exe","bash.exe","mintty.exe","git-bash.exe","alacritty.exe","wezterm-gui.exe","kitty.exe","conemu.exe","conemu64.exe","cmder.exe","tabby.exe","hyper.exe","warp.exe","fluentterminal.app.exe","putty.exe","kitty_portable.exe","mobaxterm.exe","securecrt.exe","termius.exe",
            "mstsc.exe","msrdc.exe","quickassist.exe","teamviewer.exe","anydesk.exe","parsecd.exe","vncviewer.exe",
            "regedit.exe","taskmgr.exe","mmc.exe","systemsettings.exe","control.exe","msconfig.exe","perfmon.exe","resmon.exe","eventvwr.exe","sechealthui.exe","useraccountcontrolsettings.exe","netplwiz.exe","rundll32.exe","systempropertiesadvanced.exe","optionalfeatures.exe","msiexec.exe","wscript.exe","cscript.exe","mshta.exe","dism.exe","diskpart.exe","procexp.exe","procexp64.exe","processhacker.exe","systeminformer.exe",
            "pad.console.host.exe","pad.designer.exe","powertoys.exe",
            "consent.exe","credentialuibroker.exe","logonui.exe","lockapp.exe","winlogon.exe","1password.exe","bitwarden.exe","keepass.exe","keepassxc.exe","lastpass.exe","dashlane.exe","nordpass.exe","protonpass.exe","enpass.exe","roboform.exe","keeperpasswordmanager.exe","authy desktop.exe",
            "explorer.exe","startmenuexperiencehost.exe","searchhost.exe","shellexperiencehost.exe","textinputhost.exe","applicationframehost.exe"
        };
        static readonly HashSet<string> DenyClass = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "ConsoleWindowClass","CASCADIA_HOSTING_WINDOW_CLASS","PseudoConsoleWindow","mintty","Credential Dialog Xaml Host","Shell_TrayWnd","Shell_SecondaryTrayWnd","Progman","WorkerW"
        };

        public static string Denied(Win w)
        {
            string exe = w.Exe ?? "";
            if (DenyExe.Contains(exe) || exe.StartsWith("autohotkey") || exe.StartsWith("systemproperties")) return "deny";
            if (DenyClass.Contains(w.Class)) return "deny";
            if (w.Aumid != null && (w.Aumid.StartsWith("windows.immersivecontrolpanel", StringComparison.OrdinalIgnoreCase))) return "deny";
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

        // ---- anti-cheat ----
        static readonly uint[] SteamIds = { 1808500, 1938090, 730, 2669320, 3405690, 1063730, 578080, 581320, 359550, 3058630, 1144200, 2073850, 1172470, 252490, 2767030, 2807960 };
        static readonly string[] MarkerPrefixes = { "EasyAntiCheat", "EasyAntiCheat_EOS", "start_protected_game.exe", "BattlEye", "BEService", "EAAntiCheat", "AntiCheatExpert", "GameGuard", "xigncode", "mhyprot", "vgc", "FACEIT" };
        static readonly HashSet<string> AcProcs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "beservice.exe", "vgc.exe", "eaanticheat.gameservice.exe", "sguard64.exe" };
        static readonly Dictionary<string, string> staticCache = new Dictionary<string, string>();

        static bool IsAcProcName(string exe) { return exe.StartsWith("easyanticheat") || AcProcs.Contains(exe); }

        public static string AntiCheat(Win w)
        {
            string r = AntiCheatStatic(w.Path);
            if (r != null) return r;
            var snap = Procs.Snapshot();
            ProcEntry me;
            if (snap.TryGetValue(w.Pid, out me))
            {
                ProcEntry par;
                if (snap.TryGetValue(me.Parent, out par) && IsAcProcName(par.Exe)) return "anti_cheat";
                foreach (var e in snap.Values) if (e.Parent == w.Pid && IsAcProcName(e.Exe)) return "anti_cheat";
            }
            return null;
        }

        public static string AntiCheatStatic(string exePath)
        {
            if (string.IsNullOrEmpty(exePath)) return null;
            string r;
            if (staticCache.TryGetValue(exePath, out r)) return r;
            r = null;
            try { r = ScanStatic(exePath); } catch { }
            staticCache[exePath] = r;
            return r;
        }

        static bool IsBoundary(string dir)
        {
            string d = dir.TrimEnd('\\').ToLowerInvariant();
            if (d.Length <= 3) return true;
            string name = System.IO.Path.GetFileName(d);
            if (name == "program files" || name == "program files (x86)" || name == "windows" || name == "users" || name == "common" || name == "steamapps" || name == "epic games" || name == "windowsapps" || name == "programdata" || name == "appdata" || name == "local" || name == "locallow" || name == "roaming" || name == "programs" || name == "desktop" || name == "downloads" || name == "documents" || name == "temp") return true;
            return false;
        }

        static string ScanStatic(string exePath)
        {
            string dir = System.IO.Path.GetDirectoryName(exePath);
            // Steam app id
            uint id = SteamAppId(dir);
            if (id != 0 && SteamIds.Contains(id)) return "anti_cheat";
            string cur = dir;
            for (int i = 0; i < 4 && !string.IsNullOrEmpty(cur); i++)
            {
                if (i > 0 && IsBoundary(cur)) break;
                string[] names;
                try { names = Directory.GetFileSystemEntries(cur).Select(System.IO.Path.GetFileName).ToArray(); } catch { names = new string[0]; }
                foreach (var n in names)
                    foreach (var m in MarkerPrefixes)
                        if (n.StartsWith(m, StringComparison.OrdinalIgnoreCase)) return "anti_cheat";
                if (IsBoundary(cur)) break;
                var p = Directory.GetParent(cur);
                cur = p == null ? null : p.FullName;
            }
            return null;
        }

        public static uint SteamAppId(string dir)
        {
            try
            {
                string f = System.IO.Path.Combine(dir, "steam_appid.txt");
                if (File.Exists(f))
                {
                    uint v;
                    if (uint.TryParse(File.ReadAllText(f).Trim(), out v) && v != 0) return v;
                }
            }
            catch { }
            // steamapps\common\<installdir>\...
            string low = dir.ToLowerInvariant();
            int ix = low.IndexOf("\\steamapps\\common\\");
            if (ix < 0) return 0;
            string steamapps = dir.Substring(0, ix) + "\\steamapps";
            string rest = dir.Substring(ix + "\\steamapps\\common\\".Length);
            string installdir = rest.Split('\\')[0];
            try
            {
                foreach (var acf in Directory.GetFiles(steamapps, "appmanifest_*.acf"))
                {
                    string txt = File.ReadAllText(acf);
                    var m = Regex.Match(txt, "\"installdir\"\\s+\"([^\"]*)\"");
                    if (m.Success && m.Groups[1].Value.Equals(installdir, StringComparison.OrdinalIgnoreCase))
                    {
                        var id = Regex.Match(System.IO.Path.GetFileName(acf), "appmanifest_(\\d+)\\.acf");
                        if (id.Success) return uint.Parse(id.Groups[1].Value);
                    }
                }
            }
            catch { }
            return 0;
        }
    }
}

