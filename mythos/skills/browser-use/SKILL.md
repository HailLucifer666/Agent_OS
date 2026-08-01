---
name: browser-use
description: "Drive a browser by describing the outcome instead of the clicks — multi-step web tasks where the page structure is unknown or changes between runs. Reached through MYTHOS's MCP client as an optional server. Prefer the built-in playwright browser tools for anything deterministic; use this when a task needs the page understood rather than merely operated."
---

# browser-use — outcome-driven browser automation

`github.com/browser-use/browser-use` (MIT). An agent that looks at a page,
decides what to do next, and keeps going until the task is done.

## When to use it instead of the built-in browser tools

MYTHOS already drives Chrome over CDP through `adapters/browser-agent`
(playwright-core), exposed as the `browser_*` effectors. That surface is
deterministic: you name a selector, it acts on that selector, and it either
worked or it did not.

- **Built-in `browser_*`** — you know the site. Fixed selectors, a login flow
  that does not change, scraping a stable page, anything that must be
  repeatable and cheap. No extra LLM cost. This stays the default.
- **browser-use** — you do not know the site, or it changes. "Find the pricing
  on this vendor's site and tell me what tier includes SSO." Multi-step
  navigation where the next click depends on what the last page rendered.

Reaching for browser-use because a selector was awkward to write is the wrong
trade: it adds a second LLM billing against the operator's key, and it is
slower and less reproducible than the tool that was already there.

## Running it

It ships an MCP server, so MYTHOS reaches it through the MCP client rather
than a bespoke adapter:

```
uvx --from 'browser-use[cli]' browser-use --mcp
```

Requires Python >= 3.11 and `uv` on PATH. It needs an LLM key of the
operator's own — `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` — plus optionally
`BROWSER_USE_HEADLESS=false` to watch it work.

Register it as an `MCP_SERVERS` entry. Its tools then appear namespaced as
`mcp__browser_use__<tool>`, which is what keeps `browser_navigate` (its tool)
from colliding with `browser_navigate` (MYTHOS's own effector). Those are two
different tools driving two different browsers — do not treat them as
interchangeable, and do not mix them within one task.

## Tools it exposes

`retry_with_browser_use_agent` (the autonomous fallback for a whole task),
`browser_navigate`, `browser_click`, `browser_type`, `browser_get_state`,
`browser_scroll`, `browser_go_back`, `browser_list_tabs`, `browser_switch_tab`,
`browser_close_tab`, `browser_extract_content`, `browser_list_sessions`,
`browser_close_session`, `browser_close_all`.

## Honesty

The agent reports its own success. A "task completed" from
`retry_with_browser_use_agent` is a claim, not evidence — confirm with
`browser_get_state` or `browser_extract_content` before telling the operator
something happened on a page.
