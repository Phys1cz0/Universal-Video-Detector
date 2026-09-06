using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Diagnostics;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Linq;
using System.Runtime.InteropServices;

public class Request {
    public string action { get; set; }
    public string rootDirectory { get; set; }
    public string ffmpegPath { get; set; }
    public int parallelDownloads { get; set; }
    public string duplicateFileMode { get; set; }
    public string path { get; set; }
    public string folderNaming { get; set; }
    public List<Item> items { get; set; }
    public List<string> paths { get; set; }
    public List<string> jobIds { get; set; }
    public Site site { get; set; }
    public string extensionVersion { get; set; }
    public string coAppVersion { get; set; }
    public string batchId { get; set; }
    public string jobId { get; set; }
    public string itemId { get; set; }
    public string mediaUrl { get; set; }
    public string identityUrl { get; set; }
    public string companionSource { get; set; }
    public string uninstallerSource { get; set; }
}
public class Item {
    public object id { get; set; }
    public string itemId { get; set; }
    public string mediaUrl { get; set; }
    public string identityUrl { get; set; }
    public string url { get; set; } // legacy input compatibility only
    public string name { get; set; }
    public string filename { get; set; }
    public string type { get; set; }
    public string downloadFolderName { get; set; }
    public string pageUrl { get; set; }
    public string referer { get; set; }
    public string userAgent { get; set; }
    public string cookie { get; set; }
    public Dictionary<string, object> headers { get; set; }
    public double duration { get; set; }
    public object fileSize { get; set; }
    public string thumbnail { get; set; }
    public string landingPage { get; set; }
    public string pageTitle { get; set; }
    // Optional page-level identity evidence collected once by the UI/content layer.
    // CoApp is the sole authority that compares it and assigns/reuses folders.
    public Dictionary<string,string> pageIdentity { get; set; }
    public Dictionary<string,string> videoIdentity { get; set; }
}
public class Site { public string host { get; set; } public string origin { get; set; } public string title { get; set; } }
public class Job {
    public string id { get; set; }
    public string itemId { get; set; }
    public string mediaUrl { get; set; }
    public string identityUrl { get; set; }
    public string name { get; set; }
    public string type { get; set; }
    public string status { get; set; }
    public int progress { get; set; }
    public string path { get; set; }
    public string folder { get; set; }
    public string error { get; set; }
    public string ffmpegPath { get; set; }
    public int processId { get; set; }
    public int coordinatorProcessId { get; set; }
    public long createdAt { get; set; }
    public long updatedAt { get; set; }
    public long completedAt { get; set; }
    public string batchId { get; set; }
    public string recoveryReason { get; set; }
    // Optional identity evidence persisted by CoApp so a completed/missing job
    // can be found again without relying on the current media URL alone.
    public Dictionary<string,string> pageIdentity { get; set; }
    public Dictionary<string,string> videoIdentity { get; set; }
    public string itemDataPath { get; set; }
    public string logPath { get; set; }
}

public static class NativeProtocol {
    public const int MaxMessageBytes = 1024 * 1024;
    public static byte[] ReadMessage(Stream input) {
        byte[] header = ReadExactly(input, 4); if (header == null) return null;
        uint length = BitConverter.ToUInt32(header, 0);
        if (length > MaxMessageBytes) throw new InvalidDataException("Native message exceeds 1 MB.");
        return ReadExactly(input, checked((int)length));
    }
    public static void WriteMessage(Stream output, byte[] body) {
        if (body.Length > MaxMessageBytes) throw new InvalidDataException("Native response exceeds 1 MB.");
        byte[] header = BitConverter.GetBytes((uint)body.Length);
        output.Write(header, 0, 4); output.Write(body, 0, body.Length); output.Flush();
    }
    static byte[] ReadExactly(Stream input, int count) {
        byte[] result = new byte[count]; int offset = 0;
        while (offset < count) { int n = input.Read(result, offset, count - offset); if (n <= 0) return null; offset += n; }
        return result;
    }
}

public class Program {
    static Program() { try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; } catch {} }
    const string Version = "0.6.18";
    static readonly string BaseDir = AppDomain.CurrentDomain.BaseDirectory;
    static readonly string JobsDir = Path.Combine(BaseDir, "jobs");
    static readonly string WorkerExe = Path.Combine(BaseDir, "uvd_downloader_worker.exe");
    static string WorkerProgressPath(string id) { return Path.Combine(JobsDir, id + ".worker-progress.json"); }
    static void WritePlaybackLog(string jobId,string message) {
        try {
            Directory.CreateDirectory(JobsDir);
            string name=String.IsNullOrWhiteSpace(jobId)?"playback":jobId;
            File.AppendAllText(Path.Combine(JobsDir,name+".log"),Now()+" PLAYBACK "+message+Environment.NewLine,Encoding.UTF8);
        } catch {}
    }
    static void MonitorDetachedPlaybackPid(string jobId,int processId,string expectedName,string expectedExecutable,int maxPolls=32,int intervalMs=250) {
        if(processId<=0) return;
        WritePlaybackLog(jobId,"DETACHED_MONITOR_START pid="+processId+" maxPolls="+maxPolls+" intervalMs="+intervalMs);
        try {
            for(int i=0;i<maxPolls;i++) {
                Thread.Sleep(intervalMs);
                try {
                    using(Process observed=Process.GetProcessById(processId)) {
                        observed.Refresh();
                        string name=observed.ProcessName??"";
                        string executable="";
                        try { executable=observed.MainModule==null?"":(observed.MainModule.FileName??""); } catch {}
                        if(!String.IsNullOrWhiteSpace(expectedName) && !String.Equals(name,expectedName,StringComparison.OrdinalIgnoreCase)) {
                            WritePlaybackLog(jobId,"DETACHED_PID_REUSED pid="+processId+" expectedName="+expectedName+" actualName="+name);
                            return;
                        }
                        if(!String.IsNullOrWhiteSpace(expectedExecutable) && !String.IsNullOrWhiteSpace(executable) && !String.Equals(executable,expectedExecutable,StringComparison.OrdinalIgnoreCase)) {
                            WritePlaybackLog(jobId,"DETACHED_PID_REUSED pid="+processId+" expectedExe="+expectedExecutable+" actualExe="+executable);
                            return;
                        }
                        if(observed.HasExited) {
                            string code="unknown";
                            try { code=observed.ExitCode.ToString(); } catch {}
                            WritePlaybackLog(jobId,"DETACHED_EXIT pid="+processId+" code="+code+" name="+name+" exe="+executable);
                            return;
                        }
                        if(i==0 || i==5 || i==10 || i==15 || i==19 || i==23 || i==27) {
                            string state=observed.MainWindowHandle!=IntPtr.Zero?"alive_with_window":"alive";
                            WritePlaybackLog(jobId,"DETACHED_POLL pid="+processId+" state="+state+" name="+name+" exe="+executable);
                        }
                    }
                } catch(ArgumentException) {
                    WritePlaybackLog(jobId,"DETACHED_EXIT pid="+processId+" code=unknown name="+expectedName+" exe="+expectedExecutable);
                    return;
                } catch(Exception ex) {
                    WritePlaybackLog(jobId,"DETACHED_POLL_ERROR pid="+processId+" error="+ex.GetType().Name+": "+ex.Message);
                    return;
                }
            }
            WritePlaybackLog(jobId,"DETACHED_MONITOR_END pid="+processId+" state=still_alive");
        } catch(Exception ex) {
            WritePlaybackLog(jobId,"DETACHED_MONITOR_ERROR pid="+processId+" error="+ex.GetType().Name+": "+ex.Message);
        }
    }
    static string WorkerResultPath(string id) { return Path.Combine(JobsDir, id + ".worker-result.json"); }
    static readonly string BundledFfmpeg = Path.Combine(BaseDir, "ffmpeg.exe");
    static string MediaUrl(Item i) { if (i == null) return ""; return String.IsNullOrWhiteSpace(i.mediaUrl) ? (i.url ?? "") : i.mediaUrl; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
        public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool IsProcessInJob(IntPtr processHandle, IntPtr jobHandle, out bool result);
    static string JobMembership(Process process){
        if(process==null)return "unknown";
        try{bool inJob;if(IsProcessInJob(process.Handle,IntPtr.Zero,out inJob))return inJob?"true":"false";return "error:"+Marshal.GetLastWin32Error();}
        catch(Exception ex){return "error:"+ex.GetType().Name;}
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr hObject);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr ShellExecuteW(IntPtr hwnd, string lpOperation, string lpFile, string lpParameters, string lpDirectory, int nShowCmd);
    static bool IsUncPath(string path){
        return !String.IsNullOrWhiteSpace(path) && (path.StartsWith("\\\\",StringComparison.Ordinal) || path.StartsWith("//",StringComparison.Ordinal));
    }
    static string ValidateAndNormalizePlaybackPath(string rawPath, out string pathKind){
        pathKind="";
        string raw=(rawPath??"").Trim().Trim('"');
        if(String.IsNullOrWhiteSpace(raw))throw new ArgumentException("Job.path が空です。", "Job.path");
        foreach(char c in raw){
            if(c=='\0' || Char.IsControl(c))throw new ArgumentException("Job.path に制御文字が含まれています。", "Job.path");
            if(c=='"')throw new ArgumentException("Job.path にダブルクォーテーションを使用できません。", "Job.path");
        }
        // Job.path is a Windows filesystem path, not a URI. Keep drive-letter paths
        // (C:\...) and UNC paths (\\server\share\...) valid, while rejecting
        // URI schemes such as http:, file:, ftp:, javascript:, and data:.
        bool drivePath=raw.Length>=3 && Char.IsLetter(raw[0]) && raw[1]==':' && (raw[2]=='\\' || raw[2]=='/');
        bool uncPath=IsUncPath(raw);
        if(!drivePath && !uncPath) {
            int colon=raw.IndexOf(':');
            int slash=raw.IndexOfAny(new[]{'\\','/'});
            if(colon>=0 && (slash<0 || colon<slash))throw new ArgumentException("Job.path に許可されていないURIスキームが含まれています。", "Job.path");
            throw new ArgumentException("Job.path は絶対WindowsファイルパスまたはUNCパスで指定してください。", "Job.path");
        }
        string full;
        try{full=Path.GetFullPath(raw);}catch(Exception ex){throw new ArgumentException("Job.path を正規化できません。",ex);}
        if(full.IndexOf('"')>=0 || full.IndexOf('\0')>=0)throw new ArgumentException("正規化後のJob.pathが不正です。", "Job.path");
        pathKind=IsUncPath(full)?"unc":"local";
        return full;
    }
    static IntPtr BuildPlaybackEnvironment(string targetPath, out string environmentVariable){
        environmentVariable="UVD_PLAY_TARGET="+targetPath;
        var vars=Environment.GetEnvironmentVariables();
        var sb=new StringBuilder();
        foreach(System.Collections.DictionaryEntry e in vars){
            string k=Convert.ToString(e.Key)??"";
            string v=Convert.ToString(e.Value)??"";
            if(String.Equals(k,"UVD_PLAY_TARGET",StringComparison.OrdinalIgnoreCase))continue;
            sb.Append(k).Append('=').Append(v).Append('\0');
        }
        sb.Append(environmentVariable).Append('\0').Append('\0');
        return Marshal.StringToHGlobalUni(sb.ToString());
    }
    static int StartFileViaCmdBreakaway(string filePath, out string launcherPath, out int launcherPid, out string launcherState, out uint? launcherExitCode, out string launcherInJob, out string error) {
        launcherPath=Path.Combine(Environment.SystemDirectory, "cmd.exe");
        launcherPid=0; launcherState=""; launcherExitCode=null; launcherInJob="unknown"; error="";
        if(!File.Exists(launcherPath)){error="cmd.exe was not found: "+launcherPath;return -1;}
        IntPtr envBlock=IntPtr.Zero;
        try {
            var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags=1; si.wShowWindow=0;
            PROCESS_INFORMATION pi;
            // Keep Shell association handling in `start`, but do not interpolate
            // Job.path directly into the cmd command. The exact path is passed via
            // a dedicated environment variable; this prevents '%' in a legitimate
            // filename from being re-expanded as an environment variable. Quoting
            // the expansion keeps shell metacharacters in the path inside the argument.
            string envName;
            envBlock=BuildPlaybackEnvironment(filePath,out envName);
            string cmdLine=Q(launcherPath)+" /d /v:off /c start \"\" \"%UVD_PLAY_TARGET%\"";
            uint flags=CREATE_BREAKAWAY_FROM_JOB|CREATE_NEW_PROCESS_GROUP|CREATE_NO_WINDOW|CREATE_UNICODE_ENVIRONMENT;
            if(!CreateProcess(launcherPath,new StringBuilder(cmdLine),IntPtr.Zero,IntPtr.Zero,false,flags,envBlock,Path.GetDirectoryName(filePath)??BaseDir,ref si,out pi)) {
                error="CreateProcess(cmd.exe breakaway) failed Win32="+Marshal.GetLastWin32Error();
                return -1;
            }
            launcherPid=pi.dwProcessId;
            try {using(Process launcher=Process.GetProcessById(launcherPid)){launcherInJob=JobMembership(launcher);}} catch {}
            CloseHandle(pi.hThread);
            uint wait=WaitForSingleObject(pi.hProcess,1200);
            if(wait==0) {
                uint code;if(GetExitCodeProcess(pi.hProcess,out code))launcherExitCode=code;
                launcherState=(launcherExitCode.HasValue&&launcherExitCode.Value==0)?"exited_ok":"exited_error";
                if(launcherExitCode.HasValue&&launcherExitCode.Value!=0){error="cmd.exe /c start returned exit code "+launcherExitCode.Value;CloseHandle(pi.hProcess);return -1;}
                CloseHandle(pi.hProcess);return launcherPid;
            }
            if(wait==0x00000102){launcherState="still_running_after_1200ms";CloseHandle(pi.hProcess);return launcherPid;}
            error="WaitForSingleObject failed Win32="+Marshal.GetLastWin32Error();CloseHandle(pi.hProcess);return -1;
        } catch(Exception ex){error="cmd.exe breakaway exception="+ex.GetType().Name+": "+ex.Message;return -1;}
        finally{if(envBlock!=IntPtr.Zero)try{Marshal.FreeHGlobal(envBlock);}catch{}}
    }
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    const int SW_RESTORE=9;
    const uint CREATE_BREAKAWAY_FROM_JOB=0x01000000, CREATE_NEW_PROCESS_GROUP=0x00000200, CREATE_NO_WINDOW=0x08000000, CREATE_UNICODE_ENVIRONMENT=0x00000400, DETACHED_PROCESS=0x00000008;

    static int StartWorkerDetached(string exe,string args,out string launchDetail) {
        launchDetail="";
        try {
            var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO));
            PROCESS_INFORMATION pi;
            var cmd=new StringBuilder(Q(exe)+" "+args);
            uint flags=CREATE_BREAKAWAY_FROM_JOB|CREATE_NEW_PROCESS_GROUP|DETACHED_PROCESS;
            if(CreateProcess(null,cmd,IntPtr.Zero,IntPtr.Zero,false,flags,IntPtr.Zero,BaseDir,ref si,out pi)) {
                int pid=pi.dwProcessId; CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
                launchDetail="CreateProcess breakaway pid="+pid;
                return pid;
            }
            launchDetail="CreateProcess failed Win32="+Marshal.GetLastWin32Error();
        } catch(Exception ex) { launchDetail="CreateProcess exception="+ex.GetType().Name+": "+ex.Message; }
        try {
            var psi=new ProcessStartInfo { FileName=exe, Arguments=args, UseShellExecute=true, WorkingDirectory=BaseDir, WindowStyle=ProcessWindowStyle.Hidden };
            var p=Process.Start(psi);
            if(p!=null) { launchDetail += "; ShellExecute pid="+p.Id; return p.Id; }
        } catch(Exception ex) { launchDetail += "; ShellExecute exception="+ex.GetType().Name+": "+ex.Message; }
        return -1;
    }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly object OutputGate = new object();
    static string StartedExtensionId = "";

    static void Log(string s) { try { Console.Error.WriteLine("[UVD-COAPP] " + s); Console.Error.Flush(); } catch {} }
    static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds; }
    static long MonotonicMilliseconds() { return (long)(Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency); }
    static void Send(object value) { string s = Json.Serialize(value); byte[] b = new UTF8Encoding(false).GetBytes(s); lock(OutputGate) NativeProtocol.WriteMessage(Console.OpenStandardOutput(), b); }
    static string Safe(string s, string fallback) {
        if (String.IsNullOrWhiteSpace(s)) return fallback;
        foreach (char c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
        s = s.Trim().TrimEnd('.'); return String.IsNullOrWhiteSpace(s) ? fallback : s;
    }
    static string ResolveFfmpeg(string requested) {
        if (!String.IsNullOrWhiteSpace(requested)) {
            string q=Path.GetFullPath(requested.Trim().Trim('"'));
            if(File.Exists(q)) return q;
        }
        if(File.Exists(BundledFfmpeg)) return BundledFfmpeg;
        try {
            string pathEnv=Environment.GetEnvironmentVariable("PATH")??"";
            foreach(string dir in pathEnv.Split(Path.PathSeparator)) {
                if(String.IsNullOrWhiteSpace(dir)) continue;
                string candidate=Path.Combine(dir.Trim().Trim('"'),"ffmpeg.exe");
                if(File.Exists(candidate)) return candidate;
            }
        } catch {}
        return "";
    }
    static string Unique(string p) {
        if (!File.Exists(p)) return p;
        string d = Path.GetDirectoryName(p), n = Path.GetFileNameWithoutExtension(p), e = Path.GetExtension(p);
        for (int i=1;i<100000;i++) { string q=Path.Combine(d,n+" ("+i+")"+e); if(!File.Exists(q)) return q; }
        throw new IOException("Too many duplicate files");
    }
    static string JobPath(string id) { return Path.Combine(JobsDir, id + ".json"); }
    static readonly object JobFileGate = new object();
    static readonly string JobMutexName = "Global\\UniversalVideoDetector.JobFiles.0.6.18";
    static readonly string StorePath = Path.Combine(BaseDir, "uvd_store.json");
    static readonly string StoreMutexName = "Global\\UniversalVideoDetector.StateStore.0.6.18";
    static Dictionary<string,object> LoadStoreRawUnlocked() {
        if(!File.Exists(StorePath)) return new Dictionary<string,object>();
        Exception last=null;
        for(int attempt=0;attempt<20;attempt++) {
            try {
                using(var fs=new FileStream(StorePath,FileMode.Open,FileAccess.Read,FileShare.Read))
                using(var sr=new StreamReader(fs,new UTF8Encoding(false),true)) {
                    string raw=sr.ReadToEnd();
                    if(String.IsNullOrWhiteSpace(raw)) return new Dictionary<string,object>();
                    return Json.Deserialize<Dictionary<string,object>>(raw) ?? new Dictionary<string,object>();
                }
            } catch(Exception ex) {
                last=ex;
                if(attempt<19) System.Threading.Thread.Sleep(50);
            }
        }
        throw new IOException("Unable to read state store after retrying: "+StorePath,last);
    }
    static Dictionary<string,object> LoadStoreRaw() {
        using(var mutex=new Mutex(false,StoreMutexName)) {
            mutex.WaitOne();
            try { return LoadStoreRawUnlocked(); }
            finally { mutex.ReleaseMutex(); }
        }
    }
    static long ReadRevisionUnlocked() {
        var o=LoadStoreRawUnlocked();
        object value;
        if(o.TryGetValue("stateRevision",out value) && value!=null) return Convert.ToInt64(value);
        return 0;
    }
    static long ReadRevision() {
        using(var mutex=new Mutex(false,StoreMutexName)) {
            mutex.WaitOne();
            try { return ReadRevisionUnlocked(); }
            finally { mutex.ReleaseMutex(); }
        }
    }
    static Dictionary<string,Job> ReadStoredJobsUnlocked() {
        var result=new Dictionary<string,Job>(StringComparer.OrdinalIgnoreCase);
        var root=LoadStoreRawUnlocked();
        object rawJobs=null;
        if(root.TryGetValue("jobs",out rawJobs) && rawJobs is Dictionary<string,object>) {
            foreach(var kv in (Dictionary<string,object>)rawJobs) {
                try {
                    object rawJob=kv.Value;
                    var rawMap=rawJob as Dictionary<string,object>;
                    if(rawMap!=null && (!rawMap.ContainsKey("mediaUrl") || rawMap["mediaUrl"]==null || String.IsNullOrWhiteSpace(Convert.ToString(rawMap["mediaUrl"]))) && rawMap.ContainsKey("url")) rawMap["mediaUrl"]=Convert.ToString(rawMap["url"]);
                    var j=Json.ConvertToType<Job>(rawJob);
                    if(j!=null&&!String.IsNullOrWhiteSpace(j.id)) result[j.id]=j;
                } catch {}
            }
        }
        return result;
    }
    static Dictionary<string,Job> ReadStoredJobs() {
        using(var mutex=new Mutex(false,StoreMutexName)) {
            mutex.WaitOne();
            try { return ReadStoredJobsUnlocked(); }
            finally { mutex.ReleaseMutex(); }
        }
    }
    static void WriteStore(Dictionary<string,Job> jobs,long revision) {
        Directory.CreateDirectory(BaseDir);
        var jobObjects=new Dictionary<string,object>(StringComparer.OrdinalIgnoreCase);
        foreach(var kv in jobs) jobObjects[kv.Key]=kv.Value;
        var root=new Dictionary<string,object>{{"stateRevision",revision},{"updatedAt",Now()},{"jobs",jobObjects}};
        string tmp=StorePath+"."+Process.GetCurrentProcess().Id+".tmp";
        string data=Json.Serialize(root);
        using(var fs=new FileStream(tmp,FileMode.Create,FileAccess.Write,FileShare.None)) {
            byte[] b=new UTF8Encoding(false).GetBytes(data); fs.Write(b,0,b.Length); fs.Flush(true);
        }
        Exception last=null;
        for(int attempt=0;attempt<20;attempt++) {
            try {
                if(File.Exists(StorePath)) {
                    try { File.Replace(tmp,StorePath,null); }
                    catch { File.Copy(tmp,StorePath,true); File.Delete(tmp); }
                } else File.Move(tmp,StorePath);
                return;
            } catch(Exception ex) {
                last=ex;
                if(attempt<19) System.Threading.Thread.Sleep(50);
            }
        }
        try { if(File.Exists(tmp)) File.Delete(tmp); } catch {}
        throw new IOException("Unable to write state store after retrying: "+StorePath,last);
    }
    static long SaveStateJob(Job j) {
        using(var mutex=new Mutex(false,StoreMutexName)) {
            mutex.WaitOne();
            try {
                var jobs=ReadStoredJobsUnlocked();
                jobs[j.id]=j;
                long rev=ReadRevisionUnlocked()+1;
                WriteStore(jobs,rev);
                return rev;
            } finally { mutex.ReleaseMutex(); }
        }
    }
    static long RemoveStateJobs(IEnumerable<string> ids) {
        using(var mutex=new Mutex(false,StoreMutexName)) {
            mutex.WaitOne();
            try {
                var jobs=ReadStoredJobsUnlocked();
                bool changed=false;
                foreach(string id in ids??new List<string>()) if(!String.IsNullOrWhiteSpace(id)&&jobs.Remove(id)) changed=true;
                if(!changed) return ReadRevisionUnlocked();
                long rev=ReadRevisionUnlocked()+1; WriteStore(jobs,rev); return rev;
            } finally { mutex.ReleaseMutex(); }
        }
    }
    static void SaveJob(Job j) {
        Directory.CreateDirectory(JobsDir);
        j.updatedAt=Now();
        string finalPath=JobPath(j.id), tmp=finalPath+"."+Process.GetCurrentProcess().Id+".tmp";
        string data=Json.Serialize(j);
        lock(JobFileGate) using(var mutex=new Mutex(false,JobMutexName)) {
            mutex.WaitOne();
            try {
                using(var fs=new FileStream(tmp,FileMode.Create,FileAccess.Write,FileShare.None)) {
                    byte[] b=new UTF8Encoding(false).GetBytes(data); fs.Write(b,0,b.Length); fs.Flush(true);
                }
                if(File.Exists(finalPath)) { try { File.Replace(tmp,finalPath,null); } catch { File.Copy(tmp,finalPath,true); File.Delete(tmp); } }
                else File.Move(tmp,finalPath);
            } finally { mutex.ReleaseMutex(); }
        }
        SaveStateJob(j);
    }
    static Job LoadJob(string path) {
        string id=Path.GetFileNameWithoutExtension(path??"");
        if(!String.IsNullOrWhiteSpace(id)) {
            var stored=ReadStoredJobs();
            Job sj; if(stored.TryGetValue(id,out sj)&&sj!=null) return sj;
        }
        Exception last=null;
        for(int attempt=0;attempt<30;attempt++){
            try {
                if(!File.Exists(path)) throw new FileNotFoundException("Job file not found.",path);
                string raw;
                using(var mutex=new Mutex(false,JobMutexName)) {
                    mutex.WaitOne();
                    try { using(var fs=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) using(var sr=new StreamReader(fs,Encoding.UTF8,true)){ raw=sr.ReadToEnd(); } }
                    finally { mutex.ReleaseMutex(); }
                }
                if(String.IsNullOrWhiteSpace(raw)) throw new Exception("Job file is empty.");
                Job j=Json.Deserialize<Job>(raw); if(j==null) throw new Exception("Job JSON is invalid.");
                return j;
            } catch(Exception ex){ last=ex; Thread.Sleep(100); }
        }
        try{File.AppendAllText(Path.Combine(JobsDir,"worker.log"),Now()+" LOADJOB_FAILED path="+path+" error="+(last==null?"unknown":last.ToString())+Environment.NewLine,Encoding.UTF8);}catch{}
        return null;
    }
    static List<Job> LoadJobs() {
        var merged=ReadStoredJobs();
        Directory.CreateDirectory(JobsDir);
        foreach(string p in Directory.GetFiles(JobsDir,"*.json")) {
            string id=Path.GetFileNameWithoutExtension(p);
            if(String.IsNullOrWhiteSpace(id)||merged.ContainsKey(id)) continue;
            try {
                Job j=LoadJobFromFile(p);
                if(j!=null&&!String.IsNullOrWhiteSpace(j.id)) merged[j.id]=j;
            } catch {}
        }
        return merged.Values.OrderByDescending(x=>x.createdAt).ToList();
    }
    static Job LoadJobFromFile(string path) {
        if(!File.Exists(path)) return null;
        using(var mutex=new Mutex(false,JobMutexName)) {
            mutex.WaitOne();
            try {
                string raw=File.ReadAllText(path,Encoding.UTF8);
                if(String.IsNullOrWhiteSpace(raw)) return null;
                return Json.Deserialize<Job>(raw);
            } finally { mutex.ReleaseMutex(); }
        }
    }
    static void UpdateJob(Job j,string status,int progress,string path,string folder,string error) {
        j.status=status; j.progress=Math.Max(0,Math.Min(100,progress)); if(status=="completed"||status=="exist")j.completedAt=Now(); if(path!=null)j.path=path; if(folder!=null)j.folder=folder; if(error!=null)j.error=error; SaveJob(j);
    }
    static string FindFfmpeg(string explicitPath) {
        // 1) Explicitly configured path. Resolve both a full path and a relative path.
        if(!String.IsNullOrWhiteSpace(explicitPath)) {
            string p=explicitPath.Trim().Trim('"');
            try {
                if(File.Exists(p)) return Path.GetFullPath(p);
                if(!Path.IsPathRooted(p)) {
                    string rel=Path.GetFullPath(Path.Combine(BaseDir,p));
                    if(File.Exists(rel)) return rel;
                }
            } catch {}
        }

        // 2) ffmpeg.exe beside the companion.
        string local=Path.Combine(BaseDir,"ffmpeg.exe");
        if(File.Exists(local)) return local;

        // 3) Search the actual Windows PATH. File.Exists("ffmpeg.exe") does NOT
        // reliably mean "is executable available on PATH", so resolve it explicitly.
        string pathEnv=Environment.GetEnvironmentVariable("PATH")??"";
        foreach(string dir in pathEnv.Split(new[]{Path.PathSeparator},StringSplitOptions.RemoveEmptyEntries)) {
            try {
                string candidate=Path.Combine(dir.Trim().Trim('"'),"ffmpeg.exe");
                if(File.Exists(candidate)) return candidate;
            } catch {}
        }

        // 4) Ask Windows command resolution as a final PATH check.
        try {
            var psi=new ProcessStartInfo {
                FileName="where.exe",
                Arguments="ffmpeg.exe",
                UseShellExecute=false,
                CreateNoWindow=true,
                RedirectStandardOutput=true,
                RedirectStandardError=true
            };
            using(var p=Process.Start(psi)) {
                if(p!=null) {
                    string output=p.StandardOutput.ReadToEnd();
                    p.WaitForExit(5000);
                    if(p.ExitCode==0) {
                        foreach(string line in output.Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries)) {
                            string candidate=line.Trim();
                            if(File.Exists(candidate)) return Path.GetFullPath(candidate);
                        }
                    }
                }
            }
        } catch {}

        return "";
    }
    [STAThread] static string ChooseFolder() { using(var d=new FolderBrowserDialog()){d.Description="Universal Video Detector - Select folder";d.ShowNewFolderButton=true;return d.ShowDialog()==DialogResult.OK?d.SelectedPath:"";} }

    static string CookieHeader(Item i) { return i==null?"":(i.cookie??""); }
    static void ApplyRequestHeaders(HttpWebRequest req, Item i) {
        req.UserAgent=String.IsNullOrWhiteSpace(i.userAgent)?"Mozilla/5.0":i.userAgent;
        req.AutomaticDecompression=DecompressionMethods.GZip|DecompressionMethods.Deflate;
        req.KeepAlive=true;
        if(!String.IsNullOrWhiteSpace(i.referer)) req.Referer=i.referer;
        if(!String.IsNullOrWhiteSpace(i.cookie)) {
            try {
                req.CookieContainer=new CookieContainer();
                var uri=new Uri(MediaUrl(i));
                foreach(var part in i.cookie.Split(new[]{';'},StringSplitOptions.RemoveEmptyEntries)) {
                    int eq=part.IndexOf('='); if(eq<=0) continue;
                    string name=part.Substring(0,eq).Trim(), value=part.Substring(eq+1).Trim();
                    try { req.CookieContainer.Add(uri,new Cookie(name,value,"/",uri.Host)); } catch {}
                }
            } catch {}
        }
        if(i.headers!=null) foreach(var kv in i.headers) {
            try { string k=kv.Key,v=kv.Value==null?"":kv.Value.ToString();
                if(k.Equals("Referer",StringComparison.OrdinalIgnoreCase)||k.Equals("User-Agent",StringComparison.OrdinalIgnoreCase)||k.Equals("Cookie",StringComparison.OrdinalIgnoreCase)||k.Equals("Host",StringComparison.OrdinalIgnoreCase)||k.Equals("Content-Length",StringComparison.OrdinalIgnoreCase))continue;
                req.Headers[k]=v;
            } catch {}
        }
    }
    static void WriteAtomicText(string path,string text) {
        string tmp=path+"."+Process.GetCurrentProcess().Id+".tmp";
        File.WriteAllText(tmp,text,new UTF8Encoding(false));
        if(File.Exists(path)){try{File.Replace(tmp,path,null);}catch{File.Copy(tmp,path,true);File.Delete(tmp);}}else File.Move(tmp,path);
    }
    static void WriteWorkerProgress(string jobId,int progress) {
        if(String.IsNullOrWhiteSpace(jobId)) return;
        try { Directory.CreateDirectory(JobsDir); WriteAtomicText(WorkerProgressPath(jobId),Json.Serialize(new Dictionary<string,object>{{"jobId",jobId},{"progress",Math.Max(0,Math.Min(99,progress))},{"updatedAt",Now()}})); } catch {}
    }
    static void WriteWorkerResult(string jobId,string status,string path,string error) {
        if(String.IsNullOrWhiteSpace(jobId)) return;
        try { Directory.CreateDirectory(JobsDir); WriteAtomicText(WorkerResultPath(jobId),Json.Serialize(new Dictionary<string,object>{{"jobId",jobId},{"status",status??"failed"},{"path",path??""},{"error",error??""},{"updatedAt",Now()}})); } catch {}
    }
    static Dictionary<string,object> ReadWorkerJson(string path) {
        try { if(!File.Exists(path)) return null; string raw=File.ReadAllText(path,new UTF8Encoding(false)); if(String.IsNullOrWhiteSpace(raw)) return null; return Json.Deserialize<Dictionary<string,object>>(raw); } catch { return null; }
    }
    static void DownloadDirect(Item i,string dest,Job j) {
        if(i==null||String.IsNullOrWhiteSpace(MediaUrl(i))) throw new Exception("Download URL is empty.");
        Uri uri; if(!Uri.TryCreate(MediaUrl(i),UriKind.Absolute,out uri)||!(uri.Scheme=="http"||uri.Scheme=="https")) throw new Exception("Invalid download URL: "+MediaUrl(i));
        HttpWebRequest req=(HttpWebRequest)WebRequest.Create(uri); req.AllowAutoRedirect=true; req.Timeout=60000; req.ReadWriteTimeout=60000; ApplyRequestHeaders(req,i);
        using(WebResponse resp=req.GetResponse()) using(Stream input=resp.GetResponseStream()) using(FileStream output=new FileStream(dest,FileMode.Create,FileAccess.Write,FileShare.Read)) {
            long total=resp.ContentLength,done=0; byte[] buf=new byte[1024*1024]; int n; long lastProgressAt=0; int lastProgress=-1;
            while((n=input.Read(buf,0,buf.Length))>0){output.Write(buf,0,n);done+=n;if(total>0){int progress=(int)Math.Min(99,done*100/total);long now=MonotonicMilliseconds();if(progress!=lastProgress&&(now-lastProgressAt>=300||progress>=99)){WriteWorkerProgress(j.id,progress);lastProgress=progress;lastProgressAt=now;}}}
            output.Flush(true);
            if(total>0)WriteWorkerProgress(j.id,99);
            if(done==0) throw new Exception("Server returned an empty response.");
        }
    }
    static string Q(string s) {
        if(s==null) return "\"\"";
        var sb=new StringBuilder(); sb.Append('"'); int slashes=0;
        foreach(char c in s){
            if(c=='\\'){slashes++; continue;}
            if(c=='"'){sb.Append(new string('\\',slashes*2+1)); sb.Append('"'); slashes=0; continue;}
            if(slashes>0){sb.Append(new string('\\',slashes)); slashes=0;} sb.Append(c);
        }
        if(slashes>0) sb.Append(new string('\\',slashes*2)); sb.Append('"'); return sb.ToString();
    }
    static string BuildHeaders(Item i) {
        var lines=new List<string>();
        if(!String.IsNullOrWhiteSpace(i.referer))lines.Add("Referer: "+i.referer);
        if(!String.IsNullOrWhiteSpace(i.userAgent))lines.Add("User-Agent: "+i.userAgent);
        if(!String.IsNullOrWhiteSpace(i.cookie))lines.Add("Cookie: "+i.cookie);
        if(i.headers!=null)foreach(var kv in i.headers){string k=kv.Key;if(k.Equals("Referer",StringComparison.OrdinalIgnoreCase)||k.Equals("User-Agent",StringComparison.OrdinalIgnoreCase)||k.Equals("Cookie",StringComparison.OrdinalIgnoreCase))continue;lines.Add(k+": "+(kv.Value==null?"":kv.Value.ToString()));}
        return String.Join("\r\n",lines);
    }
    static void DownloadWithFfmpeg(Item i,string dest,string ffmpeg,Job j) {
        string headers=BuildHeaders(i); string args="-hide_banner -nostats -loglevel error -y ";
        if(!String.IsNullOrWhiteSpace(headers)) args+="-headers "+Q(headers+"\r\n")+" ";
        if(!String.IsNullOrWhiteSpace(i.userAgent)) args+="-user_agent "+Q(i.userAgent)+" ";
        if(!String.IsNullOrWhiteSpace(i.referer))args+="-referer "+Q(i.referer)+" ";
        args+="-progress pipe:1 -i "+Q(MediaUrl(i))+" -c copy -avoid_negative_ts make_zero -movflags +faststart -f mp4 "+Q(dest);
        var psi=new ProcessStartInfo(ffmpeg,args){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
        Process p=null;
        try {
            p=Process.Start(psi);
            if(p==null) throw new Exception("ffmpeg process could not be started.");
            Task<string> errorTask=p.StandardError.ReadToEndAsync();
            string line; long lastProgressAt=0; int lastProgress=-1;
            while((line=p.StandardOutput.ReadLine())!=null){if(line.StartsWith("out_time_ms=")){long ms;if(long.TryParse(line.Substring(12),out ms)&&i.duration>0){int progress=(int)Math.Min(99,(ms/1000000.0)/i.duration*100);long now=MonotonicMilliseconds();if(progress!=lastProgress&&(now-lastProgressAt>=300||progress>=99)){WriteWorkerProgress(j.id,progress);lastProgress=progress;lastProgressAt=now;}}}}
            p.WaitForExit(3600000);
            if(!p.HasExited) { try{p.Kill();}catch{} try{p.WaitForExit(5000);}catch{} throw new Exception("ffmpeg timed out"); }
            string err=errorTask.GetAwaiter().GetResult();
            if(p.ExitCode!=0)throw new Exception(String.IsNullOrWhiteSpace(err)?"ffmpeg failed (exit "+p.ExitCode+")":err.Trim());
        } finally {
            if(p!=null) { try { if(!p.HasExited)p.Kill(); } catch {} try { p.WaitForExit(5000); } catch {} try { p.Dispose(); } catch {} }
        }
    }
    static void Coordinator(string[] ids, int concurrency) {
        if(ids==null||ids.Length==0)return;
        int degree=Math.Max(1,Math.Min(99,concurrency<=0?3:concurrency));
        int coordinatorPid=Process.GetCurrentProcess().Id;
        var queue=new Queue<string>(ids.Where(x=>!String.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase));
        var active=new Dictionary<string,int>(StringComparer.OrdinalIgnoreCase);
        var startedAt=new Dictionary<string,long>(StringComparer.OrdinalIgnoreCase);
        Directory.CreateDirectory(JobsDir);
        while(queue.Count>0 || active.Count>0) {
            while(active.Count<degree && queue.Count>0) {
                string id=queue.Dequeue(); Job j=LoadJob(JobPath(id));
                if(j==null) continue;
                if(j.status!="queued" && j.status!="starting") continue;
                try {
                    j.coordinatorProcessId=coordinatorPid; j.processId=0; UpdateJob(j,"starting",0,j.path,j.folder,null);
                    string launchDetail=""; int pid=StartWorkerDetached(WorkerExe,"--worker-id "+Q(id),out launchDetail);
                    if(pid<=0) { UpdateJob(j,"failed",0,j.path,j.folder,"Worker start failed: "+launchDetail); continue; }
                    j.processId=pid; j.coordinatorProcessId=coordinatorPid; UpdateJob(j,"downloading",0,j.path,j.folder,null);
                    active[id]=pid; startedAt[id]=Now();
                    try { File.AppendAllText(Path.Combine(JobsDir,id+".log"),Now()+" COAPP_ASSIGNED_WORKER pid="+pid+Environment.NewLine,Encoding.UTF8); } catch {}
                } catch(Exception ex) { UpdateJob(j,"failed",0,j.path,j.folder,"Worker assignment failed: "+ex.GetType().Name+": "+ex.Message); }
            }
            foreach(string id in active.Keys.ToArray()) {
                Job j=LoadJob(JobPath(id)); if(j==null){active.Remove(id);startedAt.Remove(id);continue;}
                var progress=ReadWorkerJson(WorkerProgressPath(id));
                if(progress!=null) { int pv; if(Int32.TryParse(Convert.ToString(progress.ContainsKey("progress")?progress["progress"]:0),out pv) && pv>=0) { if(pv!=j.progress) UpdateJob(j,"downloading",Math.Min(99,pv),j.path,j.folder,null); } }
                var result=ReadWorkerJson(WorkerResultPath(id));
                if(result!=null) {
                    string rs=Convert.ToString(result.ContainsKey("status")?result["status"]:"failed")??"failed";
                    string path=Convert.ToString(result.ContainsKey("path")?result["path"]:j.path)??j.path??"";
                    string err=Convert.ToString(result.ContainsKey("error")?result["error"]:"")??"";
                    bool fileReady=false; try { fileReady=!String.IsNullOrWhiteSpace(path)&&File.Exists(path)&&new FileInfo(path).Length>0; } catch {}
                    if(rs=="completed" && fileReady) { UpdateJob(j,"completed",100,path,j.folder,null); try { if(!String.IsNullOrWhiteSpace(j.itemDataPath)&&File.Exists(j.itemDataPath))File.Delete(j.itemDataPath); } catch {} }
                    else UpdateJob(j,"failed",0,path,j.folder,String.IsNullOrWhiteSpace(err)?"Worker reported failure without a valid output file.":err);
                    try{File.Delete(WorkerResultPath(id));}catch{} try{File.Delete(WorkerProgressPath(id));}catch{}
                    active.Remove(id);startedAt.Remove(id); continue;
                }
                int pid=active[id];
                if(!ProcessAlive(pid)) {
                    string path=j.path??"";
                    if(Now()-startedAt[id]>=5000) {
                        UpdateJob(j,"failed",0,path,j.folder,"Downloader Worker exited without returning a result.");
                        active.Remove(id);startedAt.Remove(id);try{File.Delete(WorkerProgressPath(id));}catch{}
                    }
                }
            }
            if(active.Count>0) Thread.Sleep(150);
        }
    }
    static void Worker(string jobPath) {
        string workerLog=Path.Combine(JobsDir,"worker.log");
        int pid=Process.GetCurrentProcess().Id; Job j=null; string itemPath=""; string dest=""; string tempDest="";
        try {
            Directory.CreateDirectory(JobsDir);
            File.AppendAllText(workerLog,Now()+" START pid="+pid+" job="+jobPath+Environment.NewLine,Encoding.UTF8);
            j=LoadJob(jobPath);
            if(j==null) throw new FileNotFoundException("Job data not found",jobPath);
            itemPath=j.itemDataPath; if(String.IsNullOrWhiteSpace(itemPath))itemPath=Path.Combine(BaseDir,"jobitems",j.id+".json");
            if(!File.Exists(itemPath))throw new FileNotFoundException("Job item data not found",itemPath);
            string raw=File.ReadAllText(itemPath,Encoding.UTF8);
            if(String.IsNullOrWhiteSpace(raw))throw new Exception("Job item data is empty.");
            Item i=Json.Deserialize<Item>(raw); if(i==null)throw new Exception("Job item JSON could not be parsed.");
            if(String.IsNullOrWhiteSpace(MediaUrl(i)))throw new Exception("Job item URL is empty.");
            dest=(j.path??"").Trim(); if(String.IsNullOrWhiteSpace(dest))throw new Exception("CoApp did not assign an output path.");
            Directory.CreateDirectory(j.folder);
            tempDest=dest+".part-"+j.id;
            try{if(File.Exists(tempDest))File.Delete(tempDest);}catch{}
            WriteWorkerProgress(j.id,0);
            string type=(i.type??"").ToLowerInvariant();
            if(type=="direct"||type=="mp4"||type=="webm"||type=="mov"||type=="m4v") DownloadDirect(i,tempDest,j);
            else {
                string ff=FindFfmpeg(j.ffmpegPath);
                if(String.IsNullOrWhiteSpace(ff))throw new Exception("ffmpeg.exe could not be resolved. Configured path: "+(String.IsNullOrWhiteSpace(j.ffmpegPath)?"(not configured)":j.ffmpegPath));
                DownloadWithFfmpeg(i,tempDest,ff,j);
            }
            if(!File.Exists(tempDest)||new FileInfo(tempDest).Length==0)throw new Exception("Download completed without producing a valid file.");
            if(File.Exists(dest))throw new IOException("Output file appeared while the Worker was downloading: "+dest);
            File.Move(tempDest,dest);
            if(!File.Exists(dest)||new FileInfo(dest).Length==0)throw new Exception("Final output file validation failed.");
            WriteWorkerProgress(j.id,99);
            WriteWorkerResult(j.id,"completed",dest,"");
        } catch(Exception ex) {
            Log("WORKER JOB "+(j==null?"unknown":j.id)+" FAILED: "+ex.ToString());
            try{if(!String.IsNullOrWhiteSpace(tempDest)&&File.Exists(tempDest))File.Delete(tempDest);}catch{}
            WriteWorkerResult(j==null?Path.GetFileNameWithoutExtension(jobPath):j.id,"failed",dest,ex.GetType().Name+": "+ex.Message);
            Environment.ExitCode=1;
        } finally {
            try { if(j!=null) File.Delete(WorkerProgressPath(j.id)); } catch {}
            try { File.AppendAllText(workerLog,Now()+" EXIT pid="+pid+" job="+(j==null?jobPath:j.id)+Environment.NewLine,Encoding.UTF8); } catch {}
        }
    }
    static bool ProcessAlive(int pid) { if(pid<=0)return false;try{Process p=Process.GetProcessById(pid);return !p.HasExited;}catch{return false;} }
    static void Reconcile() {
        long now=Now();
        foreach(Job j in LoadJobs()) {
            if(j.status=="completed"||j.status=="exist") {
                bool exists=false; try{exists=!String.IsNullOrWhiteSpace(j.path)&&File.Exists(j.path)&&new FileInfo(j.path).Length>0;}catch{}
                if(!exists) UpdateJob(j,"missing",0,j.path,j.folder,"Downloaded file is no longer present.");
                continue;
            }
            if(j.status=="queued") continue;
            if(j.status!="starting"&&j.status!="downloading") continue;
            if(j.coordinatorProcessId>0 && ProcessAlive(j.coordinatorProcessId)) continue;
            if(ProcessAlive(j.processId)) continue;
            if(now-j.updatedAt<5000) continue;
            bool ready=false; try{ready=!String.IsNullOrWhiteSpace(j.path)&&File.Exists(j.path)&&new FileInfo(j.path).Length>0;}catch{}
            if(ready) { UpdateJob(j,"completed",100,j.path,j.folder,null); continue; }
            // Coordinator/Worker may have been interrupted while the native host was
            // reconnecting. Requeue the job instead of turning an indeterminate state
            // into a permanent failure. The next download-state reconciliation can
            // restart queued work.
            j.processId=0; j.coordinatorProcessId=0; j.error=""; j.recoveryReason="coordinator_or_worker_interrupted"; UpdateJob(j,"queued",0,j.path,j.folder,null);
        }
    }

    static Job FindJobByExactPath(string path) {
        string target; try{target=Path.GetFullPath(path).TrimEnd('\\').ToLowerInvariant();}catch{return null;}
        return LoadJobs().Where(j=>j!=null&&!String.IsNullOrWhiteSpace(j.path)).FirstOrDefault(j=>{try{return Path.GetFullPath(j.path).TrimEnd('\\').ToLowerInvariant()==target;}catch{return false;}});
    }
    static Job CreateExistingJob(Item item,string path,string folder) {
        var existing=FindJobByExactPath(path);
        if(existing!=null){
            if(existing.status=="missing"||existing.status=="failed") UpdateJob(existing,"exist",100,path,folder,null);
            return existing;
        }
        var j=new Job{id=Guid.NewGuid().ToString("N"),itemId=item.itemId,mediaUrl=MediaUrl(item),identityUrl=item.identityUrl,name=item.name,type=item.type,status="exist",progress=100,path=path,folder=folder,error="",createdAt=Now(),updatedAt=Now(),completedAt=Now(),batchId="",recoveryReason="filesystem_existing",pageIdentity=CloneIdentity(item),videoIdentity=item.videoIdentity!=null?new Dictionary<string,string>(item.videoIdentity,StringComparer.OrdinalIgnoreCase):new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase)};
        SaveJob(j); return j;
    }
    static List<Dictionary<string,object>> CheckFiles(List<string> paths) {
        var result=new List<Dictionary<string,object>>();
        foreach(string p in paths??new List<string>()) {
            string full=p??"";
            bool exists=false;
            try { if(!String.IsNullOrWhiteSpace(full)) exists=File.Exists(Path.GetFullPath(full)); } catch {}
            result.Add(new Dictionary<string,object>{{"path",full},{"exists",exists}});
        }
        return result;
    }

    static bool CompileSource(string source,string output,bool winExe,out string error) {
        error="";
        try {
            if(String.IsNullOrWhiteSpace(source)) { error="Source is empty."; return false; }
            var provider=new Microsoft.CSharp.CSharpCodeProvider();
            var p=new System.CodeDom.Compiler.CompilerParameters();
            p.GenerateExecutable=true; p.GenerateInMemory=false; p.OutputAssembly=output;
            p.CompilerOptions=winExe?"/target:winexe /platform:anycpu":"/target:exe /platform:anycpu";
            foreach(var r in new[]{"System.dll","System.Core.dll","System.Windows.Forms.dll","System.Web.Extensions.dll","System.Xml.dll","System.Threading.Tasks.dll"}) p.ReferencedAssemblies.Add(r);
            var result=provider.CompileAssemblyFromSource(p,source);
            if(result.Errors.HasErrors||!File.Exists(output)) { error=String.Join(Environment.NewLine,result.Errors.Cast<object>().Select(x=>x.ToString()).ToArray()); return false; }
            return true;
        } catch(Exception ex) { error=ex.GetType().Name+": "+ex.Message; return false; }
    }

    static string QArg(string s){return "\""+String.Join("",(s??"").Split('"'))+"\"";}
    // CoApp releases before the canonical 0.x.y format used a two-part version.
    // Interpret 6.8 as 0.6.8 so legacy installs do not outrank 0.6.10/0.6.18.
    static int[] ParseCoAppVersion(string value) {
        string[] parts=(value??"0").Trim().Split('.');
        var result=new int[Math.Max(3,parts.Length)];
        int offset=parts.Length==2?1:0;
        for(int i=0;i<parts.Length;i++) int.TryParse(parts[i],out result[i+offset]);
        return result;
    }
    static int CompareCoAppVersions(string a,string b) {
        var left=ParseCoAppVersion(a); var right=ParseCoAppVersion(b);
        int count=Math.Max(left.Length,right.Length);
        for(int i=0;i<count;i++){int x=i<left.Length?left[i]:0;int y=i<right.Length?right[i]:0;if(x!=y)return x.CompareTo(y);}
        return 0;
    }
    static Dictionary<string,object> StartInPlaceUpdate(Request r) {
        if(String.IsNullOrWhiteSpace(r.extensionVersion)||String.IsNullOrWhiteSpace(r.coAppVersion)||String.IsNullOrWhiteSpace(r.companionSource)||String.IsNullOrWhiteSpace(r.uninstallerSource)) return new Dictionary<string,object>{{"ok",false},{"error","Update payload is incomplete."}};
        if(!r.companionSource.Contains("const string Version = \""+r.coAppVersion+"\";")) return new Dictionary<string,object>{{"ok",false},{"error","CoApp source version does not match the requested CoApp version."}};
        try { new System.Version(r.coAppVersion); new System.Version(Version); } catch { return new Dictionary<string,object>{{"ok",false},{"error","Invalid version."}};}
        if(CompareCoAppVersions(r.coAppVersion,Version)<=0) return new Dictionary<string,object>{{"ok",true},{"updated",false},{"version",Version},{"message","CoApp is already current."}};
        string tempRoot=Path.Combine(Path.GetTempPath(),"uvd-coapp-update-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(tempRoot);
        string newExe=Path.Combine(tempRoot,"uvd_companion.exe"),newWorker=Path.Combine(tempRoot,"uvd_downloader_worker.exe"),newUninstaller=Path.Combine(tempRoot,"uninstaller.exe");
        string err;
        if(!CompileSource(r.companionSource,newExe,false,out err)){try{Directory.Delete(tempRoot,true);}catch{}return new Dictionary<string,object>{{"ok",false},{"error","Failed to compile CoApp: "+err}};}
        if(!CompileSource(r.companionSource,newWorker,false,out err)){try{Directory.Delete(tempRoot,true);}catch{}return new Dictionary<string,object>{{"ok",false},{"error","Failed to compile Downloader Worker: "+err}};}
        if(!CompileSource(r.uninstallerSource,newUninstaller,true,out err)){try{Directory.Delete(tempRoot,true);}catch{}return new Dictionary<string,object>{{"ok",false},{"error","Failed to compile Uninstaller: "+err}};}
        string script=Path.Combine(tempRoot,"update.cmd");
        string targetExe=Path.Combine(BaseDir,"uvd_companion.exe");
        string targetWorker=Path.Combine(BaseDir,"uvd_downloader_worker.exe");
        string targetUninstaller=Path.Combine(BaseDir,"uninstaller.exe");
        string log=Path.Combine(tempRoot,"update.log");
        string body="@echo off\r\nsetlocal EnableExtensions EnableDelayedExpansion\r\nset \"LOG="+log+"\"\r\nset \"TARGET_EXE="+targetExe+"\"\r\nset \"TARGET_WORKER="+targetWorker+"\"\r\nset \"TARGET_UNINSTALLER="+targetUninstaller+"\"\r\nset \"NEW_EXE="+newExe+"\"\r\nset \"NEW_WORKER="+newWorker+"\"\r\nset \"NEW_UNINSTALLER="+newUninstaller+"\"\r\nset \"TARGET_VERSION="+r.coAppVersion+"\"\r\necho [UVD UPDATE] start %date% %time%>>\"%LOG%\"\r\nrem Do not inspect the Native Messaging host PID. Firefox controls its lifetime, and PID polling caused a visible/stuck command window on some systems.\r\nrem Wait briefly for the current host to finish, then let file locking determine when replacement is safe.\r\nping 127.0.0.1 -n 3 >nul\r\ntaskkill /IM uvd_downloader_worker.exe /F >nul 2>&1\r\nset RETRIES=0\r\n:copyloop\r\nset /a RETRIES+=1\r\necho [UVD UPDATE] attempt !RETRIES!>>\"%LOG%\"\r\ncopy /Y \"%NEW_EXE%\" \"%TARGET_EXE%\" >>\"%LOG%\" 2>&1\r\nif errorlevel 1 goto retry\r\ncopy /Y \"%NEW_WORKER%\" \"%TARGET_WORKER%\" >>\"%LOG%\" 2>&1\r\nif errorlevel 1 goto retry\r\ncopy /Y \"%NEW_UNINSTALLER%\" \"%TARGET_UNINSTALLER%\" >>\"%LOG%\" 2>&1\r\nif errorlevel 1 goto retry\r\nif not exist \"%TARGET_EXE%\" goto retry\r\nif not exist \"%TARGET_WORKER%\" goto retry\r\nif not exist \"%TARGET_UNINSTALLER%\" goto retry\r\nset \"INSTALLED_VERSION=\"\r\nfor /f \"delims=\" %%V in ('\"%TARGET_EXE%\" --version 2^>nul') do set \"INSTALLED_VERSION=%%V\"\r\necho [UVD UPDATE] installed version=!INSTALLED_VERSION! target=%TARGET_VERSION%>>\"%LOG%\"\r\nif /I not \"!INSTALLED_VERSION!\"==\"%TARGET_VERSION%\" goto retry\r\necho [UVD UPDATE] replacement and version verification complete>>\"%LOG%\"\r\ndel /Q \"%NEW_EXE%\" \"%NEW_WORKER%\" \"%NEW_UNINSTALLER%\" >nul 2>&1\r\ndel /Q \"%~f0\" >nul 2>&1\r\nexit /b 0\r\n:retry\r\nif !RETRIES! GEQ 30 (echo [UVD UPDATE] failed after retries>>\"%LOG%\" & exit /b 1)\r\nping 127.0.0.1 -n 2 >nul\r\ngoto copyloop\r\n";
        File.WriteAllText(script,body,new UTF8Encoding(false));
        var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        var updateCmd=new StringBuilder("cmd.exe /d /c "+QArg(script));
        uint flags=CREATE_BREAKAWAY_FROM_JOB|CREATE_NEW_PROCESS_GROUP|CREATE_NO_WINDOW;
        bool launched=false;
        try { launched=CreateProcess(null,updateCmd,IntPtr.Zero,IntPtr.Zero,false,flags,IntPtr.Zero,BaseDir,ref si,out pi); if(launched){CloseHandle(pi.hThread);CloseHandle(pi.hProcess);} } catch { launched=false; }
        if(!launched){ try { var psi=new ProcessStartInfo{FileName="cmd.exe",Arguments="/d /c "+QArg(script),UseShellExecute=true,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=BaseDir}; var proc=Process.Start(psi); launched=proc!=null; } catch {} }
        if(!launched) return new Dictionary<string,object>{{"ok",false},{"error","Could not start the CoApp update process."}};
        return new Dictionary<string,object>{{"ok",true},{"updated",false},{"updating",true},{"targetVersion",r.coAppVersion},{"message","CoApp update process started. Final success is confirmed only after reconnection and version verification."}};
    }

    static string CanonicalUrl(string u) {
        if(String.IsNullOrWhiteSpace(u)) return "";
        try {
            var x=new Uri(u);
            var builder=new UriBuilder(x);
            var query=builder.Query;
            var pairs=new List<string>();
            if(!String.IsNullOrWhiteSpace(query)) {
                foreach(var part in query.TrimStart('?').Split('&')) {
                    if(String.IsNullOrWhiteSpace(part)) continue;
                    int eq=part.IndexOf('=');
                    string name=eq>=0?part.Substring(0,eq):part;
                    string decodedName=name;
                    try { decodedName=Uri.UnescapeDataString(name); } catch {}
                    if(System.Text.RegularExpressions.Regex.IsMatch(decodedName,"^(token|sig|signature|expires|exp|auth|timestamp)$",System.Text.RegularExpressions.RegexOptions.IgnoreCase)) continue;
                    pairs.Add(part);
                }
            }
            pairs.Sort(StringComparer.Ordinal);
            builder.Query=String.Join("&",pairs);
            builder.Fragment="";
            return builder.Uri.AbsoluteUri.ToLowerInvariant();
        } catch { return u.Split(new[]{'?' ,'#'},2)[0].ToLowerInvariant(); }
    }
    static string Text(object v) { return v==null?"":Convert.ToString(v,System.Globalization.CultureInfo.InvariantCulture)??""; }
    static string AssetKey(string u) { return CanonicalUrl(u); }
    static string VideoIdentityValue(Item item,string key) {
        if(item==null||item.videoIdentity==null||String.IsNullOrWhiteSpace(key)) return "";
        string value; return item.videoIdentity.TryGetValue(key,out value) ? (value??"").Trim() : "";
    }
    static bool SameVideoIdentityValue(Item a,Item b,string key) {
        string av=NormalizeIdentityValue(key,VideoIdentityValue(a,key));
        string bv=NormalizeIdentityValue(key,VideoIdentityValue(b,key));
        return !String.IsNullOrWhiteSpace(av)&&!String.IsNullOrWhiteSpace(bv)&&String.Equals(av,bv,StringComparison.OrdinalIgnoreCase);
    }
    static int VideoIdentityScore(Item a,Item b) {
        if(a==null||b==null)return 0;
        string pageA=VideoIdentityValue(a,"pageItemIdentity");
        string pageB=VideoIdentityValue(b,"pageItemIdentity");
        if(!String.IsNullOrWhiteSpace(pageA)&&!String.IsNullOrWhiteSpace(pageB)&&!String.Equals(pageA,pageB,StringComparison.OrdinalIgnoreCase))return 0;
        string stableA=VideoIdentityValue(a,"stableId");
        string stableB=VideoIdentityValue(b,"stableId");
        if(!String.IsNullOrWhiteSpace(stableA)&&!String.IsNullOrWhiteSpace(stableB)&&String.Equals(stableA,stableB,StringComparison.OrdinalIgnoreCase))return 100;
        if(SameVideoIdentityValue(a,b,"uuid"))return 96;
        bool samePage=!String.IsNullOrWhiteSpace(pageA)&&!String.IsNullOrWhiteSpace(pageB)&&String.Equals(pageA,pageB,StringComparison.OrdinalIgnoreCase);
        bool thumb=SameVideoIdentityValue(a,b,"thumbnail");
        bool file=SameVideoIdentityValue(a,b,"filename");
        bool duration=a.duration>0&&b.duration>0&&Math.Abs(a.duration-b.duration)<0.75;
        bool type=String.Equals(a.type,b.type,StringComparison.OrdinalIgnoreCase);
        string am=MediaUrl(a),bm=MediaUrl(b);
        if(!String.IsNullOrWhiteSpace(am)&&!String.IsNullOrWhiteSpace(bm)&&String.Equals(CanonicalUrl(am),CanonicalUrl(bm),StringComparison.OrdinalIgnoreCase))return 95;
        // Multiple independent video-level signals are required when URLs differ
        // (for example HLS/DASH quality variants). Page identity alone never merges.
        if(samePage&&thumb&&(duration||file))return 92;
        if(samePage&&file&&duration)return 90;
        if(samePage&&thumb&&type)return 88;
        if(thumb&&file&&duration)return 86;
        if(thumb&&duration&&type)return 85;
        if(file&&duration&&type)return 84;
        return 0;
    }
    static bool SameItemIdentity(Item a, Item b) {
        if(a==null||b==null) return false;
        // Page identity is never used for video duplicate detection.
        if(VideoIdentityScore(a,b)>=84) return true;
        // A canonical video URL/identity URL is itself video-level evidence.
        // Never merge two distinct videos merely because filename/thumbnail/duration
        // happen to match; many galleries legitimately reuse names such as 4.mp4.
        string ai=!String.IsNullOrWhiteSpace(a.identityUrl)?a.identityUrl:MediaUrl(a);
        string bi=!String.IsNullOrWhiteSpace(b.identityUrl)?b.identityUrl:MediaUrl(b);
        if(String.IsNullOrWhiteSpace(ai)||String.IsNullOrWhiteSpace(bi)) return false;
        return String.Equals(CanonicalUrl(ai),CanonicalUrl(bi),StringComparison.OrdinalIgnoreCase);
    }
    static readonly string FolderSequencePath = Path.Combine(BaseDir, "uvd_folder_sequences.json");
    static readonly string FolderSequenceMutexName = "Global\\UniversalVideoDetector.FolderSequences.0.6.18";

    static string IdentityValue(Item item,string key) {
        if(item==null||item.pageIdentity==null||String.IsNullOrWhiteSpace(key)) return "";
        string value; return item.pageIdentity.TryGetValue(key,out value) ? (value??"").Trim() : "";
    }
    static string NormalizeIdentityValue(string key,string value) {
        value=(value??"").Trim(); if(value.Length==0) return "";
        if(key.IndexOf("Url",StringComparison.OrdinalIgnoreCase)>=0 || key.IndexOf("Page",StringComparison.OrdinalIgnoreCase)>=0) {
            return CanonicalUrl(value);
        }
        return value.ToLowerInvariant();
    }
    static bool SameIdentityValue(Item a,Item b,string key) {
        string av=NormalizeIdentityValue(key,IdentityValue(a,key));
        string bv=NormalizeIdentityValue(key,IdentityValue(b,key));
        return !String.IsNullOrWhiteSpace(av)&&!String.IsNullOrWhiteSpace(bv)&&String.Equals(av,bv,StringComparison.OrdinalIgnoreCase);
    }
    static int PageIdentityScore(Item a,Item b) {
        if(a==null||b==null) return 0;
        // Strong identifiers are preferred. A single strong match is enough to
        // reuse a folder because these values are explicitly page-level IDs.
        if(SameIdentityValue(a,b,"structuredId")) return 100;
        if(SameIdentityValue(a,b,"structuredIdentifier")) return 95;
        if(SameIdentityValue(a,b,"microdataItemId")) return 95;
        int score=0, comparable=0;
        if(SameIdentityValue(a,b,"structuredMainEntityOfPage")){score+=55;comparable++;}
        else if(!String.IsNullOrWhiteSpace(IdentityValue(a,"structuredMainEntityOfPage"))&&!String.IsNullOrWhiteSpace(IdentityValue(b,"structuredMainEntityOfPage"))) comparable++;
        if(SameIdentityValue(a,b,"canonicalUrl")){score+=45;comparable++;}
        else if(!String.IsNullOrWhiteSpace(IdentityValue(a,"canonicalUrl"))&&!String.IsNullOrWhiteSpace(IdentityValue(b,"canonicalUrl"))) comparable++;
        if(SameIdentityValue(a,b,"ogUrl")){score+=40;comparable++;}
        else if(!String.IsNullOrWhiteSpace(IdentityValue(a,"ogUrl"))&&!String.IsNullOrWhiteSpace(IdentityValue(b,"ogUrl"))) comparable++;
        if(SameIdentityValue(a,b,"microdataItemType")){score+=10;comparable++;}
        // If no stronger page ID exists, an exact canonical/OG URL is the safe
        // fallback. It is never compared against a title alone.
        string ap=CanonicalUrl(a.pageUrl),bp=CanonicalUrl(b.pageUrl);
        if(!String.IsNullOrWhiteSpace(ap)&&!String.IsNullOrWhiteSpace(bp)&&String.Equals(ap,bp,StringComparison.OrdinalIgnoreCase) &&
           !String.IsNullOrWhiteSpace(a.pageTitle)&&!String.IsNullOrWhiteSpace(b.pageTitle) &&
           String.Equals(a.pageTitle.Trim(),b.pageTitle.Trim(),StringComparison.OrdinalIgnoreCase)) return 75;
        return comparable>=2&&score>=70?score:0;
    }
    static string PageIdentityFallback(Item item,Site site) {
        string canonical=NormalizeIdentityValue("canonicalUrl",IdentityValue(item,"canonicalUrl"));
        string og=NormalizeIdentityValue("ogUrl",IdentityValue(item,"ogUrl"));
        string main=NormalizeIdentityValue("structuredMainEntityOfPage",IdentityValue(item,"structuredMainEntityOfPage"));
        string page=CanonicalUrl(item==null?"":(String.IsNullOrWhiteSpace(item.pageUrl)?item.landingPage:item.pageUrl));
        string title=Safe(item==null?"":item.pageTitle,"");
        if(!String.IsNullOrWhiteSpace(canonical)&&!String.IsNullOrWhiteSpace(title)) return canonical+"|title="+title.ToLowerInvariant();
        if(!String.IsNullOrWhiteSpace(og)&&!String.IsNullOrWhiteSpace(title)) return og+"|title="+title.ToLowerInvariant();
        if(!String.IsNullOrWhiteSpace(main)&&!String.IsNullOrWhiteSpace(title)) return main+"|title="+title.ToLowerInvariant();
        if(!String.IsNullOrWhiteSpace(page)&&!String.IsNullOrWhiteSpace(title)) return page+"|title="+title.ToLowerInvariant();
        return "";
    }
    static Dictionary<string,string> CloneIdentity(Item item) {
        var result=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        if(item!=null&&item.pageIdentity!=null) foreach(var kv in item.pageIdentity) if(!String.IsNullOrWhiteSpace(kv.Value)) result[kv.Key]=kv.Value.Trim();
        return result;
    }
    static string FolderEntryKey(Item item,Site site) {
        // The key is only a diagnostic/index value. Actual reuse is decided by
        // PageIdentityScore against every stored entry so aliases can survive URL changes.
        var ids=CloneIdentity(item);
        var parts=new List<string>();
        foreach(var k in new[]{"structuredId","structuredIdentifier","microdataItemId","structuredMainEntityOfPage","canonicalUrl","ogUrl"}) {
            string v=NormalizeIdentityValue(k,ids.ContainsKey(k)?ids[k]:"");
            if(!String.IsNullOrWhiteSpace(v)) parts.Add(k+"="+v);
        }
        if(parts.Count==0) { string fallback=PageIdentityFallback(item,site); if(!String.IsNullOrWhiteSpace(fallback)) parts.Add("fallback="+fallback); }
        return String.Join("|",parts.ToArray());
    }
    static Dictionary<string,object> LoadFolderSequenceStore() {
        var store=new Dictionary<string,object>(StringComparer.OrdinalIgnoreCase);
        store["version"]=2; store["nextSequence"]=1; store["entries"]=new List<object>();
        try {
            if(!File.Exists(FolderSequencePath)) return store;
            string raw=File.ReadAllText(FolderSequencePath,new UTF8Encoding(false));
            var parsed=Json.Deserialize<Dictionary<string,object>>(raw);
            if(parsed!=null) {
                if(parsed.ContainsKey("entries")) store=parsed;
                else {
                    // An older release stored a flat host+title -> sequence map. Do not use
                    // those keys for identity, but preserve the highest sequence so
                    // the new identity store cannot accidentally reuse an old folder.
                    int max=0; foreach(var kv in parsed){int n;if(Int32.TryParse(Convert.ToString(kv.Value),out n))max=Math.Max(max,n);}
                    store["version"]=2; store["nextSequence"]=Math.Max(1,max+1); store["entries"]=new List<object>();
                }
            }
        } catch {}
        if(!store.ContainsKey("entries")||!(store["entries"] is object[] || store["entries"] is List<object>)) store["entries"]=new List<object>();
        return store;
    }
    static List<object> FolderEntries(Dictionary<string,object> store) {
        object raw; if(!store.TryGetValue("entries",out raw)||raw==null) return new List<object>();
        if(raw is List<object>) return (List<object>)raw;
        if(raw is object[]) return new List<object>((object[])raw);
        return new List<object>();
    }
    static string FindExistingSequenceFolder(Item item,Site site) {
        using(var mutex=new Mutex(false,FolderSequenceMutexName)) {
            mutex.WaitOne();
            try {
                var store=LoadFolderSequenceStore();
                foreach(object raw in FolderEntries(store)) {
                    var e=raw as Dictionary<string,object>; if(e==null) continue;
                    object data; if(!e.TryGetValue("identity",out data)||data==null) continue;
                    var identityMap=data as Dictionary<string,object>; if(identityMap==null) continue;
                    var candidate=new Item{pageIdentity=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase)};
                    foreach(var kv in identityMap) candidate.pageIdentity[kv.Key]=Convert.ToString(kv.Value)??"";
                    if(PageIdentityScore(item,candidate)>=70) {
                        object folderValue; int existing;
                        if(e.TryGetValue("folder",out folderValue)&&Int32.TryParse(Convert.ToString(folderValue),out existing)&&existing>0)
                            return existing.ToString("D3");
                    }
                }
            } finally { try{mutex.ReleaseMutex();}catch{} }
        }
        return "";
    }

    static int NextSequenceFromStore(Dictionary<string,object> store,List<object> entries) {
        int max=0;
        object nextObj; int next;
        if(store.TryGetValue("nextSequence",out nextObj)&&Int32.TryParse(Convert.ToString(nextObj),out next)) max=Math.Max(max,next-1);
        foreach(object raw in entries) {
            var e=raw as Dictionary<string,object>; if(e==null) continue;
            object fv; if(e.TryGetValue("folder",out fv)){int n;if(Int32.TryParse(Convert.ToString(fv),out n))max=Math.Max(max,n);}
        }
        return Math.Max(1,max+1);
    }
    static string NextFolderSequence(Item item,Site site) {
        using(var mutex=new Mutex(false,FolderSequenceMutexName)) {
            mutex.WaitOne();
            try {
                var store=LoadFolderSequenceStore();
                var entries=FolderEntries(store);
                foreach(object raw in entries) {
                    var e=raw as Dictionary<string,object>; if(e==null) continue;
                    object data; if(!e.TryGetValue("identity",out data)||data==null) continue;
                    var identityMap=data as Dictionary<string,object>; if(identityMap==null) continue;
                    var candidate=new Item{pageIdentity=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase)};
                    foreach(var kv in identityMap) candidate.pageIdentity[kv.Key]=Convert.ToString(kv.Value)??"";
                    if(PageIdentityScore(item,candidate)>=70) {
                        object folderValue; if(e.TryGetValue("folder",out folderValue)){int existing;if(Int32.TryParse(Convert.ToString(folderValue),out existing)&&existing>0)return existing.ToString("D3");}
                    }
                }
                // Legacy folder mappings are retained only for sequence-number continuity;
                // host+title is never used as page identity evidence because titles are not unique.
                int next=NextSequenceFromStore(store,entries);
                var entry=new Dictionary<string,object>();
                entry["folder"]=next.ToString("D3");
                entry["host"]=Safe(site==null?"unknown-site":site.host,"unknown-site");
                entry["identityKey"]=FolderEntryKey(item,site);
                var identity=new Dictionary<string,object>();
                foreach(var kv in CloneIdentity(item)) identity[kv.Key]=kv.Value;
                if(!String.IsNullOrWhiteSpace(item.pageUrl)) identity["pageUrl"]=item.pageUrl;
                if(!String.IsNullOrWhiteSpace(item.pageTitle)) identity["pageTitle"]=item.pageTitle;
                if(identity.Count==0) { string fallback=PageIdentityFallback(item,site); if(!String.IsNullOrWhiteSpace(fallback)) identity["pageFallback"]=fallback; }
                entry["identity"]=identity;
                entries.Add(entry); store["version"]=2;store["entries"]=entries;store["nextSequence"]=next+1;
                string tmp=FolderSequencePath+"."+Process.GetCurrentProcess().Id+".tmp";
                File.WriteAllText(tmp,Json.Serialize(store),new UTF8Encoding(false));
                if(File.Exists(FolderSequencePath)){try{File.Replace(tmp,FolderSequencePath,null);}catch{File.Copy(tmp,FolderSequencePath,true);File.Delete(tmp);}}else File.Move(tmp,FolderSequencePath);
                return next.ToString("D3");
            } finally { try{mutex.ReleaseMutex();}catch{} }
        }
    }
    static string BatchPageTitle(Request r) {
        if(r==null) return "";
        var counts=new Dictionary<string,int>(StringComparer.OrdinalIgnoreCase);
        string first="";
        foreach(Item item in r.items??new List<Item>()) {
            string title=item==null?"":(item.pageTitle??"").Trim();
            if(String.IsNullOrWhiteSpace(title)&&item!=null&&item.pageIdentity!=null) { string v; if(item.pageIdentity.TryGetValue("pageTitle",out v)) title=(v??"").Trim(); }
            if(String.IsNullOrWhiteSpace(title)) continue;
            if(String.IsNullOrWhiteSpace(first)) first=title;
            int n; counts.TryGetValue(title,out n); counts[title]=n+1;
        }
        string best=first; int bestCount=0;
        foreach(var kv in counts) if(kv.Value>bestCount){best=kv.Key;bestCount=kv.Value;}
        if(String.IsNullOrWhiteSpace(best)) best=(r.site==null?"":(r.site.title??"")).Trim();
        return best;
    }
    static string DownloadFolderName(Request r,Item item,string pageTitleOverride=null) {
        if(String.Equals(r.folderNaming,"sequence",StringComparison.OrdinalIgnoreCase)) return NextFolderSequence(item,r.site);
        string title=(pageTitleOverride??"").Trim();
        if(String.IsNullOrWhiteSpace(title)) title=item==null?"":(item.pageTitle??"").Trim();
        if(String.IsNullOrWhiteSpace(title)&&item!=null&&item.pageIdentity!=null) {
            string v; if(item.pageIdentity.TryGetValue("pageTitle",out v)) title=(v??"").Trim();
        }
        string siteName=Safe(r.site==null?"unknown-site":(r.site.host??""),"unknown-site");
        if(String.IsNullOrWhiteSpace(title)) {
            string identity=PageIdentityFallback(item,r.site);
            if(!String.IsNullOrWhiteSpace(identity)) {
                unchecked {
                    uint pageHash=2166136261u;
                    for(int i=0;i<identity.Length;i++){ pageHash ^= identity[i]; pageHash *= 16777619u; }
                    return Safe(siteName+" - page-"+pageHash.ToString("x8"),"page-unknown");
                }
            }
            return Safe(siteName+" - page-unknown","page-unknown");
        }
        return Safe(siteName+" - "+title,"page-unknown");
    }
    static Dictionary<string,object> JobMap(Job j){return new Dictionary<string,object>{{"id",j.id},{"jobId",j.id},{"itemId",j.itemId},{"mediaUrl",j.mediaUrl},{"identityUrl",j.identityUrl},{"name",j.name},{"type",j.type},{"status",j.status},{"progress",j.progress},{"path",j.path},{"folder",j.folder},{"error",j.error},{"recoveryReason",j.recoveryReason},{"createdAt",j.createdAt},{"updatedAt",j.updatedAt},{"completedAt",j.completedAt},{"batchId",j.batchId}};}
    static Item JobAsItem(Job j){
        if(j==null)return null;
        return new Item{itemId=j.itemId,mediaUrl=j.mediaUrl,identityUrl=j.identityUrl,name=j.name,type=j.type,pageIdentity=j.pageIdentity,videoIdentity=j.videoIdentity};
    }
    static bool JobMatchesItem(Job j,Item item){
        if(j==null||item==null)return false;
        var stored=JobAsItem(j);
        if(VideoIdentityScore(stored,item)>=84)return true;
        // A URL match is only accepted when corroborated by another video-level
        // element; never use URL alone as the video identity.
        int matches=0;
        if(!String.IsNullOrWhiteSpace(j.mediaUrl)&&!String.IsNullOrWhiteSpace(MediaUrl(item))&&String.Equals(CanonicalUrl(j.mediaUrl),CanonicalUrl(MediaUrl(item)),StringComparison.OrdinalIgnoreCase))matches++;
        if(!String.IsNullOrWhiteSpace(j.identityUrl)&&!String.IsNullOrWhiteSpace(item.identityUrl)&&String.Equals(CanonicalUrl(j.identityUrl),CanonicalUrl(item.identityUrl),StringComparison.OrdinalIgnoreCase))matches++;
        if(!String.IsNullOrWhiteSpace(j.name)&&!String.IsNullOrWhiteSpace(item.name)&&String.Equals(j.name,item.name,StringComparison.OrdinalIgnoreCase))matches++;
        return matches>=2;
    }
    static Job FindAuthoritativeJob(Item item){
        return LoadJobs().Where(j=>j!=null && (j.status=="completed"||j.status=="exist"||j.status=="missing") && JobMatchesItem(j,item)).OrderByDescending(j=>j.updatedAt).ThenByDescending(j=>j.createdAt).FirstOrDefault();
    }
    static bool HasValidFile(string path){
        try{return !String.IsNullOrWhiteSpace(path)&&File.Exists(path)&&new FileInfo(path).Length>0;}catch{return false;}
    }
    static bool TryForegroundExplorerWindow(string folder){
        object shell=null,windows=null;
        try{
            Type shellType=Type.GetTypeFromProgID("Shell.Application");
            if(shellType==null)return false;
            shell=Activator.CreateInstance(shellType);
            windows=shellType.InvokeMember("Windows",System.Reflection.BindingFlags.InvokeMethod|System.Reflection.BindingFlags.GetProperty,null,shell,null);
            int count=Convert.ToInt32(windows.GetType().InvokeMember("Count",System.Reflection.BindingFlags.GetProperty,null,windows,null));
            string target=Path.GetFullPath(folder).TrimEnd('\\').ToLowerInvariant();
            for(int i=0;i<count;i++){
                object win=null;
                try{
                    win=windows.GetType().InvokeMember("Item",System.Reflection.BindingFlags.InvokeMethod,null,windows,new object[]{i});
                    if(win==null)continue;
                    string loc=Convert.ToString(win.GetType().InvokeMember("LocationURL",System.Reflection.BindingFlags.GetProperty,null,win,null))??"";
                    string local="";
                    try{if(!String.IsNullOrWhiteSpace(loc))local=new Uri(loc).LocalPath;}catch{}
                    if(String.IsNullOrWhiteSpace(local))continue;
                    local=Path.GetFullPath(local).TrimEnd('\\').ToLowerInvariant();
                    if(local!=target)continue;
                    IntPtr hwnd=(IntPtr)Convert.ToInt64(win.GetType().InvokeMember("HWND",System.Reflection.BindingFlags.GetProperty,null,win,null));
                    if(hwnd!=IntPtr.Zero){ShowWindow(hwnd,SW_RESTORE);SetForegroundWindow(hwnd);return true;}
                }catch{}
                finally{try{if(win!=null&&Marshal.IsComObject(win))Marshal.FinalReleaseComObject(win);}catch{}}
            }
        }catch{}
        finally{try{if(windows!=null&&Marshal.IsComObject(windows))Marshal.FinalReleaseComObject(windows);}catch{} try{if(shell!=null&&Marshal.IsComObject(shell))Marshal.FinalReleaseComObject(shell);}catch{}}
        return false;
    }
    static void OpenExplorerForeground(string folder){
        var psi=new ProcessStartInfo{FileName="explorer.exe",Arguments=Q(folder),UseShellExecute=true,WorkingDirectory=folder};
        var started=Process.Start(psi);
        if(started==null)throw new InvalidOperationException("Windows Explorer could not be started.");
        // Explorer may reuse an existing shell process/window. Prefer the COM shell
        // window matching the exact folder, then fall back to the launched process.
        for(int i=0;i<20;i++){
            if(TryForegroundExplorerWindow(folder))return;
            try{started.Refresh();var h=started.MainWindowHandle;if(h!=IntPtr.Zero){ShowWindow(h,SW_RESTORE);SetForegroundWindow(h);return;}}catch{}
            Thread.Sleep(100);
        }
    }
    static Dictionary<string,object> GetFullState(){Reconcile();var jobs=LoadJobs().Select(JobMap).ToList();return new Dictionary<string,object>{{"ok",true},{"stateRevision",ReadRevision()},{"jobs",jobs}};}
    static void ValidateRequestSchema(Request r) {
        if(r==null) throw new Exception("Invalid request");
        // Existing keys remain unchanged. Optional fields may be null/missing.
        // Validate only fields whose types are contract-critical before dispatch.
        if(r.items!=null) foreach(var i in r.items) {
            if(i==null) continue;
            if(i.headers!=null && i.headers.Keys.Any(k=>String.IsNullOrWhiteSpace(k))) throw new Exception("Invalid JSON schema: empty header key.");
        }
        if(r.parallelDownloads<0) throw new Exception("Invalid JSON schema: parallelDownloads must be non-negative.");
    }
    static Dictionary<string,object> Handle(Request r) {
        ValidateRequestSchema(r);
        if(r==null)throw new Exception("Invalid request");
        switch(r.action??"") {
            case "update_from_extension": return StartInPlaceUpdate(r);
            case "ping": return new Dictionary<string,object>{{"ok",true},{"action","ping"},{"app","Universal Video Detector Companion"},{"version",Version},{"path",BaseDir},{"companionPath",BaseDir},{"ffmpegPath",File.Exists(BundledFfmpeg)?BundledFfmpeg:""},{"uninstallerPath",Path.Combine(BaseDir,"uninstaller.exe")},{"extensionId",StartedExtensionId},{"registered",true},{"stateRevision",ReadRevision()}};
            case "choose_folder": {string p=ChooseFolder();return new Dictionary<string,object>{{"ok",!String.IsNullOrEmpty(p)},{"action","choose_folder"},{"path",p},{"error",String.IsNullOrEmpty(p)?"Cancelled":""}};}
            case "open_folder": {
                string p=(r.path??"").Trim().Trim('"');
                if(String.IsNullOrWhiteSpace(p)&&!String.IsNullOrWhiteSpace(r.jobId)){var jj=LoadJob(JobPath(r.jobId));p=(jj==null?"":(jj.folder??""));}
                if(String.IsNullOrWhiteSpace(p))throw new ArgumentException("Folder path is empty.");
                p=Path.GetFullPath(p);
                if(File.Exists(p)) p=Path.GetDirectoryName(p);
                if(String.IsNullOrWhiteSpace(p)||!Directory.Exists(p))throw new DirectoryNotFoundException("Folder not found: "+p);
                OpenExplorerForeground(p);
                return new Dictionary<string,object>{{"ok",true},{"path",p}};
            }
            case "resolve_playback": {
                Job jj=null;
                if(!String.IsNullOrWhiteSpace(r.jobId)) jj=LoadJob(JobPath(r.jobId));
                if(jj==null && (!String.IsNullOrWhiteSpace(r.itemId)||!String.IsNullOrWhiteSpace(r.mediaUrl)||!String.IsNullOrWhiteSpace(r.identityUrl))) {
                    var requestItem=new Item{itemId=r.itemId,mediaUrl=r.mediaUrl,identityUrl=r.identityUrl};
                    jj=FindAuthoritativeJob(requestItem);
                }
                if(jj==null)throw new ArgumentException("CoAppで再生対象のJobを特定できません。");
                string jp=(jj.path??"").Trim().Trim('\"');
                if(String.IsNullOrWhiteSpace(jp))throw new FileNotFoundException("Job.path が存在しません。",jp);
                string pk; jp=ValidateAndNormalizePlaybackPath(jp,out pk);
                bool exists=File.Exists(jp);
                return new Dictionary<string,object>{{"ok",true},{"exists",exists},{"jobId",jj.id},{"jobPath",jp},{"status",jj.status},{"pathKind",pk}};
            }
            case "play_file": {
                // CoApp owns playback file resolution. Job.path is the only authoritative
                // playback path; the UI-supplied path is never used as a path fallback.
                string p="";
                string jobPath="";
                string resolutionSource="job.path";

                Job jj=null;
                if(!String.IsNullOrWhiteSpace(r.jobId)) jj=LoadJob(JobPath(r.jobId));
                // CoApp is authoritative for playback target selection.
                if(jj==null && (!String.IsNullOrWhiteSpace(r.itemId)||!String.IsNullOrWhiteSpace(r.mediaUrl)||!String.IsNullOrWhiteSpace(r.identityUrl))) {
                    var requestItem=new Item{itemId=r.itemId,mediaUrl=r.mediaUrl,identityUrl=r.identityUrl};
                    jj=FindAuthoritativeJob(requestItem);
                    if(jj!=null) r.jobId=jj.id;
                }
                if(jj==null) throw new ArgumentException("CoAppで再生対象のJobを特定できません。");

                jobPath=(jj.path??"").Trim().Trim('"');
                if(String.IsNullOrWhiteSpace(jobPath))
                    throw new FileNotFoundException("Job.path が存在しません。",jobPath);

                string pathKind;
                p=ValidateAndNormalizePlaybackPath(jobPath,out pathKind);

                if(!File.Exists(p))
                    throw new FileNotFoundException("Job.path の実ファイルが存在しません。",p);
                try{if((File.GetAttributes(p)&FileAttributes.Directory)!=0)throw new IOException("Job.path はディレクトリを指定できません。"+p);}catch(FileNotFoundException){throw;}

                string folder=Path.GetDirectoryName(p)??BaseDir;
                WritePlaybackLog(r.jobId,"REQUEST resolution="+resolutionSource+" pathKind="+pathKind+" path="+p);

                // Primary launch: let Windows Shell resolve the file association via
                // cmd.exe `start`, while the cmd.exe launcher itself is created with
                // CREATE_BREAKAWAY_FROM_JOB. Do not resolve or hard-code a player EXE.
                Exception firstError=null;
                int processId=0;
                string processName="";
                string executablePath="";
                string verification="";
                string processState="";
                bool verified=false;
                bool exited=false;
                int? exitCode=null;

                try{
                    string launcherPath,launcherState,launcherInJob,launchError; int launcherPid; uint? launcherExitCode;
                    int createdPid=StartFileViaCmdBreakaway(p,out launcherPath,out launcherPid,out launcherState,out launcherExitCode,out launcherInJob,out launchError);
                    WritePlaybackLog(r.jobId,"CMD_BREAKAWAY_START launcher="+launcherPath+" pid="+launcherPid+" launcherInJob="+launcherInJob+" state="+launcherState+" exitCode="+(launcherExitCode.HasValue?launcherExitCode.Value.ToString():"unknown"));
                    if(createdPid>0){
                        processId=createdPid;
                        verification=launcherExitCode.HasValue&&launcherExitCode.Value==0?"cmd_start_exit_0":"cmd_start_accepted";
                        processState=launcherState;
                        processName="cmd";
                        executablePath=launcherPath;
                        WritePlaybackLog(r.jobId,"CMD_BREAKAWAY_JOB_MEMBERSHIP coAppPid="+Process.GetCurrentProcess().Id+" coAppInJob="+JobMembership(Process.GetCurrentProcess())+" launcherPid="+createdPid+" launcherInJob="+launcherInJob);
                        WritePlaybackLog(r.jobId,"CMD_BREAKAWAY_RESULT pid="+createdPid+" state="+processState+" verification="+verification+" exitCode="+(launcherExitCode.HasValue?launcherExitCode.Value.ToString():"unknown"));
                        return new Dictionary<string,object>{{"ok",true},{"exists",true},{"path",p},{"resolutionSource",resolutionSource},{"launchMethod","cmd.exe-start-breakaway"},{"processId",createdPid},{"processName",processName},{"executablePath",executablePath},{"processState",processState},{"verification",verification},{"playbackConfirmed",true}};
                    }
                    firstError=new InvalidOperationException(launchError);
                    WritePlaybackLog(r.jobId,"CMD_BREAKAWAY_FAILED error="+launchError);
                }catch(Exception ex){firstError=ex;WritePlaybackLog(r.jobId,"CMD_BREAKAWAY_EXCEPTION error="+ex.GetType().Name+": "+ex.Message);}

                // Fallback 1: start explorer.exe itself outside the CoApp/Firefox job.
                // Explorer then asks Windows for the file association. This keeps the
                // launcher outside the parent Job object even when cmd.exe breakaway is
                // unavailable, preventing the playback process from being killed with CoApp.
                try{
                    string explorerPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"explorer.exe");
                    if(!File.Exists(explorerPath))explorerPath=Path.Combine(Environment.SystemDirectory,"explorer.exe");
                    var si=new STARTUPINFO();si.cb=Marshal.SizeOf(typeof(STARTUPINFO));si.dwFlags=1;si.wShowWindow=1;
                    PROCESS_INFORMATION pi;var cmd=new StringBuilder(Q(explorerPath)+" "+Q(p));
                    uint flags=CREATE_BREAKAWAY_FROM_JOB|CREATE_NEW_PROCESS_GROUP|CREATE_UNICODE_ENVIRONMENT;
                    if(CreateProcess(explorerPath,cmd,IntPtr.Zero,IntPtr.Zero,false,flags,IntPtr.Zero,folder,ref si,out pi)){
                        int explorerPid=pi.dwProcessId;CloseHandle(pi.hThread);CloseHandle(pi.hProcess);
                        string inJob="unknown";try{using(var ep=Process.GetProcessById(explorerPid)){inJob=JobMembership(ep);}}catch{}
                        WritePlaybackLog(r.jobId,"EXPLORER_BREAKAWAY_START pid="+explorerPid+" inJob="+inJob);
                        return new Dictionary<string,object>{{"ok",true},{"exists",true},{"path",p},{"resolutionSource",resolutionSource},{"launchMethod","explorer.exe-breakaway"},{"processId",explorerPid},{"processName","explorer"},{"executablePath",explorerPath},{"processState","started"},{"verification","breakaway_launcher_started"},{"playbackConfirmed",true}};
                    }
                    firstError=new InvalidOperationException("CreateProcess(explorer.exe breakaway) failed Win32="+Marshal.GetLastWin32Error());
                }catch(Exception ex){firstError=ex;WritePlaybackLog(r.jobId,"EXPLORER_BREAKAWAY_EXCEPTION error="+ex.GetType().Name+": "+ex.Message);}

                // Fallback 2: preserve the existing generic Windows association path.
                // This is used only after both detached launch methods fail.
                try{
                    Process launched=Process.Start(new ProcessStartInfo{FileName=p,WorkingDirectory=folder,UseShellExecute=true,Verb="open"});
                    if(launched==null){firstError=new InvalidOperationException("Process.Start returned no process.");}
                    else{
                        try{processId=launched.Id;}catch{}
                        WritePlaybackLog(r.jobId,"PROCESS_START pid="+processId);
                        string coAppJob=JobMembership(Process.GetCurrentProcess()); string playerJob=JobMembership(launched);
                        WritePlaybackLog(r.jobId,"JOB_MEMBERSHIP coappPid="+Process.GetCurrentProcess().Id+" coAppInJob="+coAppJob+" playerPid="+processId+" playerInJob="+playerJob);
                        verified=false;exited=false;exitCode=null;processName="";executablePath="";processState="";verification="";
                        for(int i=0;i<14;i++){Thread.Sleep(150);try{using(Process observed=Process.GetProcessById(processId)){observed.Refresh();processName=observed.ProcessName??"";try{executablePath=observed.MainModule==null?"":(observed.MainModule.FileName??"");}catch{}if(observed.HasExited){exited=true;try{exitCode=observed.ExitCode;}catch{};processState="exited";break;}processState=observed.MainWindowHandle!=IntPtr.Zero?"alive_with_window":"alive";WritePlaybackLog(r.jobId,"PID_POLL pid="+processId+" state="+processState+" name="+processName+" exe="+executablePath);if(observed.MainWindowHandle!=IntPtr.Zero){verified=true;verification="pid_alive_with_window";break;}}}catch(ArgumentException){exited=true;processState="pid_not_found";break;}catch(Exception ex){firstError=ex;processState="monitor_error";break;}}
                        if(!exited&&!verified){try{using(Process observed=Process.GetProcessById(processId)){observed.Refresh();if(!observed.HasExited){verified=true;verification="pid_alive";processState=observed.MainWindowHandle!=IntPtr.Zero?"alive_with_window":"alive";}else{exited=true;processState="exited";try{exitCode=observed.ExitCode;}catch{}}}}catch{}}
                        try{launched.Dispose();}catch{} WritePlaybackLog(r.jobId,"PROCESS_RESULT pid="+processId+" verified="+verified+" state="+processState+" name="+processName+" exe="+executablePath);
                        if(verified){MonitorDetachedPlaybackPid(r.jobId,processId,processName,executablePath);return new Dictionary<string,object>{{"ok",true},{"exists",true},{"path",p},{"resolutionSource",resolutionSource},{"launchMethod","Process.Start"},{"processId",processId},{"processName",processName},{"executablePath",executablePath},{"processState",processState},{"verification",verification},{"playbackConfirmed",true}};}
                        if(exited&&firstError==null)firstError=new InvalidOperationException("起動したPID "+processId+" のプロセスが終了しました。ExitCode="+(exitCode.HasValue?exitCode.Value.ToString():"unknown")+" / ProcessName="+processName+" / ExecutablePath="+executablePath);
                    }
                }catch(Exception ex){firstError=ex;}

                // Fallback 2: direct Windows association API. >32 means Windows
                // accepted the request; unlike Process.Start, ShellExecuteW cannot
                // reliably expose the associated player's process for verification.
                try{
                    IntPtr result=ShellExecuteW(IntPtr.Zero,"open",p,null,folder,1);
                    long code=result.ToInt64();
                    if(code>32){
                        WritePlaybackLog(r.jobId,"SHELLEXECUTE_ACCEPTED code="+code);
                        return new Dictionary<string,object>{{"ok",true},{"exists",true},{"path",p},{"resolutionSource",resolutionSource},{"launchMethod","ShellExecuteW"},{"launchCode",code},{"verification","shell_execute_accepted"},{"playbackConfirmed",true}};
                    }
                    firstError=new InvalidOperationException("ShellExecuteW returned code "+code+".");
                }catch(Exception ex){firstError=ex;}

                // Final fallback: Explorer asks Windows to open the file using its
                // registered association. A returned Process object means explorer.exe
                // itself started; it does not claim that the player consumed the file.
                try{
                    Process explorer=Process.Start(new ProcessStartInfo{
                        FileName="explorer.exe",
                        Arguments=Q(p),
                        UseShellExecute=false,
                        CreateNoWindow=true
                    });
                    if(explorer!=null){
                        int explorerPid=0;
                        try{explorerPid=explorer.Id;}catch{}
                        WritePlaybackLog(r.jobId,"EXPLORER_STARTED pid="+explorerPid);
                        try{explorer.Dispose();}catch{}
                        return new Dictionary<string,object>{{"ok",true},{"exists",true},{"path",p},{"resolutionSource",resolutionSource},{"launchMethod","explorer.exe"},{"processId",explorerPid},{"verification","explorer_process_started"},{"playbackConfirmed",true}};
                    }
                    firstError=new InvalidOperationException("explorer.exe returned no process.");
                }catch(Exception ex){firstError=ex;}

                WritePlaybackLog(r.jobId,"FAILED error="+(firstError==null?"unknown":firstError.Message));
                throw new InvalidOperationException("動画プレイヤーの起動に失敗しました。cmd.exe-start-breakaway / Process.Start / ShellExecuteW / explorer.exe のすべてが失敗しました。最後のエラー: "+(firstError==null?"unknown":firstError.Message));
            }
            case "jobs": return GetFullState();
            case "get_full_state": return GetFullState();
            case "cancel_downloads": {
                var targets=new HashSet<string>((r.jobIds??new List<string>()).Where(x=>!String.IsNullOrWhiteSpace(x)),StringComparer.OrdinalIgnoreCase);
                int cancelled=0;
                if(targets.Count==0) return new Dictionary<string,object>{{"ok",true},{"cancelled",0}};
                var coordinators=new HashSet<int>();
                foreach(Job j in LoadJobs()) if(targets.Contains(j.id)&&j.coordinatorProcessId>0&&j.coordinatorProcessId!=Process.GetCurrentProcess().Id) coordinators.Add(j.coordinatorProcessId);
                foreach(int cpid in coordinators){try{if(ProcessAlive(cpid))Process.GetProcessById(cpid).Kill();}catch{}}
                foreach(Job j in LoadJobs()) {
                    if(!targets.Contains(j.id)) continue;
                    if(j.status!="queued"&&j.status!="starting"&&j.status!="downloading") continue;
                    try { if(j.processId>0&&ProcessAlive(j.processId)){ try { Process.GetProcessById(j.processId).Kill(); } catch {} } } catch {}
                    try { UpdateJob(j,"cancelled",j.progress,j.path,j.folder,"Cancelled by user."); cancelled++; } catch {}
                }
                return new Dictionary<string,object>{{"ok",true},{"cancelled",cancelled}};
            }
            case "clear_history": {
                var remove=new List<string>(); int deleted=0;
                foreach(Job j in LoadJobs()) {
                    if(j.status=="completed"||j.status=="exist"||j.status=="failed"||j.status=="cancelled") { remove.Add(j.id); try{File.Delete(JobPath(j.id));deleted++;}catch{} }
                }
                RemoveStateJobs(remove);
                return new Dictionary<string,object>{{"ok",true},{"deleted",deleted}};
            }
            case "clear_logs": {
                int deleted=0;
                if(Directory.Exists(JobsDir)) {
                    foreach(string f in Directory.GetFiles(JobsDir,"*.log")) { try { File.Delete(f); deleted++; } catch {} }
                    foreach(string f in Directory.GetFiles(JobsDir,"batch-*.start")) { try { File.Delete(f); deleted++; } catch {} }
                }
                return new Dictionary<string,object>{{"ok",true},{"deleted",deleted}};
            }
            case "uninstall": {
                try { using(var key=Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Mozilla\NativeMessagingHosts\universal_video_detector_companion",true)){} Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Mozilla\NativeMessagingHosts\universal_video_detector_companion",false); } catch {}
                return new Dictionary<string,object>{{"ok",true},{"path",BaseDir}};
            }
            case "check_files": return new Dictionary<string,object>{{"ok",true},{"files",CheckFiles(r.paths)}};
            case "check_existing_downloads": {
                if(String.IsNullOrWhiteSpace(r.rootDirectory)) return new Dictionary<string,object>{{"ok",false},{"error","Download root is empty"},{"files",new List<Dictionary<string,object>>()}};
                var found=new List<Dictionary<string,object>>();
                string checkHost=Safe(r.site==null?"unknown-site":r.site.host,"unknown-site");
                string batchPageTitle=BatchPageTitle(r);
                foreach(Item item in r.items??new List<Item>()){
                    if(item==null) continue;
                    string folderName;
                    if(String.Equals(r.folderNaming,"sequence",StringComparison.OrdinalIgnoreCase)) {
                        folderName=FindExistingSequenceFolder(item,r.site);
                        if(String.IsNullOrWhiteSpace(folderName)) continue;
                    } else folderName=DownloadFolderName(r,item,batchPageTitle);
                    string folder=Path.Combine(r.rootDirectory,folderName);
                    string name=Safe(!String.IsNullOrWhiteSpace(item.filename)?item.filename:item.name,"video");
                    string type=(item.type??"").ToLowerInvariant();
                    if(type=="hls"||type=="dash"||!Path.HasExtension(name)) name=Path.GetFileNameWithoutExtension(name)+".mp4";
                    string requestedPath=Path.Combine(folder,name);
                    bool exists=false;
                    try{exists=File.Exists(requestedPath)&&new FileInfo(requestedPath).Length>0;}catch{}
                    if(exists){
                        Job ej=CreateExistingJob(item,requestedPath,folder);
                        found.Add(new Dictionary<string,object>{{"itemId",item.itemId},{"jobId",ej==null?"":ej.id},{"mediaUrl",MediaUrl(item)},{"identityUrl",item.identityUrl},{"path",requestedPath},{"folder",folder},{"status","exist"},{"exists",true}});
                    }
                }
                return new Dictionary<string,object>{{"ok",true},{"files",found}};
            }
            case "download": {
                if(String.IsNullOrWhiteSpace(r.rootDirectory)) return new Dictionary<string,object>{{"ok",false},{"error","Download root is empty"}};
                if(r.items==null||r.items.Count==0) return new Dictionary<string,object>{{"ok",false},{"error","No download items were supplied."}};
                Directory.CreateDirectory(r.rootDirectory); Directory.CreateDirectory(JobsDir); Directory.CreateDirectory(Path.Combine(BaseDir,"jobitems"));
                var ids=new List<string>();
                int childPid=0;
                string launchDetail="";
                var skippedExisting=new List<Dictionary<string,object>>();
                string batchPageTitle=BatchPageTitle(r);
                string duplicateMode=String.Equals(r.duplicateFileMode,"number",StringComparison.OrdinalIgnoreCase)?"number":"exist";
                var requestItems=new List<Item>();
                foreach(Item candidate in r.items){
                    if(candidate==null) continue;
                    bool duplicateInRequest=false;
                    foreach(Item existing in requestItems){ if(SameItemIdentity(existing,candidate)){ duplicateInRequest=true; break; } }
                    if(!duplicateInRequest) requestItems.Add(candidate);
                }
                foreach(Item item in requestItems){
                    if(item==null) continue;
                    string id=Guid.NewGuid().ToString("N");
                    string host=Safe(r.site==null?"unknown-site":r.site.host,"unknown-site");
                    if(String.IsNullOrWhiteSpace(MediaUrl(item))){
                        Job ej=new Job{id=id,itemId=item.itemId,mediaUrl="",identityUrl=item.identityUrl,name=String.IsNullOrWhiteSpace(item.name)?item.filename:item.name,type=item.type,status="failed",progress=0,path="",folder="",error="Download URL is empty.",ffmpegPath=ResolveFfmpeg(r.ffmpegPath),processId=0,coordinatorProcessId=0,createdAt=Now(),updatedAt=Now(),completedAt=0,batchId=String.IsNullOrWhiteSpace(r.batchId)?"":r.batchId,pageIdentity=CloneIdentity(item),videoIdentity=item.videoIdentity,itemDataPath="",logPath=Path.Combine(BaseDir,"jobs",id+".log")};
                        SaveJob(ej);
                        try { File.AppendAllText(ej.logPath,Now()+" INVALID_ITEM Download URL is empty."+Environment.NewLine,Encoding.UTF8); } catch {}
                        continue;
                    }
                    // Reconcile an authoritative completed/exist job against the
                    // real filesystem before deciding that a video is already done.
                    // If the file disappeared, retain the job identity/folder mapping
                    // and resume it instead of creating a new job/folder.
                    Job authoritative=FindAuthoritativeJob(item);
                    if(authoritative!=null){
                        if((authoritative.status=="completed"||authoritative.status=="exist")&&HasValidFile(authoritative.path)){
                            if(duplicateMode=="exist"){
                                if(!String.IsNullOrWhiteSpace(r.batchId)) {
                                    string eid=Guid.NewGuid().ToString("N");
                                    Job ej=new Job{id=eid,itemId=item.itemId,mediaUrl=MediaUrl(item),identityUrl=item.identityUrl,name=String.IsNullOrWhiteSpace(item.name)?item.filename:item.name,type=item.type,status="exist",progress=100,path=authoritative.path,folder=authoritative.folder,error="",ffmpegPath=ResolveFfmpeg(r.ffmpegPath),processId=0,coordinatorProcessId=0,createdAt=Now(),updatedAt=Now(),completedAt=Now(),batchId=r.batchId,pageIdentity=CloneIdentity(item),videoIdentity=item.videoIdentity,itemDataPath="",logPath=Path.Combine(BaseDir,"jobs",eid+".log")};
                                    SaveJob(ej);
                                    skippedExisting.Add(new Dictionary<string,object>{{"itemId",ej.itemId},{"mediaUrl",ej.mediaUrl},{"identityUrl",ej.identityUrl},{"path",ej.path},{"folder",ej.folder},{"status","exist"},{"jobId",ej.id},{"batchId",ej.batchId},{"redownloadWarning",true}});
                                } else {
                                    authoritative.status="exist";authoritative.progress=100;authoritative.error="";authoritative.completedAt=authoritative.completedAt>0?authoritative.completedAt:Now();SaveJob(authoritative);
                                    skippedExisting.Add(new Dictionary<string,object>{{"itemId",item.itemId},{"mediaUrl",MediaUrl(item)},{"identityUrl",item.identityUrl},{"path",authoritative.path},{"folder",authoritative.folder},{"status","exist"},{"jobId",authoritative.id},{"batchId",authoritative.batchId},{"redownloadWarning",true}});
                                }
                                continue;
                            }
                        }
                        if(authoritative.status=="missing"||((authoritative.status=="completed"||authoritative.status=="exist")&&!HasValidFile(authoritative.path))){
                            string reuseFolder=authoritative.folder??"";
                            string reusePath=authoritative.path??"";
                            // A new batch must have one page folder. Do not inherit a
                            // stale folder from an older job when the output was deleted.
                            if(!String.IsNullOrWhiteSpace(r.batchId)) {
                                reuseFolder=Path.Combine(r.rootDirectory,DownloadFolderName(r,item,batchPageTitle));
                                reusePath="";
                            }
                            if(!String.IsNullOrWhiteSpace(reuseFolder))Directory.CreateDirectory(reuseFolder);
                            authoritative.pageIdentity=CloneIdentity(item);authoritative.videoIdentity=item.videoIdentity;authoritative.itemId=item.itemId;authoritative.mediaUrl=MediaUrl(item);authoritative.identityUrl=item.identityUrl;authoritative.name=String.IsNullOrWhiteSpace(item.name)?item.filename:item.name;authoritative.type=item.type;
                            authoritative.batchId=String.IsNullOrWhiteSpace(r.batchId)?authoritative.batchId:r.batchId;
                            string itemPathReuse=Path.Combine(BaseDir,"jobitems",authoritative.id+".json");
                            File.WriteAllText(itemPathReuse,Json.Serialize(item),new UTF8Encoding(false));
                            authoritative.itemDataPath=itemPathReuse;
                            if(String.IsNullOrWhiteSpace(reusePath)){
                                string fallbackFolder=String.IsNullOrWhiteSpace(reuseFolder)?Path.Combine(r.rootDirectory,DownloadFolderName(r,item,batchPageTitle)):reuseFolder;
                                Directory.CreateDirectory(fallbackFolder);
                                string nm=Safe(!String.IsNullOrWhiteSpace(item.filename)?item.filename:item.name,"video");
                                string tp=(item.type??"").ToLowerInvariant();if(tp=="hls"||tp=="dash"||!Path.HasExtension(nm))nm=Path.GetFileNameWithoutExtension(nm)+".mp4";
                                reusePath=Path.Combine(fallbackFolder,nm);authoritative.folder=fallbackFolder;
                            }
                            authoritative.path=reusePath;authoritative.status="queued";authoritative.progress=0;authoritative.error="";authoritative.processId=0;authoritative.coordinatorProcessId=0;authoritative.completedAt=0;SaveJob(authoritative);ids.Add(authoritative.id);
                            continue;
                        }
                    }
                    string folderName=DownloadFolderName(r,item,batchPageTitle);
                    string folder=Path.Combine(r.rootDirectory,folderName);
                    Directory.CreateDirectory(folder);
                    string name=Safe(!String.IsNullOrWhiteSpace(item.filename)?item.filename:item.name,"video");
                    string type=(item.type??"").ToLowerInvariant();
                    if(type=="hls"||type=="dash"||!Path.HasExtension(name)) name=Path.GetFileNameWithoutExtension(name)+".mp4";
                    string requestedPath=Path.Combine(folder,name);
                    if(duplicateMode=="number") requestedPath=Unique(requestedPath);
                    if(duplicateMode=="exist" && File.Exists(requestedPath)){
                        // The same filename does not mean the same video. This is common
                        // on galleries where every entry is named 4.mp4, 1.mp4, etc.
                        // Find a video-level authoritative job before declaring EXIST.
                        Job pathOwner=FindAuthoritativeJob(item);
                        bool sameExisting=pathOwner!=null&&HasValidFile(pathOwner.path)&&String.Equals(Path.GetFullPath(pathOwner.path),Path.GetFullPath(requestedPath),StringComparison.OrdinalIgnoreCase);
                        if(sameExisting){
                            string eid=Guid.NewGuid().ToString("N");
                            Job ej=new Job{id=eid,itemId=item.itemId,mediaUrl=MediaUrl(item),identityUrl=item.identityUrl,name=String.IsNullOrWhiteSpace(item.name)?item.filename:item.name,type=item.type,status="exist",progress=100,path=requestedPath,folder=folder,error="",ffmpegPath=ResolveFfmpeg(r.ffmpegPath),processId=0,coordinatorProcessId=0,createdAt=Now(),updatedAt=Now(),completedAt=Now(),batchId=String.IsNullOrWhiteSpace(r.batchId)?"":r.batchId,pageIdentity=CloneIdentity(item),videoIdentity=item.videoIdentity,itemDataPath="",logPath=Path.Combine(BaseDir,"jobs",eid+".log")};
                            SaveJob(ej);
                            skippedExisting.Add(new Dictionary<string,object>{{"itemId",ej.itemId},{"mediaUrl",ej.mediaUrl},{"identityUrl",ej.identityUrl},{"path",requestedPath},{"folder",folder},{"status","exist"},{"jobId",eid},{"batchId",ej.batchId}});
                            continue;
                        }
                        requestedPath=Unique(requestedPath);
                    }
                    string itemPath=Path.Combine(BaseDir,"jobitems",id+".json");
                    string raw=Json.Serialize(item);
                    if(String.IsNullOrWhiteSpace(raw)||raw=="null") throw new Exception("Failed to serialize download item "+id);
                    File.WriteAllText(itemPath,raw,new UTF8Encoding(false));
                    if(!File.Exists(itemPath)||new FileInfo(itemPath).Length==0) throw new IOException("Download item file was not written: "+itemPath);
                    Job j=new Job{id=id,itemId=item.itemId,mediaUrl=MediaUrl(item),identityUrl=item.identityUrl,name=String.IsNullOrWhiteSpace(item.name)?item.filename:item.name,type=item.type,status="queued",progress=0,path=requestedPath,folder=folder,error="",ffmpegPath=ResolveFfmpeg(r.ffmpegPath),processId=0,coordinatorProcessId=0,createdAt=Now(),updatedAt=Now(),completedAt=0,batchId=String.IsNullOrWhiteSpace(r.batchId)?"":r.batchId,pageIdentity=CloneIdentity(item),videoIdentity=item.videoIdentity,itemDataPath=itemPath,logPath=Path.Combine(BaseDir,"jobs",id+".log")};
                    SaveJob(j);
                    try {
                        // The Coordinator owns state transitions after the job is published.
                        // Do not write starting here: that would let the Native Messaging
                        // process race with the Coordinator over the same Job state.
                        ids.Add(id);
                    } catch(Exception ex) {
                        UpdateJob(j,"failed",0,"",folder,"Worker preparation failed: "+ex.GetType().Name+": "+ex.Message);
                    }
                }
                if(ids.Count>0) {
                    if(!File.Exists(WorkerExe)) throw new FileNotFoundException("Download worker executable not found.",WorkerExe);
                    int concurrency=Math.Max(1,Math.Min(99,r.parallelDownloads<=0?3:r.parallelDownloads));
                    string coordinatorExe=Environment.GetCommandLineArgs()[0];
                    string coordinatorArgs="--coordinator "+String.Join(" ",ids.Select(Q))+" --concurrency "+concurrency;
                    launchDetail=""; childPid=StartWorkerDetached(coordinatorExe,coordinatorArgs,out launchDetail);
                    if(childPid<=0) { foreach(string id in ids){try{Job j=LoadJob(JobPath(id));if(j!=null)UpdateJob(j,"failed",0,j.path,j.folder,"CoApp coordinator could not be started. "+launchDetail);}catch{}} throw new Exception("CoApp coordinator could not be started. "+launchDetail); }
                    foreach(string id in ids){try{Job j=LoadJob(JobPath(id));if(j!=null){j.coordinatorProcessId=childPid;SaveJob(j);}}catch{}}
                }
                var jobItems=new List<Dictionary<string,object>>();
                foreach(string id in ids){ try { Job jj=LoadJob(JobPath(id)); if(jj!=null) jobItems.Add(new Dictionary<string,object>{{"jobId",jj.id},{"itemId",jj.itemId},{"mediaUrl",jj.mediaUrl},{"identityUrl",jj.identityUrl}}); } catch {} }
                var returnedJobs=new List<Dictionary<string,object>>(); foreach(string jid in ids){try{Job jj=LoadJob(JobPath(jid)); if(jj!=null)returnedJobs.Add(JobMap(jj));}catch{}} return new Dictionary<string,object>{{"ok",ids.Count>0||skippedExisting.Count>0},{"jobIds",ids},{"jobItems",jobItems},{"jobs",returnedJobs},{"queued",ids.Count},{"skippedExisting",skippedExisting},{"workerPid",childPid},{"workerLaunch",launchDetail}};
            }
            default:return new Dictionary<string,object>{{"ok",false},{"error","Unknown action: "+r.action}};
        }
    }

    [STAThread] public static void Main(string[] args) {
        if(args!=null&&args.Length>=1&&String.Equals(args[0],"--self-test",StringComparison.OrdinalIgnoreCase)){Console.Write("UVD-COAPP-OK");return;}
        if(args!=null&&args.Length>=1&&String.Equals(args[0],"--version",StringComparison.OrdinalIgnoreCase)){Console.Write(Version);return;}
        if(args!=null&&args.Length>=1&&String.Equals(args[0],"--worker-self-test",StringComparison.OrdinalIgnoreCase)){Console.Write("UVD-WORKER-OK");return;}
        if(args!=null&&args.Length>=2&&String.Equals(args[0],"--worker",StringComparison.OrdinalIgnoreCase)){Worker(JobPath(args[1]));return;}
        if(args!=null&&args.Length>=2&&String.Equals(args[0],"--worker-id",StringComparison.OrdinalIgnoreCase)){Worker(JobPath(args[1]));return;}
        if(args!=null&&args.Length>=2&&String.Equals(args[0],"--coordinator",StringComparison.OrdinalIgnoreCase)){
            int concurrency=3; var ids=new List<string>();
            for(int i=1;i<args.Length;i++){if(String.Equals(args[i],"--concurrency",StringComparison.OrdinalIgnoreCase)&&i+1<args.Length){int.TryParse(args[++i],out concurrency);}else ids.Add(args[i]);}
            Coordinator(ids.ToArray(),concurrency); return;
        }
        if(args!=null&&args.Length>=1)StartedExtensionId=args[0]??"";
        try { byte[] body=NativeProtocol.ReadMessage(Console.OpenStandardInput()); if(body==null)return; Request request;try{request=Json.Deserialize<Request>(new UTF8Encoding(false,true).GetString(body));}catch(Exception ex){Send(new Dictionary<string,object>{{"ok",false},{"error","JSON parse error: "+ex.Message}});return;}try{Send(Handle(request));}catch(Exception ex){Log(ex.ToString());Send(new Dictionary<string,object>{{"ok",false},{"error",ex.Message},{"version",Version}});} }
        catch(Exception ex){Log("Native messaging fatal error: "+ex.ToString());}
    }
}
