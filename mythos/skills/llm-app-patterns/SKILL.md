---
name: llm-app-patterns
description: "Reference index of proven LLM/agent application patterns — voice agents, memory, MCP agents, RAG, multi-agent teams, always-on agents — drawn from the awesome-llm-apps catalog. Use when designing a new agent capability or build lane and you want a shape that already works, rather than inventing one. A reading reference, never a runtime dependency."
---

# LLM app patterns

`github.com/Shubhamsaboo/awesome-llm-apps` (Apache-2.0) is a catalog of
several hundred working agent applications, each a small self-contained
project. It is useful here for one thing: **the shapes**. When designing a new
MYTHOS capability, the category below usually already contains something that
solved the same structural problem.

**This is a reference, not a dependency.** Nothing in MYTHOS imports it,
nothing installs it, and no build should ever require it to be present. Read a
pattern, take the structure, write MYTHOS's own implementation in MYTHOS's own
style.

## The categories worth knowing

| Category | What to steal from it |
|---|---|
| **Voice AI agents** | Turn-taking, barge-in, transcript-to-action loops. Directly relevant to the live-voice lane. |
| **LLM apps with memory** | How long-lived agents decide what to persist and what to forget — compare against MYTHOS's episodic / semantic / working split. |
| **MCP AI agents** | Wiring an agent to MCP servers: tool discovery, namespacing, degradation when a server is absent. |
| **RAG** | Chunking, agentic retrieval, citation-carrying answers, knowledge-graph retrieval. |
| **Multi-agent teams** | Role decomposition and hand-off shapes for the business/agent-team layer. |
| **Always-on agents** | Scheduled/triggered agents that run without a prompt — briefing, watcher and radar patterns. |
| **Advanced AI agents** | End-to-end verticals; useful mainly for how they scope a domain, not for their code. |
| **Generative UI** | Agents that emit interface rather than text. |

## How to use it

1. Name the structural problem first ("an agent that wakes on a schedule and
   only speaks when something changed").
2. Find the closest category above and read one or two examples end to end —
   read them fully, the way systematic-debugging says to read a reference
   implementation, rather than skimming for a snippet.
3. Extract the shape: what state it keeps, where it decides, what it does when
   a dependency is missing.
4. Implement it in MYTHOS's idiom — its effector contract, its evidence rule,
   its config schema, its degradation-when-absent rule. Do not port code
   wholesale; these examples are mostly Python and mostly optimized for a demo,
   not for a long-running process.

## Caveats

Examples are demo-grade. They generally assume a single user, a fresh process,
and a key in the environment. Error handling, concurrency, and honest failure
reporting — the things this repo cares most about — are usually the parts they
skip. Take the architecture, not the error handling.
