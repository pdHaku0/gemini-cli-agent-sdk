import { AgentChatClient, AgentChatStore } from '@pdhaku0/gemini-cli-agent-sdk/client';
import * as readline from 'readline';

const url = process.env.GEMINI_WS_URL || 'ws://localhost:4444';
const client = new AgentChatClient({ url });
const store = new AgentChatStore(client);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
});

// Stream tracking state
let currentMessageId = null;
// Track printed length for each content part index
let printedContentLengths = [];
const processedToolCalls = new Set();

client.on('connection_state_changed', (evt) => {
    console.log(`\n[System] Connection state: ${evt.state}`);
});

client.on('session_ready', (sessionId) => {
    console.log(`\n[System] Session established: ${sessionId}`);
    (async () => {
        try {
            await client.sendMessage(
                [
                    'あなたは長時間動作するエージェントです。',
                    'UIに出したくない機械可読の情報は SYS タグで囲んで出力してください。',
                    '作業を始める前に、必ず「今から何をやります」の宣言をSYSタグで出してください。',
                    '宣言は見出し用途で、以下の固定JSONスキーマのみを使ってください。',
                    '',
                    'スキーマ:',
                    '<SYS_JSON>{"type":"heading","payload":{"title":"<短い見出し>","intent":"<これから何をするか>","scope":"<対象/範囲>","expected":"<期待される結果>"},"version":"1.0"}</SYS_JSON>',
                    '',
                    '使い方:',
                    '<SYS_JSON>{"type":"tool.invoke","payload":{"name":"ping"}}</SYS_JSON>',
                    '<SYS_BLOCK>{"type":"start","id":"b1","title":"Data Collection"}</SYS_BLOCK>',
                    '',
                    '通常の会話テキストはSYSタグの外に書いてください。',
                    'SYSタグ内のJSONは壊さず、閉じタグまで必ず出力してください。'
                ].join('\n'),
                { hidden: 'turn' }
            );
        } catch (err) {
            console.error('[System] Failed to send SYS tag primer:', err);
        } finally {
            console.log('Type your message below (or "exit" to quit):');
            promptUser();
        }
    })();
});

client.on('turn_started', () => {
    console.log(`\n[System] Turn started...`);
});

client.on('bridge/structured_event', (evt) => {
    if (!evt) return;
    process.stdout.write('\n');
    console.log(`\x1b[35m[SYS_EVENT] ${evt.type || 'unknown'}\x1b[0m`);
    if (evt.error) {
        console.log(`\x1b[31m  Error: ${evt.error}\x1b[0m`);
    }
    if (evt.payload !== undefined) {
        const payloadText = typeof evt.payload === 'string' ? evt.payload : JSON.stringify(evt.payload);
        const preview = payloadText.length > 300 ? `${payloadText.slice(0, 300)}...` : payloadText;
        console.log(`\x1b[90m  Payload: ${preview}\x1b[0m`);
    } else if (evt.raw) {
        const rawText = String(evt.raw);
        const preview = rawText.length > 300 ? `${rawText.slice(0, 300)}...` : rawText;
        console.log(`\x1b[90m  Raw: ${preview}\x1b[0m`);
    }
});

store.subscribe((state) => {
    const msg = state.messages[state.messages.length - 1];
    if (!msg || msg.role !== 'assistant') return;

    const assistantMsg = msg;
    if (currentMessageId !== assistantMsg.id) {
        currentMessageId = assistantMsg.id;
        printedContentLengths = [];
        processedToolCalls.clear();
        console.log('\n[Assistant]');
    }

    assistantMsg.content.forEach((part, index) => {
        if (printedContentLengths.length <= index) {
            printedContentLengths.push(0);
        }

        const printedLen = printedContentLengths[index];

        if (part.type === 'thought') {
            if (part.thought.length > printedLen) {
                const delta = part.thought.substring(printedLen);
                process.stdout.write(`\x1b[2m${delta}\x1b[0m`);
                printedContentLengths[index] = part.thought.length;
            }
        } else if (part.type === 'text') {
            if (part.text.length > printedLen) {
                const delta = part.text.substring(printedLen);
                process.stdout.write(delta);
                printedContentLengths[index] = part.text.length;
            }
        } else if (part.type === 'tool_call') {
            const tc = part.call;
            const key = `${tc.id}-${tc.status}`;

            if (!processedToolCalls.has(key)) {
                if (tc.status === 'running') {
                    process.stdout.write('\n');
                    console.log(`\x1b[36m[Tool Input] ${tc.name}\x1b[0m`);
                    if (tc.description) console.log(`\x1b[90m  Purpose: ${tc.description}\x1b[0m`);

                    if (tc.args) {
                        Object.entries(tc.args).forEach(([k, v]) => {
                            console.log(`\x1b[90m  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\x1b[0m`);
                        });
                    } else if (tc.input) {
                        console.log(`\x1b[90m  Input: ${tc.input}\x1b[0m`);
                    }

                    if (tc.workingDir) console.log(`\x1b[90m  Cwd: ${tc.workingDir}\x1b[0m`);
                } else if (tc.status === 'completed') {
                    process.stdout.write('\n');
                    console.log(`\x1b[32m[Tool Output] ${tc.name} completed.\x1b[0m`);
                    if (tc.result) {
                        const snippet = tc.result.split('\n').slice(0, 5).join('\n');
                        console.log(`\x1b[90m${snippet}${tc.result.split('\n').length > 5 ? '...' : ''}\x1b[0m`);
                    }
                } else if (tc.status === 'failed') {
                    process.stdout.write('\n');
                    console.log(`\x1b[31m[Tool Error] ${tc.name} failed.\x1b[0m`);
                }

                processedToolCalls.add(key);
            }
        }
    });
});

client.on('turn_completed', (reason) => {
    console.log(`\n\n[System] Turn completed. (Reason: ${reason || 'N/A'})`);
    promptUser();
});

client.on('auth_required', (url) => {
    console.log(`\n[Auth] Authentication required!`);
    console.log(`Please visit: ${url}`);
    rl.question('Paste the auth code here: ', async (code) => {
        await client.submitAuthCode(code);
    });
});

client.on('approval_required', (approval) => {
    const { toolCall, options } = approval;

    const req = {
        toolCallId: toolCall.toolCallId,
        kind: toolCall.kind,
        title: toolCall.title
    };
    const toolLabel = toolCall.input || toolCall.title;
    console.log(`\n[Permission] Agent wants to call: ${toolLabel}`);
    if (toolCall.description) console.log(`  Purpose: ${toolCall.description}`);
    if (toolCall.workingDir) console.log(`  Cwd: ${toolCall.workingDir}`);
    console.log('Options:');

    const standardOptions = options.map((opt, i) => ({
        index: i,
        label: `${opt.label || opt.optionId} (${opt.kind})`,
        optionId: opt.optionId,
        action: 'standard'
    }));

    standardOptions.forEach((opt) => {
        console.log(`${opt.index}: ${opt.label}`);
    });

    rl.question('Select an option (index): ', async (ans) => {
        const idx = parseInt(ans);
        const selected = standardOptions.find((o) => o.index === idx);

        if (selected) {
            await client.approveTool(selected.optionId);
        }
    });
});

await client.connect();

function promptUser() {
    rl.question('> ', async (input) => {
        if (input.trim().toLowerCase() === 'exit') {
            rl.close();
            process.exit(0);
        }
        await client.sendMessage(input);
    });
}
