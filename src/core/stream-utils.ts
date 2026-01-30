/**
 * Extracts the new unique segment from an incoming stream chunk, handling overlaps.
 * @param previous The text we have already processed/displayed.
 * @param incoming The new text chunk (which might overlap with valid previous text).
 * @returns The new unique text to append.
 */
export function extractNewStreamSegment(previous: string, incoming: string): string {
    if (!incoming) return '';
    if (!previous) return incoming;
    if (incoming === previous) return '';

    // If incoming is a subset of previous (fully contained at the end), nothing new
    if (incoming.length <= previous.length && previous.includes(incoming)) {
        // Precise check: is it actually at the end?
        if (previous.endsWith(incoming)) return '';
        // If it's in the middle, it might be a weird re-send, but usually we ignore
        // For safety/simplicity like webnew:
        return '';
    }

    // If incoming starts with previous (simple append)
    if (incoming.startsWith(previous)) {
        return incoming.slice(previous.length);
    }

    // If previous ends with incoming (duplicate resend?)
    if (previous.endsWith(incoming)) {
        return '';
    }

    // Checking for partial overlap at the boundary
    const maxOverlap = Math.min(previous.length, Math.max(0, incoming.length - 1));
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
        if (previous.slice(-overlap) === incoming.slice(0, overlap)) {
            return incoming.slice(overlap);
        }
    }

    return incoming;
}

/**
 * Removes control tags or special markers from assistant output.
 */
export function sanitizeAssistantOutput(text: string): { text: string; focus: number | null } {
    if (typeof text !== 'string') return { text: '', focus: null };

    // Example regex from webnew for focus levels
    const focusRegex = /[\r\n]+\[END\]\s*\r?\n\s*<F\s+level=([0-9]*\.?[0-9]+)\s*>[\s\r\n]*$/;
    const m = focusRegex.exec(text);
    if (m) {
        const level = Number(m[1]);
        const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : null;
        const cleaned = text.replace(focusRegex, '').trimEnd();
        return { text: cleaned, focus: clamped };
    }
    return { text: (text || '').trimEnd(), focus: null };
}
