import { AgentChatClient } from './core/AgentChatClient.js';
import { AssistantMessage, ChatMessage } from './common/types.js';
import { ToolPermissionManager } from './core/ToolPermissionManager.js';
import * as readline from 'readline';

const url = process.env.GEMINI_WS_URL || 'ws://localhost:4444';
const client = new AgentChatClient({ url });

// CLI manages permissions, not the SDK
const permissionManager = new ToolPermissionManager('./settings.json');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
});

// Stream tracking state
let currentMessageId: string | null = null;
// Track printed length for each content part index
let printedContentLengths: number[] = [];
const processedToolCalls = new Set<string>();

client.on('connection_state_changed', (evt) => {
    console.log(`\n[System] Connection state: ${evt.state}`);
});

client.on('session_ready', (sessionId) => {
    console.log(`\n[System] Session established: ${sessionId}`);
    console.log('Type your message below (or "exit" to quit):');
    promptUser();
});

client.on('turn_started', () => {
    // Optional: clear spinner or just log
    console.log(`\n[System] Turn started...`);
});

client.on('message', (msg) => {
    // User messages are already echoed by readline
});

client.on('message_update', (msg) => {
    if (msg.role !== 'assistant') return;
    const assistantMsg = msg as AssistantMessage;

    // New message detection: print header
    if (currentMessageId !== assistantMsg.id) {
        currentMessageId = assistantMsg.id;
        printedContentLengths = [];
        processedToolCalls.clear();
        console.log('\n[Assistant]');
    }

    // Iterate over content parts in order
    assistantMsg.content.forEach((part, index) => {
        // Initialize length tracking for new parts
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
        }
        else if (part.type === 'text') {
            if (part.text.length > printedLen) {
                const delta = part.text.substring(printedLen);
                process.stdout.write(delta);
                printedContentLengths[index] = part.text.length;
            }
        }
        else if (part.type === 'tool_call') {
            const tc = part.call;
            const key = `${tc.id}-${tc.status}`;

            if (!processedToolCalls.has(key)) {
                if (tc.status === 'running') {
                    // Only print running header once (when we first encounter it running)
                    // The standard unique check handles this if status doesn't change
                    // But if status changes running->running (update), we might reprint. 
                    // Let's rely on standard logic but format cleanly.

                    // Add newline before tool call if it follows text
                    process.stdout.write('\n');
                    console.log(`\x1b[36m[Tool Input] ${tc.name}\x1b[0m`);
                    if (tc.description) console.log(`\x1b[90m  Purpose: ${tc.description}\x1b[0m`);

                    // Print args/input details
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

    // 1. Check permissions first
    const req = {
        toolCallId: toolCall.toolCallId,
        kind: toolCall.kind,
        title: toolCall.title
    };
    const outcome = permissionManager.checkPermission(req);

    if (outcome === 'allow') {
        const allowOpt = options.find((o: any) => o.kind === 'allow_once' || o.optionId === 'proceed_once') || options[0];
        if (allowOpt) {
            console.log(`\n[System] Auto-approving tool: ${toolCall.title} (Reason: Always Allow)`);
            client.approveTool(allowOpt.optionId);
            return;
        }
    } else if (outcome === 'deny') {
        const denyOpt = options.find((o: any) => o.kind === 'deny' || o.optionId === 'cancel');
        if (denyOpt) {
            console.log(`\n[System] Auto-denying tool: ${toolCall.title} (Reason: Deny Always)`);
            client.approveTool(denyOpt.optionId);
            return;
        }
    }

    // 2. If 'ask', prompt user
    const toolLabel = toolCall.input || toolCall.title;
    console.log(`\n[Permission] Agent wants to call: ${toolLabel}`);
    if (toolCall.description) console.log(`  Purpose: ${toolCall.description}`);
    if (toolCall.workingDir) console.log(`  Cwd: ${toolCall.workingDir}`);
    console.log('Options:');

    const standardOptions = options.map((opt: any, i: number) => ({
        index: i,
        label: `${opt.label || opt.optionId} (${opt.kind})`,
        optionId: opt.optionId,
        action: 'standard'
    }));

    // Append custom options
    const extendedOptions = [
        ...standardOptions,
        { index: standardOptions.length, label: 'Always Allow (Persist)', action: 'always_allow' },
        { index: standardOptions.length + 1, label: 'Deny Always (Persist)', action: 'deny_always' }
    ];

    extendedOptions.forEach((opt: any) => {
        console.log(`${opt.index}: ${opt.label}`);
    });

    rl.question('Select an option (index): ', async (ans) => {
        const idx = parseInt(ans);
        const selected = extendedOptions.find((o: any) => o.index === idx);

        if (selected) {
            if (selected.action === 'standard') {
                await client.approveTool(selected.optionId);
            } else if (selected.action === 'always_allow') {
                permissionManager.grantAlways(req);
                const allowOpt = options.find((o: any) => o.kind === 'allow_once' || o.optionId === 'proceed_once') || options[0];
                if (allowOpt) await client.approveTool(allowOpt.optionId);
            } else if (selected.action === 'deny_always') {
                permissionManager.denyAlways(req);
                const denyOpt = options.find((o: any) => o.kind === 'deny' || o.optionId === 'cancel');
                if (denyOpt) await client.approveTool(denyOpt.optionId);
                else await client.approveTool('deny');
            }
        } else {
            console.log('Invalid option, denying by default.');
            await client.approveTool(options.find((o: any) => o.kind === 'deny')?.optionId || 'deny');
        }
    });
});

async function promptUser() {
    rl.question('\n> ', async (input) => {
        if (input.toLowerCase() === 'exit') {
            client.dispose();
            process.exit(0);
        }
        if (input.toLowerCase() === '/cancel') {
            console.log('[System] Cancelling...');
            await client.cancel();
            return;
        }
        try {
            await client.sendMessage(input);
        } catch (err: any) {
            console.error(`\n[Error] Failed to send message: ${err.message || JSON.stringify(err)}`);
            promptUser();
        }
    });
}

console.log(`[Test CLI] Connecting to ${url}...`);
client.connect().catch(err => {
    console.error('[Error] Connection failed:', err);
    process.exit(1);
});
