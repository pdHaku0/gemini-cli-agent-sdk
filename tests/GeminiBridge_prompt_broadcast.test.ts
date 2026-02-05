// @ts-nocheck
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeminiBridge } from '../src/server/GeminiBridge';

class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    _socket = { remoteAddress: '127.0.0.1' };

    send(data: string) {
        this.sent.push(data);
    }
}

describe('GeminiBridge session/prompt realtime broadcast', () => {
    test('broadcasts session/prompt to peers as bridge/replay envelope', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-bridge-'));
        const bridge = new GeminiBridge({ projectRoot: tmp });

        const ws1 = new FakeWebSocket() as any;
        const ws2 = new FakeWebSocket() as any;

        (bridge as any).geminiProcess = { stdin: { write: jest.fn() } };
        (bridge as any).wss = { clients: new Set([ws1, ws2]) };

        (bridge as any).handleConnection(ws1, { url: '/' });
        (bridge as any).handleConnection(ws2, { url: '/' });

        ws1.emit(
            'message',
            Buffer.from(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: '1',
                    method: 'session/prompt',
                    params: {
                        sessionId: 's',
                        prompt: [{ type: 'text', text: '<SYS_JSON>worker.batch</SYS_JSON>', meta: { hidden: 'user' } }],
                    },
                })
            )
        );

        expect(ws1.sent).toHaveLength(0);
        expect(ws2.sent).toHaveLength(1);

        const msg = JSON.parse(ws2.sent[0]);
        expect(msg.method).toBe('bridge/replay');
        expect(typeof msg.params.timestamp).toBe('number');
        expect(typeof msg.params.replayId).toBe('string');

        const payload = msg.params.data;
        expect(payload.method).toBe('session/prompt');
        expect(payload.params.prompt[0].text).toBe('<SYS_JSON>worker.batch</SYS_JSON>');
        expect(payload.__hiddenMode).toBe('user');
        expect(payload.params.meta.hidden).toBe('user');
        expect(payload.__turnId).toBe(1);
    });
});
