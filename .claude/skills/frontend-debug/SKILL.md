---
name: frontend-debug
description: Use when debugging frontend UI rendering, layout, CSS, DOM, responsive behavior, text wrapping, CJK/Chinese text squeezed into vertical columns, browser console diagnostics, Playwright screenshots, or SillyTavern frontend rendering issues involving regex/templates/streaming partial DOM. Not for backend-only bugs unless a visible UI symptom is involved.
---

# Frontend Debug

## Core Workflow

1. Reproduce the visible symptom before changing code. Capture viewport size, browser/theme, whether the bug appears during streaming/loading only or remains after the UI settles, and whether the source data already contains problematic HTML/CSS.
2. Inspect the live DOM and computed styles. For layout bugs, gather the element path, bounding rect, parent width, `display`, `flex-direction`, `grid-template-*`, `width`/`min-width`/`max-width`, `white-space`, `word-break`, `overflow-wrap`, `writing-mode`, `font-family`, `position`, `z-index`, and active stylesheet source.
3. Classify the cause before fixing:
   - CSS/layout constraint: flex/grid compression, missing min width, wrapping rules, overflow, specificity, responsive breakpoint, or actual `writing-mode`.
   - Content pipeline: generated HTML, Markdown parsing, sanitizer output, regex/template replacement, or transform order.
   - Runtime state: streaming/partial DOM, incremental parser state, hydration mismatch, stale cache, or an extension/script injecting styles.
   - Theme/asset issue: missing CSS variables, font fallback, unloaded stylesheet, missing icons/assets.
4. Fix at the narrowest stable layer. Prefer correcting the component/template or parser output; use scoped CSS fallback only when upstream content is intentionally variable or user-generated.
5. Verify in at least the failing viewport and one contrasting viewport. For visual changes, use screenshots or live DOM checks; for text wrapping, verify no overlap, no clipped labels, and no layout shift from hover/active/loading states.

## Vertical Or Narrow Text

Use this path when CJK/Chinese text is displayed one character per line, appears "竖排", or becomes an extremely tall narrow column.

Read [vertical-text-diagnosis.md](references/vertical-text-diagnosis.md) before making SillyTavern, Chaoxi/SPreset, regex, or streaming-related changes. It is the full case record for the SillyTavern vertical-text incident and contains the console probes, CSS fallback, regex storage pitfalls, and streaming-state analysis.

Quick triage:

- If completed/static DOM is still vertical, inspect the offending element and its parents for tiny widths, `flex-direction: column`, `white-space`, `word-break`, `overflow-wrap`, `writing-mode`, and class/template mismatches.
- If the bug appears only while content is streaming and disappears after completion, suspect the transform pipeline first: partial regex matches, unclosed HTML, or incremental DOM parser state. CSS may hide the symptom but usually cannot repair the transient DOM structure.
- If the offending classes are not defined in the repo, treat them as generated/user content. A template fix will not affect already-emitted arbitrary HTML; use a scoped defensive selector only after confirming the naming pattern.
- Font or color fallback is usually a fingerprint of missing theme variables, not the root cause of vertical text. Do not confuse visual fallback with layout compression.
- Attribute selectors can outrank simple class selectors. When both use `!important`, specificity still decides the winner.

Useful CJK wrapping pair:

```css
word-break: keep-all;
overflow-wrap: break-word;
```

This keeps Chinese/Japanese/Korean text from breaking between every character while still allowing long Latin tokens or URLs to wrap at boundaries.

## Console Probe

For a live browser page, this finds likely narrow/tall text offenders:

```js
(() => {
  const suspects = [...document.querySelectorAll('.mes_text *, body *')]
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, r, ratio: r.height / Math.max(r.width, 1) };
    })
    .filter((x) => x.r.width > 0 && x.r.width < 80 && x.r.height > 200 && x.ratio > 3)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5);

  suspects.forEach(({ el, r, ratio }, i) => {
    const cs = getComputedStyle(el);
    const path = [];
    for (let cur = el; cur && cur !== document.body && path.length < 7; cur = cur.parentElement) {
      const cls = typeof cur.className === 'string' && cur.className
        ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      path.unshift(`${cur.tagName.toLowerCase()}${cls}`);
    }
    console.log(`#${i + 1}`, {
      ratio: ratio.toFixed(1),
      width: r.width.toFixed(0),
      height: r.height.toFixed(0),
      path: path.join(' > '),
      className: el.className,
      display: cs.display,
      flexDirection: cs.flexDirection,
      widthCss: cs.width,
      minWidth: cs.minWidth,
      whiteSpace: cs.whiteSpace,
      wordBreak: cs.wordBreak,
      overflowWrap: cs.overflowWrap,
      writingMode: cs.writingMode,
      parentWidth: el.parentElement?.getBoundingClientRect().width.toFixed(0),
    });
  });
})();
```

## SillyTavern Notes

- Runtime settings can be duplicated between source preset JSON, runtime preset JSON, and `data/default-user/settings.json`. Verify the active runtime copy, not only the source file.
- For regex toggles or SPreset/Regex Binding changes, prefer the UI when possible because it synchronizes multiple storage locations. If editing JSON directly, check every active copy.
- A stale open SillyTavern tab can save old in-memory state back to disk. After disk edits, refresh the page before saving or changing settings in that old tab.
- For Scruple preset work specifically, also use `sillytavern-preset-scruple`.

## References

- [vertical-text-diagnosis.md](references/vertical-text-diagnosis.md): full SillyTavern vertical text diagnosis and repair record, including the final CSS fallback and the `00a` streaming regex root cause.
