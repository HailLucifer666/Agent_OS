---
name: okf-knowledge
description: "Write and read knowledge in the Open Knowledge Format — plain markdown files with YAML frontmatter that both humans and models can consume. Use when exporting MYTHOS's semantic memory or documents for another tool, importing a knowledge bundle someone shares, or deciding how to persist durable project knowledge."
---

# Open Knowledge Format (OKF)

A vendor-neutral way to represent knowledge: **markdown files with YAML
frontmatter**. The frontmatter is the queryable part; the body is prose,
schemas and examples. Published by Google Cloud
(`github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf`), spec v0.2.

## The shape

```markdown
---
type: Playbook
---

# Steps

1. First action
2. Second action
```

That is a conforming document. **`type` is the only required key** — a short
string naming the kind of concept. There is no central registry of type
values: producers pick a descriptive label, and consumers must tolerate a type
they have never seen rather than rejecting the document.

Common types in the wild: `BigQuery Table`, `BigQuery Dataset`, `API
Endpoint`, `Metric`, `Playbook`, `Reference`, `Attested Computation`.

Frequently used optional keys: `resource`, `tags`, `sources`, `generated`,
`verified`, `status`, `stale_after`. Arbitrary extra keys and arbitrary body
sections are explicitly allowed and must not break a consumer.

## Bundle layout

```
bundle/
  index.md          # optional directory listing
  log.md            # optional chronological history
  <concept>.md      # one concept per file
  <subdir>/
    index.md
    <concept>.md
  references/       # conventionally mirrors external material and code
```

`index.md` and `log.md` are reserved — never name a concept document either.
Concepts link to each other with ordinary markdown links, which is how OKF
expresses relationships richer than the parent/child nesting the directories
already imply.

## When to reach for it

- **Exporting** — the operator wants MYTHOS's semantic memory, documents or a
  project's accumulated knowledge somewhere else. OKF travels as plain files;
  no database, no schema migration, readable without MYTHOS.
- **Importing** — someone hands over a knowledge bundle. Parse the
  frontmatter, keep unknown keys, and preserve the body verbatim.
- **Durable project knowledge** — facts that should outlive a session and
  belong in a file rather than in working memory.

## What it is not

Not a graph database, not an ontology, not a replacement for MYTHOS's episodic
or vector memory. It is an interchange format. Do not translate MYTHOS's
internal memory records into OKF and then read them back as the source of
truth — export is a copy, and a copy goes stale.

## Honesty when generating

The `generated` and `verified` frontmatter keys mean what they say. Mark a
document you produced as generated. Do not set `verified` on a fact you did
not check against a real source, and record what that source was in `sources`.
