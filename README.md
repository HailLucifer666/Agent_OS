<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0f0c29,50:302b63,100:24243e&height=220&section=header&text=MYTHOS&fontSize=80&fontColor=43e5a0&fontAlignY=35&desc=Autonomous%20Entity%20OS&descSize=24&descAlignY=58&descColor=4fd8ff&animation=fadeIn" width="100%" alt="MYTHOS header"/>

<a href="https://github.com/HailLucifer666/Agent_OS">
  <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=22&duration=3000&pause=900&color=43E5A0&center=true&vCenter=true&multiline=false&width=700&height=50&lines=Not+a+chatbot.+Not+an+agent+framework.;A+living+system+with+an+OODA+loop.;Perceives+%C2%B7+Reasons+%C2%B7+Acts+%C2%B7+Self-heals.;7628+tests+green.+Zero+build+step." alt="Typing SVG" />
</a>

<br/>

[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-7628%20pass-2dd4bf?style=for-the-badge&logo=checkmarx&logoColor=white)](https://github.com/HailLucifer666/Agent_OS/actions)
[![Phases](https://img.shields.io/badge/phases-P0%E2%80%93P20%20shipped-6e40c9?style=for-the-badge)](ROADMAP.md)
[![Effectors](https://img.shields.io/badge/effectors-186%20tools-eab308?style=for-the-badge)](#-186-tool-effectors)
[![Deploy](https://img.shields.io/badge/deploy-render-4fc08d?style=for-the-badge&logo=render&logoColor=white)](https://agent-os-7gg5.onrender.com)
[![License](https://img.shields.io/badge/license-personal%2Fhobby-lightgrey?style=for-the-badge)](#%EF%B8%8F-license)

<br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="Dashboard Assets/built/mission-control.png">
  <img alt="MYTHOS JARVIS HUD" width="880" src="Dashboard Assets/built/mission-control.png">
</picture>

<em>🛰️ The JARVIS HUD — radial neural map, live entity state, voice mesh.</em>

</div>

---

> [!IMPORTANT]
> **Honest-inert by design.** Missing keys, dead providers, failed calls show up as `OFFLINE` / `DEGRADED` — never faked. Quota numbers are estimates. Errors surface verbatim. If something doesn't work, you *see* that it doesn't work.

A living system with an OODA loop, layered memory, tiered autonomy, immune system, and 7628 tests.

<div align="center">

### 🧭 Navigate

[**Architecture**](#-architecture-overview) · [**OODA Loop**](#-the-ooda-cognitive-loop) · [**Brain**](#-brain--multi-provider-chain) · [**Memory**](#%EF%B8%8F-memory-system) · [**Immune System**](#%EF%B8%8F-immune-system) · [**Safety**](#-tiered-autonomy--safety) · [**Voice**](#%EF%B8%8F-voice-system) · [**186 Tools**](#-186-tool-effectors) · [**Engagements**](#-engagement-layer--structured-task-lifecycle) · [**Deploy**](#-deploy) · [**Screenshots**](#-screenshots) · [**History**](#-build-history) · [**Stack**](#%EF%B8%8F-tech-stack) · [**Docs**](#-documentation)

</div>

---

## 🌐 Architecture Overview

```mermaid
flowchart TB
    subgraph Cloud["☁️ Cloud Providers"]
        direction LR
        NIM["NVIDIA NIM<br/>2 keys · rotation"]
        GQ["Groq<br/>70B · 1K RPD"]
        MI["Mistral<br/>Large · ∞ free"]
        CE["Cerebras<br/>Sub-100ms"]
        OR["OpenRouter<br/>Free models"]
        GOOG["Google<br/>Gemini Flash"]
        ZC["ZCode<br/>GLM-5.2"]
    end

    subgraph MYTHOS["🔮 MYTHOS Entity"]
        direction TB
        subgraph Foundation["Foundation"]
            CFG["Config"]
            BUS["Event Bus"]
            LIFE["Lifecycle"]
        end
        subgraph Cognition["Cognition"]
            CORT["Cortex<br/>OODA Loop"]
            BRN["Brain<br/>Chain Walk"]
            MEM["Memory<br/>5 Stores"]
            GOAL["Goals"]
            LEASH["Leash<br/>Safety"]
            IMM["Immune<br/>Self-Heal"]
        end
        subgraph IOLayer["I/O"]
            SENS["10 Sensors"]
            EFF["186 Effectors"]
        end
        CORT --> BRN --> Cloud
        SENS --> BUS --> EFF
    end

    subgraph Interface["🖥️ Interface"]
        HUD["JARVIS HUD<br/>Radial Neural Map"]
        VOICE["Voice Loop<br/>Push-to-Talk"]
        CAM["Camera<br/>Gesture Control"]
        API["REST API<br/>+ WebSocket v2"]
    end

    Interface <--> MYTHOS
```

### ⚔️ Entity vs Agent

| Property | 🤖 Traditional Agent | 🔮 **MYTHOS Entity** |
|----------|----------------------|----------------------|
| **Trigger** | User request | OODA cognitive loop (1s tick) |
| **Cognition** | On-demand chain walk | Continuous cortex tick |
| **Memory** | Session-only | Layered persistent memory (5 stores) |
| **Safety** | Confirm dialog | Tiered autonomy + audit trail + immune |
| **Failure** | Return error | Self-diagnose → self-heal → degrade |
| **Idle** | No work, no cost | Idle ticks call zero LLM APIs |
| **Deployment** | Serverless | Long-running process + Docker |

---

## 🔄 The OODA Cognitive Loop

Every second, MYTHOS runs a full **observe → orient → decide → act** cycle:

```mermaid
flowchart LR
    OBS["👁️ OBSERVE<br/>Timer · File · WS<br/>Job · Metric sensors"] --> ORI

    subgraph ORI["🧭 ORIENT"]
        RANK["Rank salience<br/>vs goals + drives"] --> HIGH{"High?"}
        HIGH -->|yes| EPI["Record to<br/>episodic memory"]
        HIGH -->|no| SKIP["Skip"]
    end

    ORI --> DEC

    subgraph DEC["⚖️ DECIDE"]
        ARB["Arbiter<br/>weighted score"] --> PLAN["Planner<br/>recall or Brain"]
    end

    DEC --> ACT

    subgraph ACT["⚡ ACT"]
        CHK["Leash check"] --> BRK["Breaker allow"] --> DSP["Dispatch<br/>effector"]
        DSP --> CONF{"Tier ≥ 3?"}
        CONF -->|yes| AUD["Write audit<br/>then execute"]
        CONF -->|no| EXE["Execute"]
    end

    ACT --> REF["🔄 REFLECT<br/>consolidate memory<br/>every 60 ticks"]
    REF -.-> OBS

    style OBS fill:#0e4429,stroke:#43e5a0,color:#fff
    style ORI fill:#1a1a4e,stroke:#4fd8ff,color:#fff
    style DEC fill:#4a1a6b,stroke:#a78bfa,color:#fff
    style ACT fill:#4a2a0a,stroke:#eab308,color:#fff
    style REF fill:#1a3a1a,stroke:#22c55e,color:#fff
```

> [!TIP]
> **Key insight:** Idle ticks skip Brain entirely — no LLM call, no cost. Only salient perceptions trigger reasoning.

---

## 🏛️ Six-Layer Stack

```
┌─────────────────────────────────────────────────────┐
│              SERVER & UI v2                          │  Express + WS on :4478
│         JARVIS HUD · Voice · Camera                  │  Vanilla JS, zero build step
├─────────────────────────────────────────────────────┤
│              IDENTITY                                │  self.md · boundaries.md
│         Human-editable persona                       │  Entity has no write path
├─────────────────────────────────────────────────────┤
│     SENSORS   ←→   BUS   ←→   EFFECTORS             │  11 sensors · 186 effectors
│  timer·file·ws·job·metric·gmail·screen·window·       │  Publish/subscribe, never direct
│  reminder·calendar                                   │
├─────────────────────────────────────────────────────┤
│              CORTEX (OODA)                            │  1s tick, generation guard
│         observe → orient → decide → act               │  Breakers + timeouts
├─────────────────────────────────────────────────────┤
│  GOALS  │  BRAIN  │  LEASH  │  IMMUNE               │  Cognition subsystems
│  Arbitrage  Chain   Audit    Heal                    │
├─────────────────────────────────────────────────────┤
│           MEMORY (5 stores)                           │  Episodic · Semantic
│           Skills · Identity · Audit                   │  Vault-backed, persistent
├─────────────────────────────────────────────────────┤
│  CONFIG  │  BUS  │  LIFECYCLE  │  LOGGER            │  Foundation
└─────────────────────────────────────────────────────┘
```

> [!NOTE]
> **Wiring rule:** Modules never call across layer boundaries directly — publish/subscribe on bus. Cortex is the only module that holds direct refs to memory, goals, brain, leash, and effectors.

---

## 🧠 Brain — Multi-Provider Chain

**7 cloud providers** (NVIDIA NIM with 2-key rotation, Groq, Mistral, Cerebras, OpenRouter, Google, ZCode) plus a **local Ollama fallback** — 8 lanes total, walking ranked preference tables with per-model cooldown.

```mermaid
flowchart LR
    THINK["brain.think()"] --> REG["Registry<br/>probe all providers"]

    subgraph Chain["Chain Walk"]
        direction LR
        A1["Groq 70B"] -->|fail| A2["Mistral Large"]
        A2 -->|fail| A3["Cerebras Gemma"]
        A3 -->|fail| A4["NIM Key 1"]
        A4 -->|fail| A5["NIM Key 2"]
        A5 -->|fail| A6["Google<br/>Gemini Flash"]
        A6 -->|fail| A7["OpenRouter"]
        A7 -->|fail| A8["ZCode GLM<br/>lane-config gated"]
        A8 -->|fail| A9["Ollama ∞"]
    end

    A9 -->|fail| DEAD["chainExhausted<br/>offline: true"]
    A1 -->|success| RESP["Response"]

    style A1 fill:#0e4429,stroke:#43e5a0
    style A2 fill:#0e4429,stroke:#43e5a0
    style A3 fill:#0e4429,stroke:#43e5a0
    style DEAD fill:#4a0a0a,stroke:#ef4444
    style RESP fill:#0e4429,stroke:#22c55e
```

### 🛰️ Provider Fleet

| Provider | Model(s) | Free Tier | Lanes | Rotation |
|----------|----------|-----------|-------|:--------:|
| **Groq** | `llama-3.3-70b-versatile` | 1K RPD / 100K TPD | voice, simple | — |
| **Mistral** | `mistral-large-2512` | No cap · 1 req/sec | voice, build, simple, vision | — |
| **Cerebras** | `gemma-4-31b`, `zai-glm-4.7`, `gpt-oss-120b` | 2.4K RPD | build, simple, text | — |
| **NVIDIA NIM** | `meta/llama-3.1-8b-instruct`, vision models | ~1K/month · 40 RPM | voice, build, simple, text, vision | ✅ 2 keys |
| **OpenRouter** | `hermes-3-405b`, `qwen3-coder`, `llama-3.3-70b` | 50 RPD | voice, build, simple, text | — |
| **Ollama** | `qwen3:8b`, `ornith:9b`, `qwen3.5`, `qwen2.5vl` | Unlimited (local) | voice, build, simple, text, vision | — |
| **Google** | `gemini-flash-lite-latest` (+ `gemini-3.6-flash`, `gemini-flash-latest` per lane) | Flash-tier only — free keys get 429 on every Pro-tier Gemini model | voice, simple, text, vision | — |
| **ZCode** | `glm-4.6` | — | none by default (lane-config gated) | — |

### 🔀 Failover Chains per Lane

```mermaid
graph TD
    subgraph Voice["🎙️ VOICE"]
        V1["Groq 70B"] --> V2["Mistral Large"] --> V3["Cerebras"] --> V4["NIM"] --> V5["OpenRouter"] --> V6["Ollama"]
    end
    subgraph Build["🏗️ BUILD"]
        B1["Mistral Large"] --> B2["Cerebras GLM-4.7"] --> B3["Cerebras GPT-OSS"] --> B4["OpenRouter"] --> B5["NIM"] --> B6["Ollama"]
    end
    subgraph Simple["✉️ SIMPLE"]
        S1["Mistral"] --> S2["Cerebras"] --> S3["NIM"] --> S4["OpenRouter Hermes"] --> S5["Ollama"]
    end
    subgraph Vision["👁️ VISION"]
        VN1["Mistral (multimodal)"] --> VN2["NIM Vision"] --> VN3["Ollama qwen3.5"] --> VN4["Ollama qwen2.5vl"]
    end
```

---

## 🗄️ Memory System

Five persistent stores, vault-backed, layered from short-term to long-term:

```mermaid
flowchart LR
    IN["Perception<br/>event"] --> WM["WorkingMemory<br/>15-item buffer"]

    WM -->|"high salience"| EP["Episodic Store<br/>time-series events"]
    WM -->|"consolidation"| SE["Semantic Store<br/>knowledge graph"]

    EP -->|"every 60 ticks"| CONS["Consolidation<br/>Brain distills"]
    CONS --> SE

    SE --> SK["Skills Store<br/>learned procedures"]
    ID["Identity Store<br/>self.md sections"]
    AU["Audit Store<br/>immutable log"]

    style WM fill:#1a1a4e,stroke:#4fd8ff,color:#fff
    style EP fill:#0e4429,stroke:#43e5a0,color:#fff
    style SE fill:#0e4429,stroke:#22c55e,color:#fff
    style AU fill:#4a1a1a,stroke:#ef4444,color:#fff
```

| Store | Purpose | Retention | Format |
|-------|---------|-----------|--------|
| 🧠 **Working Memory** | 15-item perception buffer, drain on orient | Tick-scoped | In-memory |
| 📼 **Episodic** | Time-series of events and experiences | 30 days (config) | JSON files |
| 🕸️ **Semantic** | Consolidated knowledge, relationships | Permanent | JSON + vector index |
| 🛠️ **Skills** | Learned procedures and patterns | Permanent | JSON |
| 🪪 **Identity** | Persona sections (self.md, boundaries.md) | Permanent | Markdown |
| 📜 **Audit** | Immutable action log for tier ≥ 3 | Permanent | JSON lines |

---

## 🛡️ Immune System

Self-healing architecture with watchdog, healer, diagnostician, and circuit breakers:

```mermaid
flowchart TD
    WATCH["🐕 Watchdog<br/>polls every 2s"] -->|"stall detected"| DIAG["🔬 Diagnostician<br/>classify fault"]

    DIAG -->|"provider failure"| BRK["⚡ Circuit Breaker<br/>3 fails → open 15s"]
    DIAG -->|"cortex stall"| HEAL["🩹 Healer<br/>restart cortex"]

    BRK -->|"reset after 15s"| RETRY["Retry lane"]
    HEAL -->|"max restarts"| ANN["📢 Announcer<br/>speak status"]

    ANN -.->|"voice"| TTS["Edge TTS<br/>322 voices"]

    style WATCH fill:#4a2a0a,stroke:#eab308,color:#fff
    style BRK fill:#4a1a1a,stroke:#ef4444,color:#fff
    style HEAL fill:#0e4429,stroke:#22c55e,color:#fff
```

| Component | Role | Trigger |
|-----------|------|---------|
| 🐕 **Watchdog** | Detects cortex stalls | Polls every 2s |
| 🔬 **Diagnostician** | Classifies fault type | Stall or anomaly event |
| ⚡ **Breakers** | Trip on 3 consecutive fails | Provider-level circuit |
| 🩹 **Healer** | Restarts failed subsystems | Diagnostician dispatch |
| 📢 **Announcer** | Voice status updates | Health events |
| 💾 **Monitor** | Crash recovery on restart | Boot-time checkpoint scan |

---

## 🔐 Tiered Autonomy & Safety

Four tiers of action autonomy with **human sovereignty baked in**:

| Tier | Actions | Human Gate | Audit |
|:----:|---------|:----------:|:-----:|
| **0** | Internal state changes | — | — |
| **1** | Memory writes, perception routing | — | — |
| **2** | Goal CRUD, kanban moves, pipeline advance | — | ✅ |
| **3** | Code execution, file writes, agent dispatch | Confirm | ✅ |
| **4** | System-level changes, destructive ops | Confirm + reason | ✅ |

```mermaid
flowchart LR
    ACT["Action request"] --> LCK["Leash.check()"]
    LCK --> T3{"Tier ≥ 3?"}
    T3 -->|yes| CONF["Confirm dialog<br/>30s TTL"]
    T3 -->|no| GO["Execute"]
    CONF -->|accept| AUD["Write audit line"]
    CONF -->|reject| DENY["Denied"]
    AUD --> GO

    style T3 fill:#4a1a1a,stroke:#ef4444,color:#fff
    style DENY fill:#4a0a0a,stroke:#ef4444,color:#fff
```

> [!TIP]
> **`MYTHOS_DRY_RUN=true`** — makes all tier ≥ 1 actions logged no-ops. Perfect for observing what the entity *would* do.

---

## 🎙️ Voice System

Three integrated voice channels — browser push-to-talk, speech-to-speech pipeline, and gesture control:

```mermaid
flowchart TB
    subgraph Input["🎤 Input Channels"]
        PTT["Push-to-Talk<br/>Hold Space / mic pill"]
        S2S["Speech-to-Speech<br/>Silero VAD + Whisper"]
        CAM["Camera Gestures<br/>MediaPipe · 5 gestures"]
    end

    subgraph Brain["🧠 Voice Brain"]
        STT["Speech-to-Text"] --> INT["Ollama JSON<br/>tool-calling"]
        INT --> TOOLS["20 Dashboard tools<br/>4 Computer tools<br/>10 PC tools"]
    end

    subgraph Output["🔊 Output"]
        TTS["Edge TTS<br/>322 Neural voices"]
        SYNTH["Browser<br/>speechSynthesis fallback"]
    end

    Input --> Brain --> Output
    CAM -->|"Confirm/Deny/Mute/Vision"| TOOLS

    style Input fill:#1a1a4e,stroke:#4fd8ff,color:#fff
    style Output fill:#0e4429,stroke:#43e5a0,color:#fff
```

### ✋ Gesture Control

| Gesture | Action |
|:-------:|--------|
| 👍 **Thumb Up** | Accept confirmation |
| ✊ **Closed Fist** | Reject confirmation |
| 🖐️ **Open Palm** | Mute the mic — or unmute it, if it is already off |
| ☝️ **Pointing Up** | Unmute the mic (only ever unmutes, never mutes) |
| ✌️ **Victory** | Vision Q&A — describe scene |

A pose is **one press, however long you hold it**: the same gesture cannot fire
again until your hand leaves it, so a palm left in frame mutes once instead of
flipping the mic back on. Mute is also reachable from the mic button, the core
orb, and the global push-to-talk hotkey (`Alt+Space` by default).

### 👁️ What the camera can and cannot see

Camera is **OFF by default**, the same privacy posture as the mic, and `stop()`
releases the hardware stream rather than only the timer.

While it is on, gesture recognition runs **entirely on your machine** — MediaPipe
WASM, no server round-trip, no frames leaving the process. A single JPEG frame is
sent to the vision model **only** when you ask for it: the ✌️ gesture, or an
utterance like *"what do you see"*, *"look at this"*, *"can you see this"*,
*"what am I holding"*. One question, one frame.

Webcam frames are **never** streamed continuously to the Live session — that is
screen-share only. So MYTHOS can look when asked; it is not watching the room.

### 🗣️ Voice Actions

- **Dashboard** — navigate, goals CRUD, pipeline capture/advance, kanban build, ask agents
- **Computer** — open folders, list files, read files, compose emails
- **Safety** — dangerous actions require spoken confirmation (30s TTL)

---

## 186-Tool Effectors

🧰 Every action MYTHOS can take goes through one of these 186 registered effectors. Counts are generated (`mythos/scripts/sync-test-count.js`, AD-10) from the real `from-*.js` tool arrays — not hand-typed:

- [186-Tool Effectors](#186-tool-effectors) — the full catalog, generated from the real `from-*.js` arrays.

<!-- SYNC:EFFECTOR-CATALOG:START -->
<!-- Generated by mythos/scripts/sync-test-count.js from the real from-*.js tool
     arrays (AD-10). Hand edits inside these sentinels are overwritten by
     `node scripts/sync-test-count.js --write`. Change the code, or the label
     map in that script, not this table. -->

```mermaid
pie showData title Tool Distribution
    "PC Control" : 29
    "Dashboard" : 28
    "Browser Automation" : 24
    "Computer & Files" : 15
    "Phone (Android)" : 14
    "Memory & Notes" : 11
    "Calendar & Timers" : 7
    "Spotify" : 7
    "CUA Driver" : 4
    "Documents (RAG)" : 4
    "Gmail" : 4
    "System" : 4
    "WhatsApp" : 4
    "Other (17 modules, under 4 tools each)" : 31
```

<details>
<summary><b>📋 Full effector catalog (click to expand)</b></summary>

<br/>

| Catalog | Module | Tools | Registered |
|---------|--------|:-----:|------------|
| **PC Control** | `from-pc.js` | 29 | `launch_app`, `list_windows`, `focus_window`, `close_window`, `media_key`, `get_volume`, `set_volume`, `set_app_volume`, `get_app_volume`, `set_app_mute`, `screen_look`, `capture_screenshot`, `ui_elements`, `ui_click`, `ui_type`, `send_key`, `click_at`, `see_and_click`, `move_window`, `snap_window`, `scroll_at`, `right_click_at`, `drag`, `write_note`, `ambient_awareness`, `show_desktop`, `media_status`, `screen_read_text`, `set_wallpaper` |
| **Dashboard** | `from-dashboard.js` | 28 | `navigate`, `close_panel`, `open_web`, `open_artifact`, `delete_artifact`, `read_status`, `read_system_specs`, `web_fetch`, `web_search`, `job_status`, `create_goal`, `propose_goal`, `list_goals`, `toggle_goal`, `delete_goal`, `capture_idea`, `pipeline_status`, `pipeline_advance`, `pipeline_execute`, `kanban_status`, `kanban_add_card`, `kanban_move_card`, `kanban_assemble`, `kanban_build_card`, `ask_agent`, `camera_look`, `camera_on`, `daily_plan` |
| **Browser Automation** | `from-browser.js` | 24 | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_get_title`, `browser_get_text`, `browser_scroll`, `browser_tabs`, `browser_go_back`, `browser_wait_for`, `browser_fill_form`, `browser_dismiss_overlays`, `browser_check_captcha`, `browser_upload_file`, `browser_select_option`, `browser_press_key`, `browser_hover`, `browser_evaluate`, `browser_launch_debug`, `browser_switch`, `browser_video_list`, `browser_media_state`, `browser_media_control` |
| **Computer & Files** | `from-computer.js` | 15 | `open_file`, `open_folder`, `list_folder`, `read_file`, `write_file`, `create_folder`, `delete_file`, `move_file`, `copy_file`, `rename_file`, `search_files`, `compose_email`, `clipboard_read`, `clipboard_write`, `think_deeply` |
| **Phone (Android)** | `from-android.js` | 14 | `phone_list_devices`, `phone_screenshot`, `phone_notifications`, `phone_contacts_search`, `phone_sms_send`, `phone_call`, `phone_whatsapp_send`, `phone_wifi_toggle`, `phone_bluetooth_toggle`, `phone_hotspot_toggle`, `phone_app_launch`, `phone_app_close`, `phone_file_pull`, `phone_file_push` |
| **Memory & Notes** | `from-memory.js` | 11 | `suggest_procedures`, `note_take`, `note_read`, `note_search`, `self_capabilities`, `remember`, `forget_fact`, `log_incident`, `recall_memory`, `list_incidents`, `incident_status` |
| **Calendar & Timers** | `from-calendar.js` | 7 | `reminder_add`, `reminder_list`, `reminder_cancel`, `reminder_approve_action`, `timer_add`, `timer_cancel`, `calendar_upcoming` |
| **Spotify** | `from-spotify.js` | 7 | `spotify_play_pause`, `spotify_next`, `spotify_previous`, `spotify_volume`, `spotify_play`, `spotify_search`, `spotify_status` |
| **CUA Driver** | `from-cua.js` | 4 | `cua_list_windows`, `cua_bring_to_front`, `cua_get_window_state`, `cua_click` |
| **Documents (RAG)** | `from-documents.js` | 4 | `document_ingest`, `document_list`, `document_search`, `document_answer` |
| **Gmail** | `from-gmail.js` | 4 | `gmail_unread`, `gmail_read`, `gmail_send`, `gmail_draft` |
| **System** | `from-system.js` | 4 | `get_time`, `get_weather`, `get_directions`, `system_status` |
| **WhatsApp** | `from-whatsapp.js` | 4 | `whatsapp_send`, `whatsapp_contacts`, `whatsapp_contact_save`, `whatsapp_contact_delete` |
| **Desktop Task Operator** | `from-desktop.js` | 3 | `desktop_task_start`, `desktop_task_status`, `desktop_task_control` |
| **Document Generation** | `from-docs.js` | 3 | `generate_spreadsheet`, `generate_deck`, `generate_pdf` |
| **Forge (multi-file build)** | `from-forge.js` | 3 | `build_project`, `revise_project`, `project_status` |
| **MCP Bridge** | `from-mcp.js` | 3 | `mcp_list_servers`, `mcp_list_tools`, `mcp_call_tool` |
| **OKF Knowledge Exchange** | `from-okf.js` | 3 | `okf_export`, `okf_list`, `okf_import` |
| **Code Search** | `from-code-search.js` | 2 | `index_project`, `search_code` |
| **Mission Orchestrator** | `from-mission.js` | 2 | `run_mission`, `mission_status` |
| **Persona** | `from-persona.js` | 2 | `persona_status`, `set_persona_level` |
| **Widgets** | `from-widgets.js` | 2 | `manage_widget`, `spawn_widget` |
| **App Reply** | `from-app-reply.js` | 1 | `app_reply` |
| **DeepSeek Harness (build engine)** | `from-dsh.js` | 1 | `dsh_task` |
| **Image Generation** | `from-image-gen.js` | 1 | `generate_image` |
| **GitHub Installer** | `from-installer.js` | 1 | `install_from_github` |
| **Project** | `from-project.js` | 1 | `start_project` |
| **Command Runner** | `from-runner.js` | 1 | `run_command` |
| **Skills** | `from-skills.js` | 1 | `use_skill` |
| **Security Scan** | `from-strix.js` | 1 | `security_scan` |

</details>
<!-- SYNC:EFFECTOR-CATALOG:END -->

> [!WARNING]
> All dangerous tools (delete, execute, kill) require confirmation via the Leash system.

---

## 📋 Engagement Layer — Structured Task Lifecycle

Takes an intent (a sentence) and walks it through a structured lifecycle: **interview → spec → plan → approval → execution → verification → repair → completion**.

```mermaid
flowchart TB
    INTENT["Initial intent"] --> DRAFT["DRAFT"]
    DRAFT -->|startInterview| IV["INTERVIEWING"]
    IV -->|completeInterview| SPEC["SPEC_READY"]
    SPEC -->|buildPlan| PLAN["PLAN_READY"]
    PLAN -->|requestApproval| APPROVAL["AWAITING_APPROVAL"]

    APPROVAL -->|approve| EXEC["EXECUTING"]
    APPROVAL -->|rejectWithFeedback| PLAN

    EXEC -->|stageComplete| VERIFY["VERIFYING"]
    EXEC -->|stageFailed| REPAIR["REPAIRING"]
    EXEC -->|fatalError| FAIL["FAILED"]

    VERIFY -->|allVerified| DONE["COMPLETED"]
    VERIFY -->|verificationFailed| REPAIR
    VERIFY -->|noRepairsRemaining| BLOCK["BLOCKED"]

    REPAIR -->|retryReady| EXEC
    REPAIR -->|repairExhausted| BLOCK

    BLOCK -->|unblock| EXEC
    BLOCK -->|abandon| FAIL
    FAIL -->|restart| DRAFT

    style DONE fill:#0e4429,stroke:#43e5a0,color:#fff
    style BLOCK fill:#4a2a0a,stroke:#eab308,color:#fff
    style FAIL fill:#4a0a0a,stroke:#ef4444,color:#fff
```

| Capability | Modules | What it does |
|-----------|---------|--------------|
| **State Machine** | `state-machine.js`, `schema.js` | 12 states, 22 validated transitions with preconditions. Invalid transitions emit typed health anomalies. |
| **Interview** | `interview.js`, `interview-card` UI | Up to 5 questions, 5 variants (text, choice, confirm, multi-select, numeric), per-type validation. |
| **Spec Builder** | `spec-builder.js`, `recommendations.js` | Generates markdown specs from interview answers. Recommends build/research/hybrid approaches with confidence scores. |
| **Plan Builder** | `plan-builder.js` | Produces staged plans (setup, core, verify) with verification gates per stage. |
| **Progress** | `progress.js`, `progress-stream` UI | Real-time progress tracking, percentage-complete, repair budget monitoring. |
| **Conversation Gateway** | `gateway.js`, `intent-router.js` | Classifies messages as action/question/chat with 9 engagement action patterns. |
| **Events** | `events.js` | 18 typed bus event factories covering the full lifecycle. |

**Backend** (15 modules): `src/core/engagements/` (10) + `src/core/assistant/` (5).
**Frontend** (8 component + 3 view modules): 3-column dashboard, 5-tab detail panel, live WS-driven progress streaming, approval gate modals, interview cards, verification check cards, completion reports.
**Tests:** 166 tests (121 engagement + 45 assistant) across 14 test files.

---

## 🚀 Deploy

### ☁️ Render (Cloud)

```yaml
# render.yaml — auto-detected by Render Blueprint
services:
  - type: web
    name: agent-os
    runtime: docker
    rootDir: mythos
    plan: free
    envVars:
      - key: PORT
        generateValue: true
      - key: MYTHOS_BIND
        value: "0.0.0.0"
```

**Deploy steps:**
1. Push to `main` — auto-deploys
2. Set env vars in Render dashboard (API keys, model configs)
3. Live at `https://agent-xxxx.onrender.com`

**Dockerfile included** — Node 22 Alpine, zero build step. TTS is BYO — edge-tts is never bundled (LGPL boundary; see mythos/THIRD_PARTY_NOTICES.md).

> [!IMPORTANT]
> **Environment variables** (set in Render dashboard, NOT in the repo):
> `NIM_API_KEY` · `NIM_API_KEY_2` · `GROQ_API_KEY` · `MISTRAL_API_KEY` · `OPENROUTER_API_KEY` · `CEREBRAS_API_KEY`

### 💻 Local (Windows)

Double-click **`Start Agent OS.bat`** — that's it.

```bash
# Or manually:
cd mythos
npm install
node src/main.js
# Open http://127.0.0.1:4478
```

Copy `.env.example` to `.env` and fill in keys. Boots **degraded without any keys** — status tiles show exactly what's offline.

---

## 📸 Screenshots

<div align="center">

| 🛰️ JARVIS HUD — Radial Neural Map | 🗂️ Agent Kanban — Planner / Builder / Reviewer |
|:---:|:---:|
| <img src="Dashboard Assets/built/mission-control.png" alt="JARVIS HUD" width="100%"> | <img src="Dashboard Assets/built/agent-kanban.png" alt="Agent Kanban" width="100%"> |
| 🌌 **Memory Galaxy — Vault as a Starfield** | 🎯 **Goals — CRUD + Voice Input** |
| <img src="Dashboard Assets/built/memory-galaxy.png" alt="Memory Galaxy" width="100%"> | <img src="Dashboard Assets/built/goals-completed.png" alt="Goals" width="100%"> |
| ⚙️ **Pipeline — Capture → Gate → Execute → Ship** | 📡 **The Radar — RSS Signal Aggregation** |
| <img src="Dashboard Assets/built/pipeline.png" alt="Pipeline" width="100%"> | <img src="Dashboard Assets/built/radar.png" alt="Radar" width="100%"> |
| 🧠 **Mastermind — 13 Concurrent AI Seats** | 🤖 **Agent Room — Multi-Model Streaming** |
| <img src="Dashboard Assets/built/agent-room.png" alt="Mastermind" width="100%"> | <img src="Dashboard Assets/built/hermes.png" alt="Hermes" width="100%"> |

| 🎮 Game Studio | 🎵 Music Studio | 🎬 Video Studio | 🖼️ Thumbnail Studio |
|:---:|:---:|:---:|:---:|
| <img src="Dashboard Assets/built/game-studio.png" alt="Game Studio" width="100%"> | <img src="Dashboard Assets/built/music-studio.png" alt="Music Studio" width="100%"> | <img src="Dashboard Assets/built/video-studio.png" alt="Video Studio" width="100%"> | <img src="Dashboard Assets/built/thumbnail-studio.png" alt="Thumbnail Studio" width="100%"> |

</div>

---

## 📈 Build History

**20 phases shipped.** Linear history on `main`. 7628 tests green.

```mermaid
gantt
    title Phase History
    dateFormat YYYY-MM-DD
    axisFormat %b %d
    section Foundation
    P0 Foundation               :done, p0, 2026-07-08, 2d
    P1 Memory                   :done, p1, after p0, 2d
    P2 Brain                    :done, p2, after p1, 2d
    P3 Cortex (OODA)            :done, p3, after p2, 2d
    P4 Goals                    :done, p4, after p3, 1d
    section Safety
    P4.5 Spec Remediation       :done, p4b, after p4, 1d
    P5 Leash                    :done, p5, after p4b, 2d
    P6 Immune System            :done, p6, after p5, 2d
    section I/O
    P7 Sensors + 45 Effectors   :done, p7, after p6, 3d
    P8 Identity                 :done, p8, after p7, 2d
    P9 UI v2 + JARVIS HUD       :done, p9, after p8, 3d
    section Hardening
    P10 Chaos Drills            :done, p10, after p9, 2d
    P11 Token Streaming         :done, p11, after p10, 1d
```

<details>
<summary><b>📊 Test growth per phase (click to expand)</b></summary>

<br/>

| Phase | Scope | Tests |
|:-----:|-------|:-----:|
| **P0** | Foundation: config, bus, lifecycle, logger, vault | 26 |
| **P1** | Memory: 5 stores, consolidation, working memory | 70 |
| **P2** | Brain: chain walk, provider registry, failover | 113 |
| **P3** | Cortex: OODA loop, orient/decide/act cycle | 161 |
| **P4** | Goals: arbitrage, budget, CRUD, priority scoring | 161 |
| **P4.5** | Spec-conformance remediation (13 criticals closed) | 174 |
| **P5** | Leash: tiered autonomy, confirmation gating, audit | 184 |
| **P6** | Immune: watchdog, healer, breakers, announcer | 234 |
| **P7** | 45 effectors, 5 sensors, voice, build-runner | 272 |
| **P8** | Identity: self.md, boundaries.md, persona injection | 293 |
| **P9** | UI v2: JARVIS HUD, WS v2, REST routes, overlay panels | 316 |
| **P10** | Chaos drills: 6 drills against real shipped code | 327 |
| **P11** | Token streaming, gap-closing (D-23/D-57 fixes) | 402 |
| **P17/18** | Engagement Layer: lifecycle FSM, interview, spec, plan, store, assistant, UI | 568 |

</details>

Full history: [ROADMAP.md](ROADMAP.md) · [MYTHOS-ARCHITECTURE.md](MYTHOS-ARCHITECTURE.md)

---

## 🛠️ Tech Stack

<div align="center">

<img src="https://skillicons.dev/icons?i=nodejs,express,js,docker,powershell,py&theme=dark" alt="Tech stack icons"/>

</div>

<br/>

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Runtime** | Node.js ≥ 18 | Zero config, universal |
| **Server** | Express 5 + `ws` | Battle-tested, minimal |
| **Frontend** | Vanilla JS SPA | No framework, no bundler, no build step |
| **UI** | JARVIS HUD (Canvas) | Radial neural map, floating widgets |
| **Data** | Filesystem vault | Obsidian-compatible JSON + Markdown |
| **Realtime** | WebSocket v2 | Streaming, broadcasts, subscriptions |
| **Voice** | Edge TTS + Web Speech API | 322 Microsoft Neural voices, free |
| **Vision** | MediaPipe gestures | 5 gestures: confirm, deny, mute, unmute, vision |
| **Tests** | Built-in `node:test` | 7628 tests, zero test framework deps |
| **Deps** | 9 total | `@huggingface/transformers` · `@mediapipe/tasks-vision` · `exceljs` · `express` · `kokoro-js` · `onnxruntime-web` · `playwright-core` · `pptxgenjs` · `ws` |
| **Deploy** | Docker (Render) | One `Dockerfile`, auto-deploy on push |

<details>
<summary><b>📁 Project layout (click to expand)</b></summary>

<br/>

```
Agent_OS/
├── mythos/                      # MYTHOS entity runtime
│   ├── Dockerfile               # Docker image for cloud deploy
│   ├── .env.example             # All config knobs (documented)
│   ├── package.json             # 9 deps, 7628 tests
│   ├── src/
│   │   ├── main.js              # Boot sequence (13 lifecycle steps)
│   │   └── core/
│   │       ├── brain/           # chain.js, registry.js, lanes, spend
│   │       ├── bus/             # Event bus (pub/sub, middleware, storm guard)
│   │       ├── config/          # Schema validation + env loading
│   │       ├── cortex/          # OODA loop + orient/decide
│   │       ├── effectors/       # 186 tools, build-runner, orchestrator
│   │       ├── goals/           # Arbitrage + budget system
│   │       ├── identity/        # self.md + boundaries.md
│   │       ├── immune/          # watchdog, healer, breakers, announcer
│   │       ├── leash/           # Tiered autonomy + audit
│   │       ├── lifecycle/       # Boot/shutdown sequencing
│   │       ├── memory/          # 5 stores + working memory
│   │       ├── sensors/         # timer, file, ws, job, metric
│   │       ├── engagements/     # 10 modules: lifecycle, FSM, interview, spec, plan, store
│   │       ├── assistant/       # 5 modules: gateway, intent routing, response planning
│   │       └── voice/           # Voice agent + spoken text
│   ├── providers/               # 21 providers (openai-compat factory)
│   │   ├── nim.js / nim2.js     # NVIDIA NIM (2-key rotation)
│   │   ├── groq.js              # Groq LPU
│   │   ├── mistral.js           # Mistral La Plateforme
│   │   ├── cerebras.js          # Cerebras Cloud
│   │   ├── openrouter.js        # OpenRouter free models
│   │   └── ollama.js            # Local inference
│   ├── server/                  # Express + WebSocket v2
│   ├── ui/public/               # JARVIS HUD (canvas + widgets)
│   │   ├── js/                  # app.js, ws.js, voice, neural-map
│   │   └── css/                 # 10 stylesheets, design tokens
│   ├── test/                    # 7628 tests (node --test)
│   └── vault/                   # Persistent data (gitignored)
├── render.yaml                  # Render Blueprint (cloud deploy)
├── Start Agent OS.bat           # Windows launcher
├── ROADMAP.md                   # Full phase history
├── MYTHOS-ARCHITECTURE.md       # Architecture spec (16 sections)
└── README.md                    # ← You are here
```

</details>

---

## 📚 Documentation

| Doc | What it covers |
|-----|----------------|
| 📜 **[ROADMAP.md](ROADMAP.md)** | Phase-by-phase build history, test counts, drift tracking |
| 🏗️ **[MYTHOS-ARCHITECTURE.md](MYTHOS-ARCHITECTURE.md)** | Complete 16-section architecture spec with code |
| ⚙️ **[mythos/.env.example](mythos/.env.example)** | Every config knob, documented with defaults |
| 📋 **[ENGAGEMENT-CHANGELOG.md](ENGAGEMENT-CHANGELOG.md)** | Engagement Layer changelog — modules, test counts, event types |
| 🔌 **[docs/WIRING-AUDIT.md](docs/WIRING-AUDIT.md)** | Wiring audit — what's connected, what's not |
| 🧪 **[docs/live-verification-runbook.md](docs/live-verification-runbook.md)** | Live verification procedures |

---

## 📊 Repository Stats

<div align="center">

<img src="https://github-readme-stats.vercel.app/api/pin/?username=HailLucifer666&repo=Agent_OS&theme=tokyonight&hide_border=true&bg_color=0d1117&title_color=43e5a0&icon_color=4fd8ff&text_color=c9d1d9" alt="Agent_OS repo card"/>

<br/><br/>

<img src="https://github-readme-activity-graph.vercel.app/graph?username=HailLucifer666&repo=Agent_OS&theme=tokyo-night&hide_border=true&bg_color=0d1117&color=43e5a0&line=4fd8ff&point=a78bfa&area=true&area_color=302b63" width="95%" alt="Activity graph"/>

</div>

---

## ⚖️ License

Personal / hobby use. The bring-your-own **edge-tts** integration reverse-engineers Microsoft Edge's Read Aloud endpoint and is **not licensed for commercial deployment**. Provider integrations require their respective API keys and are subject to those providers' terms. No warranty.

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:24243e,50:302b63,100:0f0c29&height=120&section=footer" width="100%" alt="footer"/>

**Designed for the local-first operator. Built honestly. Deployed to the cloud.**

*From NOVA request→respond dashboard → MYTHOS continuous autonomous entity.*

⭐ **If this project interests you, drop a star — it helps.**

</div>
