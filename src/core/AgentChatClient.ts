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
    PendingApproval
} from '../common/types.js';
import { extractNewStreamSegment } from './stream-utils.js';
import { createUnifiedDiff } from './diff-utils.js';

export interface AgentChatClientOptions {
    url: string;
    model?: string;
    cwd?: string; // Protocol requires this
    diffContextLines?: number; // Unified diff context lines
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

    constructor(options: AgentChatClientOptions) {
        super();
        this.options = { cwd: process.cwd(), ...options };
        this.transport = new AcpWebSocketTransport({ url: options.url, reconnect: true });
        this.setupHandlers();
    }

    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.transport.once('connected', async () => {
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

    async sendMessage(text: string) {
        if (!this.sessionId) throw new Error('Session not initialized');

        const userMsg: ChatMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            text,
            ts: Date.now(),
        };
        this.messages.push(userMsg);
        this.emit('message', userMsg);
        this.inTurn = true;
        this.activeAssistantId = null;
        this.emit('turn_started', { userMessageId: userMsg.id });

        let result: any;
        try {
            result = await this.transport.sendRequest('session/prompt', {
                sessionId: this.sessionId,
                prompt: [{ type: 'text', text }],
            });
        } catch (err) {
            this.emit('turn_completed', 'error');
            this.inTurn = false;
            throw err;
        }

        if (result?.stopReason) {
            const last = this.getOrCreateAssistantMessage();
            last.stopReason = result.stopReason;
            this.emit('message_update', last);
            this.emit('turn_completed', result.stopReason);
            if (this.lastFinalizedAssistantId !== last.id) {
                this.emit('assistant_text_final', { messageId: last.id, text: last.text });
                this.lastFinalizedAssistantId = last.id;
            }
            this.inTurn = false;
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
        const { requestId } = this.pendingApproval;

        await this.transport.sendResponse(requestId, {
            sessionId: this.sessionId,
            outcome: { outcome: 'selected', optionId },
        });

        // Some implementations require this double-tap notification
        await this.transport.sendNotification('session/provide_permission', {
            sessionId: this.sessionId,
            outcome: { outcome: 'selected', optionId }
        });

        this.pendingApproval = null;
        this.emit('approval_resolved');
    }

    getMessages() {
        return [...this.messages];
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
                this.emit('turn_completed', update.stopReason);
                this.inTurn = false;
                if (this.activeAssistantId) {
                    const last = this.messages.find(m => m.id === this.activeAssistantId) as AssistantMessage | undefined;
                    if (last && this.lastFinalizedAssistantId !== last.id) {
                        this.emit('assistant_text_final', { messageId: last.id, text: last.text });
                        this.lastFinalizedAssistantId = last.id;
                    }
                }
                break;
        }
    }

    private updateAssistantMessageNormalized(delta: { text?: string; thought?: string }) {
        const last = this.getOrCreateAssistantMessage();

        if (delta.thought) {
            const rawChunk = delta.thought;
            const newSegment = extractNewStreamSegment(last.thought, rawChunk);
            if (newSegment) {
                last.thought += newSegment;
                this.emit('thought_delta', { messageId: last.id, delta: newSegment, thought: last.thought });
                this.emit('assistant_thought_delta', { messageId: last.id, delta: newSegment, thought: last.thought });
                this.emit('message_update', last);
            }
        }

        if (delta.text) {
            const rawChunk = delta.text;
            const newSegment = extractNewStreamSegment(last.text, rawChunk);
            if (newSegment) {
                last.text += newSegment;
                this.emit('text_delta', { messageId: last.id, delta: newSegment, text: last.text });
                this.emit('assistant_text_delta', { messageId: last.id, delta: newSegment, text: last.text });
                this.emit('message_update', last);
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
            ts: Date.now(),
        };

        last.toolCalls.push(toolCall);
        this.emit('tool_update', { messageId: last.id, toolCall });
        this.emit('tool_call_started', { messageId: last.id, toolCall });
        this.emit('message_update', last);
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
                    else if (contentObj?.type === 'diff') {
                        const oldText = contentObj.oldText ?? '';
                        const newText = contentObj.newText ?? '';
                        const contextLines = this.normalizeDiffContextLines(this.options.diffContextLines);
                        const unified = createUnifiedDiff(oldText, newText, contentObj.path, contextLines);
                        toolCall.diff = {
                            path: contentObj.path,
                            unified,
                            oldTextLength: oldText.length,
                            newTextLength: newText.length,
                        };
                        text = unified;
                    }

                    if (text) {
                        toolCall.result = toolCall.result ? `${toolCall.result}\n${text}` : text;
                    }
                }
            }
            this.emit('tool_update', { messageId: last.id, toolCall });
            this.emit('tool_call_updated', { messageId: last.id, toolCall });
            if (toolCall.status === 'completed' || toolCall.status === 'failed' || toolCall.status === 'cancelled') {
                this.emit('tool_call_completed', { messageId: last.id, toolCall });
            }
            this.emit('message_update', last);
        }
    }

    private getOrCreateAssistantMessage(): AssistantMessage {
        let last = this.messages[this.messages.length - 1] as AssistantMessage;
        if (!last || last.role !== 'assistant') {
            last = {
                id: `assistant-${Date.now()}`,
                role: 'assistant',
                text: '',
                thought: '',
                toolCalls: [],
                ts: Date.now(),
            };
            this.messages.push(last);
            if (this.inTurn) this.activeAssistantId = last.id;
        }
        return last;
    }

    private handleAuthUrl(notif: AcpAuthUrlNotification) {
        this.authUrl = notif.params.url;
        this.emit('auth_required', this.authUrl);
    }

    private handlePermissionRequest(req: AcpRequestPermissionNotification) {
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
        this.emit('approval_required', this.pendingApproval);
        this.emit('permission_required', this.pendingApproval);
    }

    dispose() {
        this.transport.dispose();
        this.messages = [];
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
            ts: Date.now(),
        };
        last.toolCalls.push(toolCall);
        this.emit('tool_update', { messageId: last.id, toolCall });
        this.emit('tool_call_started', { messageId: last.id, toolCall });
        this.emit('message_update', last);
        return toolCall;
    }

    private normalizeDiffContextLines(value?: number) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 3;
        return Math.floor(value);
    }
}
