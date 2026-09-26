# pi-thinking-reformatter

A [Pi](https://github.com/earendil-works/pi) extension that reformats deepseek-style
thinking blocks whose tokenization leaked stray line breaks, leading spaces, and
spaces around punctuation, so they read like normal prose.

## What it does

Some deepseek models (particularly `flash` thinking) emit reasoning where token
boundaries bleed through as spurious whitespace. A typical broken block looks
like this:

```
Ch
 rome-devtools
  is not
  connected
 .
```

This extension rewrites those blocks into normal prose:

```
Chrome-devtools is not connected.
```

It joins soft line breaks, re-attaches detached punctuation, and preserves
paragraph breaks, fenced code blocks, lists, blockquotes and headers. A
`looksBroken` heuristic leaves well-formed thinking blocks byte-for-byte
unchanged, so reasoning from other models is never touched.

## How it works

The live view is repaired through `registerMarkdownTransformer`, which re-runs
on every streaming frame with the full thinking text. A full repair on every
frame would be O(n) per token and re-reflow the whole block each time; a
repair frozen between frames made the stream look choppy (the visible text
stopped advancing, then jumped a batch at each boundary). Instead every frame
appends the newly arrived raw tail to the last full repair, so the block
grows token-by-token exactly like untransformed streaming, and a complete
repair runs on a ~150ms time budget, bounding the CPU cost regardless of token
rate. The tail region carries the stream's own artifacts for at most 150ms
before the next full repair cleans it, and because the repair's rules are all
local, that recompute only rewrites the tail - no whole-block reshuffle. On
finalize the exact full repair is always recomputed. The `message_end`
event then re-applies the same repair and returns a replacement message, so
the repaired text is what actually gets stored
in the session and what gets sent into model context on later turns - it is a
durable fix, not just a display-time transformation.

## Install

```
pi install git:github.com/mitchellnemitz/pi-thinking-reformatter
```

or from a local checkout:

```
pi install /path/to/pi-thinking-reformatter
```

Reload Pi (`/reload`) or restart it to load the extension.

## Scope and limitations

- Fenced code blocks (```` ``` ````) are left byte-for-byte intact.
- Rare token splits that glue two lowercase fragments into a word (e.g.
  `Ch\nrome-devtools`) are not yet re-joined without a word dictionary; the
  dominant spurious-linebreak and punctuation-spacing cases are covered.
- Inline code spans are not fenced, so punctuation normalization can touch the
  inside of a backtick span in an already-broken block.
- Requires a Pi version that lets `message_end` handlers return a replacement
  message and exposes `registerMarkdownTransformer`.

## Development

```
npm install
npm run typecheck
```
