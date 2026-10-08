// "Hey Apron" voice commands, recognised offline with Windows' built-in speech engine
// (System.Speech). Only a fixed set of phrases is listened for, nothing is recorded or
// sent anywhere. Each recognised command is written to stdout as one JSON line.
using System;
using System.Globalization;
using System.IO;
using System.Linq;
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
    static void Emit(string json)
    {
        lock (emitLock)
        {
            stdout.WriteLine(json);
            stdout.Flush();
        }
    }

    static string Q(string text) { return "\"" + (text ?? "").Replace("\\", "").Replace("\"", "'") + "\""; }

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
        using (var engine = new SpeechRecognitionEngine(info))
        {
            engine.LoadGrammar(Build());
            // A .wav path argument replaces the microphone (used by the tests).
            bool fromFile = args.Length > 0;
            try
            {
                if (fromFile) engine.SetInputToWaveFile(args[0]);
                else engine.SetInputToDefaultAudioDevice();
            }
            catch (Exception e)
            {
                Emit("{\"error\":\"no microphone: " + e.Message.Replace("\"", "'") + "\"}");
                return;
            }
            bool debug = Environment.GetEnvironmentVariable("APRON_VOICE_DEBUG") == "1";
            if (debug)
            {
                int peak = 0;
                engine.AudioLevelUpdated += (s, e) => { if (e.AudioLevel > peak) peak = e.AudioLevel; };
                new Thread(() => { while (true) { Thread.Sleep(2000); Emit("{\"debug\":\"audio peak " + peak + "\"}"); peak = 0; } }) { IsBackground = true }.Start();
                engine.SpeechHypothesized += (s, e) => Emit("{\"debug\":\"heard? " + e.Result.Text.Replace("\"", "'") + " " + e.Result.Confidence.ToString("0.00", CultureInfo.InvariantCulture) + "\"}");
                engine.SpeechRecognitionRejected += (s, e) => Emit("{\"debug\":\"rejected " + (e.Result.Alternates.Count > 0 ? e.Result.Alternates[0].Text + " " + e.Result.Alternates[0].Confidence.ToString("0.00", CultureInfo.InvariantCulture) : "-") + "\"}");
                engine.AudioSignalProblemOccurred += (s, e) => Emit("{\"debug\":\"signal problem " + e.AudioSignalProblem + "\"}");
            }
            // Mic level every few seconds, so Settings can show whether we hear anything at all.
            int level = 0;
            engine.AudioLevelUpdated += (s, e) => { if (e.AudioLevel > level) level = e.AudioLevel; };
            if (!fromFile) new Thread(() => { while (true) { Thread.Sleep(3000); Emit("{\"level\":" + level + "}"); level = 0; } }) { IsBackground = true }.Start();
            // "Listening…" cue as soon as the wake phrase is heard.
            DateTime lastWake = DateTime.MinValue;
            engine.SpeechHypothesized += (s, e) =>
            {
                var t = e.Result.Text.ToLowerInvariant();
                // The engine forces everything it hears into the grammar, so ordinary speech
                // also "contains apron"; only trust it when the wake words themselves score well.
                var wakeWords = e.Result.Words.Where(w => w.Text.ToLowerInvariant() == "apron").ToList();
                bool sure = wakeWords.Count > 0 && wakeWords.All(w => w.Confidence >= 0.85f);
                if (debug) Emit("{\"debug\":\"hyp " + t + " apron=" + (wakeWords.Count > 0 ? wakeWords[0].Confidence.ToString("0.00", CultureInfo.InvariantCulture) : "-") + "\"}");
                if (sure && t.Contains("apron") && (DateTime.UtcNow - lastWake).TotalSeconds > 3)
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
                bool wake = best.Words.Any(w => w.Text.ToLowerInvariant() == "apron" && w.Confidence >= 0.75f);
                if (wake) Emit("{\"unsure\":" + Q(best.Text) + "}");
            };
            engine.SpeechRecognized += (s, e) =>
            {
                if (debug) Emit("{\"debug\":\"recognized " + e.Result.Text + " " + e.Result.Confidence.ToString("0.00", CultureInfo.InvariantCulture) + "\"}");
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
                sb.Append(",\"confidence\":").Append(e.Result.Confidence.ToString("0.00", CultureInfo.InvariantCulture)).Append('}');
                Emit(sb.ToString());
            };
            if (fromFile)
            {
                var done = new ManualResetEvent(false);
                engine.RecognizeCompleted += (s, e) => done.Set();
                engine.RecognizeAsync(RecognizeMode.Multiple);
                done.WaitOne(20000);
                return;
            }
            engine.RecognizeAsync(RecognizeMode.Multiple);
            Emit("{\"ready\":true,\"recognizer\":\"" + info.Culture.Name + "\"}");
            // Exit when Apron closes our stdin.
            var stdin = new StreamReader(Console.OpenStandardInput());
            while (stdin.ReadLine() != null) { }
            engine.RecognizeAsyncCancel();
        }
    }
}
