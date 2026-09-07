# Browser extension transport

`createBrowserExtensionBridge({runtimeDir,allowedExtensionIds,bus,logger})` exposes
`start`, `stop`, `getStatus`, `execute(operation,args,{taskId,signal})`, and trusted
backend-only `resumeTask(taskId)` / `beginTask(taskId)`. No tool bypass belongs here:
the application wraps these operations in its ordinary leash and dispatcher.

Windows packaging builds `resources/mythos-browser-host.exe` from the tracked
C# source using the Windows .NET Framework compiler in the `beforePack` hook.
The compiler is a build prerequisite; no compiler or external Node install is
needed at runtime. Setup targets this console helper, never the GUI executable.
Real Electron 43.4.1 emitted a leading CRLF before application code and exposed
stdin as EOF, so using its GUI entry broke native framing. The helper directly
bridges bounded native frames and the protected pipe. The shared runtime path
comes from the explicit environment, then HKCU `Software\MYTHOS\BrowserOperator`
`RuntimeDir`, then the existing child-runtime default. Registration remains an
explicit reviewed setup step; setup never changes a signed-in browser profile.

Operations are `tabs`, `createTab`, `observe` / `videoList`, `playbackState` /
`mediaState`, `selectTab`, `navigate`, `click`, `scroll`, and `mediaControl`
(`pause`, `play`, `resume`, `next`). Observation returns `target` containing
`browserId,tabId,frameId,documentId,url,observationId,generation`. Actions pass
that exact target, plus `ref`, `url`, `deltaY`, or `action` as applicable.
An action consumes the observation. Delivery returns `commandAccepted`, never
a claim that playback progressed. Read the player twice to establish progression.

The native host executable starts from the caller's extension origin before
Electron boot. `setup-browser-extension.js --exe ... --ids ... --runtime-dir ...`
generates reviewable host and HKCU registration files. It does not install an
extension, import registry entries, or alter any browser profile. The native host
reads the explicitly configured runtime environment or the reviewed HKCU
`Software\MYTHOS\BrowserOperator` runtime path, then the shared runtime default.

Windows isolation uses an actual .NET named-pipe object with a protected DACL:
only the current user's SID is allowed; Network SID is denied. It does not rely
on Node's default pipe descriptor. The operating-system test checks the live
descriptor, attempts connection under an anonymous impersonation token, and
then proves current-user bidirectional Unicode transport. Processes already
running as this same user remain inside the desktop trust boundary; extension
origin allowlisting is not a cryptographic defense against a compromised user.
Microsoft documents the [named-pipe DACL access check](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).

The MV3 extension uses [`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger)
with a CDP isolated world. No content script receives task commands or provider
keys. Observations are task/browser/tab/document bound. Document changes,
debugger detach, consumed observations, cancellation and trusted browser input
invalidate them. Trusted `pointerdown`, `keydown` and `wheel` in the attached
top-level document stop later actions and emit `browser.extension.user-takeover`
with `{taskId,browserId,tabId,inputType}`. This is not a global Windows input gate.

Stage 1 supports explicitly selected non-incognito HTTP(S) top-level frames.
Nested-frame control is refused. YouTube ordinal selection requires one visible
supported search/home region and normal video cards; generic anchors, Shorts
and labeled ads are not ranked. Ambiguous or unsupported layouts return no
actionable video list. Native installation, real signed-in Brave/Chrome playback,
ad transitions, enterprise debugger restrictions and media progression remain
separate attended acceptance checks. DOM activation can be refused by sites
requiring trusted native input; outcome readback must report that honestly.

## Operator connection contract

`DESKTOP_OPERATOR_ENABLED` defaults to false. The additive
`/api/config/s2s.operatorEnabled` flag selects completed batch transcription and
the playback-only Live sink in the HUD. Legacy clients keep their existing
HTTP/WebSocket behavior when operator mode is disabled.

Completed `utterance` messages retain their existing `reqId` and `text` fields.
The authenticated server connection supplies ownership; a caller-provided
connection ID is never authority. The trusted request ID is persisted with a
new desktop task, so reconnect or restart cannot replay an accepted request.
`desktop_task_start`, `desktop_task_status` and `desktop_task_control` derive
from the shared catalog and dispatch. Wrapper acceptance is not completion.

The server sends `{type:"desktop-task",ok,result}` with a versioned execution
snapshot or an explicit refusal. The HUD sends
`{type:"desktop-task-control",taskId,action}` for pause/resume/cancel. The HUD
discovers the newest unowned pending task without starting it, displays its
request and ID, and offers explicit Resume. A tool/utterance can also continue
the displayed persisted task after reconnect;
the server first releases the closed owner's authority and re-observes targets.
Live output frames in operator mode include `operatorReqId`; playback discards
unidentified or prior-request audio, transcripts, interruption and completion.
The normal `done` acknowledgement adds `desktopSpeechId`. Only actual audio
drain causes `{type:"desktop-speech-drained",speechId}`; server delivery alone
does not release final task narration. A 15-second missing receipt produces an
explicit failure, never proof that the operator heard speech.

The initial executor supports YouTube open/third-video/pause/resume/next only.
Unsupported browser operations refuse rather than silently switching to a CDP
profile. Global physical-input detection and nested frames are later gates.
