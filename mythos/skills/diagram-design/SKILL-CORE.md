# diagram-design — essence (editorial schematic discipline)

Diagrams are self-contained HTML with inline SVG + CSS, in an editorial
design system — not clip-art boxes and arrows.

Philosophy: **the highest-quality move is usually deletion.**
- Every node is a distinct idea; two nodes that always travel together are
  one node.
- Every connection carries information; if the relationship is obvious from
  layout, remove the line.
- Accent colour is editorial, not a flag: 1–2 focal nodes per diagram.
  Using it on 5 nodes erases the signal.
- Target density 4/10 — technically complete, readable without a guide.
  Above ~9 nodes it is probably two diagrams.

Before drawing, ask: would the reader learn more from this than from a
well-written paragraph or table? If no, don't draw. Never emit one-shape
"diagrams" — write the sentence instead.

Selection order: if behaviour/state/enforcement/risk carries the meaning,
pick a semantic pattern first (fan-in bottleneck, staged framework, trust
boundary / paved road, layered controls), THEN the nearest visual type for
layout (architecture, flowchart, sequence, state machine, ER, timeline,
swimlane, layer stack, tree, funnel, Gantt, …). Pattern owns the meaning
budget; type owns the layout grammar.

Style: one paper background, one ink, one accent; consistent stroke widths;
label text horizontal wherever possible; motion only when it materially
clarifies ordered change — static is the default. Match the project's brand
tokens when they exist instead of shipping the default skin.
