// Media bridge for the island, built with the .NET Framework csc that ships with Windows.
// stdin:  one command per line: toggle | next | prev
// stdout: the current media session as one JSON line, whenever it changes.
using System;
using System.Globalization;
using System.IO;
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
                var s = manager.GetCurrentSession();
                if (s == null) continue;
                switch (line.Trim())
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

    static string Status()
    {
        var s = manager.GetCurrentSession();
        if (s == null) return "{\"active\":false}";
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
