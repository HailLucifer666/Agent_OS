using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Collections.Concurrent;
using System.Web.Script.Serialization;
using System.Threading.Tasks;

// Node's Windows pipe default ACL is not a user-isolation contract. Construct
// the kernel object with a protected current-SID DACL and deny network tokens.
public static class MythosBrowserPipe {
  static readonly ConcurrentDictionary<string, StreamWriter> clients = new ConcurrentDictionary<string, StreamWriter>();
  static readonly object outputLock = new object();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
  static void Emit(string line) { lock(outputLock) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
  static string ReadBounded(TextReader reader) {
    var value = new StringBuilder(); int c;
    while ((c = reader.Read()) != -1) {
      if (c == '\n') return value.ToString().TrimEnd('\r');
      if (value.Length >= 1048576) throw new IOException("message-too-large");
      value.Append((char)c);
    }
    return value.Length == 0 ? null : value.ToString();
  }
  static NamedPipeServerStream MakePipe(string name) {
    var sid = WindowsIdentity.GetCurrent().User;
    var acl = new PipeSecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(sid);
    acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
    acl.AddAccessRule(new PipeAccessRule(sid, PipeAccessRights.FullControl, AccessControlType.Allow));
    return new NamedPipeServerStream(name, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, acl);
  }
  static void Serve(NamedPipeServerStream pipe) {
    string id = Guid.NewGuid().ToString("N");
    try {
      var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
      clients[id] = writer;
      Emit("{\"kind\":\"connected\",\"clientId\":\"" + id + "\"}");
      var reader = new StreamReader(pipe, new UTF8Encoding(false, true), false, 4096, true); string line;
      while ((line = ReadBounded(reader)) != null) {
        Emit("{\"kind\":\"message\",\"clientId\":\"" + id + "\",\"payloadBase64\":\"" + Convert.ToBase64String(Encoding.UTF8.GetBytes(line)) + "\"}");
      }
    } catch (Exception) { /* client failure is reported by disconnection; no payload logging */ }
    finally { StreamWriter discarded; clients.TryRemove(id, out discarded); pipe.Dispose(); Emit("{\"kind\":\"disconnected\",\"clientId\":\"" + id + "\"}"); }
  }
  public static void Run(string name) {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    var first = MakePipe(name);
    Emit("{\"kind\":\"ready\",\"sid\":\"" + WindowsIdentity.GetCurrent().User.Value + "\",\"sddl\":\"" + first.GetAccessControl().GetSecurityDescriptorSddlForm(AccessControlSections.All) + "\"}");
    Task.Run(() => { var next = first; try { while (true) { next.WaitForConnection(); var connected = next; Task.Run(() => Serve(connected)); next = MakePipe(name); } } catch (Exception) { Emit("{\"kind\":\"fatal\",\"error\":\"pipe-accept-failed\"}"); } });
    string input;
    while ((input = ReadBounded(Console.In)) != null) {
      var message = json.DeserializeObject(input) as System.Collections.Generic.Dictionary<string, object>;
      if (message == null || !message.ContainsKey("clientId")) continue;
      StreamWriter writer;
      if (!clients.TryGetValue(Convert.ToString(message["clientId"]), out writer)) continue;
      lock(writer) {
        try {
          if (message.ContainsKey("close")) writer.BaseStream.Dispose();
          else writer.WriteLine(Encoding.UTF8.GetString(Convert.FromBase64String(Convert.ToString(message["payloadBase64"]))));
        } catch (Exception) { /* receiver will emit disconnect */ }
      }
    }
    foreach (var writer in clients.Values) { try { writer.BaseStream.Dispose(); } catch {} }
    first.Dispose();
  }
}
