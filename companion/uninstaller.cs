using System;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32;
using System.Windows.Forms;

class UvdUninstaller {
    static string BaseDir { get { return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'); } }
    static void Stop(string name) {
        foreach (var p in Process.GetProcessesByName(name)) {
            try { p.CloseMainWindow(); } catch {}
        }
        System.Threading.Thread.Sleep(300);
        foreach (var p in Process.GetProcessesByName(name)) {
            try { p.Kill(); } catch {}
            try { p.Dispose(); } catch {}
        }
    }
    static void Main() {
        try {
            var r = MessageBox.Show("UVD-Companion、Native Messaging登録、関連ログ・ジョブを削除します。続行しますか？", "Universal Video Detector", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (r != DialogResult.Yes) return;
            Stop("uvd_companion"); Stop("uvd_downloader_worker");
            try { using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Mozilla\NativeMessagingHosts\universal_video_detector_companion", true)) { if (key != null) Registry.CurrentUser.DeleteSubKeyTree(@"Software\Mozilla\NativeMessagingHosts\universal_video_detector_companion", false); } } catch {}
            string dir = BaseDir;
            string cmd = "ping 127.0.0.1 -n 2 >nul & rmdir /s /q " + Quote(dir);
            Process.Start(new ProcessStartInfo { FileName = "cmd.exe", Arguments = "/c " + cmd, UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(dir) });
            MessageBox.Show("UVD-Companionの削除を開始しました。", "Universal Video Detector", MessageBoxButtons.OK, MessageBoxIcon.Information);
        } catch (Exception ex) {
            MessageBox.Show(ex.Message, "Universal Video Detector", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
    static string Quote(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }
}
