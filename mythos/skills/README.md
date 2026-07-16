# Vendored skills

Repo-local skills so MYTHOS works out of the box for any user — no `~/.zcode`
install required. The loader (`src/core/skills/loader.js`) resolves this
directory FIRST, then falls back to `~/.zcode/skills/` for anything not
vendored here.

Each directory holds:

- `SKILL.md` — the full skill, vendored verbatim from upstream (only the
  frontmatter `name` is normalized to the directory name). Loaded on demand by
  the `use_skill` voice tool.
- `SKILL-CORE.md` — a hand-distilled ~1–2 KB essence. This is what build-lane
  prompts inject (free/low-context brain models can't afford the full text).
- `LICENSE` — upstream license, copied alongside where upstream ships one.

| Skill | Upstream | License |
|---|---|---|
| taste-frontend | github.com/leonxlnx/taste-skill | MIT |
| ponytail | github.com/DietrichGebert/ponytail | MIT |
| karpathy-guidelines | github.com/multica-ai/andrej-karpathy-skills | MIT (declared in SKILL.md frontmatter; repo ships no LICENSE file) |
| caveman | github.com/juliusbrussee/caveman | MIT |
| ui-ux-pro-max | github.com/nextlevelbuilder/ui-ux-pro-max-skill | MIT (essence only — the full skill needs its Python search database, so it stays a `~/.zcode` install) |

To add a skill: create `mythos/skills/<name>/SKILL.md` (frontmatter `name`
matching the directory), optionally a `SKILL-CORE.md` essence, add the name to
`mythos/skills.allowlist`, and copy the upstream LICENSE.
