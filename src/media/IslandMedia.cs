// Media bridge for the island, built with the .NET Framework csc that ships with Windows.
// stdin:  one command per line: toggle | next | prev | volup | voldown | mute | vol <0-100>
// stdout: the current media session + system volume as one JSON line, whenever it changes.
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
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

        string last = null;
        while (true)
        {
            try
            {
                var json = Status();
                if (json != last)
                {
                    stdout.WriteLine(json);
                    stdout.Flush();
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
                var s = Pick();
                if (s == null) continue;
                lock (pickLock) lastCommand = DateTime.UtcNow;
                switch (cmd)
                {
                    case "toggle": Await(s.TryTogglePlayPauseAsync()); break;
                    case "next": Await(s.TrySkipNextAsync()); break;
                    case "prev": Await(s.TrySkipPreviousAsync()); break;
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

    static GlobalSystemMediaTransportControlsSession Pick()
    {
        lock (pickLock)
        {
            var current = manager.GetCurrentSession();
            GlobalSystemMediaTransportControlsSession pin = null;
            GlobalSystemMediaTransportControlsSession playing = current != null && IsPlaying(current) ? current : null;
            foreach (var s in manager.GetSessions())
            {
                if (s.SourceAppUserModelId == pinned) pin = s;
                if (playing == null && IsPlaying(s)) playing = s;
            }
            bool recentCommand = (DateTime.UtcNow - lastCommand).TotalSeconds < 60;
            if (pin != null && (IsPlaying(pin) || recentCommand || playing == null)) return pin;
            var chosen = playing ?? current;
            if (chosen != null) pinned = chosen.SourceAppUserModelId;
            return chosen;
        }
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
    interface IAudioEndpointVolume
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

    static Guid context = Guid.Empty;

    // Fetched each time so switching speakers/headphones just works.
    static IAudioEndpointVolume Endpoint()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(0 /* render */, 1 /* multimedia */, out device) != 0 || device == null) return null;
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
