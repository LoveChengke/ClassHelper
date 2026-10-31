using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// 独立 WinExe：从 updates 目录运行，安装器覆盖应用时不会锁住安装目录。
// 只接收主进程生成的清单；不接受任意命令或安装参数。
internal static class UpdateHelper
{
    public sealed class Manifest
    {
        public string Attempt;
        public int ParentId;
        public string ParentExe;
        public string Installer;
        public string RestartExe;
        public string Version;
        public string ServerUrl;
        public string Username;
        public string Sha256;
        public long Size;
        public bool Portable;
    }

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Encoding Utf8 = new UTF8Encoding(false);
    private static string directory;
    private static string prefix;
    private static Manifest manifest;
    private static Process parent;
    private static bool installerRunning;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1) return 2;
            var file = Path.GetFullPath(args[0]);
            directory = Path.GetDirectoryName(file);
            if (!String.Equals(Path.GetFileName(directory), "updates", StringComparison.OrdinalIgnoreCase)) return 2;
            manifest = Json.Deserialize<Manifest>(File.ReadAllText(file, Utf8));
            if (manifest == null || !Regex.IsMatch(manifest.Attempt ?? "", "^[0-9a-f-]{36}$")) return 2;
            prefix = Path.Combine(directory, "install-" + manifest.Attempt);
            if (!SamePath(file, prefix + ".json")) return 2;
            Log("助手启动，目标版本 " + manifest.Version);
            parent = Process.GetProcessById(manifest.ParentId);
            if (!SamePath(parent.MainModule.FileName, manifest.ParentExe)) throw new Exception("旧进程身份不匹配");
            var installer = Path.GetFullPath(manifest.Installer);
            if (!SamePath(Path.GetDirectoryName(installer), directory) ||
                !String.Equals(Path.GetExtension(installer), ".exe", StringComparison.OrdinalIgnoreCase) ||
                (File.GetAttributes(installer) & FileAttributes.ReparsePoint) != 0)
                throw new Exception("安装包不在受管理目录内");
            if (!Regex.IsMatch(manifest.Sha256 ?? "", "^[0-9a-fA-F]{64}$")) throw new Exception("缺少有效安装包摘要");
            if (manifest.Size <= 0 || new FileInfo(installer).Length != manifest.Size) throw new Exception("安装包长度不匹配");
            using (var stream = File.OpenRead(installer))
            using (var hash = SHA256.Create())
            {
                var actual = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "");
                if (!String.Equals(actual, manifest.Sha256, StringComparison.OrdinalIgnoreCase)) throw new Exception("安装包 SHA256 校验失败");
            }
            File.WriteAllText(prefix + ".ready", manifest.Attempt, Utf8);
            Log("校验通过，等待主进程确认交接");
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (!File.Exists(prefix + ".start"))
            {
                if (File.Exists(prefix + ".cancel")) { Log("主进程取消交接"); return 0; }
                if (parent.HasExited) throw new Exception("主进程在确认交接前退出");
                if (DateTime.UtcNow >= deadline) throw new Exception("等待主进程确认超时");
                Thread.Sleep(50);
            }
            if (File.ReadAllText(prefix + ".start", Utf8) != manifest.Attempt) throw new Exception("交接标识不匹配");
            if (!parent.WaitForExit(60000)) throw new Exception("等待旧客户端退出超时");
            Log("旧进程已退出，开始安装");
            int exitCode;
            using (var installerProcess = Process.Start(new ProcessStartInfo(installer, "/S --updated --force-run")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = directory
            }))
            {
                if (installerProcess == null) throw new Exception("安装器未能启动");
                installerRunning = true;
                if (!installerProcess.WaitForExit(10 * 60 * 1000)) throw new Exception("安装器执行超时，请查看安装日志");
                installerRunning = false;
                exitCode = installerProcess.ExitCode;
            }
            Log("安装器退出码：" + exitCode);
            if (exitCode != 0) throw new Exception("安装器退出码：" + exitCode);
            if (!manifest.Portable)
            {
                var expected = ParseVersion(manifest.Version);
                var actual = ParseVersion(FileVersionInfo.GetVersionInfo(manifest.RestartExe).ProductVersion);
                if (actual.CompareTo(expected) < 0) throw new Exception("安装器结束后客户端版本仍未更新");
                // 安装器通常会启动新版；未启动时补启一次，避免留在“安装中”。
                var startedAt = DateTime.UtcNow;
                while (!IsClientRunning(manifest.RestartExe) && DateTime.UtcNow - startedAt < TimeSpan.FromSeconds(3)) Thread.Sleep(100);
                if (!IsClientRunning(manifest.RestartExe)) RestartClient();
            }
            Result("installed", "", exitCode);
            Log("安装交接完成，等待新版客户端心跳确认");
            return 0;
        }
        catch (Exception error)
        {
            try { Log("更新失败：" + error.Message); Result("failed", error.Message, null); } catch { }
            // 超时的安装器可能仍在替换文件，不可在它退出之前重新打开客户端。
            try { if (!installerRunning && parent != null && parent.HasExited && manifest != null && File.Exists(manifest.RestartExe) && !IsClientRunning(manifest.RestartExe)) RestartClient(); }
            catch (Exception restoreError) { try { Log("恢复客户端失败：" + restoreError.Message); } catch { } }
            return 1;
        }
        finally
        {
            if (prefix != null) foreach (var suffix in new[] { ".ready", ".start", ".cancel", ".json" })
                try { File.Delete(prefix + suffix); } catch { }
            if (parent != null) parent.Dispose();
        }
    }

    private static bool SamePath(string a, string b)
    {
        return String.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    }

    private static Version ParseVersion(string value)
    {
        Version version;
        if (!Version.TryParse((value ?? "").Trim().TrimStart('v', 'V').Split('-', '+')[0], out version)) throw new Exception("无法识别客户端版本：" + value);
        return version;
    }

    private static bool IsClientRunning(string exe)
    {
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(exe)))
        {
            using (process) try { if (!process.HasExited && SamePath(process.MainModule.FileName, exe)) return true; } catch { }
        }
        return false;
    }

    private static void RestartClient()
    {
        Process.Start(new ProcessStartInfo(manifest.RestartExe, "--hidden")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(manifest.RestartExe)
        });
        Log("已启动客户端");
    }

    private static void Log(string message)
    {
        if (directory != null) File.AppendAllText(Path.Combine(directory, "install-helper.log"), DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, Utf8);
    }

    private static void Result(string stage, string error, int? exitCode)
    {
        if (manifest == null || prefix == null) return;
        var value = new { version = manifest.Version, serverUrl = manifest.ServerUrl, username = manifest.Username, attempt = manifest.Attempt, stage = stage, error = error, installerExitCode = exitCode, at = DateTime.UtcNow.ToString("o") };
        var target = Path.Combine(directory, "install-result.json");
        var temp = prefix + ".result";
        File.WriteAllText(temp, Json.Serialize(value), Utf8);
        if (File.Exists(target)) File.Delete(target);
        File.Move(temp, target);
    }
}
