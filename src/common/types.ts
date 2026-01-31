import { z } from 'zod';

/**
 * Base JSON-RPC 2.0 types
 */
export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcMessageSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema.optional(),
    method: z.string().optional(),
    params: z.any().optional(),
    result: z.any().optional(),
    error: z.object({
        code: z.number(),
        message: z.string(),
        data: z.any().optional(),
    }).optional(),
});

export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;

/**
 * ACP Specific Types
 */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type HiddenMode = 'none' | 'user' | 'assistant' | 'turn';

export interface PendingApproval {
    requestId: JsonRpcId;
    toolCall: {
        toolCallId: string;
        kind: string;
        title: string;
        locations?: any[];
        input?: string;
        description?: string;
        workingDir?: string;
        args?: any;
    };
    options: Array<{
        optionId: string;
        kind: 'allow_once' | 'allow_always' | 'deny' | 'deny_always' | 'reject_once';
        label?: string;
        name?: string;
    }>;
}

// Session
export interface AcpSessionNewParams {
    cwd: string;
    mcpServers?: any[];
    model?: string;
}

export interface AcpSessionNewResult {
    sessionId: string;
}

// Prompting
export interface AcpPromptParams {
    sessionId: string;
    prompt: Array<{
        type: 'text';
        text: string;
    }>;
}

// Session Update (Notifications)
export type AcpSessionUpdateType =
    | 'agent_thought_chunk'
    | 'agent_message_chunk'
    | 'end_of_turn'
    | 'tool_call'
    | 'tool_call_update'
    | 'response.completed';

export interface AcpSessionUpdateNotification {
    method: 'session/update';
    params: {
        update: {
            sessionUpdate: AcpSessionUpdateType;
            content?: {
                type: 'text';
                text: string;
            };
            toolCallId?: string;
            kind?: string;
            title?: string;
            status?: string;
            locations?: any[];
            stopReason?: string;
        };
    };
}

// Permission & Auth
export interface AcpRequestPermissionNotification {
    id: JsonRpcId;
    method: 'session/request_permission';
    params: {
        toolCall: {
            toolCallId: string;
            kind: string;
            title: string;
            locations?: any[];
        };
        options: Array<{
            optionId: string;
            kind: 'allow_once' | 'deny' | 'allow_always' | 'deny_always';
            label?: string;
        }>;
    };
}

export interface AcpAuthUrlNotification {
    method: 'gemini/authUrl';
    params: {
        url: string;
    };
}

export interface AcpSubmitAuthCodeParams {
    code: string;
}

// State Mapping for UI
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export type ToolStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ToolCall {
    id: string;
    name: string;
    title: string;
    description?: string;
    workingDir?: string;
    status: ToolStatus;
    input?: string;
    args?: any;
    result?: string;
    diff?: {
        path?: string;
        unified: string;
        oldTextLength?: number;
        newTextLength?: number;
    };
    ts: number;
}

export type MessageContentPart =
    | { type: 'text'; text: string }
    | { type: 'thought'; thought: string }
    | { type: 'tool_call'; call: ToolCall };

export interface AssistantMessage {
    id: string;
    role: 'assistant';
    thought: string;
    text: string;
    content: MessageContentPart[];
    toolCalls: ToolCall[];
    stopReason?: string;
    hidden?: boolean;
    ts: number;
}

export interface UserMessage {
    id: string;
    role: 'user';
    text: string;
    hidden?: boolean;
    ts: number;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface AgentChatState {
    connectionState: ConnectionState;
    isStreaming: boolean;
    messages: ChatMessage[];
    pendingApproval: PendingApproval | null;
    authUrl: string | null;
    lastStopReason: string | null;
    lastError: unknown | null;
}
