// dsh-computer-use helper: a long-lived Windows process driven over stdin/stdout
// (one JSON object per line). Compiled on first use with the .NET Framework
// csc.exe that ships with Windows, so the npm package carries no native binary.
//
// Language level: C# 5 (no string interpolation, no ?. operator, no expression
// bodies) because that is what the in-box csc.exe understands.
//
// Request:  {"id": 1, "cmd": "screenshot", ...}
// Response: {"id": 1, "ok": true, "result": {...}} | {"id": 1, "ok": false, "error": "..."}
// Event:    {"event": "stop", "reason": "esc"}   (no id)
//
// All coordinates are physical pixels in virtual-screen space: the process is
// Per-Monitor-V2 DPI aware before any GDI / WinForms code runs.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

namespace DshComputerUse
{
    internal static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; public POINT(int x, int y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; public SIZE(int w, int h) { cx = w; cy = h; } }
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion u; }

        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);

        public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hMonitor, int type, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);

        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
        [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hwnd, int index, int value);
        [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPLACEMENT { public int length; public int flags; public int showCmd; public POINT ptMinPosition; public POINT ptMaxPosition; public RECT rcNormalPosition; }
        [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT wp);
        [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr hwnd, ref WINDOWPLACEMENT wp);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);

        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        public struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int flags);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, IntPtr pptDst, IntPtr psize, IntPtr hdcSrc, IntPtr pptSrc, int crKey, ref BLENDFUNCTION pblend, int flags);
        [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);

        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc fn, IntPtr hMod, uint threadId);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

        public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
        public const uint MOUSEEVENTF_MOVE = 0x1, MOUSEEVENTF_LEFTDOWN = 0x2, MOUSEEVENTF_LEFTUP = 0x4, MOUSEEVENTF_RIGHTDOWN = 0x8, MOUSEEVENTF_RIGHTUP = 0x10,
            MOUSEEVENTF_MIDDLEDOWN = 0x20, MOUSEEVENTF_MIDDLEUP = 0x40, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000;
        public static readonly IntPtr Marker = new IntPtr(0x44534843); // "DSHC"
    }

    internal static class Args
    {
        public static bool Has(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null; }
        public static int Int(Dictionary<string, object> d, string k, int def)
        {
            object v; if (!d.TryGetValue(k, out v) || v == null) return def;
            return (int)Math.Round(Convert.ToDouble(v));
        }
        public static double Double(Dictionary<string, object> d, string k, double def)
        {
            object v;
            return d.TryGetValue(k, out v) && v != null ? Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture) : def;
        }
        public static string Str(Dictionary<string, object> d, string k, string def)
        {
            object v; if (!d.TryGetValue(k, out v) || v == null) return def;
            return Convert.ToString(v);
        }
        public static bool Bool(Dictionary<string, object> d, string k, bool def)
        {
            object v; if (!d.TryGetValue(k, out v) || v == null) return def;
            return Convert.ToBoolean(v);
        }
        public static List<string> Strs(Dictionary<string, object> d, string k)
        {
            var list = new List<string>(); object v;
            if (d.TryGetValue(k, out v) && v is IEnumerable && !(v is string))
                foreach (var item in (IEnumerable)v) list.Add(Convert.ToString(item));
            return list;
        }
        public static List<int> Ints(Dictionary<string, object> d, string k)
        {
            var list = new List<int>(); object v;
            if (d.TryGetValue(k, out v) && v is IEnumerable && !(v is string))
                foreach (var item in (IEnumerable)v) list.Add((int)Math.Round(Convert.ToDouble(item)));
            return list;
        }
        public static List<List<int>> IntLists(Dictionary<string, object> d, string k)
        {
            var list = new List<List<int>>(); object v;
            if (d.TryGetValue(k, out v) && v is IEnumerable && !(v is string))
                foreach (var row in (IEnumerable)v)
                {
                    var inner = new List<int>();
                    foreach (var item in (IEnumerable)row) inner.Add((int)Math.Round(Convert.ToDouble(item)));
                    list.Add(inner);
                }
            return list;
        }
    }

    internal static class Program
    {
        static readonly object OutLock = new object();
        static TextWriter Out;
        public const string Version = "1";

        [STAThread]
        static int Main(string[] argv)
        {
            // Must precede every GDI / WinForms call, or the process is stuck in
            // DPI-virtualised coordinates.
            try { if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) Native.SetProcessDPIAware(); }
            catch (Exception) { try { Native.SetProcessDPIAware(); } catch (Exception) { } }

            var utf8 = new UTF8Encoding(false);
            var writer = new StreamWriter(Console.OpenStandardOutput(), utf8);
            writer.AutoFlush = true;
            Out = writer;
            var input = new StreamReader(Console.OpenStandardInput(), utf8);
            var parser = new JavaScriptSerializer();
            parser.MaxJsonLength = int.MaxValue;

            var hello = new Dictionary<string, object>();
            hello["event"] = "ready"; hello["version"] = Version; hello["pid"] = Process.GetCurrentProcess().Id;
            Emit(hello);

            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                object id = null;
                var reply = new Dictionary<string, object>();
                try
                {
                    var req = (Dictionary<string, object>)parser.DeserializeObject(line);
                    if (req.ContainsKey("id")) id = req["id"];
                    reply["id"] = id;
                    reply["result"] = Commands.Run(req);
                    reply["ok"] = true;
                }
                catch (Exception ex)
                {
                    reply["id"] = id;
                    reply["ok"] = false;
                    reply["error"] = ex.Message;
                }
                Emit(reply);
            }
            Overlay.Shutdown();
            return 0;
        }

        public static void Emit(Dictionary<string, object> msg)
        {
            lock (OutLock)
            {
                var s = new JavaScriptSerializer();
                s.MaxJsonLength = int.MaxValue;
                Out.Write(s.Serialize(msg));
                Out.Write('\n');
                Out.Flush();
            }
        }

        public static void EmitEvent(string name, string reason)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                var e = new Dictionary<string, object>();
                e["event"] = name; e["reason"] = reason;
                try { Emit(e); } catch (Exception) { }
            });
        }
    }

    internal static class Commands
    {
        public static object Run(Dictionary<string, object> r)
        {
            string cmd = Args.Str(r, "cmd", "");
            switch (cmd)
            {
                case "ping": { var d = new Dictionary<string, object>(); d["version"] = Program.Version; return d; }
                case "displays": return Screen2.Displays();
                case "screenshot": return Screen2.Capture(r);
                case "settle": return Screen2.Settle(r);
                case "cursor": { Native.POINT p; Native.GetCursorPos(out p); return Pt(p.X, p.Y); }
                case "move": using (new PassThrough()) { Overlay.Dodge(Args.Int(r, "x", 0), Args.Int(r, "y", 0)); Input.Move(Args.Int(r, "x", 0), Args.Int(r, "y", 0)); } return null;
                case "click": using (new PassThrough()) return Input.Click(r);
                case "button": using (new PassThrough()) return Input.Button(r);
                case "drag": using (new PassThrough()) return Input.Drag(r);
                case "scroll": using (new PassThrough()) return Input.Scroll(r);
                case "keys": return Input.Keys(r);
                case "key_state": return Input.KeyState(r);
                case "type": return Input.Type(Args.Str(r, "text", ""), Args.Int(r, "chunkDelay", 8), Args.Int(r, "charDelay", 0));
                case "clipboard_hold": Clip.Hold(); return null;
                case "clipboard_release": Clip.Release(); return null;
                case "paste": return Input.Paste(Args.Str(r, "text", ""), Args.Bool(r, "restore", true), Args.Int(r, "waitMs", 250));
                case "windows": return Windows.List();
                case "background": return Windows.Background();
                case "tray_restore": return Tray.Restore(Args.Str(r, "exe", ""));
                case "card_opacity": CardLayer.SetOpacity(Args.Int(r, "opacity", 100)); return null;
                case "foreground": return Windows.Describe(Native.GetForegroundWindow());
                case "window_at": return Windows.At(Args.Int(r, "x", 0), Args.Int(r, "y", 0));
                case "focus": return Windows.Focus(new IntPtr(Convert.ToInt64(r["hwnd"])));
                case "window_cmd": return Windows.Command(new IntPtr(Convert.ToInt64(r["hwnd"])), Args.Str(r, "op", ""));
                case "apps": return Apps.Search(Args.Str(r, "query", ""), Args.Int(r, "limit", 8));
                case "launch": return Apps.Launch(r);
                case "clipboard_get": { var d = new Dictionary<string, object>(); d["text"] = Clip.Get(); return d; }
                case "clipboard_set": if (Args.Bool(r, "agent", false)) Clip.AgentSet(Args.Str(r, "text", "")); else Clip.Set(Args.Str(r, "text", ""), false); return null;
                case "clipboard_restore": { var d = new Dictionary<string, object>(); d["restored"] = Clip.RestoreAgent(); return d; }
                case "ui": return Uia.Elements(r);
                case "overlay_show": Overlay.ExcludeFromCapture = Args.Bool(r, "excludeFromCapture", true); Overlay.Show(r); return null;
                case "overlay_pause": Overlay.SetPaused(Args.Bool(r, "paused", false)); return null;
                case "window_card": CardLayer.SetOpacity(Args.Int(r, "opacity", 100)); return Windows.Card(new IntPtr(Convert.ToInt64(r["hwnd"])), Args.Int(r, "x", 0), Args.Int(r, "y", 0), Args.Int(r, "width", 0), Args.Int(r, "height", 0));
                case "window_uncard": return Windows.Uncard(new IntPtr(Convert.ToInt64(r["hwnd"])));
                case "overlay_status": Overlay.Status(Args.Str(r, "status", "")); return null;
                case "pet_update": Overlay.PetUpdate(Args.Str(r, "text", ""), Args.Str(r, "thinking", ""), Args.Strs(r, "steps"), Args.Bool(r, "thinkingLatest", false)); return null;
                case "pet_finish": Overlay.Finish(Args.Str(r, "text", ""), Args.Int(r, "holdMs", 4000)); return null;
                case "overlay_hide": Overlay.Hide(); return null;
                default: throw new Exception("unknown command: " + cmd);
            }
        }

        public static Dictionary<string, object> Pt(int x, int y) { var d = new Dictionary<string, object>(); d["x"] = x; d["y"] = y; return d; }
    }

    internal static class Screen2
    {
        public static List<object> Displays()
        {
            var list = new List<object>();
            Native.MonitorEnumProc cb = delegate (IntPtr h, IntPtr hdc, ref Native.RECT rc, IntPtr data)
            {
                var info = new Native.MONITORINFOEX();
                info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFOEX));
                Native.GetMonitorInfo(h, ref info);
                uint dx = 96, dy = 96;
                try { Native.GetDpiForMonitor(h, 0, out dx, out dy); } catch (Exception) { }
                var d = new Dictionary<string, object>();
                d["x"] = info.rcMonitor.Left; d["y"] = info.rcMonitor.Top;
                d["width"] = info.rcMonitor.Right - info.rcMonitor.Left; d["height"] = info.rcMonitor.Bottom - info.rcMonitor.Top;
                d["workX"] = info.rcWork.Left; d["workY"] = info.rcWork.Top;
                d["workWidth"] = info.rcWork.Right - info.rcWork.Left; d["workHeight"] = info.rcWork.Bottom - info.rcWork.Top;
                d["primary"] = (info.dwFlags & 1) != 0;
                d["dpi"] = (int)dx;
                d["name"] = info.szDevice;
                list.Add(d);
                return true;
            };
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return list;
        }

        /** Sample every 8th pixel of a screen rectangle (BGR bytes). */
        /** Sample the screen for settle detection; the card area is blanked (no flicker). */
        static byte[] Sample(int x, int y, int w, int h)
        {
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr dst = g.GetHdc();
                    IntPtr src = Native.GetDC(IntPtr.Zero);
                    try { Native.BitBlt(dst, 0, 0, w, h, src, x, y, 0x00CC0020 | 0x40000000); }
                    finally { Native.ReleaseDC(IntPtr.Zero, src); g.ReleaseHdc(dst); }
                    CardLayer.Blank(g, x, y);
                }
                return SampleBitmap(bmp);
            }
        }

        /** Every 8th pixel of a 24-bit bitmap (BGR bytes). */
        static byte[] SampleBitmap(Bitmap bmp)
        {
            int w = bmp.Width, h = bmp.Height;
            var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                int sx = (w + 7) / 8, sy = (h + 7) / 8;
                var row = new byte[data.Stride];
                var outp = new byte[sx * sy * 3];
                int k = 0;
                for (int j = 0; j < sy; j++)
                {
                    Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)j * 8 * data.Stride), row, 0, data.Stride);
                    for (int i = 0; i < sx; i++) { int o = i * 8 * 3; outp[k++] = row[o]; outp[k++] = row[o + 1]; outp[k++] = row[o + 2]; }
                }
                return outp;
            }
            finally { bmp.UnlockBits(data); }
        }

        /** What the screen looked like in the last screenshot the model was shown. */
        static byte[] marked;
        static string markedRect;

        static string RectKey(int x, int y, int w, int h) { return x + "," + y + "," + w + "," + h; }

        static double Changed(byte[] a, byte[] b)
        {
            int n = a.Length / 3, diff = 0;
            for (int i = 0; i < a.Length; i += 3)
                if (Math.Abs(a[i] - b[i]) + Math.Abs(a[i + 1] - b[i + 1]) + Math.Abs(a[i + 2] - b[i + 2]) > 30) diff++;
            return n == 0 ? 0 : (double)diff / n;
        }

        /**
         * Wait until the screen stops changing: at least minMs, then until two
         * consecutive samples (quietMs apart in total) differ in under 0.2% of
         * the sampled pixels, or maxMs passes (videos, spinners).
         */
        public static Dictionary<string, object> Settle(Dictionary<string, object> r)
        {
            int x = Args.Int(r, "x", 0), y = Args.Int(r, "y", 0), w = Args.Int(r, "width", 0), h = Args.Int(r, "height", 0);
            int minMs = Args.Int(r, "minMs", 300), maxMs = Args.Int(r, "maxMs", 2500), interval = Args.Int(r, "intervalMs", 120), quietMs = Args.Int(r, "quietMs", 240);
            if (w <= 0 || h <= 0) throw new Exception("invalid settle rect");
            var watch = System.Diagnostics.Stopwatch.StartNew();
            byte[] prev = Sample(x, y, w, h);
            long quietSince = -1;
            bool stable = false;
            while (true)
            {
                Thread.Sleep(interval);
                byte[] cur = Sample(x, y, w, h);
                long now = watch.ElapsedMilliseconds;
                if (Changed(prev, cur) < 0.002) { if (quietSince < 0) quietSince = now - interval; }
                else quietSince = -1;
                prev = cur;
                if (now >= minMs && quietSince >= 0 && now - quietSince >= quietMs) { stable = true; break; }
                if (now >= maxMs) break;
            }
            var d = new Dictionary<string, object>();
            d["ms"] = (int)watch.ElapsedMilliseconds;
            d["stable"] = stable;
            return d;
        }

        static ImageCodecInfo jpegCodec;

        public static Dictionary<string, object> Capture(Dictionary<string, object> r)
        {
            int x = Args.Int(r, "x", 0), y = Args.Int(r, "y", 0), w = Args.Int(r, "width", 0), h = Args.Int(r, "height", 0);
            int ow = Args.Int(r, "outWidth", w), oh = Args.Int(r, "outHeight", h);
            int quality = Args.Int(r, "quality", 80);
            if (w <= 0 || h <= 0 || ow <= 0 || oh <= 0) throw new Exception("invalid capture size");
            string via = "blt";
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr dst = g.GetHdc();
                    IntPtr src = Native.GetDC(IntPtr.Zero);
                    // The DSH card is for the user only: capture what is under it.
                    // Preferred: the Magnification API renders the screen without
                    // the card (no flicker). Fallback: hide the card for one BitBlt.
                    bool done = false;
                    var area = new Rectangle(x, y, w, h);
                    via = "blt";
                    if (CardLayer.Covers(area))
                    {
                        g.ReleaseHdc(dst);
                        dst = IntPtr.Zero;
                        using (var mag = MagCapture.Capture(area, CardLayer.Hwnd))
                        {
                            if (mag != null) { g.DrawImageUnscaled(mag, 0, 0); done = true; via = "mag"; }
                        }
                        if (!done) dst = g.GetHdc();
                    }
                    if (!done)
                    {
                        using (CardLayer.Hide(area))
                        {
                            try { Native.BitBlt(dst, 0, 0, w, h, src, x, y, 0x00CC0020 | 0x40000000); }
                            finally { g.ReleaseHdc(dst); }
                        }
                    }
                    Native.ReleaseDC(IntPtr.Zero, src);
                }
                // compare: report "unchanged" instead of an identical image; mark: remember for next time.
                bool compare = Args.Bool(r, "compare", false), mark = Args.Bool(r, "mark", false) || compare;
                if (mark)
                {
                    string key = RectKey(x, y, w, h);
                    byte[] sample = SampleBitmap(bmp);
                    if (compare && marked != null && markedRect == key && Changed(marked, sample) < Args.Double(r, "threshold", 0.0005))
                    {
                        var same = new Dictionary<string, object>();
                        same["unchanged"] = true;
                        return same;
                    }
                    marked = sample;
                    markedRect = key;
                }
                Bitmap output = bmp;
                Bitmap scaled = null;
                try
                {
                    if (ow != w || oh != h)
                    {
                        scaled = new Bitmap(ow, oh, PixelFormat.Format24bppRgb);
                        using (var g2 = Graphics.FromImage(scaled))
                        using (var attrs = new ImageAttributes())
                        {
                            attrs.SetWrapMode(WrapMode.TileFlipXY);
                            g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            g2.CompositingQuality = CompositingQuality.HighQuality;
                            g2.DrawImage(bmp, new Rectangle(0, 0, ow, oh), 0, 0, w, h, GraphicsUnit.Pixel, attrs);
                        }
                        output = scaled;
                    }
                    if (jpegCodec == null)
                        foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpegCodec = c;
                    using (var ms = new MemoryStream())
                    using (var ep = new EncoderParameters(1))
                    {
                        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                        output.Save(ms, jpegCodec, ep);
                        var d = new Dictionary<string, object>();
                        d["data"] = Convert.ToBase64String(ms.ToArray());
                        d["via"] = via == "blt" && MagCapture.Why.Length > 0 ? "blt (" + MagCapture.Why + ")" : via;
                        d["width"] = ow; d["height"] = oh;
                        return d;
                    }
                }
                finally { if (scaled != null) scaled.Dispose(); }
            }
        }
    }

    internal static class Input
    {
        static readonly int InputSize = Marshal.SizeOf(typeof(Native.INPUT));
        static readonly HashSet<int> Extended = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5 };

        static Native.INPUT Mouse(uint flags, uint data)
        {
            var i = new Native.INPUT(); i.type = Native.INPUT_MOUSE;
            i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; i.u.mi.dwExtraInfo = Native.Marker;
            return i;
        }

        static Native.INPUT Key(int vk, bool up)
        {
            var i = new Native.INPUT(); i.type = Native.INPUT_KEYBOARD;
            i.u.ki.wVk = (ushort)vk;
            i.u.ki.wScan = (ushort)Native.MapVirtualKey((uint)vk, 0);
            i.u.ki.dwFlags = (up ? Native.KEYEVENTF_KEYUP : 0) | (Extended.Contains(vk) ? Native.KEYEVENTF_EXTENDEDKEY : 0);
            i.u.ki.dwExtraInfo = Native.Marker;
            return i;
        }

        static Native.INPUT Unicode(char c, bool up)
        {
            var i = new Native.INPUT(); i.type = Native.INPUT_KEYBOARD;
            i.u.ki.wVk = 0; i.u.ki.wScan = c;
            i.u.ki.dwFlags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0);
            i.u.ki.dwExtraInfo = Native.Marker;
            return i;
        }

        static void Send(List<Native.INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            WaitForInstructionBox();
            uint sent = Native.SendInput((uint)inputs.Count, inputs.ToArray(), InputSize);
            if (sent != inputs.Count)
                throw new Exception("SendInput was blocked (error " + Marshal.GetLastWin32Error() + "). The target may be running elevated (as administrator) or the secure desktop (UAC / lock screen) is active.");
        }

        /**
         * The user opened the progress card's instruction box mid-action (say,
         * halfway through typing): hold the rest until it closes and focus is
         * back, so no keystroke lands in the box.
         */
        static void WaitForInstructionBox()
        {
            if (Overlay.InputHwnd == IntPtr.Zero) return;
            var until = DateTime.UtcNow.AddSeconds(90);
            while (Overlay.InputHwnd != IntPtr.Zero)
            {
                if (DateTime.UtcNow > until) throw new Exception("Stopped: the user is typing an instruction to you in the progress card.");
                Thread.Sleep(100);
            }
            // The box hands the focus back to the window it took it from: wait until that happened.
            IntPtr target = Overlay.InputReturnsTo;
            var back = DateTime.UtcNow.AddSeconds(4);
            while (target != IntPtr.Zero && Native.IsWindow(target) && Native.GetForegroundWindow() != target && DateTime.UtcNow < back) Thread.Sleep(50);
            Thread.Sleep(150);
        }

        public static void Move(int x, int y)
        {
            Native.SetCursorPos(x, y);
            // A zero relative move lets apps that only watch WM_MOUSEMOVE notice the cursor.
            Send(new List<Native.INPUT> { Mouse(Native.MOUSEEVENTF_MOVE, 0) });
        }

        static void Flags(string button, out uint down, out uint up)
        {
            switch (button)
            {
                case "right": down = Native.MOUSEEVENTF_RIGHTDOWN; up = Native.MOUSEEVENTF_RIGHTUP; break;
                case "middle": down = Native.MOUSEEVENTF_MIDDLEDOWN; up = Native.MOUSEEVENTF_MIDDLEUP; break;
                default: down = Native.MOUSEEVENTF_LEFTDOWN; up = Native.MOUSEEVENTF_LEFTUP; break;
            }
        }

        static void Modifiers(List<int> vks, bool up)
        {
            var list = new List<Native.INPUT>();
            if (up) for (int i = vks.Count - 1; i >= 0; i--) list.Add(Key(vks[i], true));
            else foreach (var vk in vks) list.Add(Key(vk, false));
            Send(list);
        }

        public static object Click(Dictionary<string, object> r)
        {
            if (Args.Has(r, "x"))
            {
                int x = Args.Int(r, "x", 0), y = Args.Int(r, "y", 0);
                Overlay.Dodge(x, y);
                Move(x, y);
                Thread.Sleep(30);
            }
            uint down, up; Flags(Args.Str(r, "button", "left"), out down, out up);
            int count = Math.Max(1, Math.Min(3, Args.Int(r, "count", 1)));
            var mods = Args.Ints(r, "modifiers");
            Modifiers(mods, false);
            try
            {
                for (int i = 0; i < count; i++)
                {
                    Send(new List<Native.INPUT> { Mouse(down, 0) });
                    Thread.Sleep(20);
                    Send(new List<Native.INPUT> { Mouse(up, 0) });
                    if (i < count - 1) Thread.Sleep(40);
                }
            }
            finally { Modifiers(mods, true); }
            return null;
        }

        public static object Button(Dictionary<string, object> r)
        {
            if (Args.Has(r, "x")) { int x = Args.Int(r, "x", 0), y = Args.Int(r, "y", 0); Overlay.Dodge(x, y); Move(x, y); Thread.Sleep(20); }
            uint down, up; Flags(Args.Str(r, "button", "left"), out down, out up);
            Send(new List<Native.INPUT> { Mouse(Args.Bool(r, "up", false) ? up : down, 0) });
            return null;
        }

        public static object Drag(Dictionary<string, object> r)
        {
            int x1 = Args.Int(r, "x1", 0), y1 = Args.Int(r, "y1", 0), x2 = Args.Int(r, "x2", 0), y2 = Args.Int(r, "y2", 0);
            uint down, up; Flags(Args.Str(r, "button", "left"), out down, out up);
            Overlay.Dodge(x1, y1); Overlay.Dodge(x2, y2);
            Move(x1, y1); Thread.Sleep(40);
            Send(new List<Native.INPUT> { Mouse(down, 0) });
            try
            {
                Thread.Sleep(60);
                int steps = Math.Max(8, Math.Min(40, (int)(Math.Sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) / 20)));
                for (int i = 1; i <= steps; i++)
                {
                    Move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
                    Thread.Sleep(12);
                }
                Thread.Sleep(60);
            }
            finally { Send(new List<Native.INPUT> { Mouse(up, 0) }); }
            return null;
        }

        public static object Scroll(Dictionary<string, object> r)
        {
            if (Args.Has(r, "x")) { int x = Args.Int(r, "x", 0), y = Args.Int(r, "y", 0); Overlay.Dodge(x, y); Move(x, y); Thread.Sleep(30); }
            int dx = Args.Int(r, "dx", 0), dy = Args.Int(r, "dy", 0);
            var mods = Args.Ints(r, "modifiers");
            Modifiers(mods, false);
            try
            {
                // One notch per event, spaced out, so smooth-scrolling apps keep up.
                for (int i = 0; i < Math.Abs(dy); i++) { Send(new List<Native.INPUT> { Mouse(Native.MOUSEEVENTF_WHEEL, (uint)(dy > 0 ? -120 : 120)) }); Thread.Sleep(15); }
                for (int i = 0; i < Math.Abs(dx); i++) { Send(new List<Native.INPUT> { Mouse(Native.MOUSEEVENTF_HWHEEL, (uint)(dx > 0 ? 120 : -120)) }); Thread.Sleep(15); }
            }
            finally { Modifiers(mods, true); }
            return null;
        }

        // combos: [[vk, vk, ...], ...] — each combo presses in order and releases in reverse.
        public static object Keys(Dictionary<string, object> r)
        {
            var combos = Args.IntLists(r, "combos");
            int hold = Args.Int(r, "holdMs", 0);
            foreach (var combo in combos)
            {
                var downs = new List<Native.INPUT>();
                foreach (var vk in combo) downs.Add(Key(vk, false));
                Send(downs);
                Thread.Sleep(hold > 0 ? hold : 25);
                var ups = new List<Native.INPUT>();
                for (int i = combo.Count - 1; i >= 0; i--) ups.Add(Key(combo[i], true));
                Send(ups);
                Thread.Sleep(30);
            }
            return null;
        }

        public static object KeyState(Dictionary<string, object> r)
        {
            var vks = Args.Ints(r, "vks");
            Modifiers(vks, Args.Bool(r, "up", false));
            return null;
        }

        /** charDelay > 0: one character at a time, like a person typing; otherwise fast batches. */
        public static object Type(string text, int chunkDelay, int charDelay)
        {
            var batch = new List<Native.INPUT>();
            int pause = charDelay > 0 ? charDelay : chunkDelay;
            Action flush = delegate { if (batch.Count == 0) return; Send(batch); batch.Clear(); if (pause > 0) Thread.Sleep(pause); };
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r') { if (i + 1 < text.Length && text[i + 1] == '\n') continue; c = '\n'; }
                if (c == '\n') { flush(); batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); flush(); continue; }
                if (c == '\t') { batch.Add(Key(0x09, false)); batch.Add(Key(0x09, true)); continue; }
                batch.Add(Unicode(c, false)); batch.Add(Unicode(c, true));
                if (char.IsHighSurrogate(c)) continue;
                if (charDelay > 0 || batch.Count >= 40) flush();
            }
            flush();
            return null;
        }

        public static object Paste(string text, bool restore, int waitMs)
        {
            // Keep every format the user had (images, files, rich text), not just text.
            DataObject previous = null;
            if (restore) { try { previous = Clip.Snapshot(); } catch (Exception) { } }
            Clip.Set(text, true);
            Thread.Sleep(40);
            Send(new List<Native.INPUT> { Key(0x11, false), Key(0x56, false) });
            Thread.Sleep(30);
            Send(new List<Native.INPUT> { Key(0x56, true), Key(0x11, true) });
            Thread.Sleep(Math.Max(60, waitMs)); // the app reads the clipboard asynchronously
            if (restore) { try { Clip.Put(previous); } catch (Exception) { } }
            return null;
        }
    }

    internal static class Clip
    {
        public static string Get()
        {
            for (int i = 0; i < 5; i++)
            {
                try { return Clipboard.ContainsText() ? Clipboard.GetText() : ""; }
                catch (ExternalException) { Thread.Sleep(50); }
            }
            throw new Exception("clipboard is busy");
        }

        /** The user's clipboard before the agent first wrote to it, restored when control ends. */
        static DataObject saved;
        static bool hasSaved;
        /** What the agent last put there, to tell whether the user copied something since. */
        static string agentText;

        static string Normalize(string text)
        {
            return string.IsNullOrEmpty(text) ? "" : text.Replace("\r\n", "\n").Replace("\r", "\n").Replace("\n", "\r\n");
        }

        /** Mark data as transient: clipboard history (Win+V), cloud clipboard and clipboard managers skip it. */
        static void MarkPrivate(DataObject d)
        {
            d.SetData("ExcludeClipboardContentFromMonitorProcessing", false, new MemoryStream(new byte[] { 1, 0, 0, 0 }));
            d.SetData("CanIncludeInClipboardHistory", false, new MemoryStream(BitConverter.GetBytes(0)));
            d.SetData("CanUploadToCloudClipboard", false, new MemoryStream(BitConverter.GetBytes(0)));
        }

        /** Copy every format currently on the clipboard (null when empty). */
        public static DataObject Snapshot()
        {
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    var src = Clipboard.GetDataObject();
                    if (src == null) return null;
                    var formats = src.GetFormats(false);
                    if (formats.Length == 0) return null;
                    var dst = new DataObject();
                    foreach (var f in formats)
                    {
                        if (f == "CanIncludeInClipboardHistory" || f == "CanUploadToCloudClipboard" || f == "ExcludeClipboardContentFromMonitorProcessing") continue;
                        try { var v = src.GetData(f, false); if (v != null) dst.SetData(f, false, v); } catch (Exception) { }
                    }
                    return dst;
                }
                catch (ExternalException) { Thread.Sleep(50); }
            }
            throw new Exception("clipboard is busy");
        }

        /** Put a snapshot back without adding a history entry (null clears). */
        public static void Put(DataObject data)
        {
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    if (data == null) Clipboard.Clear();
                    else { MarkPrivate(data); Clipboard.SetDataObject(data, true); }
                    return;
                }
                catch (ExternalException) { Thread.Sleep(50); }
            }
            throw new Exception("clipboard is busy");
        }

        /** The user's clipboard, kept aside while a streamed paste runs. */
        static DataObject held;
        static bool holding;

        public static void Hold()
        {
            if (holding) return;
            held = Snapshot();
            holding = true;
        }

        public static void Release()
        {
            if (!holding) return;
            var data = held;
            held = null; holding = false;
            Put(data);
        }

        public static void Set(string text, bool isPrivate)
        {
            text = Normalize(text);
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    if (text.Length == 0) Clipboard.Clear();
                    else
                    {
                        var d = new DataObject();
                        d.SetData(DataFormats.UnicodeText, false, text);
                        if (isPrivate) MarkPrivate(d);
                        Clipboard.SetDataObject(d, true);
                    }
                    return;
                }
                catch (ExternalException) { Thread.Sleep(50); }
            }
            throw new Exception("clipboard is busy");
        }

        /** The agent writes the clipboard: remember the user's content first (once per control session). */
        public static void AgentSet(string text)
        {
            if (!hasSaved) { saved = Snapshot(); hasSaved = true; }
            Set(text, true);
            agentText = Normalize(text);
        }

        /** Control ended: put the user's clipboard back, unless they copied something since the agent's last write. */
        public static bool RestoreAgent()
        {
            if (!hasSaved) return false;
            bool ours = false;
            try { ours = Get() == agentText; } catch (Exception) { }
            var data = saved;
            saved = null; hasSaved = false; agentText = null;
            if (!ours) return false;
            Put(data);
            return true;
        }
    }

    /**
     * The DeepSeek Harness card floats on top for the user only. To the agent
     * it is transparent: while a screenshot is taken the card is made fully
     * transparent for a few milliseconds (another process's window cannot be
     * excluded from capture), and its pointer input passes through.
     */
    internal static class CardLayer
    {
        public static IntPtr Hwnd = IntPtr.Zero;
        static int originalEx;
        /** Resting alpha of the card (see-through); it turns opaque while the pointer rests on it. */
        static byte alpha = 255;
        static bool hot;
        static int hiding;
        static DateTime enteredAt = DateTime.MaxValue;
        static System.Threading.Timer hover;
        static readonly object Gate = new object();

        public static void SetOpacity(int percent)
        {
            lock (Gate)
            {
                alpha = (byte)Math.Max(64, Math.Min(255, (int)Math.Round(Math.Max(25, Math.Min(100, percent)) * 2.55)));
                if (alpha < 255 && hover == null) hover = new System.Threading.Timer(delegate { Track(); }, null, 150, 150);
                Apply();
            }
        }

        static byte Current() { return hot ? (byte)255 : alpha; }

        static void Apply()
        {
            if (hiding == 0 && Hwnd != IntPtr.Zero && Native.IsWindow(Hwnd)) Native.SetLayeredWindowAttributes(Hwnd, 0, Current(), 2);
        }

        /** Opaque once the pointer has rested on the card for a moment (the user wants to read or click it). */
        static void Track()
        {
            lock (Gate)
            {
                bool inside = false;
                if (Live() && alpha < 255)
                {
                    Native.POINT p; Native.GetCursorPos(out p);
                    inside = Frame(Hwnd).Contains(p.X, p.Y);
                }
                if (!inside) { enteredAt = DateTime.MaxValue; if (hot) { hot = false; Apply(); } return; }
                if (enteredAt == DateTime.MaxValue) enteredAt = DateTime.UtcNow;
                if (!hot && (DateTime.UtcNow - enteredAt).TotalMilliseconds >= 300) { hot = true; Apply(); }
            }
        }

        static bool Live()
        {
            return Hwnd != IntPtr.Zero && Native.IsWindow(Hwnd) && Native.IsWindowVisible(Hwnd) && !Native.IsIconic(Hwnd);
        }

        public static uint Pid()
        {
            if (!Live()) return 0;
            uint pid; Native.GetWindowThreadProcessId(Hwnd, out pid);
            return pid;
        }

        /** The card becomes a (fully opaque) layered window so its alpha can be dropped instantly. */
        public static void Attach(IntPtr hwnd)
        {
            if (Hwnd == hwnd) return;
            Detach();
            Hwnd = hwnd;
            originalEx = Native.GetWindowLong(hwnd, -20);
            Native.SetWindowLong(hwnd, -20, originalEx | 0x80000);
            lock (Gate) { hot = false; enteredAt = DateTime.MaxValue; Native.SetLayeredWindowAttributes(hwnd, 0, Current(), 2); }
        }

        public static void Detach()
        {
            var hwnd = Hwnd;
            Hwnd = IntPtr.Zero;
            if (hwnd != IntPtr.Zero && Native.IsWindow(hwnd)) Native.SetWindowLong(hwnd, -20, originalEx);
        }

        public static Rectangle Frame(IntPtr hwnd)
        {
            Native.RECT rc;
            if (Native.DwmGetWindowAttribute(hwnd, 9, out rc, Marshal.SizeOf(typeof(Native.RECT))) != 0) Native.GetWindowRect(hwnd, out rc);
            return new Rectangle(rc.Left, rc.Top, rc.Right - rc.Left, rc.Bottom - rc.Top);
        }

        /** g draws a bitmap whose (0, 0) is screen (ox, oy): fill the card area with a constant. */
        public static void Blank(Graphics g, int ox, int oy)
        {
            if (!Live()) return;
            var r = Frame(Hwnd);
            r.Inflate(32, 32); // its drop shadow too (wide at 200% scaling)
            g.FillRectangle(Brushes.Black, r.X - ox, r.Y - oy, r.Width, r.Height);
        }

        /** Is the card visible over (any part of) this screen rectangle? */
        public static bool Covers(Rectangle area)
        {
            if (!Live()) return false;
            var r = Frame(Hwnd);
            r.Inflate(32, 32);
            return r.IntersectsWith(area);
        }

        /** Make the card invisible while a capture of `area` runs (dispose to show it again). */
        public static IDisposable Hide(Rectangle area)
        {
            if (!Live()) return new Hidden(IntPtr.Zero);
            var r = Frame(Hwnd);
            r.Inflate(32, 32);
            return new Hidden(r.IntersectsWith(area) ? Hwnd : IntPtr.Zero);
        }

        sealed class Hidden : IDisposable
        {
            readonly IntPtr hwnd;
            public Hidden(IntPtr hwnd)
            {
                this.hwnd = hwnd;
                if (hwnd == IntPtr.Zero) return;
                lock (Gate) { hiding++; Native.SetLayeredWindowAttributes(hwnd, 0, 0, 2); }
            }
            public void Dispose()
            {
                if (hwnd == IntPtr.Zero) return;
                lock (Gate)
                {
                    hiding--;
                    if (hiding == 0 && Native.IsWindow(hwnd)) Native.SetLayeredWindowAttributes(hwnd, 0, Current(), 2);
                }
            }
        }
    }

    /**
     * Screen capture through the Windows Magnification API, which can leave
     * out windows of other processes (MagSetWindowFilterList). The magnifier
     * control lives in a never-shown host window; MagSetWindowSource renders
     * synchronously into the scaling callback. Any failure disables it for the
     * rest of the run and callers fall back to BitBlt.
     */
    internal static class MagCapture
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct MAGIMAGEHEADER { public uint width; public uint height; public Guid format; public uint stride; public uint offset; public UIntPtr cbSize; }

        delegate bool ScalingCallback(IntPtr hwnd, IntPtr srcdata, MAGIMAGEHEADER srcheader, IntPtr destdata, MAGIMAGEHEADER destheader, Native.RECT unclipped, Native.RECT clipped, IntPtr dirty);

        [DllImport("Magnification.dll")] static extern bool MagInitialize();
        [DllImport("Magnification.dll")] static extern bool MagSetWindowSource(IntPtr hwnd, Native.RECT rect);
        [DllImport("Magnification.dll")] static extern bool MagSetWindowFilterList(IntPtr hwnd, int mode, int count, IntPtr[] list);
        [DllImport("Magnification.dll")] static extern bool MagSetImageScalingCallback(IntPtr hwnd, ScalingCallback cb);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr CreateWindowEx(int ex, string cls, string name, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);

        static bool broken;
        public static string Why = "";
        static Form host;
        static IntPtr magnifier = IntPtr.Zero;
        static ScalingCallback callback;
        static Bitmap frame;

        static bool Ready()
        {
            if (broken) return false;
            if (magnifier != IntPtr.Zero) return true;
            try
            {
                if (!MagInitialize()) { broken = true; Why = "init"; return false; }
                host = new Form { FormBorderStyle = FormBorderStyle.None, ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(0, 0), Size = new Size(16, 16) };
                IntPtr parent = host.Handle; // created, never shown
                magnifier = CreateWindowEx(0, "Magnifier", "cu-magnifier", 0x40000000 | 0x10000000, 0, 0, 16, 16, parent, IntPtr.Zero, Native.GetModuleHandle(null), IntPtr.Zero);
                callback = OnImage;
                if (magnifier == IntPtr.Zero || !MagSetImageScalingCallback(magnifier, callback)) { broken = true; Why = "callback"; return false; }
                return true;
            }
            catch (Exception e) { broken = true; Why = "ready: " + e.Message; return false; }
        }

        /** The screen rectangle without the `exclude` window, or null when unavailable. */
        public static Bitmap Capture(Rectangle area, IntPtr exclude)
        {
            if (!Ready()) return null;
            try
            {
                // The never-shown host must be as large as the capture, or the control is clipped.
                Native.SetWindowPos(host.Handle, IntPtr.Zero, 0, 0, area.Width, area.Height, 0x0004 | 0x0010);
                Native.SetWindowPos(magnifier, IntPtr.Zero, 0, 0, area.Width, area.Height, 0x0004 | 0x0010); // NOZORDER | NOACTIVATE
                if (!MagSetWindowFilterList(magnifier, 0 /* MW_FILTERMODE_EXCLUDE */, 1, new[] { exclude })) { broken = true; Why = "filter"; return null; }
                frame = null;
                var rc = new Native.RECT { Left = area.Left, Top = area.Top, Right = area.Right, Bottom = area.Bottom };
                if (!MagSetWindowSource(magnifier, rc)) { broken = true; Why = "source"; return null; }
                var result = frame;
                frame = null;
                if (result == null || result.Width != area.Width || result.Height != area.Height)
                {
                    Why = result == null ? "no frame" : "size " + result.Width + "x" + result.Height;
                    if (result != null) result.Dispose();
                    broken = true;
                    return null;
                }
                return result;
            }
            catch (Exception e) { broken = true; Why = "capture: " + e.Message; return null; }
        }

        static bool OnImage(IntPtr hwnd, IntPtr srcdata, MAGIMAGEHEADER h, IntPtr destdata, MAGIMAGEHEADER dh, Native.RECT unclipped, Native.RECT clipped, IntPtr dirty)
        {
            try
            {
                var bmp = new Bitmap((int)h.width, (int)h.height, PixelFormat.Format32bppRgb);
                var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
                try
                {
                    int rowBytes = (int)h.width * 4;
                    var row = new byte[rowBytes];
                    for (int y = 0; y < h.height; y++)
                    {
                        Marshal.Copy(new IntPtr(srcdata.ToInt64() + h.offset + (long)y * h.stride), row, 0, rowBytes);
                        Marshal.Copy(row, 0, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), rowBytes);
                    }
                }
                finally { bmp.UnlockBits(data); }
                frame = bmp;
            }
            catch (Exception) { frame = null; }
            return true;
        }
    }

    /** While the agent moves, clicks or scrolls, the card lets the mouse through. */
    internal sealed class PassThrough : IDisposable
    {
        readonly IntPtr[] hwnds;
        readonly int[] oldEx;
        bool active;

        /** The DSH card and our progress card let injected pointer input through. */
        public PassThrough()
        {
            hwnds = new[] { CardLayer.Hwnd, Overlay.PetHwnd };
            oldEx = new int[hwnds.Length];
            for (int i = 0; i < hwnds.Length; i++)
            {
                if (hwnds[i] == IntPtr.Zero || !Native.IsWindow(hwnds[i])) { hwnds[i] = IntPtr.Zero; continue; }
                oldEx[i] = Native.GetWindowLong(hwnds[i], -20);
                Native.SetWindowLong(hwnds[i], -20, oldEx[i] | 0x20 | 0x80000); // WS_EX_TRANSPARENT (layered already)
                active = true;
            }
        }

        public void Dispose()
        {
            if (!active) return;
            Thread.Sleep(60); // let the injected input reach its target first
            for (int i = 0; i < hwnds.Length; i++)
                if (hwnds[i] != IntPtr.Zero && Native.IsWindow(hwnds[i])) Native.SetWindowLong(hwnds[i], -20, oldEx[i]);
        }
    }

    internal static class Windows
    {
        public static string ExePath(uint pid)
        {
            IntPtr h = Native.OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return "";
            try
            {
                var sb = new StringBuilder(1024); int size = sb.Capacity;
                return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
            }
            finally { Native.CloseHandle(h); }
        }

        public static Dictionary<string, object> Describe(IntPtr hwnd)
        {
            var d = new Dictionary<string, object>();
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) return d;
            uint pid; Native.GetWindowThreadProcessId(hwnd, out pid);
            int len = Native.GetWindowTextLength(hwnd);
            var title = new StringBuilder(Math.Max(len + 1, 2)); Native.GetWindowText(hwnd, title, title.Capacity);
            var cls = new StringBuilder(256); Native.GetClassName(hwnd, cls, cls.Capacity);
            Native.RECT rc;
            if (Native.DwmGetWindowAttribute(hwnd, 9, out rc, Marshal.SizeOf(typeof(Native.RECT))) != 0) Native.GetWindowRect(hwnd, out rc);
            string path = ExePath(pid);
            d["hwnd"] = hwnd.ToInt64();
            d["title"] = title.ToString();
            d["className"] = cls.ToString();
            d["pid"] = (long)pid;
            d["exe"] = path.Length > 0 ? Path.GetFileName(path) : "";
            d["path"] = path;
            d["x"] = rc.Left; d["y"] = rc.Top; d["width"] = rc.Right - rc.Left; d["height"] = rc.Bottom - rc.Top;
            d["minimized"] = Native.IsIconic(hwnd);
            d["maximized"] = Native.IsZoomed(hwnd);
            return d;
        }

        public static List<object> List()
        {
            var list = new List<object>();
            IntPtr fg = Native.GetForegroundWindow();
            uint self = (uint)Process.GetCurrentProcess().Id;
            Native.EnumWindowsProc cb = delegate (IntPtr h, IntPtr data)
            {
                if (!Native.IsWindowVisible(h) || Native.GetWindowTextLength(h) == 0) return true;
                if (Native.GetWindow(h, 4) != IntPtr.Zero) return true; // owned popup
                int ex = Native.GetWindowLong(h, -20);
                if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true; // tool window
                int cloaked;
                if (Native.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                uint pid; Native.GetWindowThreadProcessId(h, out pid);
                if (pid == self) return true;
                var d = Describe(h);
                d["foreground"] = h == fg;
                list.Add(d);
                return true;
            };
            Native.EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return list;
        }

        public static Dictionary<string, object> At(int x, int y)
        {
            IntPtr h = Native.WindowFromPoint(new Native.POINT(x, y));
            if (h != IntPtr.Zero) h = Native.GetAncestor(h, 2); // GA_ROOT
            uint pid = 0;
            if (h != IntPtr.Zero) Native.GetWindowThreadProcessId(h, out pid);
            uint cardPid = CardLayer.Pid();
            if (h == IntPtr.Zero || pid == (uint)Process.GetCurrentProcess().Id || (cardPid != 0 && pid == cardPid) || SeeThrough(pid))
            {
                // Our own status pill is under the point (it dodges before the
                // click): report the topmost foreign window there instead.
                IntPtr found = IntPtr.Zero;
                uint self = (uint)Process.GetCurrentProcess().Id;
                Native.EnumWindowsProc cb = delegate (IntPtr w, IntPtr data)
                {
                    if (!Native.IsWindowVisible(w)) return true;
                    uint p; Native.GetWindowThreadProcessId(w, out p);
                    if (p == self || (cardPid != 0 && p == cardPid) || SeeThrough(p)) return true; // our overlay, the DSH card, game overlays
                    if ((Native.GetWindowLong(w, -20) & 0x20) != 0) return true; // WS_EX_TRANSPARENT
                    if (Native.IsIconic(w)) return true;
                    int cloaked;
                    if (Native.DwmGetWindowAttribute(w, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                    Native.RECT rc; Native.GetWindowRect(w, out rc);
                    if (x >= rc.Left && x < rc.Right && y >= rc.Top && y < rc.Bottom) { found = w; return false; }
                    return true;
                };
                Native.EnumWindows(cb, IntPtr.Zero);
                GC.KeepAlive(cb);
                h = found;
            }
            return Describe(h);
        }

        /** Full-screen overlays that never take input themselves (NVIDIA / Xbox Game Bar...). */
        static readonly string[] Overlays = { "nvidia overlay.exe", "nvsphelper64.exe", "gamebar.exe", "gamebarftserver.exe" };

        static bool SeeThrough(uint pid)
        {
            if (pid == 0) return false;
            string exe = Path.GetFileName(ExePath(pid)).ToLowerInvariant();
            return Array.IndexOf(Overlays, exe) >= 0;
        }

        /**
         * Apps that run without any visible window (closed to the system tray):
         * per program, its largest hidden, titled, unowned top-level window.
         */
        public static List<object> Background()
        {
            uint self = (uint)Process.GetCurrentProcess().Id;
            var visible = new HashSet<uint>();
            var best = new Dictionary<uint, KeyValuePair<IntPtr, int>>();
            Native.EnumWindowsProc cb = delegate (IntPtr h, IntPtr data)
            {
                uint pid; Native.GetWindowThreadProcessId(h, out pid);
                if (pid == self || pid == 0) return true;
                if (Native.GetWindow(h, 4) != IntPtr.Zero) return true; // owned
                if (Native.IsWindowVisible(h))
                {
                    int cloaked;
                    bool isCloaked = Native.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0;
                    if (!isCloaked && Native.GetWindowTextLength(h) > 0) visible.Add(pid);
                    return true;
                }
                if (Native.GetWindowTextLength(h) == 0) return true;
                var cls = new StringBuilder(256); Native.GetClassName(h, cls, cls.Capacity);
                string c = cls.ToString();
                if (c == "ConsoleWindowClass" || c == "IME" || c == "MSCTFIME UI" || c.StartsWith("GDI+")) return true;
                Native.RECT rc; Native.GetWindowRect(h, out rc);
                int area = (rc.Right - rc.Left) * (rc.Bottom - rc.Top);
                if (rc.Right - rc.Left < 240 || rc.Bottom - rc.Top < 160) return true;
                KeyValuePair<IntPtr, int> seen;
                if (!best.TryGetValue(pid, out seen) || seen.Value < area) best[pid] = new KeyValuePair<IntPtr, int>(h, area);
                return true;
            };
            Native.EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            // Programs whose other process shows a window are not in the background.
            var shownExes = new HashSet<string>();
            foreach (var pid in visible) shownExes.Add(Path.GetFileName(ExePath(pid)).ToLowerInvariant());
            var byExe = new Dictionary<string, Dictionary<string, object>>();
            foreach (var pair in best)
            {
                if (visible.Contains(pair.Key)) continue;
                var d = Describe(pair.Value.Key);
                string exe = ((string)d["exe"]).ToLowerInvariant();
                if (exe.Length == 0 || shownExes.Contains(exe) || exe == "explorer.exe" || exe == "textinputhost.exe" || exe == "shellexperiencehost.exe" || exe == "searchhost.exe" || exe == "startmenuexperiencehost.exe") continue;
                Dictionary<string, object> prev;
                if (byExe.TryGetValue(exe, out prev) && Convert.ToInt32(prev["width"]) * Convert.ToInt32(prev["height"]) >= pair.Value.Value) continue;
                byExe[exe] = d;
            }
            var owners = Tray.WindowsByPid();
            var exeOf = new Dictionary<uint, string>();
            foreach (var pid in owners.Keys) exeOf[pid] = Path.GetFileName(ExePath(pid));
            foreach (var d in byExe.Values) d["tray"] = Tray.HasIcon((string)d["exe"], owners, exeOf);
            return new List<object>(byExe.Values);
        }

        /** Visible, titled, unowned windows of these processes. */
        public static IntPtr ShownWindowOf(HashSet<uint> pids)
        {
            IntPtr found = IntPtr.Zero; int bestArea = 0;
            Native.EnumWindowsProc cb = delegate (IntPtr h, IntPtr data)
            {
                if (!Native.IsWindowVisible(h) || Native.GetWindowTextLength(h) == 0 || Native.GetWindow(h, 4) != IntPtr.Zero) return true;
                uint pid; Native.GetWindowThreadProcessId(h, out pid);
                if (!pids.Contains(pid)) return true;
                int cloaked;
                if (Native.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                Native.RECT rc; Native.GetWindowRect(h, out rc);
                int area = (rc.Right - rc.Left) * (rc.Bottom - rc.Top);
                if (area > bestArea) { bestArea = area; found = h; }
                return true;
            };
            Native.EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return found;
        }

        public static Dictionary<string, object> Focus(IntPtr hwnd)
        {
            if (!Native.IsWindow(hwnd)) throw new Exception("window no longer exists");
            if (Native.IsIconic(hwnd)) { Native.ShowWindow(hwnd, 9); Thread.Sleep(150); }
            if (Native.GetForegroundWindow() != hwnd)
            {
                IntPtr fg = Native.GetForegroundWindow();
                uint pid;
                uint fgThread = Native.GetWindowThreadProcessId(fg, out pid);
                uint cur = Native.GetCurrentThreadId();
                bool attached = fgThread != 0 && fgThread != cur && Native.AttachThreadInput(cur, fgThread, true);
                try
                {
                    Native.BringWindowToTop(hwnd);
                    Native.SetForegroundWindow(hwnd);
                }
                finally { if (attached) Native.AttachThreadInput(cur, fgThread, false); }
                Thread.Sleep(60);
                if (Native.GetForegroundWindow() != hwnd)
                {
                    Native.SwitchToThisWindow(hwnd, true);
                    Thread.Sleep(120);
                }
                if (Native.GetForegroundWindow() != hwnd)
                {
                    // Holding Alt lifts the foreground lock; a no-op VK keeps the
                    // Alt release from opening the target's menu bar.
                    var inputs = new Native.INPUT[3];
                    var down = new Native.INPUT(); down.type = Native.INPUT_KEYBOARD; down.u.ki.wVk = 0x12; down.u.ki.dwExtraInfo = Native.Marker;
                    Native.SendInput(1, new[] { down }, Marshal.SizeOf(typeof(Native.INPUT)));
                    Native.SetForegroundWindow(hwnd);
                    var noop = new Native.INPUT(); noop.type = Native.INPUT_KEYBOARD; noop.u.ki.wVk = 0xFF; noop.u.ki.dwExtraInfo = Native.Marker;
                    var noopUp = noop; noopUp.u.ki.dwFlags = Native.KEYEVENTF_KEYUP;
                    var up = down; up.u.ki.dwFlags = Native.KEYEVENTF_KEYUP;
                    inputs[0] = noop; inputs[1] = noopUp; inputs[2] = up;
                    Native.SendInput(3, inputs, Marshal.SizeOf(typeof(Native.INPUT)));
                    Thread.Sleep(120);
                }
                if (Native.GetForegroundWindow() != hwnd)
                {
                    // Last resort: restoring a minimized window always activates it.
                    bool zoomed = Native.IsZoomed(hwnd);
                    Native.ShowWindow(hwnd, 6); // SW_MINIMIZE
                    Thread.Sleep(150);
                    Native.ShowWindow(hwnd, zoomed ? 3 : 9); // SW_MAXIMIZE / SW_RESTORE
                    Thread.Sleep(200);
                }
            }
            var d = Describe(hwnd);
            d["focused"] = Native.GetForegroundWindow() == hwnd;
            return d;
        }

        static readonly Dictionary<long, Native.WINDOWPLACEMENT> cards = new Dictionary<long, Native.WINDOWPLACEMENT>();

        /// Shrink a window into an always-on-top card; Uncard restores it exactly.
        public static object Card(IntPtr hwnd, int x, int y, int w, int h)
        {
            if (!Native.IsWindow(hwnd)) throw new Exception("window no longer exists");
            CardLayer.Attach(hwnd);
            if (!cards.ContainsKey(hwnd.ToInt64()))
            {
                var wp = new Native.WINDOWPLACEMENT();
                wp.length = Marshal.SizeOf(typeof(Native.WINDOWPLACEMENT));
                Native.GetWindowPlacement(hwnd, ref wp);
                cards[hwnd.ToInt64()] = wp;
            }
            // A minimized window restores to its previous state, which may be maximized: restore until normal.
            for (int i = 0; i < 2 && (Native.IsIconic(hwnd) || Native.IsZoomed(hwnd)); i++) { Native.ShowWindow(hwnd, 9); Thread.Sleep(150); }
            Native.SetWindowPos(hwnd, new IntPtr(-1), x, y, w, h, 0x0010 | 0x0040); // TOPMOST, NOACTIVATE | SHOWWINDOW
            // Apps enforce a minimum size (Electron does): keep the card anchored bottom-right.
            Native.RECT rc;
            if (Native.GetWindowRect(hwnd, out rc) && (rc.Right - rc.Left != w || rc.Bottom - rc.Top != h))
            {
                int nx = x + w - (rc.Right - rc.Left), ny = y + h - (rc.Bottom - rc.Top);
                Native.SetWindowPos(hwnd, new IntPtr(-1), nx, ny, 0, 0, 0x0001 | 0x0010); // NOSIZE | NOACTIVATE
            }
            return Describe(hwnd);
        }

        public static object Uncard(IntPtr hwnd)
        {
            if (CardLayer.Hwnd == hwnd) CardLayer.Detach();
            Native.WINDOWPLACEMENT wp;
            bool known = cards.TryGetValue(hwnd.ToInt64(), out wp);
            cards.Remove(hwnd.ToInt64());
            if (!Native.IsWindow(hwnd)) return null;
            Native.SetWindowPos(hwnd, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); // NOTOPMOST
            if (known)
            {
                // Restore the normal rectangle first, then the original show state (maximized etc.).
                int show = wp.showCmd;
                wp.showCmd = 1; // SW_SHOWNORMAL
                Native.SetWindowPlacement(hwnd, ref wp);
                if (show == 3) Native.ShowWindow(hwnd, 3);
                else if (show == 2) Native.ShowWindow(hwnd, 6);
            }
            return Describe(hwnd);
        }

        public static object Command(IntPtr hwnd, string op)
        {
            if (!Native.IsWindow(hwnd)) throw new Exception("window no longer exists");
            switch (op)
            {
                case "minimize": Native.ShowWindow(hwnd, 6); break;
                case "maximize": Native.ShowWindow(hwnd, 3); break;
                case "restore": Native.ShowWindow(hwnd, 9); break;
                case "close": Native.PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); break;
                default: throw new Exception("unknown window op: " + op);
            }
            Thread.Sleep(150);
            return Describe(hwnd);
        }
    }

    /**
     * Bring a program that lives in the system tray back the way the user
     * would: click its notification-area icon (opening the "show hidden icons"
     * overflow first). Launching it again would start a second instance (QQ
     * shows a second login), and showing its hidden window directly leaves
     * Electron / Qt apps frozen.
     */
    internal static class Tray
    {
        [StructLayout(LayoutKind.Sequential)]
        struct NOTIFYICONIDENTIFIER { public int cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem; }
        [DllImport("shell32.dll")] static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER id, out Native.RECT rect);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);

        static bool IconRect(IntPtr hwnd, uint id, out Rectangle rect)
        {
            var n = new NOTIFYICONIDENTIFIER(); n.cbSize = Marshal.SizeOf(typeof(NOTIFYICONIDENTIFIER)); n.hWnd = hwnd; n.uID = id;
            Native.RECT rc;
            bool ok = Shell_NotifyIconGetRect(ref n, out rc) == 0 && rc.Right > rc.Left;
            rect = ok ? new Rectangle(rc.Left, rc.Top, rc.Right - rc.Left, rc.Bottom - rc.Top) : Rectangle.Empty;
            return ok;
        }

        /** Top-level and message-only windows per process: tray icons are registered on one of them. */
        public static Dictionary<uint, List<IntPtr>> WindowsByPid()
        {
            var map = new Dictionary<uint, List<IntPtr>>();
            Action<IntPtr> add = delegate (IntPtr h)
            {
                uint pid; Native.GetWindowThreadProcessId(h, out pid);
                List<IntPtr> list;
                if (!map.TryGetValue(pid, out list)) map[pid] = list = new List<IntPtr>();
                list.Add(h);
            };
            Native.EnumWindowsProc cb = delegate (IntPtr h, IntPtr data) { add(h); return true; };
            Native.EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            IntPtr m = IntPtr.Zero;
            while ((m = FindWindowEx(new IntPtr(-3), m, null, null)) != IntPtr.Zero) add(m); // HWND_MESSAGE
            return map;
        }

        /** The icon's owner window and id. */
        static bool Find(HashSet<uint> pids, Dictionary<uint, List<IntPtr>> byPid, out IntPtr owner, out uint id)
        {
            var windows = new List<IntPtr>();
            foreach (var pid in pids) { List<IntPtr> list; if (byPid.TryGetValue(pid, out list)) windows.AddRange(list); }
            foreach (var h in windows)
            {
                // Icon ids are small; scan further only on windows that look like tray hosts.
                var cls = new StringBuilder(256); Native.GetClassName(h, cls, cls.Capacity);
                string c = cls.ToString().ToLowerInvariant();
                uint ids = c.Contains("tray") || c.Contains("notify") || c.Contains("icon") ? 128u : 16u;
                for (uint i = 0; i < ids; i++)
                {
                    Rectangle r;
                    if (IconRect(h, i, out r)) { owner = h; id = i; return true; }
                }
            }
            owner = IntPtr.Zero; id = 0;
            return false;
        }

        public static bool HasIcon(string exe, Dictionary<uint, List<IntPtr>> byPid, Dictionary<uint, string> exeOf)
        {
            // Process.GetProcessesByName is slow; the processes owning windows are enough here.
            var pids = new HashSet<uint>();
            foreach (var pair in exeOf)
                if (string.Equals(pair.Value, exe, StringComparison.OrdinalIgnoreCase)) pids.Add(pair.Key);
            IntPtr owner; uint id;
            return pids.Count > 0 && Find(pids, byPid, out owner, out id);
        }

        static HashSet<uint> Pids(string exe)
        {
            var pids = new HashSet<uint>();
            foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exe))) { pids.Add((uint)p.Id); p.Dispose(); }
            return pids;
        }

        /** The taskbar's "show hidden icons" button. */
        static Rectangle Chevron()
        {
            Rectangle found = Rectangle.Empty;
            var worker = new Thread(delegate ()
            {
                try
                {
                    var tray = AutomationElement.RootElement.FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, "Shell_TrayWnd"));
                    if (tray == null) return;
                    var buttons = tray.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
                    AutomationElement pick = null;
                    foreach (AutomationElement b in buttons)
                    {
                        string name = b.Current.Name ?? "";
                        if (name.Contains("隐藏的图标") || name.ToLowerInvariant().Contains("hidden icons") || b.Current.ClassName == "NotifyIconOverflowButton") { pick = b; break; }
                    }
                    if (pick == null)
                        foreach (AutomationElement b in buttons)
                            if (b.Current.ClassName == "SystemTray.NormalButton") { pick = b; break; }
                    if (pick == null) return;
                    var r = pick.Current.BoundingRectangle;
                    found = new Rectangle((int)r.X, (int)r.Y, (int)r.Width, (int)r.Height);
                }
                catch (Exception) { }
            });
            worker.IsBackground = true;
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            worker.Join(4000);
            return found;
        }

        static void Click(Rectangle r, int count)
        {
            var d = new Dictionary<string, object>();
            d["x"] = r.X + r.Width / 2; d["y"] = r.Y + r.Height / 2; d["count"] = count;
            using (new PassThrough()) Input.Click(d);
        }

        static IntPtr WaitShown(HashSet<uint> pids, int ms)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            do
            {
                IntPtr h = Windows.ShownWindowOf(pids);
                if (h != IntPtr.Zero) return h;
                Thread.Sleep(120);
            } while (DateTime.UtcNow < until);
            return IntPtr.Zero;
        }

        public static object Restore(string exe)
        {
            var result = new Dictionary<string, object>();
            var pids = Pids(exe);
            result["running"] = pids.Count > 0;
            IntPtr owner; uint id;
            if (pids.Count == 0 || !Find(pids, WindowsByPid(), out owner, out id)) { result["icon"] = false; return result; }
            result["icon"] = true;
            Rectangle icon; IconRect(owner, id, out icon);
            // An icon in the overflow reports the chevron's rectangle until the overflow is open.
            Rectangle chevron = Chevron();
            if (!chevron.IsEmpty && Math.Abs(chevron.X - icon.X) <= 2 && Math.Abs(chevron.Y - icon.Y) <= 2)
            {
                Click(chevron, 1);
                Thread.Sleep(450);
                IconRect(owner, id, out icon);
                result["overflow"] = true;
            }
            Click(icon, 1);
            IntPtr shown = WaitShown(pids, 1500);
            if (shown == IntPtr.Zero)
            {
                // Some apps restore on a double click only.
                Rectangle again;
                if (IconRect(owner, id, out again) && !(Math.Abs(chevron.X - again.X) <= 2 && Math.Abs(chevron.Y - again.Y) <= 2)) Click(again, 2);
                shown = WaitShown(pids, 1500);
            }
            if (shown != IntPtr.Zero) { result["window"] = Windows.Focus(shown); }
            return result;
        }
    }

    internal static class Apps
    {
        static List<KeyValuePair<string, string>> cache;
        static DateTime cachedAt;

        static List<KeyValuePair<string, string>> All()
        {
            if (cache != null && (DateTime.UtcNow - cachedAt).TotalSeconds < 120) return cache;
            var list = new List<KeyValuePair<string, string>>();
            Type t = Type.GetTypeFromProgID("Shell.Application");
            dynamic shell = Activator.CreateInstance(t);
            try
            {
                dynamic folder = shell.NameSpace("shell:AppsFolder");
                foreach (dynamic item in folder.Items())
                {
                    string name = item.Name; string path = item.Path;
                    if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(path)) list.Add(new KeyValuePair<string, string>(name, path));
                }
            }
            finally { Marshal.FinalReleaseComObject(shell); }
            // Desktop shortcuts too: portable apps often only live there.
            foreach (var folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory) })
            {
                try
                {
                    if (folder.Length == 0 || !Directory.Exists(folder)) continue;
                    foreach (var f in Directory.GetFiles(folder, "*.lnk"))
                        list.Add(new KeyValuePair<string, string>(Path.GetFileNameWithoutExtension(f), "lnk:" + f));
                }
                catch (Exception) { }
            }
            cache = list; cachedAt = DateTime.UtcNow;
            return list;
        }

        public static List<object> Search(string query, int limit)
        {
            string q = query.Trim().ToLowerInvariant();
            var scored = new List<KeyValuePair<int, KeyValuePair<string, string>>>();
            foreach (var app in All())
            {
                string n = app.Key.ToLowerInvariant();
                int score = n == q ? 0 : n.StartsWith(q) ? 1 : n.Contains(q) ? 2 : (q.Length > 0 && q.Contains(n)) ? 3 : app.Value.ToLowerInvariant().Contains(q) ? 4 : -1;
                if (q.Length == 0) score = 5;
                if (score >= 0) scored.Add(new KeyValuePair<int, KeyValuePair<string, string>>(score * 1000 + Math.Min(n.Length, 999), app));
            }
            scored.Sort(delegate (KeyValuePair<int, KeyValuePair<string, string>> a, KeyValuePair<int, KeyValuePair<string, string>> b) { return a.Key.CompareTo(b.Key); });
            var result = new List<object>();
            for (int i = 0; i < scored.Count && i < limit; i++)
            {
                var d = new Dictionary<string, object>();
                d["name"] = scored[i].Value.Key; d["id"] = scored[i].Value.Value;
                result.Add(d);
            }
            return result;
        }

        public static object Launch(Dictionary<string, object> r)
        {
            string appId = Args.Str(r, "appId", "");
            string target = Args.Str(r, "target", "");
            string args = Args.Str(r, "args", "");
            ProcessStartInfo psi;
            if (appId.StartsWith("lnk:")) psi = new ProcessStartInfo(appId.Substring(4));
            else if (appId.Length > 0) psi = new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + appId);
            else { psi = new ProcessStartInfo(target); if (args.Length > 0) psi.Arguments = args; }
            psi.UseShellExecute = true;
            using (var p = Process.Start(psi)) { }
            return null;
        }
    }

    internal static class Uia
    {
        static readonly ControlType[] Interactive = {
            ControlType.Button, ControlType.Edit, ControlType.Hyperlink, ControlType.MenuItem, ControlType.ListItem,
            ControlType.TabItem, ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox, ControlType.TreeItem,
            ControlType.DataItem, ControlType.SplitButton, ControlType.Slider, ControlType.Spinner, ControlType.Document,
            ControlType.MenuBar, ControlType.Menu, ControlType.ScrollBar };

        public static object Elements(Dictionary<string, object> r)
        {
            IntPtr hwnd = Args.Has(r, "hwnd") ? new IntPtr(Convert.ToInt64(r["hwnd"])) : Native.GetForegroundWindow();
            int max = Args.Int(r, "maxNodes", 150);
            bool all = Args.Bool(r, "includeText", false);
            List<object> result = null; Exception error = null;
            var worker = new Thread(delegate ()
            {
                try
                {
                    result = Collect(hwnd, max, all);
                    if (result.Count < 4) { Thread.Sleep(400); result = Collect(hwnd, max, all); } // Chromium builds its tree lazily
                }
                catch (Exception ex) { error = ex; }
            });
            worker.IsBackground = true;
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            if (!worker.Join(Args.Int(r, "timeoutMs", 8000))) throw new Exception("UI Automation timed out on this window");
            if (error != null) throw error;
            var d = Windows.Describe(hwnd);
            d["elements"] = result;
            return d;
        }

        static List<object> Collect(IntPtr hwnd, int max, bool includeText)
        {
            var root = AutomationElement.FromHandle(hwnd);
            var types = new List<Condition>();
            foreach (var t in Interactive) types.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, t));
            if (includeText) types.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text));
            var cond = new AndCondition(new PropertyCondition(AutomationElement.IsOffscreenProperty, false), new OrCondition(types.ToArray()));
            var cache = new CacheRequest();
            cache.Add(AutomationElement.NameProperty);
            cache.Add(AutomationElement.ControlTypeProperty);
            cache.Add(AutomationElement.BoundingRectangleProperty);
            cache.Add(AutomationElement.IsEnabledProperty);
            cache.Add(AutomationElement.AutomationIdProperty);
            cache.Add(ValuePattern.ValueProperty);
            cache.Add(TogglePattern.ToggleStateProperty);
            cache.AutomationElementMode = AutomationElementMode.None;
            cache.TreeScope = TreeScope.Element;
            AutomationElementCollection found;
            using (cache.Activate()) { found = root.FindAll(TreeScope.Descendants, cond); }
            var list = new List<object>();
            foreach (AutomationElement el in found)
            {
                if (list.Count >= max) break;
                var rect = (System.Windows.Rect)el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
                if (rect.IsEmpty || rect.Width < 2 || rect.Height < 2) continue;
                var type = (ControlType)el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
                string name = (el.GetCachedPropertyValue(AutomationElement.NameProperty) as string) ?? "";
                var d = new Dictionary<string, object>();
                d["role"] = type.ProgrammaticName.Replace("ControlType.", "");
                d["name"] = name.Length > 120 ? name.Substring(0, 120) + "…" : name;
                object value = el.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
                if (value is string && ((string)value).Length > 0) { var v = (string)value; d["value"] = v.Length > 120 ? v.Substring(0, 120) + "…" : v; }
                object toggle = el.GetCachedPropertyValue(TogglePattern.ToggleStateProperty, true);
                if (toggle is ToggleState) d["checked"] = (ToggleState)toggle == ToggleState.On;
                if (!(bool)el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty)) d["disabled"] = true;
                if (type == ControlType.Document && name.Length == 0 && !d.ContainsKey("value")) continue;
                d["x"] = (int)rect.X; d["y"] = (int)rect.Y; d["width"] = (int)rect.Width; d["height"] = (int)rect.Height;
                list.Add(d);
            }
            return list;
        }
    }

    // ---------------------------------------------------------------- overlay

    internal class LayeredForm : Form
    {
        readonly bool clickThrough;
        public Rectangle Physical;

        public LayeredForm(bool clickThrough)
        {
            this.clickThrough = clickThrough;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            TopMost = true;
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x80000 | 0x80 | 0x8000000 | 0x8; // LAYERED | TOOLWINDOW | NOACTIVATE | TOPMOST
                if (clickThrough) cp.ExStyle |= 0x20;         // TRANSPARENT
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            // Keep the overlay out of every screenshot, including our own.
            if (Overlay.ExcludeFromCapture) { try { Native.SetWindowDisplayAffinity(Handle, 0x11); } catch (Exception) { } }
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x21) { m.Result = new IntPtr(3); return; } // WM_MOUSEACTIVATE -> MA_NOACTIVATE
            base.WndProc(ref m);
        }

        public void SetBitmap(Bitmap bmp, Rectangle bounds, byte alpha)
        {
            Physical = bounds;
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr memDc = Native.CreateCompatibleDC(screenDc);
            IntPtr hBitmap = IntPtr.Zero, old = IntPtr.Zero;
            try
            {
                hBitmap = bmp.GetHbitmap(Color.FromArgb(0));
                old = Native.SelectObject(memDc, hBitmap);
                var size = new Native.SIZE(bmp.Width, bmp.Height);
                var src = new Native.POINT(0, 0);
                var dst = new Native.POINT(bounds.X, bounds.Y);
                var blend = new Native.BLENDFUNCTION(); blend.BlendOp = 0; blend.SourceConstantAlpha = alpha; blend.AlphaFormat = 1;
                Native.UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, 2);
            }
            finally
            {
                Native.ReleaseDC(IntPtr.Zero, screenDc);
                if (hBitmap != IntPtr.Zero) { Native.SelectObject(memDc, old); Native.DeleteObject(hBitmap); }
                Native.DeleteDC(memDc);
            }
        }

        public void SetAlpha(byte alpha)
        {
            var blend = new Native.BLENDFUNCTION(); blend.BlendOp = 0; blend.SourceConstantAlpha = alpha; blend.AlphaFormat = 1;
            Native.UpdateLayeredWindow(Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref blend, 2);
        }

        public void KeepOnTop()
        {
            Native.SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0200); // NOSIZE|NOMOVE|NOACTIVATE|NOOWNERZORDER
        }
    }

    /** The progress card's instruction box: a small focusable window laid over the card's field. */
    internal class InputBox : Form
    {
        public readonly TextBox Box;
        public event Action<string> Submitted;
        public event Action Cancelled;
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr w, string l);

        public InputBox(Font font, Color back, Color fore, string cue)
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            TopMost = true;
            BackColor = back;
            Box = new TextBox();
            Box.BorderStyle = BorderStyle.None;
            Box.Font = font;
            Box.BackColor = back;
            Box.ForeColor = fore;
            Controls.Add(Box);
            Box.HandleCreated += delegate { SendMessage(Box.Handle, 0x1501, new IntPtr(1), cue); }; // EM_SETCUEBANNER
            Box.KeyDown += delegate (object s, KeyEventArgs e)
            {
                if (e.KeyCode == System.Windows.Forms.Keys.Enter && !e.Shift) { e.SuppressKeyPress = true; if (Submitted != null) Submitted(Box.Text); }
                else if (e.KeyCode == System.Windows.Forms.Keys.Escape) { e.SuppressKeyPress = true; if (Cancelled != null) Cancelled(); }
            };
        }

        protected override CreateParams CreateParams
        {
            get { var cp = base.CreateParams; cp.ExStyle |= 0x80 | 0x8; return cp; } // TOOLWINDOW | TOPMOST
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (Overlay.ExcludeFromCapture) { try { Native.SetWindowDisplayAffinity(Handle, 0x11); } catch (Exception) { } }
        }

        public void Place(Rectangle r)
        {
            Bounds = r;
            Box.Width = r.Width;
            Box.Location = new Point(0, Math.Max(0, (r.Height - Box.PreferredHeight) / 2));
        }
    }

    internal static class Overlay
    {
        static readonly Color Accent = Color.FromArgb(217, 119, 87);    // #D97757
        static readonly Color AccentHi = Color.FromArgb(240, 160, 106); // #F0A06A

        public static volatile bool ExcludeFromCapture = true;
        static Thread thread;
        static Control invoker;
        static readonly List<LayeredForm> glows = new List<LayeredForm>();
        static LayeredForm pill;
        static Rectangle pillRect;
        static readonly List<KeyValuePair<Rectangle, string>> buttons = new List<KeyValuePair<Rectangle, string>>();
        static bool pillAtBottom;
        static string label = "", status = "", rendered = "";
        static Image icon, iconLight;
        static string iconPath = "", iconLightPath = "";
        static int idleMs = 1500;
        static System.Windows.Forms.Timer timer;
        static DateTime shownAt;
        static IntPtr hook = IntPtr.Zero;
        static Native.LowLevelKeyboardProc hookProc;
        static volatile bool visible;
        static volatile bool paused;
        static int lastTyping = int.MinValue / 2;
        static int lastEmit;
        static readonly object RectLock = new object();

        // The progress card ("pet"): replaces the pill while DeepSeek Harness is minimized.
        static bool petMode;
        static LayeredForm pet;
        public static volatile IntPtr PetHwnd = IntPtr.Zero;
        static string petText = "", petThinking = "";
        static List<string> petSteps = new List<string>();
        static bool petThinkingLatest;
        /** Bottom-right corner of the card body; the card grows upward when expanded. */
        static Point petAnchor = Point.Empty;
        static int petShadow;
        static Rectangle petBody;
        static byte petAlpha = 230;
        static bool petDragged, petExpanded, petFinished;
        static DateTime finishedAt;
        static int finishHoldMs = 4000;
        // The instruction box under the card (a real, focusable window over the card's field).
        static InputBox input;
        public static volatile IntPtr InputHwnd = IntPtr.Zero;
        /** The window that had the focus before the instruction box opened. */
        public static volatile IntPtr InputReturnsTo = IntPtr.Zero;
        static bool pausedByInput;
        static IntPtr beforeInput = IntPtr.Zero;
        static Rectangle inputBounds;
        static string iconFont;

        static void Ensure()
        {
            if (thread != null) return;
            var ready = new ManualResetEvent(false);
            thread = new Thread(delegate ()
            {
                invoker = new Control();
                var force = invoker.Handle;
                timer = new System.Windows.Forms.Timer();
                timer.Interval = 40;
                timer.Tick += delegate { Tick(); };
                ready.Set();
                Application.Run();
            });
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            ready.WaitOne();
        }

        static void Ui(MethodInvoker action) { invoker.Invoke(action); }

        public static void Show(Dictionary<string, object> r)
        {
            Ensure();
            Ui(delegate
            {
                label = Args.Str(r, "label", "");
                status = Args.Str(r, "status", "");
                idleMs = Args.Int(r, "idleMs", 1500);
                string path = Args.Str(r, "icon", "");
                string light = Args.Str(r, "iconLight", "");
                if (light != iconLightPath)
                {
                    iconLightPath = light;
                    if (iconLight != null) { iconLight.Dispose(); iconLight = null; }
                    try
                    {
                        if (light.Length > 0 && File.Exists(light))
                            using (var raw = Image.FromFile(light)) iconLight = new Bitmap(raw);
                    }
                    catch (Exception) { iconLight = null; }
                }
                if (path != iconPath)
                {
                    iconPath = path;
                    if (icon != null) { icon.Dispose(); icon = null; }
                    try
                    {
                        if (path.Length > 0 && File.Exists(path))
                            using (var raw = Image.FromFile(path)) icon = new Bitmap(raw);
                    }
                    catch (Exception) { icon = null; }
                }
                petAlpha = (byte)Math.Max(90, Math.Min(255, Args.Int(r, "petOpacity", 90) * 255 / 100));
                if (visible && !petFinished) { RenderPill(); return; }
                if (visible) HideCore(); // the previous run's "done" card is still up
                petMode = Args.Bool(r, "pet", false);
                petText = Args.Str(r, "text", ""); petThinking = ""; petSteps = new List<string>(); petThinkingLatest = false;
                if (status.Length > 0) petSteps.Add(status);
                pillAtBottom = false;
                paused = false;
                foreach (var g in glows) g.Close();
                glows.Clear();
                if (Args.Bool(r, "glow", true))
                {
                    foreach (Dictionary<string, object> d in Screen2.Displays())
                    {
                        var bounds = new Rectangle((int)d["x"], (int)d["y"], (int)d["width"], (int)d["height"]);
                        var form = new LayeredForm(true);
                        form.Show();
                        using (var bmp = DrawGlow(bounds.Width, bounds.Height, (int)d["dpi"] / 96f)) form.SetBitmap(bmp, bounds, 255);
                        glows.Add(form);
                    }
                }
                if (petMode)
                {
                    if (pet == null)
                    {
                        pet = new LayeredForm(false);
                        pet.MouseDown += delegate (object s, MouseEventArgs e)
                        {
                            if (e.Button != MouseButtons.Left) return;
                            foreach (var b in buttons) if (b.Key.Contains(e.Location)) return;
                            // Drag the card anywhere; it keeps that place until the next run.
                            Native.ReleaseCapture();
                            Native.SendMessage(pet.Handle, 0xA1, new IntPtr(2), IntPtr.Zero); // WM_NCLBUTTONDOWN, HTCAPTION
                            Native.RECT rc;
                            if (pet != null && Native.GetWindowRect(pet.Handle, out rc)) petAnchor = new Point(rc.Right - petShadow, rc.Bottom - petShadow);
                            petDragged = true;
                            RenderPill();
                        };
                        pet.MouseUp += delegate (object s, MouseEventArgs e)
                        {
                            if (petDragged) { petDragged = false; return; }
                            foreach (var b in buttons)
                                if (b.Key.Contains(e.Location)) { Press(b.Value); break; }
                        };
                        pet.Show();
                        PetHwnd = pet.Handle;
                    }
                }
                else if (pill == null)
                {
                    pill = new LayeredForm(false);
                    pill.MouseUp += delegate (object s, MouseEventArgs e)
                    {
                        foreach (var b in buttons)
                            if (b.Key.Contains(e.Location)) { Press(b.Value); break; }
                    };
                    pill.Show();
                }
                RenderPill();
                InstallHook();
                shownAt = DateTime.UtcNow;
                visible = true;
                timer.Start();
            });
        }

        public static void Status(string newStatus)
        {
            if (thread == null || !visible) return;
            Ui(delegate { status = newStatus; RenderPill(); });
        }

        /** New agent output for the progress card: reply text, thinking, and the recent steps (oldest first). */
        public static void PetUpdate(string text, string thinking, List<string> steps, bool thinkingLatest)
        {
            if (thread == null || !visible || !petMode || petFinished) return;
            invoker.BeginInvoke((MethodInvoker)delegate
            {
                if (petFinished) return;
                petText = text;
                petThinking = thinking;
                if (steps.Count > 0) petSteps = steps;
                petThinkingLatest = thinkingLatest;
                RenderPill();
            });
        }

        /** The run ended: the card says so for a moment (longer while the pointer rests on it), then everything hides. */
        public static void Finish(string text, int holdMs)
        {
            if (thread == null) return;
            Ui(delegate
            {
                if (!visible || !petMode) { HideCore(); return; }
                CloseInput(false);
                foreach (var g in glows) g.Close();
                glows.Clear();
                RemoveHook();
                paused = false;
                if (text.Length > 0) petText = text;
                petFinished = true;
                finishedAt = DateTime.UtcNow;
                finishHoldMs = holdMs;
                RenderPill();
            });
        }

        public static void SetPaused(bool value)
        {
            if (thread == null) return;
            Ui(delegate { paused = value; RenderPill(); });
        }

        public static void Hide()
        {
            if (thread == null) return;
            Ui(delegate { HideCore(); });
        }

        static void HideCore()
        {
            {
                CloseInput(false);
                petFinished = false;
                visible = false;
                paused = false;
                timer.Stop();
                foreach (var g in glows) g.Close();
                glows.Clear();
                if (pill != null) { pill.Close(); pill = null; }
                if (pet != null) { PetHwnd = IntPtr.Zero; pet.Close(); pet = null; }
                petMode = false;
                rendered = "";
                lock (RectLock) pillRect = Rectangle.Empty;
                RemoveHook();
            }
        }

        public static void Shutdown()
        {
            if (thread == null) return;
            try { Hide(); Ui(delegate { Application.ExitThread(); }); } catch (Exception) { }
        }

        /// Move the status pill out of the way when an injected pointer action
        /// targets it: the pill is clickable for the user but invisible to the model.
        public static void Dodge(int x, int y)
        {
            Rectangle r;
            lock (RectLock) r = pillRect;
            if (r.IsEmpty) return;
            var inflated = Rectangle.Inflate(r, 12, 12);
            if (!inflated.Contains(x, y)) return;
            Ui(delegate { pillAtBottom = !pillAtBottom; RenderPill(); });
            Thread.Sleep(30);
        }

        // pause / resume / stop, from Esc or the pill buttons.
        static void Press(string action)
        {
            if (action == "stop") { paused = false; Program.EmitEvent("stop", "button"); }
            else if (action == "pause") { paused = true; Program.EmitEvent("pause", "user"); }
            else if (action == "resume") { paused = false; pausedByInput = false; Program.EmitEvent("resume", "user"); }
            else if (action == "expand") petExpanded = !petExpanded;
            else if (action == "input") { if (input == null) OpenInput(); else CloseInput(true); return; }
            else if (action == "send") { if (input != null) SubmitInput(input.Box.Text); return; }
            else if (action == "close") { HideCore(); return; }
            RenderPill();
        }

        static void OpenInput()
        {
            beforeInput = Native.GetForegroundWindow();
            // Typing an instruction pauses the agent, so its keys cannot land in the box.
            if (!paused) { paused = true; pausedByInput = true; Program.EmitEvent("pause", "input"); }
            bool dark = DarkTheme();
            float px = 1.333f * Scale();
            input = new InputBox(new Font("Microsoft YaHei UI", 10f * px, FontStyle.Regular, GraphicsUnit.Pixel),
                dark ? Color.FromArgb(52, 51, 49) : Color.White, dark ? Color.FromArgb(244, 243, 241) : Color.FromArgb(31, 30, 29),
                "告诉 DeepSeek 接下来做什么（Enter 发送，Esc 取消）");
            input.Submitted += SubmitInput;
            input.Cancelled += delegate { CloseInput(true); };
            inputBounds = Rectangle.Empty;
            RenderPill(); // makes room for the field and places the box over it
            input.Show();
            InputHwnd = input.Handle;
            var handle = input.Handle;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try { Windows.Focus(handle); } catch (Exception) { }
                try { invoker.BeginInvoke((MethodInvoker)delegate { if (input != null) input.Box.Focus(); }); } catch (Exception) { }
            });
        }

        static void SubmitInput(string text)
        {
            text = (text ?? "").Trim();
            if (text.Length > 0) Program.EmitEvent("message", text);
            CloseInput(true);
        }

        static void CloseInput(bool restoreFocus)
        {
            if (input == null) return;
            var box = input;
            input = null;
            InputReturnsTo = restoreFocus ? beforeInput : IntPtr.Zero;
            InputHwnd = IntPtr.Zero;
            inputBounds = Rectangle.Empty;
            box.Close();
            if (pausedByInput) { paused = false; pausedByInput = false; Program.EmitEvent("resume", "input"); }
            var target = beforeInput;
            beforeInput = IntPtr.Zero;
            if (restoreFocus && target != IntPtr.Zero && Native.IsWindow(target))
                ThreadPool.QueueUserWorkItem(delegate { try { Windows.Focus(target); } catch (Exception) { } });
            if (visible) RenderPill();
        }

        static bool Typing() { return unchecked(Environment.TickCount - lastTyping) < idleMs; }

        static void Tick()
        {
            if (!visible) return;
            if (petFinished)
            {
                Native.POINT p; Native.GetCursorPos(out p);
                bool hovered = petBody.Contains(p.X, p.Y);
                if (hovered) finishedAt = DateTime.UtcNow;
                if ((DateTime.UtcNow - finishedAt).TotalMilliseconds >= finishHoldMs) HideCore();
                return;
            }
            double t = (DateTime.UtcNow - shownAt).TotalSeconds;
            double fadeIn = Math.Min(1.0, t / 0.35);
            double breathe = paused ? 0.55 : 0.72 + 0.28 * (0.5 + 0.5 * Math.Sin(t * Math.PI * 2 / 2.6));
            byte alpha = (byte)Math.Max(0, Math.Min(255, 255 * fadeIn * breathe));
            foreach (var g in glows) g.SetAlpha(alpha);
            if (Key() != rendered) RenderPill(); // typing started or stopped
            if ((int)(t * 25) % 50 == 0)
            {
                foreach (var g in glows) g.KeepOnTop();
                if (pill != null) pill.KeepOnTop();
                if (pet != null) pet.KeepOnTop();
                if (input != null) Native.SetWindowPos(input.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
            }
        }

        static Bitmap DrawGlow(int w, int h, float scale)
        {
            var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                int depth = Math.Max(14, (int)(30 * scale));
                for (int i = 0; i < depth; i++)
                {
                    double f = 1.0 - (double)i / depth;
                    int a = (int)(185 * Math.Pow(f, 1.9));
                    if (a <= 0) continue;
                    using (var pen = new Pen(Color.FromArgb(a, Accent), 1))
                        g.DrawRectangle(pen, i, i, w - 1 - 2 * i, h - 1 - 2 * i);
                }
                int line = Math.Max(2, (int)Math.Round(2.5 * scale));
                using (var pen = new Pen(Color.FromArgb(235, AccentHi), line))
                {
                    pen.Alignment = PenAlignment.Inset;
                    g.DrawRectangle(pen, 0, 0, w, h);
                }
            }
            return bmp;
        }

        static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var p = new GraphicsPath();
            float d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        // What the pill should say right now; it is re-rendered whenever this changes.
        static void Content(out string main, out string sub, out string[] actions, out string[] captions)
        {
            if (paused)
            {
                main = "已暂停"; sub = "按 Esc 继续";
                actions = new[] { "resume", "stop" }; captions = new[] { "继续", "停止" };
                return;
            }
            main = label;
            sub = Typing() ? "你正在操作，已暂停" : status.Length > 0 ? status : "Esc 暂停";
            actions = new[] { "stop" }; captions = new[] { "停止" };
        }

        static string Key()
        {
            string main, sub; string[] actions, captions;
            Content(out main, out sub, out actions, out captions);
            return main + "|" + sub + "|" + string.Join(",", actions) + "|" + pillAtBottom + "|" + Typing();
        }

        static bool DarkTheme()
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    object v = key == null ? null : key.GetValue("AppsUseLightTheme");
                    return v is int && (int)v == 0;
                }
            }
            catch (Exception) { return false; }
        }

        /** The end of `s` that fits `width`, led by "…": a ticker that scrolls as text streams in. */
        static string Tail(Graphics g, string s, Font font, float width, StringFormat fmt)
        {
            if (s.Length == 0 || g.MeasureString(s, font, 100000, fmt).Width <= width) return s;
            int lo = 1, hi = s.Length - 1;
            while (lo < hi)
            {
                int mid = (lo + hi) / 2;
                if (g.MeasureString("…" + s.Substring(mid), font, 100000, fmt).Width <= width) hi = mid; else lo = mid + 1;
            }
            if (lo < s.Length && char.IsLowSurrogate(s[lo])) lo++;
            return "…" + s.Substring(Math.Min(lo, s.Length));
        }

        static float Scale()
        {
            float scale = 1f; bool found = false;
            foreach (Dictionary<string, object> d in Screen2.Displays())
                if (!found || (bool)d["primary"]) { scale = (int)d["dpi"] / 96f; found = true; }
            return scale;
        }

        static string IconFont()
        {
            if (iconFont != null) return iconFont;
            iconFont = "";
            foreach (var name in new[] { "Segoe Fluent Icons", "Segoe MDL2 Assets" })
                using (var f = new Font(name, 10f)) if (f.Name == name) { iconFont = name; break; }
            return iconFont;
        }

        /** The end of `s` that fits in `width` x `height` when wrapped, led by "…". */
        static string TailWrapped(Graphics g, string s, Font font, float width, float height, StringFormat fmt)
        {
            Func<string, bool> fits = delegate (string t) { return g.MeasureString(t, font, new SizeF(width, 100000), fmt).Height <= height; };
            if (s.Length == 0 || fits(s)) return s;
            int lo = 1, hi = s.Length - 1;
            while (lo < hi)
            {
                int mid = (lo + hi) / 2;
                if (fits("…" + s.Substring(mid))) hi = mid; else lo = mid + 1;
            }
            if (lo < s.Length && char.IsLowSurrogate(s[lo])) lo++;
            return "…" + s.Substring(Math.Min(lo, s.Length));
        }

        static void RenderPet()
        {
            if (pet == null) return;
            Rectangle work = Rectangle.Empty; float scale = 1f;
            foreach (Dictionary<string, object> d in Screen2.Displays())
            {
                if (work.IsEmpty || (bool)d["primary"])
                {
                    work = new Rectangle((int)d["workX"], (int)d["workY"], (int)d["workWidth"], (int)d["workHeight"]);
                    scale = (int)d["dpi"] / 96f;
                }
            }
            rendered = Key();
            bool dark = DarkTheme();
            Color bg = dark ? Color.FromArgb(petAlpha, 32, 31, 30) : Color.FromArgb(petAlpha, 252, 252, 251);
            Color ink = dark ? Color.FromArgb(244, 243, 241) : Color.FromArgb(31, 30, 29);
            Color muted = dark ? Color.FromArgb(168, 165, 160) : Color.FromArgb(112, 110, 106);
            Color edge = dark ? Color.FromArgb(60, 255, 255, 255) : Color.FromArgb(34, 0, 0, 0);
            Color chip = dark ? Color.FromArgb(70, 68, 66) : Color.FromArgb(234, 232, 228);
            Color field = dark ? Color.FromArgb(52, 51, 49) : Color.White;

            string title = petFinished ? "已完成" : label;
            string state = petFinished ? "" : paused ? (input != null ? "输入指令中…" : "已暂停 · Esc 继续") : Typing() ? "你正在操作，已暂停" : "Esc 暂停";
            // Header buttons, right to left.
            var actions = new List<string>(); var glyphs = new List<string>();
            if (petFinished) { actions.Add("close"); glyphs.Add("\uE711"); }
            else
            {
                actions.Add("stop"); glyphs.Add("\uE71A");
                if (paused) { actions.Add("resume"); glyphs.Add("\uE768"); } else { actions.Add("pause"); glyphs.Add("\uE769"); }
            }
            actions.Add("expand"); glyphs.Add(petExpanded ? "\uE70D" : "\uE70E");
            if (!petFinished) { actions.Add("input"); glyphs.Add("\uE70F"); }

            float s = scale, px = 1.333f * scale;
            int shadow = (int)(14 * s);
            petShadow = shadow;
            float bodyW = 420 * s, pad = 16 * s;
            float headH = 44 * s, replyH = 26 * s;
            if (petExpanded)
            {
                // Grow with the reply, up to about eight lines.
                using (var probe = new Bitmap(1, 1))
                using (var pg = Graphics.FromImage(probe))
                using (var pf = new Font("Microsoft YaHei UI", 10.5f * 1.333f * scale, FontStyle.Regular, GraphicsUnit.Pixel))
                {
                    string t = petText.Length > 0 ? petText : "正在操作…";
                    float need = pg.MeasureString(t, pf, new SizeF(420 * scale - 32 * scale, 100000), new StringFormat(StringFormat.GenericTypographic)).Height + 6 * scale;
                    replyH = Math.Max(26 * scale, Math.Min(172 * scale, need));
                }
            }
            int stepRows = petExpanded ? Math.Min(5, Math.Max(1, petSteps.Count)) : 0;
            bool thinkingRow = petExpanded && petThinking.Length > 0 && !petFinished;
            float listH = petExpanded ? 8 * s + (thinkingRow ? 24 * s : 0) + stepRows * 22 * s : 24 * s;
            float inputH = input != null ? 46 * s : 0;
            float bodyH = headH + replyH + listH + inputH + 12 * s;
            int W = (int)Math.Ceiling(bodyW) + 2 * shadow, H = (int)Math.Ceiling(bodyH) + 2 * shadow;
            if (petAnchor.IsEmpty) petAnchor = new Point(work.Right - (int)(16 * s), work.Bottom - (int)(16 * s));
            int x = petAnchor.X - (int)bodyW - shadow, y = petAnchor.Y - (int)bodyH - shadow;
            y = Math.Max(work.Y - shadow, y);
            petBody = new Rectangle(x + shadow, y + shadow, (int)bodyW, (int)bodyH);

            string glyphFont = IconFont();
            using (var fHead = new Font("Microsoft YaHei UI", 8.5f * px, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var fState = new Font("Microsoft YaHei UI", 8f * px, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var fText = new Font("Microsoft YaHei UI", 10.5f * px, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var fAct = new Font("Microsoft YaHei UI", 8.5f * px, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var fGlyph = new Font(glyphFont.Length > 0 ? glyphFont : "Segoe UI Symbol", 8.5f * px, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb))
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.TextRenderingHint = TextRenderingHint.AntiAlias;
                var fmt = new StringFormat(StringFormat.GenericTypographic);
                fmt.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoWrap;
                var wrap = new StringFormat(StringFormat.GenericTypographic);
                wrap.Trimming = StringTrimming.None;
                var center = new StringFormat(); center.Alignment = StringAlignment.Center; center.LineAlignment = StringAlignment.Center;

                var body = new RectangleF(shadow, shadow, bodyW, bodyH);
                float radius = 18 * s;
                for (int i = shadow; i > 0; i--)
                {
                    double f = 1.0 - (double)i / shadow;
                    using (var path = Rounded(RectangleF.Inflate(body, i, i - 2 * s), radius + i))
                    using (var brush = new SolidBrush(Color.FromArgb((int)(16 * f * f), 0, 0, 0))) g.FillPath(brush, path);
                }
                using (var path = Rounded(body, radius))
                {
                    using (var brush = new SolidBrush(bg)) g.FillPath(brush, path);
                    using (var pen = new Pen(edge, Math.Max(1f, s))) g.DrawPath(pen, path);
                }

                // Header: logo, title, state, round icon buttons.
                float hy = body.Y + 10 * s, hh = 28 * s;
                float iconSize = 18 * s;
                var iconRect = new RectangleF(body.X + pad, hy + (hh - iconSize) / 2f, iconSize, iconSize);
                Image logo = dark ? icon : (iconLight ?? icon);
                if (petFinished)
                {
                    using (var brush = new SolidBrush(Color.FromArgb(46, 160, 67))) g.FillEllipse(brush, iconRect);
                    using (var b = new SolidBrush(Color.White)) g.DrawString(glyphFont.Length > 0 ? "\uE73E" : "✓", fGlyph, b, iconRect, center);
                }
                else if (logo != null) g.DrawImage(logo, iconRect);
                else using (var brush = new SolidBrush(Accent)) g.FillEllipse(brush, RectangleF.Inflate(iconRect, -3 * s, -3 * s));
                float tx = iconRect.Right + 8 * s;
                SizeF headSize = g.MeasureString(title, fHead, 100000, fmt);
                using (var b = new SolidBrush(ink)) g.DrawString(title, fHead, b, tx, hy + (hh - headSize.Height) / 2f, fmt);
                tx += headSize.Width + 8 * s;

                buttons.Clear();
                float d = 26 * s, bx = body.Right - pad;
                for (int i = 0; i < actions.Count; i++)
                {
                    bx -= d;
                    var circle = new RectangleF(bx, hy + (hh - d) / 2f, d, d);
                    bool stop = actions[i] == "stop";
                    bool on = (actions[i] == "input" && input != null) || (actions[i] == "resume");
                    using (var brush = new SolidBrush(stop ? Accent : on ? Color.FromArgb(dark ? 110 : 60, Accent) : chip)) g.FillEllipse(brush, circle);
                    string glyph = glyphFont.Length > 0 ? glyphs[i] : (stop ? "■" : actions[i] == "pause" ? "❚❚" : actions[i] == "resume" ? "▶" : actions[i] == "expand" ? (petExpanded ? "˅" : "˄") : actions[i] == "close" ? "✕" : "✎");
                    using (var b = new SolidBrush(stop ? Color.White : ink)) g.DrawString(glyph, fGlyph, b, circle, center);
                    buttons.Add(new KeyValuePair<Rectangle, string>(Rectangle.Round(circle), actions[i]));
                    bx -= 6 * s;
                }
                if (state.Length > 0)
                {
                    string st = Tail(g, state, fState, Math.Max(0, bx - tx - 4 * s), fmt);
                    SizeF stSize = g.MeasureString(st, fState, 100000, fmt);
                    using (var b = new SolidBrush(paused ? Accent : muted)) g.DrawString(st, fState, b, tx, hy + (hh - stSize.Height) / 2f, fmt);
                }

                // The reply as it streams: one scrolling line, or the latest lines when expanded.
                float lineW = bodyW - 2 * pad;
                float ry = body.Y + headH;
                string text = petText.Length > 0 ? petText : (petFinished ? "" : "正在操作…");
                using (var b = new SolidBrush(petText.Length > 0 ? ink : muted))
                {
                    if (petExpanded)
                        g.DrawString(TailWrapped(g, text, fText, lineW, replyH, wrap), fText, b, new RectangleF(body.X + pad, ry, lineW, replyH), wrap);
                    else
                    {
                        string shown = Tail(g, text, fText, lineW, fmt);
                        SizeF size = g.MeasureString(shown.Length > 0 ? shown : " ", fText, 100000, fmt);
                        g.DrawString(shown, fText, b, body.X + pad, ry + (replyH - size.Height) / 2f, fmt);
                    }
                }

                // Thinking and the step timeline.
                float ly = ry + replyH;
                if (petExpanded)
                {
                    ly += 4 * s;
                    using (var pen = new Pen(edge, Math.Max(1f, s))) g.DrawLine(pen, body.X + pad, ly, body.Right - pad, ly);
                    ly += 4 * s;
                    if (thinkingRow)
                    {
                        float prefixW = g.MeasureString("思考：", fAct, 100000, fmt).Width;
                        string th = Tail(g, petThinking, fAct, lineW - prefixW, fmt);
                        using (var b = new SolidBrush(muted)) { g.DrawString("思考：", fAct, b, body.X + pad, ly + 3 * s, fmt); g.DrawString(th, fAct, b, body.X + pad + prefixW, ly + 3 * s, fmt); }
                        ly += 24 * s;
                    }
                    int first = Math.Max(0, petSteps.Count - stepRows);
                    for (int i = first; i < petSteps.Count; i++)
                    {
                        bool current = i == petSteps.Count - 1 && !petFinished;
                        float cy = ly + 11 * s;
                        if (current) using (var brush = new SolidBrush(Accent)) g.FillEllipse(brush, body.X + pad + 2 * s, cy - 3 * s, 6 * s, 6 * s);
                        else using (var b = new SolidBrush(Color.FromArgb(46, 160, 67))) g.DrawString(glyphFont.Length > 0 ? "\uE73E" : "✓", fGlyph, b, new RectangleF(body.X + pad - 2 * s, ly, 14 * s, 22 * s), center);
                        string line = Tail(g, petSteps[i], fAct, lineW - 16 * s, fmt);
                        using (var b = new SolidBrush(current ? ink : muted)) g.DrawString(line, fAct, b, body.X + pad + 16 * s, ly + 3 * s, fmt);
                        ly += 22 * s;
                    }
                }
                else
                {
                    string act;
                    if (petFinished) act = petSteps.Count > 0 ? "共 " + petSteps.Count + " 步 · " + petSteps[petSteps.Count - 1] : "";
                    else if (petThinkingLatest && petThinking.Length > 0) act = "思考：" + Tail(g, petThinking, fAct, lineW - 14 * s - g.MeasureString("思考：", fAct, 100000, fmt).Width, fmt);
                    else
                    {
                        var parts = new List<string>();
                        for (int i = Math.Max(0, petSteps.Count - 4); i < petSteps.Count; i++) parts.Add(i < petSteps.Count - 1 ? "✓ " + petSteps[i] : petSteps[i]);
                        act = string.Join("  ›  ", parts);
                    }
                    using (var brush = new SolidBrush(petFinished ? Color.FromArgb(46, 160, 67) : Accent)) g.FillEllipse(brush, body.X + pad, ly + 8 * s, 6 * s, 6 * s);
                    string shown = Tail(g, act, fAct, lineW - 14 * s, fmt);
                    using (var b = new SolidBrush(muted)) g.DrawString(shown, fAct, b, body.X + pad + 14 * s, ly + 3 * s, fmt);
                    ly += 24 * s;
                }

                // The instruction field: the card draws its frame and send button, a real text box sits on top.
                if (input != null)
                {
                    ly += 6 * s;
                    float sendD = 32 * s;
                    var fieldRect = new RectangleF(body.X + pad, ly, lineW - sendD - 8 * s, 34 * s);
                    using (var path = Rounded(fieldRect, 17 * s))
                    {
                        using (var brush = new SolidBrush(field)) g.FillPath(brush, path);
                        using (var pen = new Pen(Color.FromArgb(150, Accent), Math.Max(1f, 1.2f * s))) g.DrawPath(pen, path);
                    }
                    var send = new RectangleF(body.Right - pad - sendD, ly + (34 * s - sendD) / 2f, sendD, sendD);
                    using (var brush = new SolidBrush(Accent)) g.FillEllipse(brush, send);
                    using (var b = new SolidBrush(Color.White)) g.DrawString(glyphFont.Length > 0 ? "\uE724" : "➤", fGlyph, b, send, center);
                    buttons.Add(new KeyValuePair<Rectangle, string>(Rectangle.Round(send), "send"));
                    var boxRect = new Rectangle(x + (int)(fieldRect.X + 14 * s), y + (int)(fieldRect.Y + 3 * s), (int)(fieldRect.Width - 28 * s), (int)(fieldRect.Height - 6 * s));
                    if (boxRect != inputBounds) { inputBounds = boxRect; input.Place(boxRect); }
                }

                pet.SetBitmap(bmp, new Rectangle(x, y, W, H), 255);
            }
            pet.KeepOnTop();
            if (input != null) Native.SetWindowPos(input.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        }

        static void RenderPill()
        {
            if (petMode) { RenderPet(); return; }
            if (pill == null) return;
            // The pill lives on the primary display (or the first one).
            Rectangle work = Rectangle.Empty; float scale = 1f;
            foreach (Dictionary<string, object> d in Screen2.Displays())
            {
                if (work.IsEmpty || (bool)d["primary"])
                {
                    work = new Rectangle((int)d["workX"], (int)d["workY"], (int)d["workWidth"], (int)d["workHeight"]);
                    scale = (int)d["dpi"] / 96f;
                }
            }
            string main, sub; string[] actions, captions;
            Content(out main, out sub, out actions, out captions);
            rendered = Key();
            if (sub.Length > 48) sub = sub.Substring(0, 47) + "…";

            float px = 1.333f * scale; // points -> physical pixels
            using (var fMain = new Font("Microsoft YaHei UI", 10f * px, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var fSub = new Font("Microsoft YaHei UI", 9f * px, FontStyle.Regular, GraphicsUnit.Pixel))
            using (var fBtn = new Font("Microsoft YaHei UI", 9f * px, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var measureBmp = new Bitmap(1, 1))
            using (var mg = Graphics.FromImage(measureBmp))
            {
                mg.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                var fmt = StringFormat.GenericTypographic;
                fmt.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
                SizeF mainSize = mg.MeasureString(main, fMain, 10000, fmt);
                SizeF subSize = mg.MeasureString(sub, fSub, 10000, fmt);
                float pad = 14 * scale, gap = 11 * scale, iconSize = 24 * scale;
                float height = 40 * scale, btnH = 26 * scale, btnGap = 6 * scale;
                var btnSizes = new SizeF[captions.Length];
                float btnsW = 0;
                for (int i = 0; i < captions.Length; i++)
                {
                    btnSizes[i] = mg.MeasureString(captions[i], fBtn, 10000, fmt);
                    btnsW += btnSizes[i].Width + 22 * scale + (i > 0 ? btnGap : 0);
                }
                float width = pad + iconSize + gap + mainSize.Width + gap + 1 * scale + gap + subSize.Width + gap + btnsW + (pad - 7 * scale);
                int W = (int)Math.Ceiling(width), H = (int)Math.Ceiling(height);
                int x = work.X + (work.Width - W) / 2;
                int y = pillAtBottom ? work.Bottom - H - (int)(18 * scale) : work.Y + (int)(14 * scale);

                using (var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb))
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Transparent);
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    var body = new RectangleF(0.5f, 0.5f, W - 1, H - 1);
                    using (var path = Rounded(body, (H - 1) / 2f))
                    {
                        using (var brush = new SolidBrush(Color.FromArgb(242, 31, 30, 29))) g.FillPath(brush, path);
                        using (var pen = new Pen(Color.FromArgb(200, Accent), Math.Max(1f, 1.2f * scale))) g.DrawPath(pen, path);
                    }
                    var iconRect = new RectangleF(pad, (H - iconSize) / 2f, iconSize, iconSize);
                    if (icon != null) g.DrawImage(icon, iconRect);
                    else using (var brush = new SolidBrush(Accent)) g.FillEllipse(brush, RectangleF.Inflate(iconRect, -5 * scale, -5 * scale));
                    float tx = pad + iconSize + gap;
                    using (var b = new SolidBrush(Color.FromArgb(250, 250, 249))) g.DrawString(main, fMain, b, tx, (H - mainSize.Height) / 2f, fmt);
                    tx += mainSize.Width + gap;
                    using (var pen = new Pen(Color.FromArgb(90, 255, 255, 255), Math.Max(1f, scale))) g.DrawLine(pen, tx, H * 0.3f, tx, H * 0.7f);
                    tx += 1 * scale + gap;
                    using (var b = new SolidBrush(Color.FromArgb(175, 172, 168))) g.DrawString(sub, fSub, b, tx, (H - subSize.Height) / 2f, fmt);
                    tx += subSize.Width + gap;
                    buttons.Clear();
                    for (int i = 0; i < captions.Length; i++)
                    {
                        float bw = btnSizes[i].Width + 22 * scale;
                        var btn = new RectangleF(tx, (H - btnH) / 2f, bw, btnH);
                        bool primary = i == 0;
                        using (var path = Rounded(btn, btnH / 2f))
                        using (var brush = new SolidBrush(primary ? Accent : Color.FromArgb(70, 68, 66))) g.FillPath(brush, path);
                        using (var b = new SolidBrush(Color.White)) g.DrawString(captions[i], fBtn, b, btn.X + (bw - btnSizes[i].Width) / 2f, btn.Y + (btnH - btnSizes[i].Height) / 2f, fmt);
                        buttons.Add(new KeyValuePair<Rectangle, string>(Rectangle.Round(btn), actions[i]));
                        tx += bw + btnGap;
                    }
                    pill.SetBitmap(bmp, new Rectangle(x, y, W, H), 255);
                }
                lock (RectLock) pillRect = new Rectangle(x, y, W, H);
            }
            pill.KeepOnTop();
        }

        static void InstallHook()
        {
            if (hook != IntPtr.Zero) return;
            hookProc = HookCallback;
            hook = Native.SetWindowsHookEx(13, hookProc, Native.GetModuleHandle(null), 0);
        }

        static void RemoveHook()
        {
            if (hook == IntPtr.Zero) return;
            Native.UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }

        static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && visible)
            {
                int msg = wParam.ToInt32();
                var kb = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                // Only physical keys count: our own SendInput sets LLKHF_INJECTED (0x10).
                if ((kb.flags & 0x10) == 0 && !(InputHwnd != IntPtr.Zero && Native.GetForegroundWindow() == InputHwnd))
                {
                    bool down = msg == 0x100 || msg == 0x104;
                    if (kb.vkCode == 0x1B)
                    {
                        // Esc toggles pause and is swallowed, so the focused app
                        // (DeepSeek Harness included) never turns it into "stop".
                        if (down) invoker.BeginInvoke((MethodInvoker)delegate { Press(paused ? "resume" : "pause"); });
                        return new IntPtr(1);
                    }
                    // Modifier-only presses (Shift to switch the IME, Ctrl, Alt, Win)
                    // and synthetic packets are not typing.
                    int vk = (int)kb.vkCode;
                    bool modifier = vk == 0x10 || vk == 0x11 || vk == 0x12 || (vk >= 0xA0 && vk <= 0xA5) || vk == 0x5B || vk == 0x5C || vk == 0x14 || vk == 0xE7 || vk == 0xFF;
                    if (down && !modifier)
                    {
                        // The user is typing: the host waits. Mouse movement is
                        // deliberately ignored (too easy to nudge).
                        int now = Environment.TickCount;
                        lastTyping = now;
                        if (unchecked(now - lastEmit) > 250) { lastEmit = now; Program.EmitEvent("user_input", "vk=0x" + vk.ToString("X2")); }
                    }
                }
            }
            return Native.CallNextHookEx(hook, nCode, wParam, lParam);
        }
    }
}
