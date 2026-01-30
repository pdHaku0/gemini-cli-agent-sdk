import { AgentChatClient } from '../core/AgentChatClient.js';
import { ChatMessage, ConnectionState, PendingApproval } from '../common/types.js';

export interface AgentChatState {
    connectionState: ConnectionState;
    isStreaming: boolean;
    messages: ChatMessage[];
    pendingApproval: PendingApproval | null;
    authUrl: string | null;
    lastStopReason: string | null;
    lastError: unknown | null;
}

type StateListener = (state: AgentChatState) => void;

export class AgentChatStore {
    private client: AgentChatClient;
    private state: AgentChatState;
    private listeners = new Set<StateListener>();
    private bindings: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    constructor(client: AgentChatClient) {
        this.client = client;
        this.state = {
            connectionState: client.getConnectionState(),
            isStreaming: false,
            messages: client.getMessages(),
            pendingApproval: client.getPendingApproval(),
            authUrl: client.getAuthUrl(),
            lastStopReason: null,
            lastError: null,
        };

        this.bind('connection_state_changed', (evt: { state: ConnectionState }) => {
            this.setState({ connectionState: evt.state });
        });
        this.bind('message', () => this.setState({ messages: client.getMessages() }));
        this.bind('message_update', () => this.setState({ messages: client.getMessages() }));
        this.bind('turn_started', () => this.setState({ isStreaming: true, lastStopReason: null }));
        this.bind('turn_completed', (reason: string) => this.setState({ isStreaming: false, lastStopReason: reason || null }));
        this.bind('permission_required', (approval: PendingApproval) => this.setState({ pendingApproval: approval }));
        this.bind('approval_resolved', () => this.setState({ pendingApproval: null }));
        this.bind('auth_required', (url: string) => this.setState({ authUrl: url }));
        this.bind('auth_resolved', () => this.setState({ authUrl: null }));
        this.bind('error', (err: unknown) => this.setState({ lastError: err }));
    }

    getState(): AgentChatState {
        return this.state;
    }

    subscribe(listener: StateListener): () => void {
        this.listeners.add(listener);
        listener(this.state);
        return () => {
            this.listeners.delete(listener);
        };
    }

    dispose() {
        for (const { event, handler } of this.bindings) {
            this.client.removeListener(event, handler);
        }
        this.bindings = [];
        this.listeners.clear();
    }

    private bind(event: string, handler: (...args: any[]) => void) {
        this.client.on(event, handler);
        this.bindings.push({ event, handler });
    }

    private setState(partial: Partial<AgentChatState>) {
        this.state = { ...this.state, ...partial };
        for (const listener of this.listeners) {
            listener(this.state);
        }
    }
}
