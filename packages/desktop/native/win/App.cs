using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;

namespace PimiDesktopHelper
{
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager
    {
        int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, int options, out uint processId);
        int ActivateForFile(string a, IntPtr b, string c, out uint d);
        int ActivateForProtocol(string a, IntPtr b, out uint c);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    class ApplicationActivationManager { }

    // The `app` verb: only ever touches the pinned app (its recorded exe path or AUMID).
    static class Apps
    {
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern uint GetGuiResources(IntPtr h, uint flag);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);

        class Held { public IntPtr H; public string Started; }
        static readonly Dictionary<uint, Held> handles = new Dictionary<uint, Held>();

        public static void Track(Win w)
        {
            if (handles.ContainsKey(w.Pid)) return;
            IntPtr h = N.OpenProcess(0x1000 | 0x400 | 0x100000, false, w.Pid);
            if (h == IntPtr.Zero) h = N.OpenProcess(0x1000 | 0x100000, false, w.Pid);
            if (h != IntPtr.Zero) handles[w.Pid] = new Held { H = h, Started = w.Started };
        }

        static bool IsAumid(string id) { return id != null && !id.Contains("\\") && !id.Contains(":") && id.Contains("!"); }

        static Dictionary<string, object> Status(Target t)
        {
            var d = new Dictionary<string, object>();
            if (!t.HasPid) throw new HelperError("failed", "The target has no recorded process.");
            uint pid = (uint)t.Pid;
            Held held;
            bool running = false; uint exit = 0; bool haveExit = false;
            if (handles.TryGetValue(pid, out held))
            {
                if (GetExitCodeProcess(held.H, out exit)) { running = exit == 259; haveExit = !running; }
            }
            else
            {
                var p = Procs.Get(pid);
                running = !p.OpenFailed && (t.Started == null || p.Started == t.Started);
            }
            d["running"] = running;
            d["status"] = running ? "running" : "exited";
            if (haveExit) d["exitCode"] = (long)exit;
            if (!running) { d["werFaultUp"] = WerUp(pid); return d; }
            try
            {
                using (var pr = Process.GetProcessById((int)pid))
                {
                    d["workingSetMB"] = Math.Round(pr.WorkingSet64 / 1048576.0, 1);
                    try { d["cpuSeconds"] = Math.Round(pr.TotalProcessorTime.TotalSeconds, 2); } catch { }
                    try { d["uptimeSeconds"] = Math.Round((DateTime.Now - pr.StartTime).TotalSeconds, 1); } catch { }
                    if (held != null)
                    {
                        d["gdiHandles"] = (long)GetGuiResources(held.H, 0);
                        d["userHandles"] = (long)GetGuiResources(held.H, 1);
                    }
                }
            }
            catch { }
            bool hung = false;
            bool responding = true;
            foreach (var h in Wn.TopLevels()) if (N.Pid(h) == pid && N.IsWindowVisible(h)) { if (N.IsHungAppWindow(h)) hung = true; }
            responding = !hung;
            d["responding"] = responding;
            d["werFaultUp"] = WerUp(pid);
            return d;
        }

        static bool WerUp(uint pid)
        {
            try
            {
                using (var s = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE Name='WerFault.exe'"))
                    foreach (ManagementObject o in s.Get())
                    {
                        string cl = Convert.ToString(o["CommandLine"]) ?? "";
                        if (Regex.IsMatch(cl, @"-p\s+" + pid + @"\b")) return true;
                    }
            }
            catch { }
            return false;
        }

        static void CheckLaunchable(Target t)
        {
            if (string.IsNullOrEmpty(t.AppId)) throw new HelperError("failed", "The target has no recorded app.");
            var fake = new Win { Class = "", Title = "" };
            if (IsAumid(t.AppId))
            {
                fake.Aumid = t.AppId; fake.AppId = t.AppId; fake.Exe = ""; fake.Path = "";
            }
            else
            {
                fake.Path = t.AppId.ToLowerInvariant(); fake.Exe = Path.GetFileName(fake.Path); fake.AppId = fake.Path;
                if (!File.Exists(t.AppId) || !fake.Path.EndsWith(".exe")) throw new HelperError("failed", "The recorded program file does not exist.");
            }
            if (Safety.Denied(fake) != null) throw new HelperError("blocked", "This app is on the never-drive list.");
            if (Safety.IsOwn(fake)) throw new HelperError("refused", "This is Pimi itself.");
        }

        static Win FindWindowOf(Target t)
        {
            foreach (var h in Wn.TopLevels())
            {
                if (!Wn.EligibleTopLevel(h)) continue;
                var w = Wn.Inspect(h);
                if (w != null && string.Equals(w.AppId, t.AppId, StringComparison.OrdinalIgnoreCase)) return w;
            }
            return null;
        }

        static void StartApp(Target t)
        {
            if (IsAumid(t.AppId))
            {
                var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
                uint pid;
                int hr = mgr.ActivateApplication(t.AppId, t.LaunchArgs ?? "", 0, out pid);
                if (hr < 0) throw new HelperError("failed", "Windows would not start the app (0x" + hr.ToString("x") + ").");
            }
            else
            {
                var psi = new ProcessStartInfo(t.AppId) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(t.AppId) };
                if (!string.IsNullOrEmpty(t.LaunchArgs)) psi.Arguments = t.LaunchArgs;
                Process.Start(psi).Dispose();
            }
        }

        public static object Run(Dictionary<string, object> a, Target t)
        {
            if (t == null) throw new HelperError("refused", "This verb needs a target.");
            string action = J.S(a, "action") ?? "status";
            if (action == "status") return Status(t);
            if (!t.AllowRelaunch) throw new HelperError("refused", "The owner has not allowed launching or relaunching this app.");
            CheckLaunchable(t);
            var res = new Dictionary<string, object>();
            if (action == "relaunch")
            {
                bool gone = true;
                if (t.HasPid)
                {
                    IntPtr hw = t.Hwnd;
                    var p = Procs.Get((uint)t.Pid);
                    bool same = !p.OpenFailed && (t.Started == null || p.Started == t.Started);
                    if (same)
                    {
                        gone = false;
                        if (hw != IntPtr.Zero && N.IsWindow(hw) && N.Pid(hw) == t.Pid) PostMessage(hw, 0x10, IntPtr.Zero, IntPtr.Zero);
                        for (int i = 0; i < 30 && !gone; i++) { Thread.Sleep(100); Procs.Reset(); gone = Procs.Get((uint)t.Pid).OpenFailed || (t.Started != null && Procs.Get((uint)t.Pid).Started != t.Started); }
                        if (!gone)
                        {
                            if (!t.Disposable) throw new HelperError("failed", "The app did not close within 3 seconds, and this target is not marked disposable, so it was left running.");
                            try { using (var pr = Process.GetProcessById((int)t.Pid)) { pr.Kill(); pr.WaitForExit(3000); } } catch { }
                            res["terminated"] = true;
                        }
                    }
                }
                Thread.Sleep(300);
            }
            else if (action == "launch")
            {
                Procs.Reset();
                var running = FindWindowOf(t);
                if (running != null) { res["launched"] = false; res["running"] = true; res["repinned"] = Pin(running); return res; }
            }
            else throw new HelperError("failed", "Unknown app action.");
            StartApp(t);
            var sw = Stopwatch.StartNew();
            Win found = null;
            while (sw.ElapsedMilliseconds < 15000)
            {
                Thread.Sleep(250); Procs.Reset();
                found = FindWindowOf(t);
                if (found != null) break;
            }
            if (found == null) throw new HelperError("failed", "The app started but no window of it appeared within 15 seconds (it may have handed off to another program).");
            res["launched"] = true;
            res["repinned"] = Pin(found);
            return res;
        }

        static Dictionary<string, object> Pin(Win w)
        {
            return new Dictionary<string, object> { { "hwnd", ((long)w.Hwnd).ToString() }, { "pid", (long)w.Pid }, { "processStartedAt", w.Started } };
        }
    }
}

