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
                case "cursor": { Native.POINT p; Native.GetCursorPos(out p); return Pt(p.X, p.Y); }
                case "move": Overlay.Dodge(Args.Int(r, "x", 0), Args.Int(r, "y", 0)); Input.Move(Args.Int(r, "x", 0), Args.Int(r, "y", 0)); return null;
                case "click": return Input.Click(r);
                case "button": return Input.Button(r);
                case "drag": return Input.Drag(r);
                case "scroll": return Input.Scroll(r);
                case "keys": return Input.Keys(r);
                case "key_state": return Input.KeyState(r);
                case "type": return Input.Type(Args.Str(r, "text", ""), Args.Int(r, "chunkDelay", 8));
                case "paste": return Input.Paste(Args.Str(r, "text", ""), Args.Bool(r, "restore", true));
                case "windows": return Windows.List();
                case "foreground": return Windows.Describe(Native.GetForegroundWindow());
                case "window_at": return Windows.At(Args.Int(r, "x", 0), Args.Int(r, "y", 0));
                case "focus": return Windows.Focus(new IntPtr(Convert.ToInt64(r["hwnd"])));
                case "window_cmd": return Windows.Command(new IntPtr(Convert.ToInt64(r["hwnd"])), Args.Str(r, "op", ""));
                case "apps": return Apps.Search(Args.Str(r, "query", ""), Args.Int(r, "limit", 8));
                case "launch": return Apps.Launch(r);
                case "clipboard_get": { var d = new Dictionary<string, object>(); d["text"] = Clip.Get(); return d; }
                case "clipboard_set": Clip.Set(Args.Str(r, "text", "")); return null;
                case "ui": return Uia.Elements(r);
                case "overlay_show": Overlay.ExcludeFromCapture = Args.Bool(r, "excludeFromCapture", true); Overlay.Show(Args.Str(r, "label", ""), Args.Str(r, "status", ""), Args.Bool(r, "glow", true)); return null;
                case "overlay_status": Overlay.Status(Args.Str(r, "status", "")); return null;
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

        static ImageCodecInfo jpegCodec;

        public static Dictionary<string, object> Capture(Dictionary<string, object> r)
        {
            int x = Args.Int(r, "x", 0), y = Args.Int(r, "y", 0), w = Args.Int(r, "width", 0), h = Args.Int(r, "height", 0);
            int ow = Args.Int(r, "outWidth", w), oh = Args.Int(r, "outHeight", h);
            int quality = Args.Int(r, "quality", 80);
            if (w <= 0 || h <= 0 || ow <= 0 || oh <= 0) throw new Exception("invalid capture size");
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr dst = g.GetHdc();
                    IntPtr src = Native.GetDC(IntPtr.Zero);
                    try { Native.BitBlt(dst, 0, 0, w, h, src, x, y, 0x00CC0020 | 0x40000000); }
                    finally { Native.ReleaseDC(IntPtr.Zero, src); g.ReleaseHdc(dst); }
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
            uint sent = Native.SendInput((uint)inputs.Count, inputs.ToArray(), InputSize);
            if (sent != inputs.Count)
                throw new Exception("SendInput was blocked (error " + Marshal.GetLastWin32Error() + "). The target may be running elevated (as administrator) or the secure desktop (UAC / lock screen) is active.");
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

        public static object Type(string text, int chunkDelay)
        {
            var batch = new List<Native.INPUT>();
            Action flush = delegate { Send(batch); batch.Clear(); if (chunkDelay > 0) Thread.Sleep(chunkDelay); };
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r') { if (i + 1 < text.Length && text[i + 1] == '\n') continue; c = '\n'; }
                if (c == '\n') { flush(); batch.Add(Key(0x0D, false)); batch.Add(Key(0x0D, true)); flush(); continue; }
                if (c == '\t') { batch.Add(Key(0x09, false)); batch.Add(Key(0x09, true)); continue; }
                batch.Add(Unicode(c, false)); batch.Add(Unicode(c, true));
                if (batch.Count >= 40 && !char.IsHighSurrogate(c)) flush();
            }
            flush();
            return null;
        }

        public static object Paste(string text, bool restore)
        {
            string previous = null;
            if (restore) { try { previous = Clip.Get(); } catch (Exception) { } }
            Clip.Set(text);
            Thread.Sleep(40);
            Send(new List<Native.INPUT> { Key(0x11, false), Key(0x56, false) });
            Thread.Sleep(30);
            Send(new List<Native.INPUT> { Key(0x56, true), Key(0x11, true) });
            Thread.Sleep(250);
            if (restore && previous != null) { try { Clip.Set(previous); } catch (Exception) { } }
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

        public static void Set(string text)
        {
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    if (string.IsNullOrEmpty(text)) Clipboard.Clear(); else Clipboard.SetText(text);
                    return;
                }
                catch (ExternalException) { Thread.Sleep(50); }
            }
            throw new Exception("clipboard is busy");
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
            if (h == IntPtr.Zero || pid == (uint)Process.GetCurrentProcess().Id)
            {
                // Our own status pill is under the point (it dodges before the
                // click): report the topmost foreign window there instead.
                IntPtr found = IntPtr.Zero;
                uint self = (uint)Process.GetCurrentProcess().Id;
                Native.EnumWindowsProc cb = delegate (IntPtr w, IntPtr data)
                {
                    if (!Native.IsWindowVisible(w)) return true;
                    uint p; Native.GetWindowThreadProcessId(w, out p);
                    if (p == self) return true;
                    if ((Native.GetWindowLong(w, -20) & 0x20) != 0) return true; // WS_EX_TRANSPARENT
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
            }
            var d = Describe(hwnd);
            d["focused"] = Native.GetForegroundWindow() == hwnd;
            return d;
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
            if (appId.Length > 0) psi = new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + appId);
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

    internal static class Overlay
    {
        static readonly Color Accent = Color.FromArgb(217, 119, 87);    // #D97757
        static readonly Color AccentHi = Color.FromArgb(240, 160, 106); // #F0A06A

        public static volatile bool ExcludeFromCapture = true;
        static Thread thread;
        static Control invoker;
        static readonly List<LayeredForm> glows = new List<LayeredForm>();
        static LayeredForm pill;
        static Rectangle pillRect, stopRect, pillDisplay;
        static bool pillAtBottom;
        static string label = "", status = "";
        static float pillScale = 1f;
        static System.Windows.Forms.Timer timer;
        static DateTime shownAt;
        static IntPtr hook = IntPtr.Zero;
        static Native.LowLevelKeyboardProc hookProc;
        static volatile bool visible;
        static readonly object RectLock = new object();

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

        public static void Show(string newLabel, string newStatus, bool glow)
        {
            Ensure();
            Ui(delegate
            {
                label = newLabel; status = newStatus;
                if (visible) { RenderPill(); return; }
                pillAtBottom = false;
                foreach (var g in glows) g.Close();
                glows.Clear();
                if (glow)
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
                if (pill == null)
                {
                    pill = new LayeredForm(false);
                    pill.MouseUp += delegate (object s, MouseEventArgs e)
                    {
                        if (stopRect.Contains(e.Location)) { Program.EmitEvent("stop", "button"); }
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

        public static void Hide()
        {
            if (thread == null) return;
            Ui(delegate
            {
                visible = false;
                timer.Stop();
                foreach (var g in glows) g.Close();
                glows.Clear();
                if (pill != null) { pill.Close(); pill = null; }
                lock (RectLock) pillRect = Rectangle.Empty;
                RemoveHook();
            });
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

        static void Tick()
        {
            if (!visible) return;
            double t = (DateTime.UtcNow - shownAt).TotalSeconds;
            double fadeIn = Math.Min(1.0, t / 0.35);
            double breathe = 0.72 + 0.28 * (0.5 + 0.5 * Math.Sin(t * Math.PI * 2 / 2.6));
            byte alpha = (byte)Math.Max(0, Math.Min(255, 255 * fadeIn * breathe));
            foreach (var g in glows) g.SetAlpha(alpha);
            if ((int)(t * 25) % 50 == 0)
            {
                foreach (var g in glows) g.KeepOnTop();
                if (pill != null) pill.KeepOnTop();
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

        static void DrawSpark(Graphics g, float cx, float cy, float radius, Color color, float width)
        {
            using (var pen = new Pen(color, width))
            {
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                for (int i = 0; i < 6; i++)
                {
                    double a = Math.PI * i / 6;
                    float dx = (float)(Math.Cos(a) * radius), dy = (float)(Math.Sin(a) * radius);
                    g.DrawLine(pen, cx - dx, cy - dy, cx + dx, cy + dy);
                }
            }
        }

        static void RenderPill()
        {
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
            pillDisplay = work; pillScale = scale;

            string main = label;
            string hint = "Esc 停止";
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
                string sub = status.Length > 0 ? status : hint;
                if (sub.Length > 48) sub = sub.Substring(0, 47) + "…";
                SizeF mainSize = mg.MeasureString(main, fMain, 10000, fmt);
                SizeF subSize = mg.MeasureString(sub, fSub, 10000, fmt);
                SizeF btnSize = mg.MeasureString("停止", fBtn, 10000, fmt);
                float pad = 14 * scale, gap = 10 * scale, icon = 18 * scale;
                float height = 40 * scale;
                float btnW = btnSize.Width + 22 * scale, btnH = 26 * scale;
                float width = pad + icon + gap + mainSize.Width + gap + 1 * scale + gap + subSize.Width + gap + btnW + (pad - 7 * scale);
                int W = (int)Math.Ceiling(width), H = (int)Math.Ceiling(height);
                int x = work.X + (work.Width - W) / 2;
                int y = pillAtBottom ? work.Bottom - H - (int)(18 * scale) : work.Y + (int)(14 * scale);

                using (var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb))
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Transparent);
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    var body = new RectangleF(0.5f, 0.5f, W - 1, H - 1);
                    using (var path = Rounded(body, (H - 1) / 2f))
                    {
                        using (var brush = new SolidBrush(Color.FromArgb(242, 31, 30, 29))) g.FillPath(brush, path);
                        using (var pen = new Pen(Color.FromArgb(200, Accent), Math.Max(1f, 1.2f * scale))) g.DrawPath(pen, path);
                    }
                    float cx = pad + icon / 2, cy = H / 2f;
                    DrawSpark(g, cx, cy, icon / 2, Accent, Math.Max(1.6f, 2.1f * scale));
                    float tx = pad + icon + gap;
                    using (var b = new SolidBrush(Color.FromArgb(250, 250, 249))) g.DrawString(main, fMain, b, tx, (H - mainSize.Height) / 2f, fmt);
                    tx += mainSize.Width + gap;
                    using (var pen = new Pen(Color.FromArgb(90, 255, 255, 255), Math.Max(1f, scale))) g.DrawLine(pen, tx, H * 0.3f, tx, H * 0.7f);
                    tx += 1 * scale + gap;
                    using (var b = new SolidBrush(Color.FromArgb(175, 172, 168))) g.DrawString(sub, fSub, b, tx, (H - subSize.Height) / 2f, fmt);
                    tx += subSize.Width + gap;
                    var btn = new RectangleF(tx, (H - btnH) / 2f, btnW, btnH);
                    using (var path = Rounded(btn, btnH / 2f))
                    using (var brush = new SolidBrush(Accent)) g.FillPath(brush, path);
                    using (var b = new SolidBrush(Color.White)) g.DrawString("停止", fBtn, b, btn.X + (btnW - btnSize.Width) / 2f, btn.Y + (btnH - btnSize.Height) / 2f, fmt);
                    stopRect = Rectangle.Round(btn);
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
            if (nCode >= 0 && visible && (wParam.ToInt32() == 0x100 || wParam.ToInt32() == 0x104))
            {
                var kb = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                // Only a physical Esc counts: our own SendInput sets LLKHF_INJECTED (0x10).
                if (kb.vkCode == 0x1B && (kb.flags & 0x10) == 0) Program.EmitEvent("stop", "esc");
            }
            return Native.CallNextHookEx(hook, nCode, wParam, lParam);
        }
    }
}
