// @ts-nocheck
import { AgentChatClient } from '../src/core/AgentChatClient';
import { AcpWebSocketTransport } from '../src/core/AcpWebSocketTransport';
import { EventEmitter } from 'events';

// Mock Transport
class MockTransport extends EventEmitter {
    connect() { setTimeout(() => this.emit('connected'), 0); }
    sendRequest() { return Promise.resolve({ sessionId: 'mock-session' }); }
    sendNotification() { return Promise.resolve(); }
    dispose() { }

    // Helper to simulate server messages
    emitServerEvent(method: string, params: any) {
        this.emit('notification', { method, params });
    }
}

// Mock the real transport class
jest.mock('../src/core/AcpWebSocketTransport', () => {
    return {
        AcpWebSocketTransport: jest.fn().mockImplementation(() => new MockTransport())
    };
});

describe('AgentChatClient Message Ordering', () => {
    let client: AgentChatClient;
    let mockTransport: MockTransport;

    beforeEach(async () => {
        client = new AgentChatClient({ url: 'ws://mock' });
        // @ts-ignore - accessing private transport for testing
        mockTransport = client.transport;
        await client.connect();
    });

    afterEach(() => {
        client.dispose();
    });

    test('should preserve order of text -> tool -> text', async () => {
        // Setup a message flow
        const sessionId = 'mock-session';

        // 1. Text part 1
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: 'Starting analysis...' }
            }
        });

        // 2. Tool call
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'ls-1',
                title: 'ls',
                status: 'running'
            }
        });

        // 3. Text part 2 (should NOT merge with part 1)
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: 'Found files.' }
            }
        });

        // End turn
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'end_of_turn',
                stopReason: 'end_turn'
            }
        });

        const messages = client.getMessages();
        const lastMsg = messages[messages.length - 1];

        // Current broken behavior check (to document what happens now)
        // console.log(JSON.stringify(lastMsg, null, 2));

        // Proposed expectation:
        // content should be: [Text(Starting analysis...), Tool(ls), Text(Found files.)]

        // Note: Since we haven't implemented the fix yet, we expect 'content' might not exist or be empty,
        // and 'text' might be concatenated blindly.
        // For the REPRODUCTION, we want to assert the *desired* state and see it fail, 
        // OR assert the broken state to confirm reproduction.
        // Let's assert the DESIRED state so we know when we fixed it.

        expect(lastMsg.role).toBe('assistant');

        // Check legacy behavior (concatenation)
        expect(lastMsg.text).toContain('Starting analysis...');
        expect(lastMsg.text).toContain('Found files.');

        // Check NEW behavior (interleaved structure)
        // @ts-ignore - content property doesn't exist yet on type
        const content = lastMsg.content;

        expect(content).toBeDefined();
        expect(content).toHaveLength(3);
        expect(content[0]).toEqual({ type: 'text', text: 'Starting analysis...' });
        expect(content[1]).toMatchObject({ type: 'tool_call', call: expect.objectContaining({ name: 'ls' }) });
        expect(content[2]).toEqual({ type: 'text', text: 'Found files.' });
    });

    test('should handle stream rectification correctly within a text part', async () => {
        // This tests that we don't duplicate text when the server resends overlapped chunks

        // 1. Chunk 1
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: 'Hello' }
            }
        });

        // 2. Chunk 2 (overlap: "lo w")
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: 'lo world' }
            }
        });

        const messages = client.getMessages();
        const lastMsg = messages[messages.length - 1];

        // @ts-ignore
        const content = lastMsg.content;
        expect(content).toBeDefined();
        // Should remain one text part because no tool call intervened
        expect(content).toHaveLength(1);
        expect(content[0].type).toBe('text');
        expect(content[0].text).toBe('Hello world');
    });

    test('should preserve order of thought -> tool -> thought', async () => {
        // 1. Thought part 1
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { text: 'Thinking about files...' }
            }
        });

        // 2. Tool call
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'ls-2',
                title: 'ls',
                status: 'running'
            }
        });

        // 3. Thought part 2 (overlap simulation within new part)
        // Send "Found" then "ound it" -> should be "Found it"
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { text: 'Found' }
            }
        });
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { text: 'Found it' }
            }
        });

        const messages = client.getMessages();
        const lastMsg = messages[messages.length - 1];

        // @ts-ignore
        const content = lastMsg.content;

        expect(content).toHaveLength(3);
        expect(content[0]).toEqual({ type: 'thought', thought: 'Thinking about files...' });
        expect(content[1]).toMatchObject({ type: 'tool_call', call: expect.objectContaining({ name: 'ls' }) });

        // Check new thought part logic
        expect(content[2].type).toBe('thought');
        // If scoped rectification works, it should be "Found it" (rectified against "Found")
        // If it was global, and "Thinking..." text confused it, it might fail (though unlikely with these strings)
        // But mainly we want to ensure it created a NEW part.
        expect(content[2].thought).toBe('Found it');

        // Legacy global thought should be concatenation
        expect(lastMsg.thought).toBe('Thinking about files...Found it');
    });

    test('should update message seq on each server notification', async () => {
        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: 'Hello' }
            }
        });

        let lastMsg = client.getMessages()[client.getMessages().length - 1];
        expect(lastMsg.role).toBe('assistant');
        // seq should be set from the notification
        expect(lastMsg.seq).toBe(1);

        mockTransport.emitServerEvent('session/update', {
            update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: ' world' }
            }
        });

        lastMsg = client.getMessages()[client.getMessages().length - 1];
        expect(lastMsg.seq).toBe(2);
    });

    test('should include replayId/timestamp on replayed structured_event', async () => {
        const seen = [];
        client.on('bridge/structured_event', (params, meta) => {
            seen.push({ params, meta });
        });

        mockTransport.emitServerEvent('bridge/replay', {
            data: { method: 'bridge/structured_event', params: { foo: 1 } },
            timestamp: 123456,
            replayId: 'replay-1'
        });

        expect(seen).toHaveLength(1);
        expect(seen[0].meta.seq).toBe(1);
        expect(seen[0].meta.replayId).toBe('replay-1');
        expect(seen[0].meta.replayTimestamp).toBe(123456);
        expect(seen[0].params.__eventMeta.replayId).toBe('replay-1');
        expect(seen[0].params.__replay.replayId).toBe('replay-1');
        expect(seen[0].params.__replay.timestamp).toBe(123456);
    });
});
