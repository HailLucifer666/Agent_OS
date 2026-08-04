---
name: Bug report
about: Something in MYTHOS isn't working
title: "[BUG] "
labels: bug
assignees: ''
---

**Describe the bug**
A clear description of what's wrong.

**Steps to reproduce**
1.
2.
3.

**Expected behavior**
What you expected to happen instead.

**Environment**
- OS and version (e.g. Windows 11 24H2):
- Node version (`node --version`):
- Run mode: Electron shell (`Start Agent OS.bat` / `Start Electron App.bat`) or plain `npm start`?
- Does the issue reproduce in **both** the Electron shell and plain `npm start`, or only one?

**Adapter/status check**
Open the HUD's health/status view (or check server boot logs) and list which
adapters report **OFFLINE** or DEGRADED, if any (e.g. cua-driver, Hermes-Agent,
android-child, browser-agent). Many bugs trace back to an adapter being
offline rather than a logic bug — this narrows it down fast.

**Logs**
Paste relevant lines from the server console or `mythos`'s audit/log output.
Redact any API keys or personal file paths before pasting.

**Additional context**
Anything else that might be relevant (recent config changes, custom
`.env` settings, etc.).
