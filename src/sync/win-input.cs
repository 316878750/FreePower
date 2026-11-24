// FreePower 窗口同步 · Win32 投递端（第 3 步）。
//
// 做什么：常驻进程，stdin 一行一条 JSON 指令，stdout 一行一条 JSON 回执。
// 把鼠标/键盘消息 PostMessage 给受控浏览器窗口 —— 和 AdsPower 一样「投给窗口，不投给标签」：
// 标签切换、关标签、新标签、iframe、焦点、可见性全由浏览器自己决定，我们不再需要找 target。
//
// 不装任何钩子（不 SetWindowsHookEx），只发消息；捕获端仍是页面 JS。
// 零依赖：用 Windows 自带的 .NET Framework csc.exe 现场编译（见 src/sync/win-input.js）。
//
// 指令：
//   {"op":"find","id":"p1","pid":1234}           → {"id":"p1","ok":true,"hwnd":..,"vw":..,"vh":..}
//   {"op":"mouse","hwnd":..,"t":"move|down|up","x":..,"y":..,"b":0,"btns":1,"m":0}
//   {"op":"wheel","hwnd":..,"x":..,"y":..,"dx":0,"dy":100,"m":0}
//   {"op":"key","hwnd":..,"down":true,"kc":66,"text":"b","m":0,"ext":false}
//   {"op":"char","hwnd":..,"s":"文本"}
// 坐标是「页面视口 CSS px」，这里按渲染区子窗口的位置与 DPI 换算成顶层窗口客户区物理像素。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

class FpWinInput
{
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

    const uint WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202,
        WM_RBUTTONDOWN = 0x204, WM_RBUTTONUP = 0x205, WM_MBUTTONDOWN = 0x207, WM_MBUTTONUP = 0x208,
        WM_MOUSEWHEEL = 0x20A, WM_MOUSEHWHEEL = 0x20E,
        WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_CHAR = 0x102, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
    const int MK_LBUTTON = 1, MK_RBUTTON = 2, MK_SHIFT = 4, MK_CONTROL = 8, MK_MBUTTON = 0x10;

    static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }

    /* 受控浏览器的主窗口：属于该 pid、类名 Chrome_WidgetWin_1、可见、无 owner（排除弹出菜单/气泡），取面积最大的 */
    static IntPtr FindTop(uint pid)
    {
        IntPtr best = IntPtr.Zero; long bestArea = 0;
        EnumWindows((h, l) =>
        {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != pid || !IsWindowVisible(h) || GetWindow(h, 4 /*GW_OWNER*/) != IntPtr.Zero) return true;
            if (Cls(h) != "Chrome_WidgetWin_1") return true;
            RECT r; GetClientRect(h, out r);
            long a = (long)(r.R - r.L) * (r.B - r.T);
            if (a > bestArea) { bestArea = a; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    /* 当前激活标签的渲染区（Legacy 子窗口，类名 Chrome_RenderWidgetHostHWND）：可见的那一个就是前台标签 */
    static IntPtr FindRender(IntPtr top)
    {
        IntPtr found = IntPtr.Zero; long bestArea = 0;
        EnumChildWindows(top, (h, l) =>
        {
            if (!IsWindowVisible(h) || Cls(h) != "Chrome_RenderWidgetHostHWND") return true;
            RECT r; GetClientRect(h, out r);
            long a = (long)(r.R - r.L) * (r.B - r.T);
            if (a > bestArea) { bestArea = a; found = h; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    class Geo { public int ox, oy, pw, ph; public double scale; }

    /* 渲染区在顶层客户区里的偏移 + 尺寸（物理像素）+ DPI 缩放 */
    /* 新版 Chrome 常常没有可见的 Chrome_RenderWidgetHostHWND（Aura 直接在顶层窗口收输入）。
       这时用 Node 侧从页面读的 chromeTop（= 窗口客户区顶到视口顶的 CSS px）兜底。 */
    static Geo GeoOf(IntPtr top, Dictionary<string, object> c)
    {
        var g = new Geo();
        double dpi = 96;
        try { dpi = GetDpiForWindow(top); if (dpi <= 0) dpi = 96; } catch { }
        g.scale = dpi / 96.0;
        IntPtr rw = FindRender(top);
        if (rw == IntPtr.Zero)
        {
            if (c == null || !c.ContainsKey("top") || !c.ContainsKey("vw")) return null;
            RECT tr; GetClientRect(top, out tr);
            g.ox = 0; g.oy = (int)Math.Round(D(c, "top") * g.scale);
            g.pw = Math.Min(tr.R - tr.L, (int)Math.Round(D(c, "vw") * g.scale));
            g.ph = Math.Min(tr.B - tr.T - g.oy, (int)Math.Round(D(c, "vh") * g.scale));
            return g;
        }
        RECT r; GetClientRect(rw, out r);
        var p = new POINT(); ClientToScreen(rw, ref p); ScreenToClient(top, ref p);
        g.ox = p.X; g.oy = p.Y; g.pw = r.R - r.L; g.ph = r.B - r.T;
        return g;
    }

    static IntPtr MakeL(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

    static int Mk(Dictionary<string, object> c, int btns)
    {
        int m = I(c, "m"), k = 0;
        if ((btns & 1) != 0) k |= MK_LBUTTON;
        if ((btns & 2) != 0) k |= MK_RBUTTON;
        if ((btns & 4) != 0) k |= MK_MBUTTON;
        if ((m & 8) != 0) k |= MK_SHIFT;
        if ((m & 2) != 0) k |= MK_CONTROL;
        return k;
    }

    static int I(Dictionary<string, object> c, string k) { object v; return c.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : 0; }
    static double D(Dictionary<string, object> c, string k) { object v; return c.TryGetValue(k, out v) && v != null ? Convert.ToDouble(v) : 0; }
    static bool B(Dictionary<string, object> c, string k) { object v; return c.TryGetValue(k, out v) && v is bool && (bool)v; }
    static string S(Dictionary<string, object> c, string k) { object v; return c.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }

    static Dictionary<string, object> Handle(Dictionary<string, object> c)
    {
        var res = new Dictionary<string, object>();
        string op = S(c, "op");
        if (c.ContainsKey("id")) res["id"] = c["id"];
        if (op == "ping") { res["ok"] = true; return res; }
        if (op == "find")
        {
            IntPtr top = FindTop((uint)I(c, "pid"));
            if (top == IntPtr.Zero) { res["ok"] = false; res["reason"] = "no_window"; return res; }
            var g = GeoOf(top, null);
            res["ok"] = true; res["hwnd"] = top.ToInt64();
            if (g != null) { res["vw"] = (int)Math.Round(g.pw / g.scale); res["vh"] = (int)Math.Round(g.ph / g.scale); res["scale"] = g.scale; }
            return res;
        }
        IntPtr hw = (IntPtr)Convert.ToInt64(c["hwnd"]);
        if (!IsWindow(hw)) { res["ok"] = false; res["reason"] = "window_gone"; return res; }
        if (IsIconic(hw)) { res["ok"] = false; res["reason"] = "window_minimized"; return res; }

        if (op == "mouse" || op == "wheel")
        {
            var g = GeoOf(hw, c);
            if (g == null) { res["ok"] = false; res["reason"] = "no_render_widget"; return res; }
            // 视口 CSS px → 物理像素；越界丢弃（R3，不 clamp）
            int px = (int)Math.Round(D(c, "x") * g.scale), py = (int)Math.Round(D(c, "y") * g.scale);
            if (px < 0 || py < 0 || px >= g.pw || py >= g.ph) { res["ok"] = false; res["reason"] = "out_of_view"; return res; }
            int cx = g.ox + px, cy = g.oy + py;
            if (op == "wheel")
            {
                // WM_MOUSEWHEEL 的坐标是屏幕坐标；Chrome deltaY=100 ≈ 一格 = 120，方向相反
                var sp = new POINT { X = cx, Y = cy }; ClientToScreen(hw, ref sp);
                double dy = D(c, "dy"), dx = D(c, "dx");
                int k = Mk(c, 0);
                if (dy != 0) { int d = (int)Math.Round(-dy / 100.0 * 120); PostMessage(hw, WM_MOUSEWHEEL, (IntPtr)((d << 16) | (k & 0xFFFF)), MakeL(sp.X, sp.Y)); }
                if (dx != 0) { int d = (int)Math.Round(dx / 100.0 * 120); PostMessage(hw, WM_MOUSEHWHEEL, (IntPtr)((d << 16) | (k & 0xFFFF)), MakeL(sp.X, sp.Y)); }
                res["ok"] = true; return res;
            }
            string t = S(c, "t"); int b = I(c, "b"); int btns = I(c, "btns");
            uint msg = WM_MOUSEMOVE;
            if (t == "down") msg = b == 2 ? WM_RBUTTONDOWN : b == 1 ? WM_MBUTTONDOWN : WM_LBUTTONDOWN;
            else if (t == "up") msg = b == 2 ? WM_RBUTTONUP : b == 1 ? WM_MBUTTONUP : WM_LBUTTONUP;
            // down 的 btns 已含本键；先发一条 move 到同点，hover 型菜单才认
            if (t == "down") PostMessage(hw, WM_MOUSEMOVE, (IntPtr)Mk(c, btns & ~(1 << (b == 2 ? 1 : b == 1 ? 2 : 0))), MakeL(cx, cy));
            PostMessage(hw, msg, (IntPtr)Mk(c, btns), MakeL(cx, cy));
            res["ok"] = true; return res;
        }
        if (op == "key")
        {
            uint vk = (uint)I(c, "kc"); bool down = B(c, "down");
            uint sc = MapVirtualKey(vk, 0);
            bool alt = (I(c, "m") & 1) != 0;
            long l = 1 | ((long)sc << 16);
            if (B(c, "ext")) l |= 1L << 24;
            if (alt) l |= 1L << 29;
            if (!down) l |= (1L << 30) | (1L << 31);
            uint msg = alt ? (down ? WM_SYSKEYDOWN : WM_SYSKEYUP) : (down ? WM_KEYDOWN : WM_KEYUP);
            PostMessage(hw, msg, (IntPtr)vk, (IntPtr)l);
            // 不补 WM_CHAR：Chrome 的消息循环对投递来的 WM_KEYDOWN 也会 TranslateMessage，
            // 字符由它自己产生（实测补了就变 "aabb"）。带 Shift 的字符由 Node 侧改走 CDP（见 toWinCommand）。
            res["ok"] = true; return res;
        }
        if (op == "char")
        {
            foreach (char ch in S(c, "s")) PostMessage(hw, WM_CHAR, (IntPtr)ch, (IntPtr)1);
            res["ok"] = true; return res;
        }
        res["ok"] = false; res["reason"] = "bad_op"; return res;
    }

    static int Main()
    {
        // 按 Per-Monitor-V2 读坐标，否则高 DPI 下 GetClientRect 拿到的是虚拟化后的值
        try { SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch { }
        var js = new JavaScriptSerializer();
        Console.InputEncoding = Encoding.UTF8; Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            Dictionary<string, object> res;
            try { res = Handle(js.Deserialize<Dictionary<string, object>>(line)); }
            catch (Exception e) { res = new Dictionary<string, object> { { "ok", false }, { "reason", "exception" }, { "error", e.Message } }; }
            Console.WriteLine(js.Serialize(res));
            Console.Out.Flush();
        }
        return 0;
    }
}
