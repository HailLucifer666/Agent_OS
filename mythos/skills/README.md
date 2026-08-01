# Vendored skills

Repo-local skills so MYTHOS works out of the box for any user — no host-CLI
install required. The loader (`src/core/skills/loader.js`) resolves this
directory FIRST, then falls back to `$MYTHOS_SKILLS_DIR`, `~/.claude/skills`,
the plugin packs under `~/.claude/plugins/`, and `~/.zcode/skills/`.

Each directory holds:

- `SKILL.md` — the skill itself. Loaded on demand by the `use_skill` voice
  tool. For skills copied from upstream this is verbatim, with only the
  frontmatter normalized (`name` matching the directory; a folded multi-line
  `description` collapsed to one quoted line, because the loader's frontmatter
  parser reads a single-line value and a folded one resolves to `>`).
- `SKILL-CORE.md` — a hand-distilled ~1–2 KB essence. This is what build-lane
  prompts inject (free/low-context brain models can't afford the full text).
  Optional; without it `loadEssence()` falls back to the head of `SKILL.md`.
- `LICENSE` — upstream license, copied alongside where upstream ships one.

## Copied from upstream

| Skill | Upstream | License |
|---|---|---|
| taste-frontend | github.com/Leonxlnx/taste-skill | MIT |
| ponytail | github.com/DietrichGebert/ponytail | MIT |
| karpathy-guidelines | github.com/multica-ai/andrej-karpathy-skills | MIT (declared in SKILL.md frontmatter; repo ships no LICENSE file) |
| caveman | github.com/JuliusBrussee/caveman | MIT |
| ui-ux-pro-max | github.com/nextlevelbuilder/ui-ux-pro-max-skill | MIT — **essence only**. The full 45 KB SKILL.md needs the skill's Python search database, so it stays a host install (`?ui-ux-pro-max` in the allowlist) |
| agent-reach | github.com/Panniantong/Agent-Reach | MIT |
| using-superpowers, brainstorming, writing-plans, executing-plans, systematic-debugging, test-driven-development, verification-before-completion | github.com/obra/superpowers | MIT |

## Written for this repo

These describe how MYTHOS drives an external tool. No upstream text is
redistributed; the tools themselves are optional installs that degrade to
OFFLINE when absent.

| Skill | Describes | Reached via |
|---|---|---|
| browser-use | github.com/browser-use/browser-use | MCP server |
| desktop-commander | github.com/wonderwhy-er/DesktopCommanderMCP | MCP server |
| strix-security | github.com/usestrix/strix | `strix` CLI |
| okf-knowledge | Open Knowledge Format (GoogleCloudPlatform/knowledge-catalog) | file format only |
| llm-app-patterns | github.com/Shubhamsaboo/awesome-llm-apps | reading reference |

## Adding a skill

1. Create `mythos/skills/<name>/SKILL.md` with frontmatter `name` matching the
   directory and a single-line `description`.
2. Optionally add `SKILL-CORE.md` — required if the skill should feed build-lane
   prompt injection.
3. Copy the upstream LICENSE if one exists.
4. Add the name to `mythos/skills.allowlist`. Prefix it with `?` if it is
   deliberately NOT vendored here and only resolves when a host CLI has it —
   otherwise a fresh clone reports it as a missing required skill.
5. Add a row to `mythos/THIRD_PARTY_NOTICES.md` when the content is copied
   from upstream.
