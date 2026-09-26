/**
 * Repair deepseek-style thinking blocks whose tokenization injected spurious
 * whitespace and line breaks, so they read like normal prose.
 *
 * DeepSeek flash / auto-routed deepseek models sometimes emit thinking content
 * where the stream's token boundaries leak through as stray newlines, leading
 * spaces, and spaces around punctuation:
 *
 *   "Ch\n rome-devtools\n  is not\n\n  connected\n .\n\n  Let me\n\n  try"
 *
 * This extension repairs those blocks in two places. A `registerMarkdownTransformer`
 * listener rewrites thinking blocks at display time, so the TUI shows clean prose
 * while the reasoning streams in: every streaming frame appends the newly
 * arrived text to the last full repair (so the block advances smoothly), and a
 * complete repair re-runs on a ~150ms time budget, bounding the O(n) repair
 * cost without ever freezing the display. A `message_end` handler then
 * rewrites the same blocks on the finalized message, so the repaired text is
 * what gets stored in the session and sent to the model in later context.
 * Both use the same `repairThinking` routine, so what you see streaming is
 * consistent with what persists.
 *
 * A `looksBroken` gate keeps well-formed thinking blocks byte-for-byte
 * unchanged, so normal reasoning from other models is never touched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Matches lines that start with leading whitespace before content. */
const LEADING_SPACE_LINE = /^\s+[^\s]/m;
/** A line that is exactly a punctuation token, e.g. " ." / "," on its own line. */
const BARE_PUNCT_LINE = /^\s*[.,;:!?)]\s*$/m;
/** Whitespace immediately before a closing punctuation token. */
const SPACE_BEFORE_PUNCT = /\s[.,;:!?)]/;
/** A single line break directly glued between lowercase letters (mid-word split). */
const MID_WORD_BREAK = /[a-z]\r?\n\s*[a-z]/;

/**
 * True when `text` shows signs of the deepseek token-splitting artifact. Keeps
 * normal, well-formed thinking blocks untouched.
 */
function looksBroken(text: string): boolean {
    return (
        LEADING_SPACE_LINE.test(text) ||
        BARE_PUNCT_LINE.test(text) ||
        SPACE_BEFORE_PUNCT.test(text) ||
        MID_WORD_BREAK.test(text)
    );
}

/** Remove spurious spaces around punctuation and collapse space runs. */
function normalizePunctuation(s: string): string {
    let out = s;
    // No space before a closing punctuation token.
    out = out.replace(/\s+([.,;:!?)\]}>])/g, "$1");
    // No space after an opening bracket or quote.
    out = out.replace(/([([{])[\s\t]+/g, "$1");
    // Restore a space where stream gluing ate one after sentence punctuation.
    // Capital must be followed by a lowercase letter so acronyms ("U.S.A") and
    // dotted names ("package.json", "index.ts") stay intact.
    out = out.replace(/([.!?])([A-Z][a-z])/g, "$1 $2");
    // A comma glued straight onto the next word gets its space back.
    out = out.replace(/,(?=[A-Za-z0-9])/g, ", ");
    // Punctuation butting against a bracket/backtick gets separated too.
    out = out.replace(/([.,;:!?])(?=[`(\[])/g, "$1 ");
    // Collapse any remaining runs of spaces/tabs.
    out = out.replace(/[ \t]{2,}/g, " ");
    return out.trim();
}

/** Reflow one paragraph (single newline = soft break, kept only for structure). */
function reflowParagraph(text: string): string {
    const lines = text.split(/\r?\n/).map((l) => l.trim());

    // Structured blocks (lists, blockquotes, headers) keep their line breaks.
    const structured = lines.some((l) => /^([-*+>#]|\d+[.)])\s/.test(l));
    if (structured) {
        return lines
            .map((l) => normalizePunctuation(l.replace(/[ \t]+/g, " ")))
            .join("\n");
    }

    // Plain prose: join soft line breaks into a single line, then fix spacing.
    return normalizePunctuation(lines.join(" "));
}

/** A paragraph that plausibly starts a real block; fragments get merged instead. */
const NEW_BLOCK = /^(?:[A-Z]|[\-*+>#]|\d+[.)][ \t]|```)/;

/** Reflow the prose of a thinking block, protecting fenced code verbatim. */
function reflowProse(text: string): string {
    // Extract fenced blocks first so their exact bytes survive untouched and
    // the surrounding newlines they need are preserved on restore.
    const blocks: string[] = [];
    const marked = text.replace(/```[\s\S]*?(?:```|$)/g, (m) => {
        blocks.push(m);
        return `\u0000${blocks.length - 1}\u0000`;
    });

    const repaired = reflowParagraphs(marked)
        .map((line) => line.replace(/\u0000(\d+)\u0000/g, (_, i) => `\n\n${blocks[Number(i)]}\n\n`))
        .join("\n\n")
        .replace(/[ \t]+\n/g, "\n");
    return repaired;
}

/** Reflow non-fence text: merge fragment paragraphs, then reflow each one. */
function reflowParagraphs(text: string): string[] {
    // Split into paragraphs on blank lines, then merge fragment paragraphs:
    // deepseek frequently inserts BLANK lines between tokens, and treating
    // every blank line as a paragraph boundary freezes each fragment as its
    // own "paragraph". Only paragraphs that plausibly begin a real block
    // (capital letter, marker, quote, header, fence placeholder) stay
    // separate; everything else glues into the previous paragraph.
    const merged: string[] = [];
    for (const para of text.split(/(?:\r?\n[ \t]*){2,}/)) {
        const trimmed = para.trim();
        const prev = merged[merged.length - 1];
        if (!prev || !trimmed || NEW_BLOCK.test(trimmed)) {
            merged.push(trimmed);
        } else {
            merged[merged.length - 1] = `${prev} ${trimmed}`;
        }
    }
    return merged.filter((p) => p !== "").map(reflowParagraph);
}

/** Repair a thinking block; returns the input unchanged when already clean. */
function repairThinking(raw: string): string {
    if (!looksBroken(raw)) return raw;
    return reflowProse(raw);
}

export default function (pi: ExtensionAPI) {
    // Live streaming repairs run on a time budget, not a token budget. The
    // transformer fires per streaming update with the full thinking text, so a
    // full repair on every frame is O(n) per token (and re-reflows the whole
    // block); a repair frozen between frames is what made the stream look
    // choppy - the visible text stopped advancing, then jumped a whole batch
    // at each boundary. Instead: every frame appends the raw tail that arrived
    // since the last full repair, so the display advances token-by-token like
    // untransformed streaming, and a full repair runs at most once per
    // REPAIR_INTERVAL_MS. The repair is prefix-stable (its rules are local
    // whitespace/punctuation fixes, and paragraph merge decisions are made at
    // paragraph starts), so the periodic full recompute only rewrites the
    // tail region - no whole-block reshuffle.
    const REPAIR_INTERVAL_MS = 150;
    let lastRepairAt = 0;
    let lastRaw = "";
    let lastRepair = "";

    // Reset the streaming cache at the start of each assistant turn so a
    // cached repair from a previous message is never reused.
    pi.on("message_start", async (event) => {
        if (event.message.role !== "assistant") return;
        lastRepairAt = 0;
        lastRaw = "";
        lastRepair = "";
    });

    // Rewrite thinking blocks at finalize time so the repaired text is what
    // gets stored and fed back into model context, not just a display change.
    pi.on("message_end", async (event) => {
        const m = event.message;
        if (m.role !== "assistant") return;

        let changed = false;
        const content = m.content.map((block) => {
            if (block.type !== "thinking") return block;
            const repaired = repairThinking(block.thinking);
            if (repaired !== block.thinking) changed = true;
            return { ...block, thinking: repaired };
        });
        if (!changed) return;

        return { message: { ...m, content } };
    });

    // Also rewrite thinking blocks at display time so the streamed output
    // in the TUI shows the repaired prose live, not the raw broken text. This
    // is display-only (does not alter the stored message), so the durable fix
    // still comes from the message_end handler above. Only thinking blocks are
    // touched here - user and assistant text pass through untouched.
    pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
        if (messageType !== "assistant-thinking") return markdown;

        // On finalize always recompute so the settled view is exact.
        if (!isStreaming) {
            lastRaw = markdown;
            lastRepair = repairThinking(markdown);
            return lastRepair;
        }

        // Full repair at most once per interval, and whenever the cache cannot
        // be extended (first frame, or the raw text is not a superset of the
        // cached prefix - e.g. a retry replaced the message).
        const now = Date.now();
        if (now - lastRepairAt >= REPAIR_INTERVAL_MS || !markdown.startsWith(lastRaw)) {
            lastRepairAt = now;
            lastRaw = markdown;
            lastRepair = repairThinking(markdown);
            return lastRepair;
        }

        // In between: keep the cached repair and append the raw tail that
        // arrived since it was computed. The tail shows the stream's own
        // artifacts for at most REPAIR_INTERVAL_MS, which is what the raw
        // stream looks like anyway; the next full repair cleans it.
        return lastRepair + markdown.slice(lastRaw.length);
    });
}
