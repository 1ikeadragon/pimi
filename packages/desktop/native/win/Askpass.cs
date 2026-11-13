using System;
using System.IO;
using System.IO.Pipes;
using System.Text;

namespace PimiDesktopHelper
{
    // ssh runs this exe as SSH_ASKPASS (see Program.Main) with its prompt text as args[0]. It asks the
    // Pimi desktop for the answer over the named pipe in PIMI_SSH_ASKPASS_SOCK and prints it to
    // stdout. It never reads stdin: that is ssh's data pipe when the tunnel runs.
    static class Askpass
    {
        public static int Run(string[] args)
        {
            string pipe = Environment.GetEnvironmentVariable("PIMI_SSH_ASKPASS_SOCK");
            string token = Environment.GetEnvironmentVariable("PIMI_SSH_ASKPASS_TOKEN");
            if (string.IsNullOrEmpty(pipe) || string.IsNullOrEmpty(token)) return 1;
            string prompt = args.Length > 0 ? args[0] : "";
            const string prefix = @"\\.\pipe\";
            if (!pipe.StartsWith(prefix, StringComparison.Ordinal)) return 1;
            try
            {
                using (var client = new NamedPipeClientStream(".", pipe.Substring(prefix.Length), PipeDirection.InOut))
                {
                    client.Connect(10000);
                    var utf8 = new UTF8Encoding(false);
                    byte[] request = utf8.GetBytes(token + "\n" + Convert.ToBase64String(utf8.GetBytes(prompt)) + "\n");
                    client.Write(request, 0, request.Length);
                    client.Flush();
                    string line = new StreamReader(client, utf8).ReadLine();
                    if (line == null || !line.StartsWith("OK ", StringComparison.Ordinal)) return 1;
                    byte[] secret = Convert.FromBase64String(line.Substring(3));
                    using (var stdout = Console.OpenStandardOutput())
                    {
                        stdout.Write(secret, 0, secret.Length);
                        stdout.WriteByte((byte)'\n');
                        stdout.Flush();
                    }
                    return 0;
                }
            }
            catch (Exception) { return 1; }
        }
    }
}
