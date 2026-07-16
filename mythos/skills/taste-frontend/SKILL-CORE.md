# taste-frontend — essence (distilled for small-context build models; full text in SKILL.md)

Anti-slop frontend rules. Read the brief first, then design deliberately — never default.

## Design read (do this first)
State one line before generating: "Reading this as: <page kind> for <audience>, with a <vibe> language."
The audience picks the aesthetic, not your taste. Trust-first/public-sector/accessibility constraints
override all aesthetic preference.

## Banned LLM defaults (the AI tells)
- AI-purple gradients, centered hero over dark mesh, three equal feature cards.
- Generic glassmorphism on everything; infinite-loop micro-animations everywhere.
- Inter + slate-900 as the reflex combo; Fraunces / Instrument Serif as display fonts.
- Serif as default for "creative/premium" briefs — serif ONLY if the brand names one or the
  brief is genuinely editorial/luxury/heritage. Default to a sans display otherwise.
- Emoji as icons. Mixed icon families. Mixed-family emphasis (random serif word in a sans headline —
  use italic/bold of the SAME font).

## Dials (set per brief, then obey)
VARIANCE (1 symmetric → 10 artsy chaos), MOTION (1 static → 10 cinematic), DENSITY (1 airy → 10 packed).
Minimalist/calm: 5-6/3-4/2-3. Premium consumer: 7-8/5-7/3-4. Agency/experimental: 9-10/8-10/3-4.
Trust-first/public-sector: 3-4/2-3/4-5. Default landing/portfolio: 7-9/6-8/3-5.

## Craft floor
- Typography: display `tracking-tighter leading-none`, body ~16px `leading-relaxed max-w-[65ch]`.
- Never `h-screen` heroes — `min-h-[100dvh]`. Grid over flex-percentage math.
- One design system OR one honest aesthetic (bento/brutalist/editorial/glass) per project — never a mix.
- Motion 150-300ms with meaning; respect `prefers-reduced-motion`; no decorative loops.
- Contrast 4.5:1, keyboard focus visible, 44px touch targets.
- Real content over lorem; specific microcopy over "Lorem ipsum" and "Your journey starts here".
