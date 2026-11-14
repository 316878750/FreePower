// 本机打包用的 7za 包装器：给 7-Zip 的每条命令补一个 -snl-，让解包时**不恢复符号链接**。
//
// 这份源码入库只为「npm ci 把 node_modules 冲掉之后能重建」，它**不是产品代码**：
// 编译产物只放在 node_modules\7zip-bin\win\x64\ 里（7za.exe = 包装器，7za-real.exe = 原版），
// 不进 asar、不进安装包。重建命令见 README「本机打包姿势」。
//
// 为什么需要：electron-builder 的 winCodeSign 包里带 darwin 的 .dylib 符号链接，
// 7za 解它们需要「创建符号链接」特权（本机当前没有，也不该去改用户的系统设置），
// 于是 7za 退出码 2，打包中止。darwin 的链接文件在 Windows 打包里毫无用处，
// 跳过它们内容完全等价 —— 实测 `7za x -snl-` 退出码 0、windows-10/x64/signtool.exe 齐全。
using System;
using System.Diagnostics;
using System.Text;

class Fp7zaWrap
{
    static string Quote(string s)
    {
        if (s == null) return "\"\"";
        if (s.Length == 0) return "\"\"";
        bool need = false;
        foreach (char c in s) { if (c == ' ' || c == '\t' || c == '"') { need = true; break; } }
        if (!need) return s;
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string real = System.IO.Path.Combine(dir, "7za-real.exe");
        if (!System.IO.File.Exists(real)) real = System.IO.Path.Combine(dir, "7za-orig.exe");
        if (!System.IO.File.Exists(real))
        {
            Console.Error.WriteLine("7za wrapper: real binary not found next to wrapper");
            return 127;
        }
        StringBuilder cmd = new StringBuilder();
        foreach (string a in args) { if (cmd.Length > 0) cmd.Append(' '); cmd.Append(Quote(a)); }
        cmd.Append(" -snl-");
        try
        {
            using (Process p = Process.Start(new ProcessStartInfo(real, cmd.ToString())
            {
                UseShellExecute = false,
                WorkingDirectory = Environment.CurrentDirectory,
            }))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("7za wrapper failed: " + e.Message);
            return 127;
        }
    }
}
