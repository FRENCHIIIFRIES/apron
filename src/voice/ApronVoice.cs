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
        var gb = new GrammarBuilder("hey apron");
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

    static void Emit(string json)
    {
        stdout.WriteLine(json);
        stdout.Flush();
    }

    static void Main(string[] args)
    {
        stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        var info = SpeechRecognitionEngine.InstalledRecognizers().FirstOrDefault(r => r.Culture.Name.StartsWith("en-"));
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
            engine.SpeechRecognized += (s, e) =>
            {
                if (e.Result.Confidence < 0.72f) return;
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
