import { EventEmitter } from 'events';
import { JsonRpcMessage, JsonRpcId, JsonRpcMessageSchema } from '../common/types.js';

export interface AcpWebSocketOptions {
    url: string;
    reconnect?: boolean;
    reconnectInterval?: number;
}

export class AcpWebSocketTransport extends EventEmitter {
    private ws: any | null = null;
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

    private getWebSocketConstructor(): any {
        // In browser, window.WebSocket is most likely to be the "real" native one.
        // Bundlers like Turbopack often shim globalThis.WebSocket to 'ws' shim.
        if (typeof window !== 'undefined' && typeof window.WebSocket === 'function') {
            return window.WebSocket;
        }

        const global: any = globalThis;
        const win: any = typeof window !== 'undefined' ? window : {};

        // Follow-up checks
        if (typeof global.WebSocket === 'function') return global.WebSocket;
        if (global.WebSocket?.WebSocket) return global.WebSocket.WebSocket;
        if (win.WebSocket?.WebSocket) return win.WebSocket.WebSocket;
        if (typeof win.MozWebSocket === 'function') return win.MozWebSocket;

        return null;
    }

    connect(): void {
        this.setConnectionState('connecting');
        console.log(`[ACP] Connecting to ${this.options.url}...`);

        const WS = this.getWebSocketConstructor();
        if (!WS) {
            const err = new Error('WebSocket constructor not found in this environment');
            console.error('[ACP]', err);
            this.emit('error', err);
            return;
        }

        try {
            this.ws = new WS(this.options.url);

            this.ws.onopen = () => {
                console.log(`[ACP] WebSocket Connected to ${this.options.url}`);
                this.setConnectionState('connected');
                this.emit('connected');
            };

            this.ws.onmessage = async (event: any) => {
                try {
                    // Normalize data to string
                    let data = event.data;
                    if (typeof Blob !== 'undefined' && data instanceof Blob) {
                        data = await data.text();
                    } else if (typeof ArrayBuffer !== 'undefined' && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
                        data = new TextDecoder().decode(data);
                    }
                    this.handleMessage(data.toString());
                } catch (e) {
                    console.error('[ACP] Error processing message:', e);
                }
            };

            this.ws.onclose = (event: any) => {
                const reason = event.reason || 'no reason provided';
                const code = event.code;
                console.log(`[ACP] WebSocket Closed (URL: ${this.options.url}, Code: ${code}, Reason: ${reason})`);

                if (this.pendingRequests.size) {
                    const err = new Error(`WebSocket closed: ${reason} (code: ${code})`);
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
            };

            this.ws.onerror = (err: any) => {
                // Browsers often fire a generic error event with no details.
                const msg = `WebSocket connection failed to ${this.options.url}. Check if the server is running and accessible.`;
                console.error(`[ACP] ${msg}`);
                this.emit('error', new Error(msg));
            };
        } catch (e: any) {
            console.error(`[ACP] Failed to initialize WebSocket for ${this.options.url}:`, e);
            this.emit('error', e);
        }
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
            if (!ws || ws.readyState !== 1) { // 1 = OPEN
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
        if (this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify(message));
        }
    }

    sendResponse(id: JsonRpcId, result: any): void {
        const message: JsonRpcMessage = {
            jsonrpc: '2.0',
            id,
            result,
        };
        if (this.ws?.readyState === 1) {
            this.ws.send(JSON.stringify(message));
        }
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
                        const errorMsg = msg.error.message || 'Unknown JSON-RPC error';
                        const error = new Error(errorMsg);
                        (error as any).code = msg.error.code;
                        (error as any).data = msg.error.data;
                        pending.reject(error);
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
        if (this.ws) {
            this.ws.onclose = null; // Prevent reconnect loop
            this.ws.close();
        }
        this.pendingRequests.clear();
        this.setConnectionState('disconnected');
    }

    private setConnectionState(state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') {
        if (this.connectionState === state) return;
        this.connectionState = state;
        this.emit('connection_state', state);
    }
}
