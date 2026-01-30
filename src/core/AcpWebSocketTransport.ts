import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { JsonRpcMessage, JsonRpcId, JsonRpcMessageSchema } from '../common/types.js';

export interface AcpWebSocketOptions {
    url: string;
    reconnect?: boolean;
    reconnectInterval?: number;
}

export class AcpWebSocketTransport extends EventEmitter {
    private ws: WebSocket | null = null;
    private options: AcpWebSocketOptions;
    private pendingRequests = new Map<JsonRpcId, { resolve: (res: any) => void; reject: (err: any) => void }>();
    private nextId = 1;
    private connectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' = 'disconnected';

    constructor(options: AcpWebSocketOptions) {
        super();
        this.options = {
            reconnect: true,
            reconnectInterval: 2000,
            ...options,
        };
    }

    connect(): void {
        this.setConnectionState('connecting');
        console.log(`[ACP] Connecting to ${this.options.url}...`);
        this.ws = new WebSocket(this.options.url);

        this.ws.on('open', () => {
            console.log('[ACP] WebSocket Connected');
            this.setConnectionState('connected');
            this.emit('connected');
        });

        this.ws.on('message', (data) => {
            this.handleMessage(data.toString());
        });

        this.ws.on('close', () => {
            console.log('[ACP] WebSocket Closed');
            if (this.pendingRequests.size) {
                const err = new Error('WebSocket closed');
                for (const [, pending] of this.pendingRequests) {
                    pending.reject(err);
                }
                this.pendingRequests.clear();
            }
            this.emit('disconnected');
            if (this.options.reconnect) {
                this.setConnectionState('reconnecting');
                setTimeout(() => this.connect(), this.options.reconnectInterval);
            } else {
                this.setConnectionState('disconnected');
            }
        });

        this.ws.on('error', (err) => {
            console.error('[ACP] WebSocket Error:', err);
            this.emit('error', err);
        });
    }

    sendRequest(method: string, params: any): Promise<any> {
        const id = this.nextId++;
        const message: JsonRpcMessage = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise((resolve, reject) => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket is not open'));
                return;
            }
            this.pendingRequests.set(id, { resolve, reject });
            ws.send(JSON.stringify(message));
        });
    }

    sendNotification(method: string, params: any): void {
        const message: JsonRpcMessage = {
            jsonrpc: '2.0',
            method,
            params,
        };
        this.ws?.send(JSON.stringify(message));
    }

    sendResponse(id: JsonRpcId, result: any): void {
        const message: JsonRpcMessage = {
            jsonrpc: '2.0',
            id,
            result,
        };
        this.ws?.send(JSON.stringify(message));
    }

    private handleMessage(data: string): void {
        try {
            const raw = JSON.parse(data);
            const msg = JsonRpcMessageSchema.parse(raw);

            // Handle Response
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
                const pending = this.pendingRequests.get(msg.id);
                if (pending) {
                    this.pendingRequests.delete(msg.id);
                    if (msg.error) {
                        pending.reject(msg.error);
                    } else {
                        pending.resolve(msg.result);
                    }
                }
                return;
            }

            // Handle Request/Notification
            if (msg.method) {
                this.emit('notification', msg);
                this.emit(`method:${msg.method}`, msg);
            }
        } catch (err) {
            console.error('[ACP] Failed to parse message:', err);
        }
    }

    dispose(): void {
        this.options.reconnect = false;
        this.ws?.close();
        this.pendingRequests.clear();
        this.setConnectionState('disconnected');
    }

    private setConnectionState(state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') {
        if (this.connectionState === state) return;
        this.connectionState = state;
        this.emit('connection_state', state);
    }
}
