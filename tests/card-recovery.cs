// Integration fixture: only manipulates its own scratch WinForms window.
using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using DshComputerUse;

internal static class CardRecoveryTest
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static byte originalAlpha;
    static uint originalKey, originalLayerFlags;
    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--helper")
            return (int)typeof(DshComputerUse.Native).Assembly.GetType("DshComputerUse.Program").GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { new string[0] });
        Form form = null;
        var ready = new ManualResetEvent(false);
        var ui = new Thread(delegate() {
            Native.SetProcessDPIAware();
            form = new Form { Text = "DSH card recovery test", Left = 100, Top = 100, Width = 800, Height = 600, StartPosition = FormStartPosition.Manual };
            form.Shown += delegate { ready.Set(); };
            Application.Run(form);
        });
        ui.SetApartmentState(ApartmentState.STA); ui.Start(); ready.WaitOne();
        Process helper = null;
        try
        {
            IntPtr hwnd = (IntPtr)form.Invoke(new Func<IntPtr>(delegate { return form.Handle; }));
            if (args.Length > 0 && args[0] == "--window") {
                Console.WriteLine(hwnd.ToInt64());
                while (Console.ReadLine() != null) Console.WriteLine(Json.Serialize(new { placement = Placement(hwnd), ex = Native.GetWindowLong(hwnd, -20) }));
                return 0;
            }
            for (int scenario = 0; scenario < 4; scenario++) {
            int setting = scenario;
            form.Invoke(new Action(delegate {
                form.WindowState = FormWindowState.Normal;
                form.TopMost = setting == 1;
                form.Opacity = setting == 2 ? 0.9 : 1;
                if (setting == 3) form.WindowState = FormWindowState.Maximized;
            }));
            var before = Placement(hwnd);
            int ex = Native.GetWindowLong(hwnd, -20);
            Native.GetLayeredWindowAttributes(hwnd, out originalKey, out originalAlpha, out originalLayerFlags);
            helper = Start();
            Call(helper, "window_card", hwnd);
            Check((Native.GetWindowLong(hwnd, -20) & 0x80000) != 0, "card becomes layered");
            using (var other = Start()) {
                Check(Native.GetWindowLong(hwnd, -20) != ex || Json.Serialize(Placement(hwnd)) != Json.Serialize(before), "live helper's card remains active");
                other.StandardInput.Close(); other.WaitForExit();
            }
            helper.Kill(); helper.WaitForExit(); helper.Dispose();
            helper = Start();
            AssertRestored(hwnd, before, ex, "startup recovery");
            Call(helper, "window_uncard", hwnd);
            AssertRestored(hwnd, before, ex, "replacement helper");
            Call(helper, "window_card", hwnd);
            // A second card update must not overwrite the original snapshot.
            Call(helper, "window_card", hwnd);
            helper.StandardInput.Close(); helper.WaitForExit();
            AssertRestored(hwnd, before, ex, "stdin EOF");
            helper.Dispose(); helper = null;
            }
            Console.WriteLine("PASS: card recovery after forced termination and graceful EOF");
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
        finally
        {
            if (helper != null) { if (!helper.HasExited) helper.Kill(); helper.Dispose(); }
            form.BeginInvoke(new Action(delegate { form.Close(); })); ui.Join();
        }
    }
    static Native.WINDOWPLACEMENT Placement(IntPtr hwnd)
    {
        var wp = new Native.WINDOWPLACEMENT(); wp.length = Marshal.SizeOf(wp);
        Native.GetWindowPlacement(hwnd, ref wp); return wp;
    }
    static void AssertRestored(IntPtr hwnd, Native.WINDOWPLACEMENT before, int ex, string label)
    {
        var after = Placement(hwnd);
        Check(Native.GetWindowLong(hwnd, -20) == ex, label + ": original opacity/layered/topmost styles restored");
        if ((ex & 0x80000) != 0 && originalLayerFlags != 0) {
            uint key, flags; byte alpha;
            Check(Native.GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags) && key == originalKey && flags == originalLayerFlags && alpha == originalAlpha, label + ": original layered alpha restored");
        }
        Check(Json.Serialize(after) == Json.Serialize(before), label + ": original placement restored");
    }
    static void Check(bool ok, string message) { if (!ok) throw new Exception("FAIL: " + message); }
    static Process Start()
    {
        var p = Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "--helper") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true
        });
        p.StandardOutput.ReadLine(); return p;
    }
    static void Call(Process p, string cmd, IntPtr hwnd)
    {
        p.StandardInput.WriteLine(Json.Serialize(new { id = 1, cmd = cmd, hwnd = hwnd.ToInt64(), x = 200, y = 200, width = 400, height = 300, opacity = 80 }));
        p.StandardInput.Flush();
        var reply = p.StandardOutput.ReadLine();
        Check(reply != null && reply.Contains("\"ok\":true"), "helper response: " + reply);
    }
}
