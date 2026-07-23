# MYTHOS — Build Roadmap

> Autonomous entity runtime evolving from NOVA (Agent OS). Greenfield scaffold,
> OODA cognitive loop, layered memory, tiered autonomy, immune system.
>
> **Phase Gate Policy**: Every phase must pass `npm test` green + manual smoke
> before proceeding. Zero new npm deps (dotenv, express, playwright-core, ws only).
> Vanilla JS CommonJS, `node:test`.

---

## This file is stale — root `ROADMAP.md` is authoritative

This file's own Progress table stopped at Phase 4 (P5–P10 still marked
`⬚ Pending`) while the actual codebase has moved far beyond that — 1130+
tests, dozens of shipped features (Leash, Immune, Sensors/Effectors, Identity,
UI v2, and everything documented in `BUGS.md`). Keeping two roadmap files in
sync by hand had already failed silently once; rather than re-synchronize a
duplicate, this file now points at the one source of truth.

**For current phase status, history, and the commit log: see
[`../ROADMAP.md`](../ROADMAP.md).**

The mandatory-`graphify-out/graph.html`-sync-on-every-push policy that used to
live in this file (and in root `ROADMAP.md`) is dropped as of 2026-07-24 — it
was demonstrably not being followed in practice (`graphify-out/graph.html`'s
last edit predates dozens of intervening phase-equivalent commits) and was
blocking nothing real. `graphify-out/` still exists as a manually-regenerated
visualization; regenerate it on demand (`/graphify .`) when a diagram is
actually wanted, not as a gate.
