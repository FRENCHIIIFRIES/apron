// Media bridge for the island, built with the .NET Framework csc that ships with Windows.
// stdin:  one command per line: toggle | next | prev | volup | voldown | mute | vol <0-100>
//         watch on|off | closetab <hwnd> | minimize <hwnd>   (focus lockdown) | micmute
// stdout: the current media session + system volume as one JSON line, whenever it changes.
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Windows.Devices.Enumeration;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

static class IslandMedia
{
    static GlobalSystemMediaTransportControlsSessionManager manager;
    static StreamWriter stdout;
    static StreamReader stdin;
    static readonly AutoResetEvent wake = new AutoResetEvent(false);
    static string artKey = "";
    static string art;
    static int artTries;

    // The AsTask() helpers need the Windows SDK's union metadata to compile, so poll instead.
    static T Await<T>(IAsyncOperation<T> op)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (op.Status == AsyncStatus.Started)
        {
            if (DateTime.UtcNow > deadline) { op.Cancel(); return default(T); }
            Thread.Sleep(5);
        }
        return op.Status == AsyncStatus.Completed ? op.GetResults() : default(T);
    }

    static void Main()
    {
        // Built as a windowless exe (no console flash), so talk to the raw pipes directly.
        var utf8 = new UTF8Encoding(false);
        stdout = new StreamWriter(Console.OpenStandardOutput(), utf8);
        stdin = new StreamReader(Console.OpenStandardInput(), utf8);
        manager = Await(GlobalSystemMediaTransportControlsSessionManager.RequestAsync());
        new Thread(ReadCommands) { IsBackground = true }.Start();
        Privacy.Start();
        Devices.Start();

        string last = null;
        while (true)
        {
            try
            {
                var json = Status();
                if (json != last)
                {
                    Emit(json);
                    last = json;
                }
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.Message);
            }
            wake.WaitOne(1000);
        }
    }

    static void ReadCommands()
    {
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            try
            {
                var cmd = line.Trim();
                if (Volume.Handle(cmd)) { wake.Set(); continue; }
                if (Foreground.Handle(cmd)) continue;
                var s = Pick();
                if (s == null) continue;
                lock (pickLock) lastCommand = DateTime.UtcNow;
                switch (cmd)
                {
                    case "toggle": Await(s.TryTogglePlayPauseAsync()); break;
                    case "next": Await(s.TrySkipNextAsync()); break;
                    case "prev": Await(s.TrySkipPreviousAsync()); break;
                    case "shuffle":
                    {
                        var on = s.GetPlaybackInfo().IsShuffleActive;
                        Await(s.TryChangeShuffleActiveAsync(!(on.HasValue && on.Value)));
                        break;
                    }
                    case "repeat":
                    {
                        // off -> all -> one -> off
                        var mode = s.GetPlaybackInfo().AutoRepeatMode;
                        var next = !mode.HasValue || mode.Value == Windows.Media.MediaPlaybackAutoRepeatMode.None
                            ? Windows.Media.MediaPlaybackAutoRepeatMode.List
                            : mode.Value == Windows.Media.MediaPlaybackAutoRepeatMode.List
                                ? Windows.Media.MediaPlaybackAutoRepeatMode.Track
                                : Windows.Media.MediaPlaybackAutoRepeatMode.None;
                        Await(s.TryChangeAutoRepeatModeAsync(next));
                        break;
                    }
                }
                Thread.Sleep(250);
                wake.Set();
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.Message);
            }
        }
        Environment.Exit(0); // parent went away
    }

    // Windows' "current session" jumps to whatever else is playing the moment you pause
    // (a browser video, say), which would make the next play press go to the wrong app.
    // So stick with the app we're showing: only move to another playing app when ours
    // isn't playing and you haven't pressed a control in the last minute.
    static readonly object pickLock = new object();
    static string pinned;
    static DateTime lastCommand = DateTime.MinValue;

    static bool IsPlaying(GlobalSystemMediaTransportControlsSession s)
    {
        return s.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
    }

    static bool IsBrowser(string id)
    {
        var lower = (id ?? "").ToLowerInvariant();
        foreach (var b in new[] { "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc" })
            if (lower.Contains(b)) return true;
        return false;
    }

    static GlobalSystemMediaTransportControlsSession Pick()
    {
        lock (pickLock)
        {
            var current = manager.GetCurrentSession();
            string currentId = current != null ? current.SourceAppUserModelId : null;
            GlobalSystemMediaTransportControlsSession pin = null;
            GlobalSystemMediaTransportControlsSession best = null;
            int bestScore = -1;
            foreach (var s in manager.GetSessions())
            {
                var id = s.SourceAppUserModelId;
                if (id == pinned) pin = s;
                if (!IsPlaying(s)) continue;
                // Real music apps beat browser tabs (Instagram reels loop forever and
                // count as "playing"); then prefer what Windows considers current.
                int score = (IsBrowser(id) ? 0 : 2) + (id == currentId ? 1 : 0);
                if (score > bestScore) { best = s; bestScore = score; }
            }
            // Right after you press a control, stay on that app even if another starts.
            bool recentCommand = (DateTime.UtcNow - lastCommand).TotalSeconds < 60;
            if (pin != null && recentCommand) return pin;
            if (best != null) { pinned = best.SourceAppUserModelId; return best; }
            if (pin != null) return pin;
            if (current != null) pinned = currentId;
            return current;
        }
    }

    static readonly object writeLock = new object();
    public static void Emit(string line)
    {
        lock (writeLock)
        {
            stdout.WriteLine(line);
            stdout.Flush();
        }
    }

    public static string Str(string value)
    {
        var sb = new StringBuilder();
        Prop(sb, "x", value);
        return sb.ToString().Substring(5); // drop the leading ,"x":
    }

    static string Status()
    {
        var s = Pick();
        if (s == null) return "{\"active\":false" + Volume.Json() + "}";
        var props = Await(s.TryGetMediaPropertiesAsync());
        var info = s.GetPlaybackInfo();
        var tl = s.GetTimelineProperties();
        string title = props != null ? props.Title : "";
        string artist = props != null ? props.Artist : "";

        // Apps often publish the thumbnail a moment after the title, so retry a few times.
        var key = s.SourceAppUserModelId + "|" + title + "|" + artist;
        if (key != artKey) { artKey = key; art = null; artTries = 0; }
        if (art == null && artTries < 5 && props != null)
        {
            artTries++;
            art = ReadArt(props.Thumbnail);
        }

        var sb = new StringBuilder("{\"active\":true");
        Prop(sb, "app", s.SourceAppUserModelId);
        Prop(sb, "title", title);
        Prop(sb, "artist", artist);
        Prop(sb, "album", props != null ? props.AlbumTitle : "");
        sb.Append(",\"playing\":").Append(info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing ? "true" : "false");
        sb.Append(",\"canNext\":").Append(info.Controls.IsNextEnabled ? "true" : "false");
        sb.Append(",\"canPrev\":").Append(info.Controls.IsPreviousEnabled ? "true" : "false");
        sb.Append(",\"canShuffle\":").Append(info.Controls.IsShuffleEnabled ? "true" : "false");
        sb.Append(",\"canRepeat\":").Append(info.Controls.IsRepeatEnabled ? "true" : "false");
        sb.Append(",\"shuffle\":").Append(info.IsShuffleActive.HasValue && info.IsShuffleActive.Value ? "true" : "false");
        Prop(sb, "repeat", info.AutoRepeatMode.HasValue ? info.AutoRepeatMode.Value.ToString().ToLowerInvariant() : "none");
        sb.Append(",\"position\":").Append(tl.Position.TotalSeconds.ToString("0.###", CultureInfo.InvariantCulture));
        sb.Append(",\"duration\":").Append(tl.EndTime.TotalSeconds.ToString("0.###", CultureInfo.InvariantCulture));
        sb.Append(",\"updatedAt\":").Append(tl.LastUpdatedTime.ToUnixTimeMilliseconds());
        Prop(sb, "art", art);
        sb.Append(Volume.Json());
        return sb.Append('}').ToString();
    }

    static string ReadArt(IRandomAccessStreamReference reference)
    {
        if (reference == null) return null;
        try
        {
            var stream = Await(reference.OpenReadAsync());
            if (stream == null || stream.Size == 0 || stream.Size > 8 * 1024 * 1024) return null;
            using (var reader = new DataReader(stream))
            {
                uint loaded = Await(reader.LoadAsync((uint)stream.Size));
                if (loaded == 0) return null;
                var bytes = new byte[loaded];
                reader.ReadBytes(bytes);
                var type = string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType;
                return "data:" + type + ";base64," + Convert.ToBase64String(bytes);
            }
        }
        catch
        {
            return null;
        }
    }

    static void Prop(StringBuilder sb, string name, string value)
    {
        sb.Append(",\"").Append(name).Append("\":");
        if (value == null) { sb.Append("null"); return; }
        sb.Append('"');
        foreach (var c in value)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }
}

// System master volume through Core Audio (IAudioEndpointVolume), so the island can
// show and set the level without popping up the Windows volume flyout.
static class Volume
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int NotUsed_EnumAudioEndpoints();
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr notify);
        int UnregisterControlChangeNotify(IntPtr notify);
        int GetChannelCount(out uint count);
        int SetMasterVolumeLevel(float levelDb, ref Guid context);
        int SetMasterVolumeLevelScalar(float level, ref Guid context);
        int GetMasterVolumeLevel(out float levelDb);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);
        int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
        int GetChannelVolumeLevel(uint channel, out float levelDb);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    public static Guid context = Guid.Empty;

    // Fetched each time so switching speakers/headphones just works.
    // flow 0 = speakers, 1 = microphone; role 0 = console, 1 = multimedia, 2 = communications.
    public static IAudioEndpointVolume Endpoint(int flow = 0, int role = 1)
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(flow, role, out device) != 0 || device == null) return null;
        var iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        if (device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) != 0) return null;
        return o as IAudioEndpointVolume;
    }

    public static bool Handle(string cmd)
    {
        float delta;
        if (cmd == "volup") delta = 0.04f;
        else if (cmd == "voldown") delta = -0.04f;
        else if (cmd == "micmute")
        {
            // Mute (or unmute) the default mic, for calls and for Teams/Meet in class.
            var mic = Endpoint(1, 0);
            if (mic == null) return true;
            bool muted;
            mic.GetMute(out muted);
            mic.SetMute(!muted, ref context);
            var comms = Endpoint(1, 2);
            if (comms != null) comms.SetMute(!muted, ref context);
            Devices.ReportMic();
            return true;
        }
        else if (cmd == "mute")
        {
            var ep = Endpoint();
            if (ep == null) return true;
            bool muted;
            ep.GetMute(out muted);
            ep.SetMute(!muted, ref context);
            return true;
        }
        else if (cmd.StartsWith("vol "))
        {
            int pct;
            if (!int.TryParse(cmd.Substring(4), out pct)) return true;
            var ep = Endpoint();
            if (ep != null) ep.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, pct)) / 100f, ref context);
            return true;
        }
        else return false;

        var e = Endpoint();
        if (e == null) return true;
        float level;
        e.GetMasterVolumeLevelScalar(out level);
        e.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, level + delta)), ref context);
        if (delta > 0) e.SetMute(false, ref context);
        return true;
    }

    public static string Json()
    {
        try
        {
            var e = Endpoint();
            if (e == null) return "";
            float level;
            bool muted;
            e.GetMasterVolumeLevelScalar(out level);
            e.GetMute(out muted);
            return ",\"volume\":" + (int)Math.Round(level * 100) + ",\"muted\":" + (muted ? "true" : "false");
        }
        catch
        {
            return "";
        }
    }
}

// Focus lockdown support: reports the foreground window (title + exe) while watching,
// and can close the active browser tab (Ctrl+W) or minimise a window. The decision of
// what counts as distracting lives in lockdown.js.
static class Foreground
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    static volatile bool watching;
    static Thread thread;

    public static bool Handle(string cmd)
    {
        if (cmd == "watch on")
        {
            watching = true;
            if (thread == null || !thread.IsAlive)
            {
                thread = new Thread(Loop) { IsBackground = true };
                thread.Start();
            }
            return true;
        }
        if (cmd == "watch off") { watching = false; return true; }
        if (cmd.StartsWith("closetab ") || cmd.StartsWith("minimize "))
        {
            long h;
            if (!long.TryParse(cmd.Substring(9), out h)) return true;
            var hwnd = new IntPtr(h);
            // Only act if that window is still in front, so we never hit the wrong one.
            if (GetForegroundWindow() != hwnd) return true;
            if (cmd.StartsWith("minimize "))
            {
                // Ask the window to minimise itself (works for more apps than ShowWindow).
                PostMessage(hwnd, 0x0112 /* WM_SYSCOMMAND */, new IntPtr(0xF020) /* SC_MINIMIZE */, IntPtr.Zero);
                ShowWindow(hwnd, 6 /* SW_MINIMIZE */);
            }
            else
            {
                const uint UP = 2;
                keybd_event(0x11, 0, 0, UIntPtr.Zero); // Ctrl
                keybd_event(0x57, 0, 0, UIntPtr.Zero); // W
                keybd_event(0x57, 0, UP, UIntPtr.Zero);
                keybd_event(0x11, 0, UP, UIntPtr.Zero);
            }
            return true;
        }
        return false;
    }

    static void Loop()
    {
        string last = null;
        while (watching)
        {
            try
            {
                var hwnd = GetForegroundWindow();
                var sb = new StringBuilder(512);
                GetWindowText(hwnd, sb, sb.Capacity);
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                string exe = "";
                try { exe = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
                var line = "{\"fg\":{\"hwnd\":\"" + hwnd.ToInt64() + "\",\"exe\":" + IslandMedia.Str(exe) + ",\"title\":" + IslandMedia.Str(sb.ToString()) + "}}";
                if (line != last) { IslandMedia.Emit(line); last = line; }
            }
            catch { }
            Thread.Sleep(400);
        }
    }
}

// Mic / camera in use, read from Windows' privacy usage records (the same source as
// the microphone icon in the taskbar). An app is "in use" while LastUsedTimeStop is 0.
static class Privacy
{
    const string Root = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\";
    static volatile bool started;

    public static void Start()
    {
        if (started) return;
        started = true;
        new Thread(Loop) { IsBackground = true }.Start();
    }

    static void Collect(Microsoft.Win32.RegistryKey key, System.Collections.Generic.List<string> users)
    {
        if (key == null) return;
        foreach (var name in key.GetSubKeyNames())
        {
            if (name == "NonPackaged") { using (var np = key.OpenSubKey(name)) Collect(np, users); continue; }
            using (var app = key.OpenSubKey(name))
            {
                if (app == null) continue;
                var start = app.GetValue("LastUsedTimeStart");
                var stop = app.GetValue("LastUsedTimeStop");
                if (start is long && (long)start > 0 && stop is long && (long)stop == 0)
                {
                    var label = name.Substring(name.LastIndexOf('#') + 1);
                    bool exe = label.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
                    label = exe ? label.Substring(0, label.Length - 4) : label.Split('_')[0];
                    // A crash leaves the stop time at 0 forever; only trust it if the app still runs.
                    if (exe && System.Diagnostics.Process.GetProcessesByName(label).Length == 0) continue;
                    if (!users.Contains(label)) users.Add(label);
                }
            }
        }
    }

    static string Json(System.Collections.Generic.List<string> items)
    {
        var parts = new System.Collections.Generic.List<string>();
        foreach (var i in items) parts.Add(IslandMedia.Str(i));
        return "[" + string.Join(",", parts.ToArray()) + "]";
    }

    static void Loop()
    {
        string last = null;
        while (true)
        {
            try
            {
                var mic = new System.Collections.Generic.List<string>();
                var cam = new System.Collections.Generic.List<string>();
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Root + "microphone")) Collect(k, mic);
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Root + "webcam")) Collect(k, cam);
                var line = "{\"priv\":{\"mic\":" + Json(mic) + ",\"cam\":" + Json(cam) + "}}";
                if (line != last) { IslandMedia.Emit(line); last = line; }
            }
            catch { }
            Thread.Sleep(1500);
        }
    }
}

// Your phone's battery, over the Bluetooth hands-free link Phone Link uses for calls (phones
// show up as "<name> Hands-Free HF"), and whether the mic is muted.
static class Devices
{
    const string BatteryKey = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";
    const string HfSuffix = " Hands-Free HF";
    const string IsConnected = "System.Devices.Aep.IsConnected";
    static string aepId;
    static string lastMic;
    static readonly object micLock = new object();

    public static void Start()
    {
        new Thread(PhoneLoop) { IsBackground = true }.Start();
        new Thread(() => { while (true) { ReportMic(); Thread.Sleep(1500); } }) { IsBackground = true }.Start();
    }

    static T Wait<T>(IAsyncOperation<T> op, int seconds)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (op.Status == AsyncStatus.Started)
        {
            if (DateTime.UtcNow > deadline) { op.Cancel(); return default(T); }
            Thread.Sleep(20);
        }
        return op.Status == AsyncStatus.Completed ? op.GetResults() : default(T);
    }

    public static void ReportMic()
    {
        try
        {
            var mic = Volume.Endpoint(1, 0);
            bool muted = false;
            if (mic != null) mic.GetMute(out muted);
            var line = "{\"micmuted\":" + (mic == null ? "null" : muted ? "true" : "false") + "}";
            lock (micLock)
            {
                if (line == lastMic) return;
                lastMic = line;
            }
            IslandMedia.Emit(line);
        }
        catch { }
    }

    static void PhoneLoop()
    {
        string last = null;
        while (true)
        {
            try
            {
                string name = null;
                int battery = -1;
                var devs = Wait(DeviceInformation.FindAllAsync("", new[] { BatteryKey }, DeviceInformationKind.Device), 30);
                if (devs != null)
                    foreach (var d in devs)
                    {
                        object b;
                        if (d.Name == null || !d.Name.EndsWith(HfSuffix) || !d.Properties.TryGetValue(BatteryKey, out b) || b == null) continue;
                        name = d.Name.Substring(0, d.Name.Length - HfSuffix.Length);
                        battery = Convert.ToInt32(b);
                        break;
                    }
                if (name == null)
                {
                    if (last != "none") IslandMedia.Emit("{\"phone\":null}");
                    last = "none";
                }
                else
                {
                    var head = "{\"phone\":{\"name\":" + IslandMedia.Str(name) + ",\"battery\":" + battery + ",\"connected\":";
                    // The battery is quick; whether it's connected takes a while the first time.
                    if (aepId == null && last == null) IslandMedia.Emit(head + "null}}");
                    var line = head + Connected(name) + "}}";
                    if (line != last) { IslandMedia.Emit(line); last = line; }
                }
            }
            catch { }
            Thread.Sleep(60000);
        }
    }

    // The battery value stays behind when the phone walks away, so say whether it's here.
    static string Connected(string name)
    {
        try
        {
            if (aepId == null)
            {
                // Slow (Windows checks every paired Bluetooth device), so only done once.
                var aeps = Wait(DeviceInformation.FindAllAsync(
                    "System.Devices.Aep.ProtocolId:=\"{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}\" AND System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#True",
                    new[] { IsConnected }, DeviceInformationKind.AssociationEndpoint), 90);
                if (aeps != null) foreach (var a in aeps) if (a.Name == name) { aepId = a.Id; break; }
                if (aepId == null) return "null";
            }
            var info = Wait(DeviceInformation.CreateFromIdAsync(aepId, new[] { IsConnected }, DeviceInformationKind.AssociationEndpoint), 15);
            object c;
            if (info != null && info.Properties.TryGetValue(IsConnected, out c) && c is bool) return (bool)c ? "true" : "false";
        }
        catch { }
        return "null";
    }
}
