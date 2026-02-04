export type SysTagCaptureMode = 'event' | 'raw' | 'both';

export interface SysTagParserOptions {
    mode?: SysTagCaptureMode;
    jsonTag?: string;
    blockTag?: string;
    structuredEventMethod?: string;
}

export interface SysTagEvent {
    type: 'sys_json' | 'sys_block';
    payload?: any;
    raw: string;
    error?: string;
}

interface SysTagParseResult {
    output: string;
    events: SysTagEvent[];
    parts: SysTagParsePart[];
}

type SysTagParsePart =
    | { kind: 'text'; text: string }
    | { kind: 'event'; event: SysTagEvent };

const DEFAULT_JSON_TAG = 'SYS_JSON';
const DEFAULT_BLOCK_TAG = 'SYS_BLOCK';

export class SysTagParser {
    private mode: SysTagCaptureMode;
    private jsonTag: string;
    private blockTag: string;
    private buffer = '';
    private captureBuffer = '';
    private activeTag: 'json' | 'block' | null = null;

    private readonly jsonStart: string;
    private readonly jsonEnd: string;
    private readonly blockStart: string;
    private readonly blockEnd: string;

    constructor(options: SysTagParserOptions = {}) {
        this.mode = options.mode ?? 'event';
        this.jsonTag = options.jsonTag ?? DEFAULT_JSON_TAG;
        this.blockTag = options.blockTag ?? DEFAULT_BLOCK_TAG;
        this.jsonStart = `<${this.jsonTag}>`;
        this.jsonEnd = `</${this.jsonTag}>`;
        this.blockStart = `<${this.blockTag}>`;
        this.blockEnd = `</${this.blockTag}>`;
    }

    setMode(mode: SysTagCaptureMode) {
        this.mode = mode;
    }

    consume(chunk: string): SysTagParseResult {
        if (this.mode === 'raw') {
            return { output: chunk, events: [], parts: chunk ? [{ kind: 'text', text: chunk }] : [] };
        }

        const keepRawTags = this.mode === 'both';

        this.buffer += chunk;
        const events: SysTagEvent[] = [];
        const parts: SysTagParsePart[] = [];

        const appendText = (text: string) => {
            if (!text) return;
            const last = parts[parts.length - 1];
            if (last && last.kind === 'text') {
                last.text += text;
            } else {
                parts.push({ kind: 'text', text });
            }
        };

        const pushEvent = (event: SysTagEvent) => {
            parts.push({ kind: 'event', event });
            events.push(event);
        };

        while (this.buffer.length) {
            if (!this.activeTag) {
                const ltIdx = this.buffer.indexOf('<');
                if (ltIdx === -1) {
                    appendText(this.buffer);
                    this.buffer = '';
                    break;
                }

                if (ltIdx > 0) {
                    appendText(this.buffer.slice(0, ltIdx));
                    this.buffer = this.buffer.slice(ltIdx);
                }

                if (this.buffer.startsWith(this.jsonStart)) {
                    this.buffer = this.buffer.slice(this.jsonStart.length);
                    this.activeTag = 'json';
                    this.captureBuffer = '';
                    continue;
                }
                if (this.buffer.startsWith(this.blockStart)) {
                    this.buffer = this.buffer.slice(this.blockStart.length);
                    this.activeTag = 'block';
                    this.captureBuffer = '';
                    continue;
                }

                if (this.jsonStart.startsWith(this.buffer) || this.blockStart.startsWith(this.buffer)) {
                    break;
                }

                appendText(this.buffer[0]);
                this.buffer = this.buffer.slice(1);
                continue;
            }

            const startTag = this.activeTag === 'json' ? this.jsonStart : this.blockStart;
            const endTag = this.activeTag === 'json' ? this.jsonEnd : this.blockEnd;
            const endIdx = this.buffer.indexOf(endTag);
            if (endIdx === -1) {
                // Keep a suffix of `buffer` that could be the start of the end-tag.
                // Otherwise, if the end-tag is split across chunks, we might accidentally
                // move a partial end-tag into `captureBuffer` and fail to ever match it.
                const keep = endTag.length - 1;
                if (this.buffer.length > keep) {
                    const cut = this.buffer.length - keep;
                    this.captureBuffer += this.buffer.slice(0, cut);
                    this.buffer = this.buffer.slice(cut);
                }
                break;
            }

            this.captureBuffer += this.buffer.slice(0, endIdx);
            this.buffer = this.buffer.slice(endIdx + endTag.length);

            const raw = this.captureBuffer;
            const event: SysTagEvent = {
                type: this.activeTag === 'json' ? 'sys_json' : 'sys_block',
                raw,
            };
            try {
                event.payload = JSON.parse(raw.trim());
            } catch (e: any) {
                event.error = e?.message || 'invalid_json';
            }
            if (keepRawTags || event.error) {
                // Strategy A: don't drop content. Keep the raw tagged text in-stream.
                appendText(`${startTag}${raw}${endTag}`);
            }
            pushEvent(event);
            this.captureBuffer = '';
            this.activeTag = null;
        }

        const output = parts
            .filter((p): p is Extract<SysTagParsePart, { kind: 'text' }> => p.kind === 'text')
            .map((p) => p.text)
            .join('');

        return { output, events, parts };
    }

    flush(): SysTagParseResult {
        if (this.mode === 'raw') {
            return { output: '', events: [], parts: [] };
        }

        let output = '';
        if (this.activeTag) {
            const startTag = this.activeTag === 'json' ? this.jsonStart : this.blockStart;
            output = `${startTag}${this.captureBuffer}${this.buffer}`;
        } else if (this.buffer) {
            output = this.buffer;
        }

        this.buffer = '';
        this.captureBuffer = '';
        this.activeTag = null;

        return { output, events: [], parts: output ? [{ kind: 'text', text: output }] : [] };
    }
}

export function createSysTagTransform(options: SysTagParserOptions = {}) {
    const mode = options.mode ?? 'event';
    const structuredEventMethod = options.structuredEventMethod ?? 'bridge/structured_event';
    const parser = new SysTagParser(options);
    parser.setMode(mode);
    let lastSessionId: string | null = null;
    const debug = typeof process !== 'undefined' && process?.env?.SYS_TAG_DEBUG === '1';
    const dbg = (...args: any[]) => {
        if (!debug) return;
        try {
            // eslint-disable-next-line no-console
            console.error('[SYS_TAG_DEBUG]', ...args);
        } catch { }
    };

    return (msg: any): { forward?: any | null; extra?: any[] } | null => {
        if (!msg || typeof msg !== 'object') return { forward: msg };
        if (mode === 'raw') return { forward: msg };

        // Best-effort: cache sessionId for synthetic flush updates.
        if (typeof msg?.params?.sessionId === 'string') {
            lastSessionId = msg.params.sessionId;
        } else if (typeof msg?.result?.sessionId === 'string') {
            lastSessionId = msg.result.sessionId;
        }

        // Gemini CLI ends turns via a JSON-RPC response with { result: { stopReason } }.
        // When that arrives, flush any buffered tag content so it cannot bleed into the next turn.
        const stopReason = msg?.result?.stopReason;
        if (typeof stopReason === 'string') {
            const flushResult = parser.flush();
            if (!flushResult.output) {
                return { forward: msg };
            }

            dbg('flush@stopReason', { stopReason, outLen: flushResult.output.length });

            const flushForward: any = {
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: flushResult.output },
                    },
                },
            };
            if (lastSessionId) {
                flushForward.params.sessionId = lastSessionId;
            }

            return { forward: flushForward, extra: [msg] };
        }

        const update = msg?.params?.update;
        if (!update) {
            return { forward: msg };
        }
        if (update.sessionUpdate === 'end_of_turn') {
            const flushResult = parser.flush();
            if (!flushResult.output) {
                return { forward: msg };
            }

            const flushForward = {
                ...msg,
                params: {
                    ...msg.params,
                    update: {
                        ...update,
                        sessionUpdate: 'agent_message_chunk',
                        content: { ...(update.content || {}), text: flushResult.output },
                    },
                },
            };

            return { forward: flushForward, extra: [msg] };
        }
        if (update.sessionUpdate !== 'agent_message_chunk') {
            return { forward: msg };
        }
        const text = update?.content?.text;
        if (typeof text !== 'string' || !text) return { forward: msg };

        if (debug) {
            const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;
            dbg('chunk', { inLen: text.length, preview });
        }

        const result = parser.consume(text);
        const makeStructuredEvent = (evt: SysTagEvent) => ({
            jsonrpc: '2.0',
            method: structuredEventMethod,
            params: {
                type: evt.type,
                payload: evt.payload,
                raw: evt.raw,
                error: evt.error,
            },
        });

        if (debug && result.events.length) {
            dbg('events', result.events.map((e) => e.type));
        }
        if (
            debug &&
            text.includes('<SYS_BLOCK>') &&
            text.includes('</SYS_BLOCK>') &&
            !result.events.some((e) => e.type === 'sys_block')
        ) {
            dbg('WARN: saw closed SYS_BLOCK in same chunk but no sys_block event');
        }

        // Preserve the true position of SYS events by splitting the chunk into
        // interleaved "text chunk" and "structured_event" messages.
        const outMessages: any[] = [];
        for (const part of result.parts) {
            if (part.kind === 'text') {
                if (!part.text) continue;
                outMessages.push({
                    ...msg,
                    params: {
                        ...msg.params,
                        update: {
                            ...update,
                            content: { ...update.content, text: part.text },
                        },
                    },
                });
            } else {
                outMessages.push(makeStructuredEvent(part.event));
            }
        }

        if (outMessages.length === 0) {
            return { forward: null };
        }

        const [forward, ...extra] = outMessages;
        return { forward, extra };
    };
}
