# ui-ux-pro-max — essence (self-contained; the full skill's searchable database lives upstream)

Priority-ordered UI/UX quality gates. Apply top-down; higher priorities veto lower ones.

1. **Accessibility (CRITICAL):** contrast ≥4.5:1, alt text, keyboard nav, aria-labels,
   never remove focus rings, no icon-only buttons without labels.
2. **Touch & interaction (CRITICAL):** targets ≥44×44px with 8px+ spacing, loading feedback,
   no hover-only affordances, no instant 0ms state jumps.
3. **Performance (HIGH):** modern image formats, lazy loading, reserve space (CLS < 0.1),
   no layout thrashing.
4. **Style selection (HIGH):** match the product type, stay consistent, SVG icons — never emoji
   as icons, never mix flat and skeuomorphic randomly.
5. **Layout & responsive (HIGH):** mobile-first breakpoints, viewport meta, no horizontal
   scroll, no fixed-px container widths, never disable zoom.
6. **Typography & color (MEDIUM):** base 16px, line-height ~1.5, semantic color tokens,
   no body text under 12px, no gray-on-gray, no raw hex scattered in components.
7. **Animation (MEDIUM):** 150–300ms, motion conveys meaning, respect reduced-motion,
   don't animate width/height, no decorative-only loops.
8. **Forms & feedback (MEDIUM):** visible labels (never placeholder-only), errors adjacent to
   fields, helper text, progressive disclosure.
9. **Navigation (HIGH):** predictable back behavior, bottom nav ≤5 items, deep-linkable.
10. **Charts (LOW):** legends + tooltips, accessible palettes, never rely on color alone.

Provenance: distilled from https://github.com/nextlevelbuilder/ui-ux-pro-max-skill (MIT — see LICENSE).
The full skill (84 styles, 192 palettes, 74 font pairings + search tooling) is used via ~/.zcode/skills
when installed; this essence is what build prompts inject.
