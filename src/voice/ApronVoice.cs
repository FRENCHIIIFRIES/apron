// "Hey Apron" voice commands, recognised offline with Windows' built-in speech engine
// (System.Speech). Only a fixed set of phrases is listened for, nothing is recorded or
// sent anywhere. Each recognised command is written to stdout as one JSON line.
//
// The mic is captured here (WASAPI, in Windows' "speech" mode) instead of letting
// System.Speech open it: on laptop mic arrays the normal capture path can arrive
// ~30 dB too quiet for the recogniser, while speech mode is tuned for voice and also
// cancels whatever the laptop's own speakers are playing. A small auto-gain then
// levels it before it reaches the recogniser.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Speech.AudioFormat;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

static class ApronVoice
{
    static StreamWriter stdout;

    static readonly string[] NumberWords = {
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
    };

    static Choices Minutes()
    {
        var c = new Choices();
        for (int i = 0; i < NumberWords.Length; i++) c.Add(new SemanticResultValue(NumberWords[i], i + 1));
        foreach (var pair in new[] { Tuple.Create("twenty five", 25), Tuple.Create("thirty", 30), Tuple.Create("forty", 40),
                                     Tuple.Create("forty five", 45), Tuple.Create("fifty", 50), Tuple.Create("sixty", 60),
                                     Tuple.Create("ninety", 90), Tuple.Create("a hundred and twenty", 120) })
            c.Add(new SemanticResultValue(pair.Item1, pair.Item2));
        return c;
    }

    static GrammarBuilder Command(string key, params object[] parts)
    {
        // "Hey Apron", or just "Apron", then the command.
        var gb = new GrammarBuilder(new Choices("hey apron", "apron", "okay apron", "hi apron"));
        foreach (var p in parts)
        {
            if (p is string) gb.Append((string)p);
            else if (p is Choices) gb.Append(new SemanticResultKey("minutes", (Choices)p));
        }
        var outer = new GrammarBuilder();
        outer.Append(new SemanticResultKey("cmd", new SemanticResultValue(gb, key)));
        return outer;
    }

    static Grammar Build()
    {
        var all = new Choices(
            Command("timer", Minutes(), "minute timer"),
            Command("timer", "set a timer for", Minutes(), "minutes"),
            Command("timer", "timer for", Minutes(), "minutes"),
            Command("pomodoro", "start pomodoro"),
            Command("pomodoro", "start focus"),
            Command("stop", "stop the timer"),
            Command("stop", "stop timer"),
            Command("stop", "cancel timer"),
            Command("pause", "pause music"),
            Command("pause", "pause"),
            Command("play", "play music"),
            Command("play", "resume music"),
            Command("next", "next song"),
            Command("next", "skip song"),
            Command("prev", "previous song"),
            Command("volup", "volume up"),
            Command("voldown", "volume down"),
            Command("whatsnext", "what's next"),
            Command("launcher", "open search"));
        return new Grammar(new GrammarBuilder(all)) { Name = "apron" };
    }

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
    static string F(float v) { return v.ToString("0.00", CultureInfo.InvariantCulture); }

    static string WakeConfidence(RecognizedPhrase r)
    {
        var w = r.Words.FirstOrDefault(x => x.Text.ToLowerInvariant() == "apron");
        return w == null ? "-" : F(w.Confidence);
    }

    static void Main(string[] args)
    {
        stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        var info = SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(r => r.Culture.Name == "en-US")
            ?? SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(r => r.Culture.Name.StartsWith("en-"));
        if (info == null)
        {
            Emit("{\"error\":\"no English speech recognizer installed\"}");
            return;
        }
        bool debug = Environment.GetEnvironmentVariable("APRON_VOICE_DEBUG") == "1";
        // A .wav path argument replaces the microphone (used by the tests); it goes through
        // the same auto-gain and stream as live audio.
        bool fromFile = args.Length > 0;
        short[] fileSamples = null;
        if (fromFile)
        {
            try { fileSamples = Wav.Read16kMono(args[0]); }
            catch (Exception e) { Emit("{\"error\":" + Q("bad wav: " + e.Message) + "}"); return; }
        }
        var pipe = new PcmPipe(fromFile ? fileSamples.Length * 2 + 64000 : 16000 * 2 * 4);
        using (var engine = new SpeechRecognitionEngine(info))
        {
            engine.LoadGrammar(Build());
            engine.SetInputToAudioStream(pipe, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
            if (debug)
            {
                engine.SpeechHypothesized += (s, e) => Emit("{\"debug\":" + Q("hyp " + e.Result.Text + " " + F(e.Result.Confidence) + " apron=" + WakeConfidence(e.Result)) + "}");
                engine.AudioSignalProblemOccurred += (s, e) => Emit("{\"debug\":" + Q("signal " + e.AudioSignalProblem) + "}");
            }
            // "Listening…" cue as soon as the wake phrase is heard.
            DateTime lastWake = DateTime.MinValue;
            engine.SpeechHypothesized += (s, e) =>
            {
                // The engine forces everything it hears into the grammar, so ordinary speech
                // also "contains apron"; only trust it when the wake words themselves score well.
                var wakeWords = e.Result.Words.Where(w => w.Text.ToLowerInvariant() == "apron").ToList();
                bool sure = wakeWords.Count > 0 && wakeWords.All(w => w.Confidence >= 0.85f);
                if (sure && (DateTime.UtcNow - lastWake).TotalSeconds > 3)
                {
                    lastWake = DateTime.UtcNow;
                    Emit("{\"wake\":true}");
                }
            };
            // Heard the wake phrase but not a clear command: say so instead of doing nothing.
            engine.SpeechRecognitionRejected += (s, e) =>
            {
                if (e.Result.Alternates.Count == 0) return;
                var best = e.Result.Alternates[0];
                // Logged (text and scores only) so missed commands can be tuned from voice.log.
                Emit("{\"debug\":" + Q("rejected " + best.Text + " " + F(best.Confidence) + " apron=" + WakeConfidence(best)) + "}");
                bool wake = best.Words.Any(w => w.Text.ToLowerInvariant() == "apron" && w.Confidence >= 0.75f);
                if (wake) Emit("{\"unsure\":" + Q(best.Text) + "}");
            };
            engine.SpeechRecognized += (s, e) =>
            {
                Emit("{\"debug\":" + Q("recognized " + e.Result.Text + " " + F(e.Result.Confidence) + " apron=" + WakeConfidence(e.Result)) + "}");
                // Real voices on laptop mics score lower than synthesized speech; 0.5 still rejects chatter.
                if (e.Result.Confidence < 0.5f)
                {
                    if (e.Result.Words.Any(w => w.Text.ToLowerInvariant() == "apron" && w.Confidence >= 0.75f)) Emit("{\"unsure\":" + Q(e.Result.Text) + "}");
                    return;
                }
                // Music and TV can sound like commands; the wake word itself must be clear too.
                if (!e.Result.Words.Any(w => w.Text.ToLowerInvariant() == "apron" && w.Confidence >= 0.6f)) return;
                var sem = e.Result.Semantics;
                if (!sem.ContainsKey("cmd")) return;
                var sb = new StringBuilder("{\"cmd\":\"").Append(sem["cmd"].Value).Append('"');
                if (sem["cmd"].ContainsKey("minutes")) sb.Append(",\"minutes\":").Append(Convert.ToInt32(sem["cmd"]["minutes"].Value));
                else if (sem.ContainsKey("minutes")) sb.Append(",\"minutes\":").Append(Convert.ToInt32(sem["minutes"].Value));
                sb.Append(",\"confidence\":").Append(F(e.Result.Confidence)).Append('}');
                Emit(sb.ToString());
            };

            var agc = new Agc();
            if (fromFile)
            {
                // Feed the whole file through the auto-gain, then end the stream.
                var block = new float[320];
                for (int i = 0; i < fileSamples.Length; i += block.Length)
                {
                    int n = Math.Min(block.Length, fileSamples.Length - i);
                    for (int j = 0; j < n; j++) block[j] = fileSamples[i + j] / 32768f;
                    pipe.Write(agc.Process(block, n));
                }
                // A little trailing silence so the last phrase is finalised.
                pipe.Write(new short[16000]);
                pipe.Finish();
                var done = new ManualResetEvent(false);
                engine.RecognizeCompleted += (s, e) => done.Set();
                engine.RecognizeAsync(RecognizeMode.Multiple);
                done.WaitOne(30000);
                return;
            }

            var mic = new Mic(Environment.GetEnvironmentVariable("APRON_VOICE_MODE") ?? "speech", (samples, n) => pipe.Write(agc.Process(samples, n)));
            new Thread(mic.Run) { IsBackground = true }.Start();
            engine.RecognizeAsync(RecognizeMode.Multiple);
            Emit("{\"ready\":true,\"recognizer\":\"" + info.Culture.Name + "\"}");
            // Exit when Apron closes our stdin.
            var stdin = new StreamReader(Console.OpenStandardInput());
            while (stdin.ReadLine() != null) { }
            mic.Stop();
            pipe.Finish();
            engine.RecognizeAsyncCancel();
        }
    }
}

// Blocking pipe of 16 kHz 16-bit mono PCM between the capture thread and the recogniser.
// System.Speech reads it like an endless stream; Read blocks until audio arrives.
class PcmPipe : Stream
{
    readonly byte[] buf;
    int head, count;
    bool finished;
    readonly object gate = new object();

    public PcmPipe(int capacity) { buf = new byte[capacity]; }

    public void Write(short[] samples)
    {
        lock (gate)
        {
            foreach (var s in samples)
            {
                if (count == buf.Length) { head = (head + 2) % buf.Length; count -= 2; } // recogniser fell behind: drop the oldest
                int tail = (head + count) % buf.Length;
                buf[tail] = (byte)(s & 0xFF);
                buf[(tail + 1) % buf.Length] = (byte)((s >> 8) & 0xFF);
                count += 2;
            }
            Monitor.PulseAll(gate);
        }
    }

    public void Finish() { lock (gate) { finished = true; Monitor.PulseAll(gate); } }

    public override int Read(byte[] buffer, int offset, int len)
    {
        lock (gate)
        {
            while (count < len && !finished) Monitor.Wait(gate);
            int n = Math.Min(len, count);
            for (int i = 0; i < n; i++) buffer[offset + i] = buf[(head + i) % buf.Length];
            head = (head + n) % buf.Length;
            count -= n;
            return n;
        }
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return -1; } }
    public override long Position { get { return 0; } set { } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { return 0; }
    public override void SetLength(long value) { }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}

// Slow automatic gain: brings quiet mics up to a level the recogniser likes (speech peaks
// around -10 dBFS) without pumping between words. Gain falls fast and rises slowly.
class Agc
{
    const float Target = 0.3f, MaxGain = 16f;
    float envelope = 0.02f, gain = 1f;

    public short[] Process(float[] x, int n)
    {
        var outp = new short[n];
        for (int start = 0; start < n; start += 320)
        {
            int end = Math.Min(n, start + 320);
            float peak = 0;
            for (int i = start; i < end; i++) peak = Math.Max(peak, Math.Abs(x[i]));
            envelope = Math.Max(peak, envelope * 0.998f);
            float want = Math.Max(1f, Math.Min(MaxGain, Target / Math.Max(envelope, 1e-4f)));
            gain = want < gain ? want : gain + (want - gain) * 0.02f;
            for (int i = start; i < end; i++)
            {
                float v = Math.Max(-1f, Math.Min(1f, x[i] * gain));
                outp[i] = (short)(v * 32767);
            }
        }
        return outp;
    }
}

// WASAPI capture of the default mic, converted to 16 kHz mono floats. Restarts itself when
// the default mic changes or is unplugged, and reports a 0-100 input level every 3 s.
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
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
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
    readonly Action<float[], int> onAudio;
    volatile bool stopped;

    public Mic(string mode, Action<float[], int> onAudio) { this.mode = mode; this.onAudio = onAudio; }

    public void Stop() { stopped = true; }

    public void Run()
    {
        string lastError = null;
        while (!stopped)
        {
            try
            {
                Capture();
                lastError = null;
            }
            catch (Exception e)
            {
                if (e.Message != lastError) ApronVoice.Emit("{\"debug\":" + ApronVoice.Q("mic: " + e.Message) + "}");
                lastError = e.Message;
                Thread.Sleep(2000);
            }
        }
    }

    static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " failed 0x" + hr.ToString("X8")); }

    void Capture()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        Check(enumerator.GetDefaultAudioEndpoint(1 /* capture */, 0 /* console */, out device), "no microphone:");
        string id;
        device.GetId(out id);
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
        var outBuf = new float[4096];
        int outN = 0;
        float levelPeak = 0;
        var nextLevel = DateTime.UtcNow.AddSeconds(3);
        var nextDeviceCheck = DateTime.UtcNow.AddSeconds(3);
        Check(client.Start(), "start mic");
        try
        {
            while (!stopped)
            {
                uint packet;
                Check(capture.GetNextPacketSize(out packet), "read mic");
                while (packet > 0)
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
                            float v = (float)(acc / Math.Max(accCount, 1));
                            levelPeak = Math.Max(levelPeak, Math.Abs(v));
                            outBuf[outN++] = v;
                            if (outN == outBuf.Length) { onAudio(outBuf, outN); outBuf = new float[4096]; outN = 0; }
                            phase -= step;
                            if (phase < step) { acc = 0; accCount = 0; }
                        }
                    }
                    Check(capture.GetNextPacketSize(out packet), "read mic");
                }
                if (outN > 0) { onAudio(outBuf, outN); outBuf = new float[4096]; outN = 0; }
                var now = DateTime.UtcNow;
                if (now > nextLevel)
                {
                    // 0-100 from -60..0 dBFS, before auto-gain, so Settings shows what the mic really hears.
                    double db = 20 * Math.Log10(Math.Max(levelPeak, 1e-6));
                    ApronVoice.Emit("{\"level\":" + (int)Math.Max(0, Math.Min(100, (db + 60) / 60 * 100)) + "}");
                    levelPeak = 0;
                    nextLevel = now.AddSeconds(3);
                }
                if (now > nextDeviceCheck)
                {
                    nextDeviceCheck = now.AddSeconds(3);
                    IMMDevice current;
                    string currentId = null;
                    if (enumerator.GetDefaultAudioEndpoint(1, 0, out current) == 0) current.GetId(out currentId);
                    if (currentId != id) return; // default mic changed: reopen
                }
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
    // Reads a 16-bit PCM .wav (any rate/channels) as 16 kHz mono samples.
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
