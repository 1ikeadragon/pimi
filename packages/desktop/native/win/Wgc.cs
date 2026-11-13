using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

namespace PimiDesktopHelper
{
    // Windows.Graphics.Capture for one HWND. A session per window stays warm for 5 s after its last use.
    static class Wgc
    {
        [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IGraphicsCaptureItemInterop
        {
            IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
            IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
        }

        [ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IDirect3DDxgiInterfaceAccess { IntPtr GetInterface([In] ref Guid iid); }

        [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr sw, uint flags, IntPtr levels, uint nLevels, uint sdk, out IntPtr dev, out int fl, out IntPtr ctx);
        [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr graphicsDevice);

        [StructLayout(LayoutKind.Sequential)]
        struct TexDesc { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags; }
        [StructLayout(LayoutKind.Sequential)]
        struct Mapped { public IntPtr pData; public uint RowPitch, DepthPitch; }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetDescFn(IntPtr self, out TexDesc d);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTex2DFn(IntPtr self, ref TexDesc d, IntPtr init, out IntPtr tex);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyResourceFn(IntPtr self, IntPtr dst, IntPtr src);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapFn(IntPtr self, IntPtr res, uint sub, uint type, uint flags, out Mapped m);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapFn(IntPtr self, IntPtr res, uint sub);

        static T Vt<T>(IntPtr obj, int idx) where T : class
        {
            IntPtr vtbl = Marshal.ReadIntPtr(obj);
            return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, idx * IntPtr.Size), typeof(T));
        }

        static readonly Guid IidItem = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
        static readonly Guid IidDxgiDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        static readonly Guid IidTex2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

        class Sess
        {
            public GraphicsCaptureItem Item;
            public Direct3D11CaptureFramePool Pool;
            public GraphicsCaptureSession Session;
            public SizeInt32 Size;
            public Bitmap Last;
            public long LastUse;
        }

        static readonly object lk = new object();
        static readonly Dictionary<IntPtr, Sess> sessions = new Dictionary<IntPtr, Sess>();
        static IntPtr devPtr, ctxPtr;
        static IDirect3DDevice winrtDev;
        static IGraphicsCaptureItemInterop interop;
        static Timer sweeper;
        static bool initFailed;

        static void Init()
        {
            if (winrtDev != null) return;
            if (initFailed) throw new InvalidOperationException("wgc init failed");
            try
            {
                if (!GraphicsCaptureSession.IsSupported()) throw new NotSupportedException("WGC not supported");
                int fl;
                int hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out devPtr, out fl, out ctxPtr);
                if (hr < 0) throw new COMException("D3D11CreateDevice", hr);
                IntPtr dxgi;
                Guid g = IidDxgiDevice;
                Marshal.ThrowExceptionForHR(Marshal.QueryInterface(devPtr, ref g, out dxgi));
                IntPtr wd;
                Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out wd));
                Marshal.Release(dxgi);
                winrtDev = (IDirect3DDevice)Marshal.GetObjectForIUnknown(wd);
                Marshal.Release(wd);
                interop = (IGraphicsCaptureItemInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
                sweeper = new Timer(_ => Sweep(), null, 1000, 1000);
            }
            catch { initFailed = true; throw; }
        }

        public static bool Available()
        {
            try { Init(); return true; } catch { return false; }
        }

        static void Sweep()
        {
            lock (lk)
            {
                var dead = new List<IntPtr>();
                foreach (var kv in sessions) if (Environment.TickCount - kv.Value.LastUse > 5000 || !N.IsWindow(kv.Key)) dead.Add(kv.Key);
                foreach (var h in dead) { Close(sessions[h]); sessions.Remove(h); }
            }
        }

        static void Close(Sess s)
        {
            try { s.Session.Dispose(); } catch { }
            try { s.Pool.Dispose(); } catch { }
            if (s.Last != null) s.Last.Dispose();
        }

        public static void Shutdown()
        {
            lock (lk) { foreach (var s in sessions.Values) Close(s); sessions.Clear(); }
        }

        static Sess Open(IntPtr hwnd)
        {
            Guid iid = IidItem;
            IntPtr p = interop.CreateForWindow(hwnd, ref iid);
            var item = (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(p);
            Marshal.Release(p);
            var size = item.Size;
            var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(winrtDev, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, size);
            var session = pool.CreateCaptureSession(item);
            try { session.IsCursorCaptureEnabled = false; } catch { }
            try
            {
                var pr = session.GetType().GetProperty("IsBorderRequired");
                if (pr != null) pr.SetValue(session, false, null);
            }
            catch { }
            session.StartCapture();
            return new Sess { Item = item, Pool = pool, Session = session, Size = size, LastUse = Environment.TickCount };
        }

        static Bitmap ToBitmap(Direct3D11CaptureFrame f)
        {
            var access = (IDirect3DDxgiInterfaceAccess)f.Surface;
            Guid g = IidTex2D;
            IntPtr tex = access.GetInterface(ref g);
            IntPtr staging = IntPtr.Zero;
            try
            {
                TexDesc d;
                Vt<GetDescFn>(tex, 10)(tex, out d);
                var sd = d;
                sd.Usage = 3; sd.BindFlags = 0; sd.CPUAccessFlags = 0x20000; sd.MiscFlags = 0; sd.MipLevels = 1; sd.ArraySize = 1;
                int hr = Vt<CreateTex2DFn>(devPtr, 5)(devPtr, ref sd, IntPtr.Zero, out staging);
                if (hr < 0) throw new COMException("CreateTexture2D", hr);
                Vt<CopyResourceFn>(ctxPtr, 47)(ctxPtr, staging, tex);
                Mapped m;
                hr = Vt<MapFn>(ctxPtr, 14)(ctxPtr, staging, 0, 1, 0, out m);
                if (hr < 0) throw new COMException("Map", hr);
                int w = Math.Min((int)d.Width, f.ContentSize.Width), h = Math.Min((int)d.Height, f.ContentSize.Height);
                var bmp = new Bitmap(w, h, PixelFormat.Format32bppRgb);
                var bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
                try
                {
                    unsafe
                    {
                        for (int y = 0; y < h; y++)
                            Buffer.MemoryCopy((byte*)m.pData + (long)y * m.RowPitch, (byte*)bd.Scan0 + (long)y * bd.Stride, bd.Stride, w * 4);
                    }
                }
                finally { bmp.UnlockBits(bd); Vt<UnmapFn>(ctxPtr, 15)(ctxPtr, staging, 0); }
                return bmp;
            }
            finally
            {
                if (staging != IntPtr.Zero) Marshal.Release(staging);
                Marshal.Release(tex);
            }
        }

        public static Bitmap Capture(IntPtr hwnd, RECT frame)
        {
            Bitmap src = null;
            lock (lk)
            {
                Init();
                Sess s;
                if (!sessions.TryGetValue(hwnd, out s)) { s = Open(hwnd); sessions[hwnd] = s; }
                try
                {
                    var sw = Stopwatch.StartNew();
                    while (true)
                    {
                        Direct3D11CaptureFrame f;
                        bool got = false;
                        while ((f = s.Pool.TryGetNextFrame()) != null)
                        {
                            got = true;
                            try
                            {
                                if (f.ContentSize.Width != s.Size.Width || f.ContentSize.Height != s.Size.Height)
                                {
                                    s.Size = f.ContentSize;
                                    s.Pool.Recreate(winrtDev, DirectXPixelFormat.B8G8R8A8UIntNormalized, 1, s.Size);
                                }
                                var b = ToBitmap(f);
                                if (s.Last != null) s.Last.Dispose();
                                s.Last = b;
                            }
                            finally { f.Dispose(); }
                        }
                        if (s.Last != null && (got || sw.ElapsedMilliseconds > 0)) break;
                        if (sw.ElapsedMilliseconds > 350) break;
                        Thread.Sleep(10);
                    }
                    s.LastUse = Environment.TickCount;
                    if (s.Last == null) return null;
                    src = (Bitmap)s.Last.Clone();
                }
                catch { Close(s); sessions.Remove(hwnd); throw; }
            }
            var wr = N.WinRect(hwnd);
            if (src.Width == frame.W && src.Height == frame.H) return src;
            Rectangle r;
            if (src.Width == wr.W && src.Height == wr.H) r = new Rectangle(frame.Left - wr.Left, frame.Top - wr.Top, frame.W, frame.H);
            else r = new Rectangle(0, 0, Math.Min(src.Width, frame.W), Math.Min(src.Height, frame.H));
            r.Intersect(new Rectangle(0, 0, src.Width, src.Height));
            if (r.Width <= 0 || r.Height <= 0) { src.Dispose(); return null; }
            var c = src.Clone(r, PixelFormat.Format32bppRgb);
            src.Dispose();
            return c;
        }
    }
}
