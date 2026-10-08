// Tap-to-talk recorder for Apron. The mic is only opened while you are talking to Apron:
// "start" opens it, the clip ends by itself once you stop speaking (or on "stop"), and the
// clip goes back to Apron as a WAV, which Gemini turns into a command. Nothing is kept.
//
// The mic is captured with WASAPI in Windows' "speech" mode: on laptop mic arrays the
// normal capture path can arrive ~30 dB too quiet, while speech mode is tuned for voice
// and also cancels whatever the laptop's own speakers are playing.
//
// stdin:  start | stop | cancel
// stdout: {"ready":true} {"listening":true} {"level":0-100} {"speech":true}
//         {"clip":"<base64 wav>","ms":N} | {"silent":true} | {"cancelled":true} | {"error":"..."}
// apron-voice.exe --file in.wav runs the same end-of-speech detection over a file (tests).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class ApronVoice
{
    static StreamWriter stdout;
    static readonly object emitLock = new object();

    public static void Emit(string json)
    {
        lock (emitLock)
        {
            stdout.WriteLine(json);
            stdout.Flush();
        }
    }

    public static string Q(string text) { return "\"" + (text ?? "").Replace("\\", "").Replace("\"", "'") + "\""; }

    static void Main(string[] args)
    {
        stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        if (args.Length == 2 && args[0] == "--file")
        {
            RunFile(args[1]);
            return;
        }
        Emit("{\"ready\":true}");
        Session session = null;
        var stdin = new StreamReader(Console.OpenStandardInput());
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            var cmd = line.Trim();
            if (cmd == "start")
            {
                if (session != null && !session.Finished) continue;
                session = new Session(true);
                var mic = new Mic(Environment.GetEnvironmentVariable("APRON_VOICE_MODE") ?? "speech", session);
                session.Mic = mic;
                new Thread(mic.Run) { IsBackground = true }.Start();
            }
            else if (cmd == "stop" && session != null) session.Finish(false);
            else if (cmd == "cancel" && session != null) session.Finish(true);
        }
        if (session != null) session.Finish(true);
    }

    static void RunFile(string path)
    {
        short[] samples;
        try { samples = Wav.Read16kMono(path); }
        catch (Exception e) { Emit("{\"error\":" + Q("bad wav: " + e.Message) + "}"); return; }
        var session = new Session(false);
        var block = new float[Session.Block];
        for (int i = 0; i + Session.Block <= samples.Length && !session.Finished; i += Session.Block)
        {
            for (int j = 0; j < Session.Block; j++) block[j] = samples[i + j] / 32768f;
            session.Feed(block, Session.Block);
        }
        if (!session.Finished) session.Finish(false);
    }
}

// One recording: decides when you started and stopped talking, from loudness relative to
// the room's own noise, then emits the trimmed, levelled clip.
class Session
{
    public const int Block = 320; // 20 ms at 16 kHz
    const int PreRoll = 15; // blocks kept before speech starts (300 ms)
    const int EndSilence = 50; // 1 s of quiet ends the clip
    const int NoSpeechTimeout = 350; // 7 s without speech: give up
    const int MaxBlocks = 500; // 10 s at most

    readonly bool live;
    readonly List<float> audio = new List<float>();
    readonly float[] pending = new float[Block];
    int pendingN;
    int blocks, loudRun, quietRun, speechStart = -1, lastLoud = -1, sinceLevel;
    float floor = -1;
    float voiceLevel; // how loud you got while talking (peak of a ~60 ms average)
    float smooth;
    readonly List<float> firstRms = new List<float>();
    public Mic Mic;
    public bool Finished { get; private set; }
    readonly object gate = new object();

    public Session(bool live)
    {
        this.live = live;
        if (live) ApronVoice.Emit("{\"listening\":true}");
    }

    public void Feed(float[] x, int n)
    {
        lock (gate)
        {
            if (Finished) return;
            for (int i = 0; i < n; i++)
            {
                pending[pendingN++] = x[i];
                if (pendingN == Block)
                {
                    pendingN = 0;
                    OnBlock();
                    if (Finished) return;
                }
            }
        }
    }

    void OnBlock()
    {
        double sum = 0;
        for (int i = 0; i < Block; i++) { audio.Add(pending[i]); sum += pending[i] * pending[i]; }
        float rms = (float)Math.Sqrt(sum / Block);
        blocks++;
        // The room's noise level: the quietest of the first 200 ms, then tracked slowly
        // while you aren't talking.
        if (blocks <= 10)
        {
            firstRms.Add(rms);
            float min = float.MaxValue;
            foreach (var r in firstRms) min = Math.Min(min, r);
            floor = min;
        }
        float start = Math.Max(floor * 3.2f, 0.0025f);
        // Quiet means well below the room *and* well below your own voice, so steady
        // background sound (a fan, a TV) still lets the clip end when you stop.
        float quiet = Math.Max(Math.Max(floor * 2.0f, 0.0018f), voiceLevel * 0.25f);
        if (speechStart < 0 && blocks > 10 && rms < start) floor = floor * 0.97f + rms * 0.03f;

        smooth = smooth * 0.6f + rms * 0.4f;
        if (rms >= start) { loudRun++; lastLoud = blocks; } else loudRun = 0;
        if (speechStart >= 0 || loudRun >= 3) voiceLevel = Math.Max(voiceLevel, smooth);
        if (speechStart < 0 && loudRun >= 3)
        {
            speechStart = blocks - 3;
            if (live) ApronVoice.Emit("{\"speech\":true}");
        }
        if (speechStart >= 0) quietRun = rms < quiet ? quietRun + 1 : 0;

        if (live && ++sinceLevel >= 3)
        {
            sinceLevel = 0;
            double db = 20 * Math.Log10(Math.Max(rms, 1e-6) / Math.Max(floor, 1e-5));
            ApronVoice.Emit("{\"level\":" + (int)Math.Max(0, Math.Min(100, db * 4)) + "}");
        }

        if (speechStart >= 0 && quietRun >= EndSilence) Finish(false);
        else if (speechStart < 0 && blocks >= NoSpeechTimeout) Finish(false);
        else if (blocks >= MaxBlocks) Finish(false);
    }

    public void Finish(bool cancelled)
    {
        lock (gate)
        {
            if (Finished) return;
            Finished = true;
            if (Mic != null) Mic.Stop();
            if (cancelled) { ApronVoice.Emit("{\"cancelled\":true}"); return; }
            if (speechStart < 0) { ApronVoice.Emit("{\"silent\":true}"); return; }
            int from = Math.Max(0, speechStart - PreRoll) * Block;
            int to = Math.Min(audio.Count, (Math.Max(lastLoud, speechStart) + PreRoll) * Block);
            float peak = 0;
            for (int i = from; i < to; i++) peak = Math.Max(peak, Math.Abs(audio[i]));
            float gain = Math.Min(30f, 0.7f / Math.Max(peak, 1e-4f));
            var pcm = new short[to - from];
            for (int i = 0; i < pcm.Length; i++) pcm[i] = (short)(Math.Max(-1f, Math.Min(1f, audio[from + i] * gain)) * 32767);
            ApronVoice.Emit("{\"clip\":\"" + Convert.ToBase64String(Wav.Bytes(pcm)) + "\",\"ms\":" + pcm.Length / 16 + "}");
        }
    }
}

// WASAPI capture of the default mic, converted to 16 kHz mono floats for one Session.
class Mic
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("726778CD-F60A-4eda-82DE-E47610CD78AA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient2
    {
        [PreserveSig] int Initialize(int shareMode, int flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long def, out long min);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        [PreserveSig] int IsOffloadCapable(int category, out int capable);
        [PreserveSig] int SetClientProperties(ref ClientProperties props);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ClientProperties { public int cbSize; public int bIsOffload; public int eCategory; public int Options; }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong qpc);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    const int CategorySpeech = 9, OptionRaw = 1;
    static readonly Guid FloatSubtype = new Guid("00000003-0000-0010-8000-00aa00389b71");

    readonly string mode;
    readonly Session session;
    volatile bool stopped;

    public Mic(string mode, Session session) { this.mode = mode; this.session = session; }

    public void Stop() { stopped = true; }

    public void Run()
    {
        try
        {
            Capture();
        }
        catch (Exception e)
        {
            ApronVoice.Emit("{\"error\":" + ApronVoice.Q("mic: " + e.Message) + "}");
            session.Finish(true);
        }
    }

    static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " failed 0x" + hr.ToString("X8")); }

    void Capture()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        Check(enumerator.GetDefaultAudioEndpoint(1 /* capture */, 0 /* console */, out device), "no microphone:");
        var iid = typeof(IAudioClient2).GUID;
        object o;
        Check(device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o), "open mic");
        var client = (IAudioClient2)o;
        // Speech mode where the driver offers it, else raw (no effects), else the normal path.
        string used = "default";
        foreach (var m in mode == "speech" ? new[] { "speech", "raw" } : mode == "raw" ? new[] { "raw" } : new string[0])
        {
            var props = new ClientProperties { cbSize = 16, eCategory = m == "speech" ? CategorySpeech : 0, Options = m == "raw" ? OptionRaw : 0 };
            if (client.SetClientProperties(ref props) == 0) { used = m; break; }
        }
        IntPtr fmt;
        Check(client.GetMixFormat(out fmt), "mic format");
        int tag = (ushort)Marshal.ReadInt16(fmt, 0), channels = Marshal.ReadInt16(fmt, 2), rate = Marshal.ReadInt32(fmt, 4), bits = Marshal.ReadInt16(fmt, 14);
        bool isFloat = tag == 3 || (tag == 0xFFFE && new Guid(ReadBytes(fmt, 24, 16)) == FloatSubtype);
        Check(client.Initialize(0 /* shared */, 0, 2000000 /* 200 ms */, 0, fmt, IntPtr.Zero), "start mic");
        Marshal.FreeCoTaskMem(fmt);
        var ciid = typeof(IAudioCaptureClient).GUID;
        object co;
        Check(client.GetService(ref ciid, out co), "mic capture");
        var capture = (IAudioCaptureClient)co;
        ApronVoice.Emit("{\"debug\":" + ApronVoice.Q("mic " + used + " " + channels + "ch " + rate + "Hz " + bits + "bit") + "}");

        double step = rate / 16000.0, phase = 0, acc = 0;
        int accCount = 0;
        var outBuf = new float[1024];
        int outN = 0;
        Check(client.Start(), "start mic");
        try
        {
            while (!stopped)
            {
                uint packet;
                Check(capture.GetNextPacketSize(out packet), "read mic");
                while (packet > 0 && !stopped)
                {
                    IntPtr data; uint frames, flags; ulong p1, p2;
                    Check(capture.GetBuffer(out data, out frames, out flags, out p1, out p2), "read mic");
                    bool silent = (flags & 2) != 0;
                    int frameBytes = channels * bits / 8;
                    var raw = new byte[frames * frameBytes];
                    if (!silent) Marshal.Copy(data, raw, 0, raw.Length);
                    capture.ReleaseBuffer(frames);
                    for (int f = 0; f < frames; f++)
                    {
                        double sum = 0;
                        for (int c = 0; c < channels; c++)
                        {
                            int at = f * frameBytes + c * bits / 8;
                            if (isFloat) sum += BitConverter.ToSingle(raw, at);
                            else if (bits == 16) sum += BitConverter.ToInt16(raw, at) / 32768.0;
                            else if (bits == 24) sum += ((raw[at] << 8 | raw[at + 1] << 16 | raw[at + 2] << 24) >> 8) / 8388608.0;
                            else sum += BitConverter.ToInt32(raw, at) / 2147483648.0;
                        }
                        acc += sum / channels;
                        accCount++;
                        phase += 1;
                        // Box-filter resample to 16 kHz (averages each output period's input).
                        while (phase >= step)
                        {
                            outBuf[outN++] = (float)(acc / Math.Max(accCount, 1));
                            if (outN == outBuf.Length) { session.Feed(outBuf, outN); outN = 0; }
                            phase -= step;
                            if (phase < step) { acc = 0; accCount = 0; }
                        }
                    }
                    Check(capture.GetNextPacketSize(out packet), "read mic");
                }
                if (outN > 0) { session.Feed(outBuf, outN); outN = 0; }
                Thread.Sleep(20);
            }
        }
        finally
        {
            client.Stop();
        }
    }

    static byte[] ReadBytes(IntPtr p, int offset, int n)
    {
        var b = new byte[n];
        Marshal.Copy(new IntPtr(p.ToInt64() + offset), b, 0, n);
        return b;
    }
}

static class Wav
{
    /// 16 kHz mono 16-bit PCM as a .wav file.
    public static byte[] Bytes(short[] s)
    {
        using (var ms = new MemoryStream())
        using (var w = new BinaryWriter(ms))
        {
            w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + s.Length * 2); w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
            w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(16000); w.Write(32000); w.Write((short)2); w.Write((short)16);
            w.Write(Encoding.ASCII.GetBytes("data")); w.Write(s.Length * 2);
            foreach (var v in s) w.Write(v);
            w.Flush();
            return ms.ToArray();
        }
    }

    /// Reads a 16-bit PCM .wav (any rate/channels) as 16 kHz mono samples.
    public static short[] Read16kMono(string path)
    {
        var b = File.ReadAllBytes(path);
        int channels = 1, rate = 16000, bits = 16, i = 12;
        while (i + 8 <= b.Length)
        {
            string id = Encoding.ASCII.GetString(b, i, 4);
            int len = BitConverter.ToInt32(b, i + 4);
            if (id == "fmt ") { channels = BitConverter.ToInt16(b, i + 10); rate = BitConverter.ToInt32(b, i + 12); bits = BitConverter.ToInt16(b, i + 22); }
            if (id == "data")
            {
                if (bits != 16) throw new Exception("only 16-bit wav");
                int frames = Math.Min(len, b.Length - i - 8) / (2 * channels);
                var outp = new List<short>();
                double step = rate / 16000.0;
                for (double f = 0; f < frames; f += step)
                {
                    int at = i + 8 + (int)f * 2 * channels, sum = 0;
                    for (int c = 0; c < channels; c++) sum += BitConverter.ToInt16(b, at + c * 2);
                    outp.Add((short)(sum / channels));
                }
                return outp.ToArray();
            }
            i += 8 + len + (len & 1);
        }
        throw new Exception("no audio data");
    }
}
