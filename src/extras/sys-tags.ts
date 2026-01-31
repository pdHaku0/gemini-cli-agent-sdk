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
}

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
    private readonly maxStartLen: number;

    constructor(options: SysTagParserOptions = {}) {
        this.mode = options.mode ?? 'event';
        this.jsonTag = options.jsonTag ?? DEFAULT_JSON_TAG;
        this.blockTag = options.blockTag ?? DEFAULT_BLOCK_TAG;
        this.jsonStart = `<${this.jsonTag}>`;
        this.jsonEnd = `</${this.jsonTag}>`;
        this.blockStart = `<${this.blockTag}>`;
        this.blockEnd = `</${this.blockTag}>`;
        this.maxStartLen = Math.max(this.jsonStart.length, this.blockStart.length);
    }

    setMode(mode: SysTagCaptureMode) {
        this.mode = mode;
    }

    consume(chunk: string): SysTagParseResult {
        if (this.mode === 'raw') {
            return { output: chunk, events: [] };
        }

        this.buffer += chunk;
        const events: SysTagEvent[] = [];
        let output = '';

        while (this.buffer.length) {
            if (!this.activeTag) {
                const jsonIdx = this.buffer.indexOf(this.jsonStart);
                const blockIdx = this.buffer.indexOf(this.blockStart);
                let nextIdx = -1;
                let nextTag: 'json' | 'block' | null = null;

                if (jsonIdx !== -1 && (blockIdx === -1 || jsonIdx < blockIdx)) {
                    nextIdx = jsonIdx;
                    nextTag = 'json';
                } else if (blockIdx !== -1) {
                    nextIdx = blockIdx;
                    nextTag = 'block';
                }

                if (nextIdx === -1) {
                    if (this.buffer.length < this.maxStartLen) break;
                    const safeCut = this.buffer.length - (this.maxStartLen - 1);
                    output += this.buffer.slice(0, safeCut);
                    this.buffer = this.buffer.slice(safeCut);
                    break;
                }

                output += this.buffer.slice(0, nextIdx);
                this.buffer = this.buffer.slice(nextIdx);
                if (nextTag === 'json' && this.buffer.startsWith(this.jsonStart)) {
                    this.buffer = this.buffer.slice(this.jsonStart.length);
                    this.activeTag = 'json';
                    this.captureBuffer = '';
                    continue;
                }
                if (nextTag === 'block' && this.buffer.startsWith(this.blockStart)) {
                    this.buffer = this.buffer.slice(this.blockStart.length);
                    this.activeTag = 'block';
                    this.captureBuffer = '';
                    continue;
                }
                // Fallback: output one char to avoid infinite loop
                output += this.buffer[0];
                this.buffer = this.buffer.slice(1);
                continue;
            }

            const endTag = this.activeTag === 'json' ? this.jsonEnd : this.blockEnd;
            const endIdx = this.buffer.indexOf(endTag);
            if (endIdx === -1) {
                this.captureBuffer += this.buffer;
                this.buffer = '';
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
            events.push(event);
            this.captureBuffer = '';
            this.activeTag = null;
        }

        return { output, events };
    }
}

export function createSysTagTransform(options: SysTagParserOptions = {}) {
    const mode = options.mode ?? 'event';
    const structuredEventMethod = options.structuredEventMethod ?? 'bridge/structured_event';
    const parser = new SysTagParser(options);
    parser.setMode(mode);

    return (msg: any): { forward?: any | null; extra?: any[] } | null => {
        if (!msg || typeof msg !== 'object') return { forward: msg };
        if (mode === 'raw') return { forward: msg };

        const update = msg?.params?.update;
        if (!update || update.sessionUpdate !== 'agent_message_chunk') {
            return { forward: msg };
        }
        const text = update?.content?.text;
        if (typeof text !== 'string' || !text) return { forward: msg };

        const result = parser.consume(text);
        const extras = result.events.map((evt) => ({
            jsonrpc: '2.0',
            method: structuredEventMethod,
            params: {
                type: evt.type,
                payload: evt.payload,
                raw: evt.raw,
                error: evt.error,
            },
        }));

        if (mode === 'both') {
            return { forward: msg, extra: extras };
        }

        const forward = {
            ...msg,
            params: {
                ...msg.params,
                update: {
                    ...update,
                    content: { ...update.content, text: result.output },
                },
            },
        };

        if (!result.output) {
            return { forward: null, extra: extras };
        }

        return { forward, extra: extras };
    };
}
