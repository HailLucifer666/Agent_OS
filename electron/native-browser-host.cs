using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;

// Console subsystem is required: Electron's Windows GUI startup writes CRLF
// before application code and replaces stdin with EOF, corrupting native frames.
internal static class MythosNativeBrowserHost {
  const int Limit = 1024 * 1024;
  static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
  static volatile bool stopping;
  static string RuntimeDir() {
    string direct = Environment.GetEnvironmentVariable("MYTHOS_BROWSER_EXTENSION_RUNTIME_DIR");
    if (!String.IsNullOrEmpty(direct)) return direct;
    string tools = Environment.GetEnvironmentVariable("MYTHOS_TOOLS_DIR");
    if (!String.IsNullOrEmpty(tools)) return Path.Combine(tools, "runtime", "browser-extension");
    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\MYTHOS\BrowserOperator")) {
      string registered = key == null ? null : key.GetValue("RuntimeDir") as string;
      if (!String.IsNullOrEmpty(registered)) return registered;
    }
    return Path.Combine(Path.GetTempPath(), "mythos-child-runtime", "browser-extension");
  }
  static IDictionary<string, object> Object(JavaScriptSerializer json, string value) {
    var result = json.DeserializeObject(value) as IDictionary<string, object>;
    if (result == null) throw new InvalidDataException("Expected an object frame");
    return result;
  }
  static object Value(IDictionary<string, object> value, string key) {
    object result; return value.TryGetValue(key, out result) ? result : null;
  }
  static byte[] ReadFrame(Stream input) {
    byte[] header = new byte[4]; int offset = 0;
    while (offset < 4) {
      int count = input.Read(header, offset, 4 - offset);
      if (count == 0) { if (offset == 0) return null; throw new InvalidDataException("Truncated native header"); }
      offset += count;
    }
    uint length = (uint)(header[0] | header[1] << 8 | header[2] << 16 | header[3] << 24);
    if (length < 2 || length > Limit) throw new InvalidDataException("Invalid native message size");
    byte[] body = new byte[length]; offset = 0;
    while (offset < body.Length) {
      int count = input.Read(body, offset, body.Length - offset);
      if (count == 0) throw new InvalidDataException("Truncated native payload"); offset += count;
    }
    return body;
  }
  static int Main(string[] args) {
    try { Run(args); return 0; }
    catch (Exception error) { Console.Error.WriteLine("MYTHOS native host: " + error.Message); return 1; }
  }
  static void Run(string[] args) {
    if (args.Length < 1 || !Regex.IsMatch(args[0], @"^chrome-extension://[a-p]{32}/$")) throw new InvalidDataException("Explicit extension origin required");
    string extensionId = args[0].Substring(19, 32);
    var json = new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 64 };
    string configPath = Path.Combine(RuntimeDir(), "browser-extension-host.json");
    if (new FileInfo(configPath).Length > Limit) throw new InvalidDataException("Invalid host configuration size");
    var config = Object(json, File.ReadAllText(configPath, Utf8));
    var ids = Value(config, "allowedExtensionIds") as IEnumerable; bool allowed = false;
    if (ids != null) foreach (object id in ids) if (id is string && (string)id == extensionId) allowed = true;
    if (!allowed) throw new InvalidDataException("Extension origin not allowed");
    string pipeName = Value(config, "pipeName") as string;
    if (pipeName == null || !Regex.IsMatch(pipeName, @"^[a-zA-Z0-9-]{1,100}$")) throw new InvalidDataException("Invalid local pipe configuration");
    using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous)) {
      pipe.Connect(5000);
      Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
      // Backend disconnect must terminate even while the browser keeps stdin open.
      Task.Run(() => {
        try {
          using (var reader = new StreamReader(pipe, Utf8, false, 4096, true)) {
            var line = new StringBuilder(); int value;
            while ((value = reader.Read()) != -1) {
              if (value != '\n') { line.Append((char)value); if (line.Length > Limit) throw new InvalidDataException("Pipe message exceeds limit"); continue; }
              string text = line.ToString(); line.Clear(); Object(new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 64 }, text);
              byte[] body = Utf8.GetBytes(text); if (body.Length > Limit) throw new InvalidDataException("Pipe message exceeds limit");
              output.WriteByte((byte)body.Length); output.WriteByte((byte)(body.Length >> 8)); output.WriteByte((byte)(body.Length >> 16)); output.WriteByte((byte)(body.Length >> 24));
              output.Write(body, 0, body.Length); output.Flush();
            }
            if (line.Length != 0) throw new InvalidDataException("Truncated pipe payload");
          }
          if (!stopping) Environment.Exit(0);
        } catch { if (!stopping) Environment.Exit(1); }
      });
      bool hello = false; byte[] frame;
      try { while ((frame = ReadFrame(input)) != null) {
        var message = Object(json, Utf8.GetString(frame));
        if (!hello) {
          // BUG-416 (2026-09-09) — protocol 2, and why this line is load-bearing.
          //
          // This host does not forward the extension's hello. It REBUILDS it
          // from an allowlist of four fields, which is deliberate: the frame
          // arrives from a browser extension and everything not named here is
          // dropped at the trust boundary rather than sanitised downstream.
          //
          // That is also why BUG-416's first pass was structurally incapable of
          // working. The extension began sending a persisted `instanceId` and
          // the bridge began requiring one — and this reconstruction silently
          // deleted it in between, so in production every hello would have been
          // refused as identity-invalid. Every unit test passed, because they
          // inject into the bridge directly and never traverse this host. Only
          // the compiled-host test saw it.
          //
          // So `instanceId` joins the allowlist, and is validated HERE as well
          // as in the bridge — not belt-and-braces: this is the edge, and a
          // malformed value must be refused before it is ever written to the
          // pipe. Guid.TryParseExact with "D" is the exact 8-4-4-4-12 form the
          // bridge's own check accepts; the two must agree or a frame that
          // passes one is rejected by the other.
          Guid parsedInstance;
          string instanceId = Value(message, "instanceId") as string;
          if ((Value(message, "type") as string) != "hello" || (Value(message, "extensionId") as string) != extensionId || !Equals(Value(message, "protocol"), 2) || String.IsNullOrEmpty(instanceId) || !Guid.TryParseExact(instanceId, "D", out parsedInstance)) throw new InvalidDataException("Invalid extension handshake");
          hello = true;
          message = new Dictionary<string, object> { { "type", "hello" }, { "protocol", 2 }, { "instanceId", instanceId }, { "extensionId", extensionId }, { "browserName", Value(message, "browserName") as string } };
        } else if ((Value(message, "type") as string) == "hello") throw new InvalidDataException("Duplicate extension handshake");
        byte[] bytes = Utf8.GetBytes(json.Serialize(message) + "\n"); pipe.Write(bytes, 0, bytes.Length); pipe.Flush();
      } } finally { stopping = true; }
    }
  }
}
