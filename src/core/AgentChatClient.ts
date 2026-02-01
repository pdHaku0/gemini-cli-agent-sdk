import { EventEmitter } from 'events';
import { AcpWebSocketTransport } from './AcpWebSocketTransport.js';
import {
    ChatMessage,
    AssistantMessage,
    ToolCall,
    ToolStatus,
    AcpSessionUpdateNotification,
    AcpRequestPermissionNotification,
    AcpAuthUrlNotification,
    JsonRpcMessage,
    ConnectionState,
    PendingApproval,
    HiddenMode,
    JsonRpcId
} from '../common/types.js';
import { extractNewStreamSegment } from './stream-utils.js';
import { createUnifiedDiff } from './diff-utils.js';

export interface AgentChatClientOptions {
    url: string;
    model?: string;
    cwd?: string; // Protocol requires this
    diffContextLines?: number; // Unified diff context lines
    sessionId?: string;
    replay?: {
        limit?: number;
        since?: number;
        before?: number;
    };
}

export class AgentChatClient extends EventEmitter {
    private transport: AcpWebSocketTransport;
    private sessionId: string | null = null;
    private messages: ChatMessage[] = [];
    private authUrl: string | null = null;
    private pendingApproval: PendingApproval | null = null;
    private options: AgentChatClientOptions;
    private connectionState: ConnectionState = 'disconnected';
    private inTurn = false;
    private activeAssistantId: string | null = null;
    private lastFinalizedAssistantId: string | null = null;
    private timeOverride: number | null = null;
    private idCounter = 0;
    private replayNonce: string | null = null;
    private currentTurnHidden: HiddenMode = 'none';

    constructor(options: AgentChatClientOptions) {
        super();
        const baseCwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : undefined;
        this.options = { cwd: baseCwd, ...options };
        if (options.sessionId) this.sessionId = options.sessionId;
        const url = this.buildUrlWithReplay(options.url, options.replay);
        this.transport = new AcpWebSocketTransport({ url, reconnect: true });
        this.setupHandlers();
    }

    async connect(options: { autoSession?: boolean } = {}): Promise<void> {
        const { autoSession = true } = options;
        return new Promise((resolve, reject) => {
            this.transport.once('connected', async () => {
                if (this.sessionId) {
                    this.emit('session_ready', this.sessionId);
                    resolve();
                    return;
                }
                if (!autoSession) {
                    resolve();
                    return;
                }
                try {
                    await this.initializeSession();
                    resolve();
                } catch (err) {
                    console.error('[AgentChat] Session init failed:', JSON.stringify(err, null, 2));
                    reject(err);
                }
            });
            this.transport.on('error', (err) => reject(err));
            this.transport.connect();
        });
    }

    private async initializeSession() {
        const result = await this.transport.sendRequest('session/new', {
            cwd: this.options.cwd,
            model: this.options.model,
            mcpServers: []
        });
        this.sessionId = result.sessionId;
        this.emit('session_ready', this.sessionId);
    }

    setSessionId(sessionId: string | null) {
        this.sessionId = sessionId;
    }

    getSessionId() {
        return this.sessionId;
    }

    async sendMessage(text: string, options: { hidden?: HiddenMode } = {}) {
        if (!this.sessionId) throw new Error('Session not initialized');

        const hiddenMode = options.hidden ?? 'none';
        this.currentTurnHidden = hiddenMode;

        const userMsg: ChatMessage = {
            id: this.makeId('user'),
            role: 'user',
            text,
            hidden: hiddenMode === 'user' || hiddenMode === 'turn',
            ts: Date.now(),
        };
        this.messages.push(userMsg);
        if (this.shouldEmitUser(hiddenMode)) {
            this.emit('message', userMsg);
        }
        this.inTurn = true;
        this.activeAssistantId = null;
        if (this.shouldEmitAssistant(hiddenMode)) {
            this.emit('turn_started', { userMessageId: userMsg.id });
        }

        let result: any;
        try {
            result = await this.transport.sendRequest('session/prompt', {
                sessionId: this.sessionId,
                prompt: [{ type: 'text', text, meta: { hidden: hiddenMode } }],
            });
        } catch (err) {
            if (this.shouldEmitAssistant(hiddenMode)) {
                this.emit('turn_completed', 'error');
            }
            this.inTurn = false;
            this.currentTurnHidden = 'none';
            throw err;
        }

        if (result?.stopReason) {
            const last = this.getOrCreateAssistantMessage();
            last.stopReason = result.stopReason;
            if (this.shouldEmitAssistant(hiddenMode)) {
                this.emit('message_update', last);
                this.emit('turn_completed', result.stopReason);
                if (this.lastFinalizedAssistantId !== last.id) {
                    this.emit('assistant_text_final', { messageId: last.id, text: last.text });
                    this.lastFinalizedAssistantId = last.id;
                }
            }
            this.inTurn = false;
            this.currentTurnHidden = 'none';
        }
    }

    async submitAuthCode(code: string) {
        // Send as a special notification that bridge intercepts
        await this.transport.sendNotification('gemini/submitAuthCode', { code });
        this.authUrl = null;
        this.emit('auth_resolved');
    }

    async cancel() {
        if (!this.sessionId) return;
        try {
            await this.transport.sendRequest('session/cancel', { sessionId: this.sessionId });
            // Optimistically finish the turn
            this.emit('turn_completed', 'canceled');
            this.inTurn = false;
        } catch (error) {
            console.error('[AgentChatClient] Failed to cancel:', error);
        }
    }

    async approveTool(optionId: string) {
        if (!this.pendingApproval) return;
        await this.resolveApproval(this.pendingApproval.requestId, optionId);
    }

    getMessages(options: { includeHidden?: boolean } = {}) {
        if (options.includeHidden) return [...this.messages];
        return this.messages.filter((msg) => !msg.hidden);
    }

    prependMessages(messages: ChatMessage[]) {
        if (!messages.length) return;
        this.messages = [...messages, ...this.messages];
        this.emit('messages_replayed', { count: messages.length });
        const last = this.messages[this.messages.length - 1];
        if (!last.hidden) {
            this.emit('message_update', last);
        }
    }

    getAuthUrl() {
        return this.authUrl;
    }

    getPendingApproval() {
        return this.pendingApproval;
    }

    getConnectionState() {
        return this.connectionState;
    }

    dispose() {
        this.transport.dispose();
        this.messages = [];
        this.removeAllListeners();
    }

    private setupHandlers() {
        this.transport.on('connection_state', (state: ConnectionState) => {
            this.connectionState = state;
            this.emit('connection_state_changed', { state });
        });
        this.transport.on('error', (err) => {
            this.emit('error', err);
        });
        this.transport.on('notification', (msg: JsonRpcMessage) => {
            switch (msg.method) {
                case 'session/update':
                    this.handleSessionUpdate(msg as unknown as AcpSessionUpdateNotification);
                    break;
                case 'gemini/authUrl':
                    this.handleAuthUrl(msg as unknown as AcpAuthUrlNotification);
                    break;
                case 'bridge/replay': {
                    const payload = (msg as any)?.params?.data;
                    const ts = (msg as any)?.params?.timestamp;
                    const replayId = (msg as any)?.params?.replayId;
                    const hiddenMode = payload?.__hiddenMode ?? payload?.params?.meta?.hidden;
                    if (typeof ts === 'number') this.timeOverride = ts;
                    if (typeof replayId === 'string') this.replayNonce = replayId;
                    if (typeof hiddenMode === 'string') {
                        this.currentTurnHidden = hiddenMode as HiddenMode;
                    }
                    if (payload?.method === 'session/update') {
                        this.handleSessionUpdate(payload as AcpSessionUpdateNotification);
                    } else if (payload?.method === 'session/prompt') {
                        this.handleReplayPrompt(payload?.params?.prompt, hiddenMode);
                    } else if (payload?.method === 'gemini/authUrl') {
                        this.handleAuthUrl(payload as AcpAuthUrlNotification);
                    } else {
                        const update = payload?.params?.update;
                        if (update?.sessionUpdate) {
                            this.handleSessionUpdate({ method: 'session/update', params: { update } } as AcpSessionUpdateNotification);
                        }
                    }
                    this.timeOverride = null;
                    this.replayNonce = null;
                    break;
                }
                default: {
                    const update = (msg as any)?.params?.update;
                    if (update?.sessionUpdate) {
                        this.handleSessionUpdate({ method: 'session/update', params: { update } } as AcpSessionUpdateNotification);
                    }
                    break;
                }
            }
        });

        this.transport.on('method:session/request_permission', (msg: JsonRpcMessage) => {
            this.handlePermissionRequest(msg as unknown as AcpRequestPermissionNotification);
        });
    }

    private handleSessionUpdate(notification: AcpSessionUpdateNotification) {
        const update = notification.params.update;
        switch (update.sessionUpdate) {
            case 'agent_thought_chunk':
                this.updateAssistantMessageNormalized({ thought: update.content?.text });
                break;
            case 'agent_message_chunk':
                this.updateAssistantMessageNormalized({ text: update.content?.text });
                break;
            case 'tool_call':
                this.handleToolCall(update);
                break;
            case 'tool_call_update':
                this.handleToolUpdate(update);
                break;
            case 'end_of_turn':
                if (this.shouldEmitAssistant(this.currentTurnHidden)) {
                    this.emit('turn_completed', update.stopReason);
                }
                this.inTurn = false;
                if (this.activeAssistantId) {
                    const last = this.messages.find(m => m.id === this.activeAssistantId) as AssistantMessage | undefined;
                    if (last && this.lastFinalizedAssistantId !== last.id) {
                        if (this.shouldEmitAssistant(this.currentTurnHidden)) {
                            this.emit('assistant_text_final', { messageId: last.id, text: last.text });
                        }
                        this.lastFinalizedAssistantId = last.id;
                    }
                }
                this.currentTurnHidden = 'none';
                break;
        }
    }

    private updateAssistantMessageNormalized(delta: { text?: string; thought?: string }) {
        const last = this.getOrCreateAssistantMessage();
        const shouldEmitAssistant = this.shouldEmitAssistant(this.currentTurnHidden);

        if (delta.thought) {
            const rawChunk = delta.thought;

            // Logic change: rectify against the CURRENT active thought part
            let lastPart = last.content[last.content.length - 1];
            if (!lastPart || lastPart.type !== 'thought') {
                lastPart = { type: 'thought', thought: '' };
                last.content.push(lastPart);
            }

            const currentPartThought = lastPart.type === 'thought' ? lastPart.thought : '';
            const newSegment = extractNewStreamSegment(currentPartThought, rawChunk);

            if (newSegment && lastPart.type === 'thought') {
                lastPart.thought += newSegment;
                last.thought += newSegment; // Update global thought for legacy

                if (shouldEmitAssistant) {
                    this.emit('thought_delta', { messageId: last.id, delta: newSegment, thought: last.thought });
                    this.emit('assistant_thought_delta', { messageId: last.id, delta: newSegment, thought: last.thought });
                    this.emit('message_update', last);
                }
            }
        }

        if (delta.text) {
            const rawChunk = delta.text;

            // Logic change: we must rectify against the CURRENT active text part, not the global text
            // 1. Find or create active text part
            let lastPart = last.content[last.content.length - 1];
            if (!lastPart || lastPart.type !== 'text') {
                lastPart = { type: 'text', text: '' };
                last.content.push(lastPart);
            }

            const currentPartText = lastPart.type === 'text' ? lastPart.text : ''; // Should be text

            // 2. Rectify relative to THAT part
            const newSegment = extractNewStreamSegment(currentPartText, rawChunk);

            if (newSegment && lastPart.type === 'text') {
                lastPart.text += newSegment; // Update structured content
                last.text += newSegment;     // Update flat text (legacy)

                if (shouldEmitAssistant) {
                    this.emit('text_delta', { messageId: last.id, delta: newSegment, text: last.text });
                    this.emit('assistant_text_delta', { messageId: last.id, delta: newSegment, text: last.text });
                    this.emit('message_update', last);
                }
            }
        }
    }

    private handleToolCall(update: any) {
        const last = this.getOrCreateAssistantMessage();
        const toolCallId = update.toolCallId;
        const name = toolCallId?.split('-')[0] || 'unknown';
        const parsed = this.parseToolTitle(update.title);



        let status = (update.status || 'running') as ToolStatus;
        if (update.status === 'in_progress') {
            status = 'running';
        }

        const toolCall: ToolCall = {
            id: toolCallId,
            name,
            title: update.title || '',
            status,
            args: parsed.args,
            input: parsed.input,
            description: parsed.description,
            workingDir: parsed.workingDir,
            ts: this.now(),
        };

        last.toolCalls.push(toolCall);
        // Add to ordered content
        last.content.push({ type: 'tool_call', call: toolCall });

        if (this.shouldEmitAssistant(this.currentTurnHidden)) {
            this.emit('tool_update', { messageId: last.id, toolCall });
            this.emit('tool_call_started', { messageId: last.id, toolCall });
            this.emit('message_update', last);
        }
    }

    private handleToolUpdate(update: any) {
        const last = this.getOrCreateAssistantMessage();
        const toolCallId = update.toolCallId;
        let toolCall = last.toolCalls.find(t => t.id === toolCallId);
        if (!toolCall && this.pendingApproval && this.pendingApproval.toolCall?.toolCallId === toolCallId) {
            toolCall = this.createToolCallFromPermission(last, this.pendingApproval);
        }

        if (toolCall) {
            if (update.status) {
                toolCall.status = (update.status === 'in_progress' ? 'running' : update.status) as ToolStatus;
            }
            if (update.content) {
                const contentList = Array.isArray(update.content) ? update.content : [update.content];
                for (const contentObj of contentList) {
                    let text = '';
                    if (typeof contentObj === 'string') text = contentObj;
                    else if (contentObj?.content?.text) text = contentObj.content.text;
                    else {
                        const diff = this.extractDiffData(contentObj);
                        if (diff) {
                            toolCall.diff = diff;
                            text = diff.unified;
                        }
                    }

                    if (text) {
                        toolCall.result = toolCall.result ? `${toolCall.result}\n${text}` : text;
                    }
                }
            }
            if (this.shouldEmitAssistant(this.currentTurnHidden)) {
                this.emit('tool_update', { messageId: last.id, toolCall });
                this.emit('tool_call_updated', { messageId: last.id, toolCall });
            }
            if (toolCall.status === 'completed' || toolCall.status === 'failed' || toolCall.status === 'cancelled') {
                if (this.shouldEmitAssistant(this.currentTurnHidden)) {
                    this.emit('tool_call_completed', { messageId: last.id, toolCall });
                }
            }
            if (this.shouldEmitAssistant(this.currentTurnHidden)) {
                this.emit('message_update', last);
            }
        }
    }

    private getOrCreateAssistantMessage(): AssistantMessage {
        let last = this.messages[this.messages.length - 1] as AssistantMessage;
        if (!last || last.role !== 'assistant') {
            last = {
                id: this.makeId('assistant'),
                role: 'assistant',
                text: '',
                thought: '',
                content: [],
                toolCalls: [],
                ts: this.now(),
                hidden: this.currentTurnHidden === 'assistant' || this.currentTurnHidden === 'turn',
            };
            this.messages.push(last);
            if (this.shouldEmitAssistant(this.currentTurnHidden)) {
                this.emit('message', last);
            }
            if (this.inTurn) this.activeAssistantId = last.id;
        }
        return last;
    }

    private handleAuthUrl(notif: AcpAuthUrlNotification) {
        this.authUrl = notif.params.url;
        this.emit('auth_required', this.authUrl);
    }

    private handlePermissionRequest(req: AcpRequestPermissionNotification) {
        if (this.shouldAutoRejectApproval(this.currentTurnHidden)) {
            const denyOption = req.params.options.find((opt) => opt.kind.startsWith('deny') || opt.kind.startsWith('reject'));
            if (denyOption) {
                this.resolveApproval(req.id ?? 'unknown-id', denyOption.optionId).catch(() => { });
            }
            return;
        }
        const parsed = this.parseToolTitle(req.params.toolCall?.title || '');
        this.pendingApproval = {
            requestId: req.id ?? 'unknown-id',
            toolCall: req.params.toolCall,
            options: req.params.options,
        };
        this.pendingApproval.toolCall.input = parsed.input;
        this.pendingApproval.toolCall.description = parsed.description;
        this.pendingApproval.toolCall.workingDir = parsed.workingDir;
        this.pendingApproval.toolCall.args = parsed.args;
        const last = this.getOrCreateAssistantMessage();
        this.createToolCallFromPermission(last, this.pendingApproval);
        // Pure SDK: just notify app. App handles policy.
        if (this.shouldEmitAssistant(this.currentTurnHidden)) {
            this.emit('approval_required', this.pendingApproval);
            this.emit('permission_required', this.pendingApproval);
        }
    }

    disconnect() {
        this.dispose();
    }

    private shouldEmitUser(hiddenMode: HiddenMode) {
        return hiddenMode === 'none' || hiddenMode === 'assistant';
    }

    private shouldEmitAssistant(hiddenMode: HiddenMode) {
        return hiddenMode === 'none' || hiddenMode === 'user';
    }

    private shouldAutoRejectApproval(hiddenMode: HiddenMode) {
        return hiddenMode === 'assistant' || hiddenMode === 'turn';
    }

    private async resolveApproval(requestId: JsonRpcId, optionId: string) {
        await this.transport.sendResponse(requestId, {
            sessionId: this.sessionId,
            outcome: { outcome: 'selected', optionId },
        });
        await this.transport.sendNotification('session/provide_permission', {
            sessionId: this.sessionId,
            outcome: { outcome: 'selected', optionId },
        });
        this.pendingApproval = null;
        this.emit('approval_resolved');
    }

    private parseToolTitle(title?: string) {
        let args: any = null;
        let description: string | undefined;
        let workingDir: string | undefined;
        let input: string | undefined = title || '';

        if (title) {
            const jsonMatch = title.match(/inputs?:\s*(\{.*\})/);
            if (jsonMatch) {
                try {
                    args = JSON.parse(jsonMatch[1]);
                } catch (e) {
                    args = jsonMatch[1];
                }
            } else {
                // Ensure input is a string
                input = input || '';

                // Extract Working Directory [...] first
                // Use a more specific regex for CWD to avoid false positives, but keep fallback
                const cwdMatch = title.match(/\s*\[(current working directory [^\]]+)\]/);
                if (cwdMatch) {
                    const cwdRaw = cwdMatch[1];
                    workingDir = cwdRaw.replace(/^current working directory\s*/i, '');
                    // Remove CWD from input, being careful if it appears in the middle
                    input = input.replace(cwdMatch[0], '');
                }

                // Extract Description (...) at the end
                // Use manual backward scanning to handle nested parentheses
                const trimmedInput = input.trimEnd();
                if (trimmedInput.endsWith(')')) {
                    let balance = 0;
                    let startIndex = -1;
                    for (let i = trimmedInput.length - 1; i >= 0; i--) {
                        if (trimmedInput[i] === ')') balance++;
                        if (trimmedInput[i] === '(') balance--;

                        if (balance === 0) {
                            startIndex = i;
                            break;
                        }
                    }

                    if (startIndex !== -1) {
                        description = trimmedInput.substring(startIndex + 1, trimmedInput.length - 1);
                        // Remove description from input, handling the whitespace before it
                        const fullMatch = trimmedInput.substring(startIndex);
                        // finding the actual match in the original input string to preserve robust replacement
                        const matchIndex = input.lastIndexOf(fullMatch);
                        if (matchIndex !== -1) {
                            input = input.substring(0, matchIndex);
                        }
                    }
                }

                input = input.trim();
            }
        }

        return { args, input, description, workingDir };
    }

    private createToolCallFromPermission(last: AssistantMessage, approval: PendingApproval) {
        const toolCallId = approval.toolCall?.toolCallId || 'unknown';
        let toolCall = last.toolCalls.find(t => t.id === toolCallId);
        if (toolCall) return toolCall;
        const name = toolCallId.split('-')[0] || 'unknown';
        toolCall = {
            id: toolCallId,
            name,
            title: approval.toolCall?.title || '',
            status: 'queued',
            args: approval.toolCall?.args,
            input: approval.toolCall?.input,
            description: approval.toolCall?.description,
            workingDir: approval.toolCall?.workingDir,
            ts: this.now(),
        };
        last.toolCalls.push(toolCall);
        last.content.push({ type: 'tool_call', call: toolCall }); // Fix: Add to ordered content
        this.emit('tool_update', { messageId: last.id, toolCall });
        this.emit('tool_call_started', { messageId: last.id, toolCall });
        this.emit('message_update', last);
        return toolCall;
    }

    private extractDiffData(contentObj: any): ToolCall['diff'] | null {
        if (!contentObj || typeof contentObj !== 'object') return null;

        const diffPayload =
            (contentObj.type === 'diff' ? contentObj : null) ||
            contentObj.diff ||
            contentObj.content?.diff ||
            null;

        if (!diffPayload || typeof diffPayload !== 'object') return null;

        const path = diffPayload.path ?? contentObj.path;
        const oldText = diffPayload.oldText ?? diffPayload.before ?? '';
        const newText = diffPayload.newText ?? diffPayload.after ?? '';
        const unifiedFromPayload = diffPayload.unified ?? diffPayload.patch ?? diffPayload.diff;

        let unified = '';
        if (typeof unifiedFromPayload === 'string' && unifiedFromPayload.trim()) {
            unified = unifiedFromPayload.trimEnd();
        } else {
            const contextLines = this.normalizeDiffContextLines(this.options.diffContextLines);
            unified = createUnifiedDiff(String(oldText ?? ''), String(newText ?? ''), path, contextLines);
        }

        if (!unified) return null;

        const oldLen = typeof oldText === 'string' ? oldText.length : undefined;
        const newLen = typeof newText === 'string' ? newText.length : undefined;

        return {
            path,
            unified,
            oldTextLength: oldLen,
            newTextLength: newLen,
        };
    }

    private normalizeDiffContextLines(value?: number) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 3;
        return Math.floor(value);
    }

    private now() {
        return this.timeOverride ?? Date.now();
    }

    private handleReplayPrompt(prompt: any, hiddenMode?: HiddenMode) {
        const first = Array.isArray(prompt) ? prompt[0] : prompt;
        const text = first?.text ?? '';
        if (typeof text !== 'string' || !text.trim()) return;
        const userMsg: ChatMessage = {
            id: this.makeId('user'),
            role: 'user',
            text,
            hidden: hiddenMode === 'user' || hiddenMode === 'turn',
            ts: this.now(),
        };
        this.messages.push(userMsg);
        this.emit('message', userMsg);
        this.emit('message_update', userMsg);
    }

    private makeId(prefix: string) {
        this.idCounter += 1;
        const nonce = this.replayNonce ? `-${this.replayNonce}` : '';
        return `${prefix}-${this.now()}${nonce}-${this.idCounter}`;
    }

    private buildUrlWithReplay(baseUrl: string, replay?: AgentChatClientOptions['replay']) {
        if (!replay || Object.values(replay).every((v) => v === undefined)) return baseUrl;
        try {
            const url = new URL(baseUrl);
            if (replay.limit !== undefined) url.searchParams.set('limit', String(replay.limit));
            if (replay.since !== undefined) url.searchParams.set('since', String(replay.since));
            if (replay.before !== undefined) url.searchParams.set('before', String(replay.before));
            return url.toString();
        } catch {
            const params: string[] = [];
            if (replay.limit !== undefined) params.push(`limit=${encodeURIComponent(String(replay.limit))}`);
            if (replay.since !== undefined) params.push(`since=${encodeURIComponent(String(replay.since))}`);
            if (replay.before !== undefined) params.push(`before=${encodeURIComponent(String(replay.before))}`);
            const joiner = baseUrl.includes('?') ? '&' : '?';
            return params.length ? `${baseUrl}${joiner}${params.join('&')}` : baseUrl;
        }
    }

    static async fetchReplay(
        baseUrl: string,
        replay: AgentChatClientOptions['replay'],
        options: { idleMs?: number } = {}
    ): Promise<ChatMessage[]> {
        const client = new AgentChatClient({ url: baseUrl, replay });
        const idleMs = options.idleMs ?? 200;
        let idleTimer: NodeJS.Timeout | null = null;
        let firstTimer: NodeJS.Timeout | null = null;
        let receivedAny = false;

        const bump = () => {
            receivedAny = true;
            if (firstTimer) {
                clearTimeout(firstTimer);
                firstTimer = null;
            }
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                const messages = client.getMessages();
                cleanup();
                resolve(messages);
            }, idleMs);
        };

        let resolve!: (value: ChatMessage[]) => void;
        let reject!: (reason?: any) => void;
        const promise = new Promise<ChatMessage[]>((res, rej) => {
            resolve = res;
            reject = rej;
        });

        const cleanup = () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (firstTimer) clearTimeout(firstTimer);
            client.dispose();
        };

        client.on('message', bump);
        client.on('message_update', bump);
        client.on('tool_update', bump);

        client.connect({ autoSession: false }).catch((err) => {
            cleanup();
            reject(err);
        });

        // In case no messages arrive at all
        firstTimer = setTimeout(() => {
            if (receivedAny) return;
            const messages = client.getMessages();
            cleanup();
            resolve(messages);
        }, idleMs);

        return promise;
    }
}
