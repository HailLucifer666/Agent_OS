# hallmark — essence (anti-AI-slop design discipline)

Make pages look MADE, not generated. Structural variety over visual variety:
two briefs must not share the same hero → 3-feature → CTA → footer rhythm.

Hard rules, every emit:
- **Pre-emit self-critique.** Score the artifact 1–5 on Philosophy, Hierarchy,
  Execution, Specificity, Restraint, Variety. Any score < 3 → revise before
  handing back. Stamp the scores in a comment at the top.
- **Honest copy.** Never invent metrics, testimonials, logo walls, or user
  counts ("+47% conversion", "trusted by 50,000+ teams" are slop the moment
  they're fabricated). Real numbers, a labelled placeholder, or a different
  layout.
- **Locked tokens.** Pick the palette/fonts once, then every colour and
  font-family references a named token (var(--color-accent)). No inline hex /
  OKLCH / one-off font-family mid-render; new value → new named token first.
- **No re-drawn chrome.** No fake browser bars, phone frames, or mock IDE
  windows around content. Real screenshots in a <figure>, or nothing.
- **Mobile floor: 320/375/414/768px.** No horizontal scroll (root
  overflow-x: clip, never hidden); no two-line buttons/nav links; image grid
  tracks use minmax(0,1fr), never bare 1fr; long words wrap via
  overflow-wrap: anywhere + min-width: 0.
- **Typography purity.** Headings always roman — no italic headers, no
  italicised emphasis word inside a heading. Emphasis = weight, accent
  colour, or a drawn underline. 2 fonts + 1 fallback max.
- **Interactive components ship all 8 states**: default, hover,
  :focus-visible, :active, disabled, loading, error, success.

Done is when nothing can be removed, every choice traces to the brief, and
the page could not be mistaken for a template colour-swap.
