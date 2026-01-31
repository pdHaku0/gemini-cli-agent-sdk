const { spawn, spawnSync } = require('child_process');
const readline = require('readline');
const { WebSocketServer, WebSocket } = require('ws');

const fs = require('fs');
const path = require('path');

// Configuration
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_APPROVAL_MODE = process.env.GEMINI_APPROVAL_MODE || 'default';
const PORT = parseInt(process.env.GEMINI_PORT || '4444', 10); // Default to 4444 inside container
const GEMINI_CLI_PACKAGE = process.env.GEMINI_CLI_PACKAGE || '@google/gemini-cli';
const LOG_RAW = false;
const PROJECT_ROOT_REAL = (() => {
    try {
        return fs.realpathSync(process.cwd());
    } catch {
        return process.cwd();
    }
})();

// Log file path
const LOG_FILE = path.join(process.cwd(), 'gemini-acp.log');

// Log Rotation
try {
    if (fs.existsSync(LOG_FILE)) {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size > 2 * 1024 * 1024) { // 2MB
            const oldLog = LOG_FILE + '.old';
            fs.renameSync(LOG_FILE, oldLog);
            console.log(`[Gemini Bridge] Rotated log file to ${oldLog}`);
        }
    }
} catch (e) {
    console.error(`[Gemini Bridge] Log rotation failed: ${e.message}`);
}

// Host API configuration for chat history sync
// In Docker, HOST_API_URL should be set to reach the Next.js server
// e.g., http://host.docker.internal:3000 or http://172.17.0.1:3000
const HOST_API_URL = process.env.HOST_API_URL || 'http://172.17.0.1:3000';
const SESSION_ID = process.env.DEV_SESSION_ID || null;
const BRIDGE_SECRET = process.env.GEMINI_BRIDGE_SECRET || '';
const SYNC_DEBOUNCE_MS = 2000;

// Chat history management
let chatMessages = [];
let syncTimeout = null;
// In-memory replay history
const history = [];
const MAX_HISTORY_SIZE = 2000;
let turnId = 0;

async function syncChatHistoryToHost() {
    if (!SESSION_ID) {
        log('[Gemini Bridge] No SESSION_ID, skipping history sync');
        return;
    }
    if (chatMessages.length === 0) return;

    try {
        const response = await fetch(`${HOST_API_URL}/api/gemini/save-history`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: SESSION_ID,
                messages: chatMessages,
                bridgeSecret: BRIDGE_SECRET
            })
        });
        if (response.ok) {
            log(`[Gemini Bridge] Synced ${chatMessages.length} messages to host`);
        } else {
            const text = await response.text();
            log(`[Gemini Bridge] Failed to sync history: ${response.status} ${text}`);
        }
    } catch (e) {
        log(`[Gemini Bridge] Error syncing history: ${e.message}`);
    }
}

function scheduleSyncToHost() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        syncChatHistoryToHost();
    }, SYNC_DEBOUNCE_MS);
}

function addChatMessage(msg) {
    // Store messages that are relevant for chat history
    // Filter by type: user prompts, assistant responses, tool calls
    chatMessages.push(msg);
    scheduleSyncToHost();
}

function log(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, line);
    console.log(line.trim());
}

function sendToGemini(payload) {
    if (!geminiProcess || !geminiProcess.stdin) {
        log('[Gemini Bridge] Cannot send to Gemini: process not ready');
        return;
    }
    const line = JSON.stringify(payload);
    geminiProcess.stdin.write(line + '\n');
    log(`[Bridge -> Gemini] ${line.substring(0, 300)}...`);
}

function safeResolveProjectPath(p) {
    try {
        if (!p) return null;
        const abs = path.resolve(PROJECT_ROOT_REAL, p);
        const relative = path.relative(PROJECT_ROOT_REAL, abs);
        if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
            return abs;
        }
        return null;
    } catch {
        return null;
    }
}

function respondError(id, code, message, data) {
    sendToGemini({ jsonrpc: '2.0', id, error: { code, message, data } });
}

function handleFsRead(msg) {
    const id = msg?.id;
    const params = msg?.params || {};
    const reqPath = params?.path;
    const line = typeof params?.line === 'number' ? params.line : null;
    const limit = typeof params?.limit === 'number' ? params.limit : null;
    const abs = safeResolveProjectPath(reqPath);
    if (!abs) {
        respondError(id, -32602, 'Invalid path', 'Path outside project root');
        return;
    }
    try {
        const raw = fs.readFileSync(abs, 'utf8');
        let content = raw;
        if (line !== null || limit !== null) {
            const lines = raw.split(/\r?\n/);
            const start = Math.max(0, (typeof line === 'number' ? line - 1 : 0));
            const count = typeof limit === 'number' ? Math.max(0, limit) : lines.length - start;
            content = lines.slice(start, start + count).join('\n');
        }
        sendToGemini({ jsonrpc: '2.0', id, result: { content } });
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            sendToGemini({ jsonrpc: '2.0', id, result: { content: '' } });
            return;
        }
        respondError(id, -32000, 'File read error', e?.message || String(e));
    }
}

function handleFsWrite(msg) {
    const id = msg?.id;
    const params = msg?.params || {};
    const reqPath = params?.path;
    const content = params?.content ?? '';
    const abs = safeResolveProjectPath(reqPath);
    if (!abs) {
        respondError(id, -32602, 'Invalid path', 'Path outside project root');
        return;
    }
    try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(content), 'utf8');

        // Track for checkpoint
        if (reqPath) currentTurnModifiedFiles.add(reqPath);

        sendToGemini({ jsonrpc: '2.0', id, result: null });
    } catch (e) {
        respondError(id, -32000, 'File write error', e?.message || String(e));
    }
}

/**
 * Resolve a usable Gemini CLI command.
 * Priority:
 *  1. GEMINI_BIN env
 *  2. repo-local node_modules/.bin/gemini
 *  3. common global binaries (gemini / google-gemini / google-gemini-cli)
 *  4. npx @google/gemini-cli (offline-friendly)
 */
function resolveExecutablePath(raw) {
    if (!raw) return null;
    const value = String(raw).trim();
    if (!value) return null;

    // Absolute / relative path
    if (value.includes(path.sep) || value.startsWith('.')) {
        const abs = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
        return fs.existsSync(abs) ? abs : null;
    }

    // which lookup
    const result = spawnSync('which', [value], { encoding: 'utf8' });
    if (result && result.status === 0) {
        const located = (result.stdout || '').trim();
        if (located) return located;
    }
    return null;
}

function resolveGeminiLaunch() {
    const baseArgs = ['-m', GEMINI_MODEL, '--experimental-acp'];
    if (GEMINI_APPROVAL_MODE) {
        baseArgs.push('--approval-mode', GEMINI_APPROVAL_MODE);
    }
    const candidates = [
        process.env.GEMINI_BIN,
        path.join(process.cwd(), 'node_modules/.bin/gemini'),
        'gemini',
        'google-gemini',
        'google-gemini-cli',
    ].filter(Boolean);

    for (const candidate of candidates) {
        const resolved = resolveExecutablePath(candidate);
        if (resolved) {
            log(`[Gemini Bridge] Using binary: ${resolved}`);
            return { command: resolved, args: baseArgs, preferOffline: false };
        }
    }

    // Fallback: npx package runner
    log('[Gemini Bridge] Falling back to npx @google/gemini-cli');
    return {
        command: 'npx',
        args: ['--yes', GEMINI_CLI_PACKAGE, ...baseArgs],
        preferOffline: true,
    };
}

function buildSpawnEnv(preferOffline) {
    const env = { ...process.env };
    if (preferOffline) {
        env.NPM_CONFIG_PREFER_OFFLINE = 'true';
        env.npm_config_prefer_offline = 'true';
        env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
        env.npm_config_update_notifier = 'false';
    }
    return env;
}

const { command: CMD, args: ARGS, preferOffline: PREFER_OFFLINE } = resolveGeminiLaunch();

function logCliVersion() {
    try {
        if (!CMD || CMD === 'npx') {
            log('[Gemini Bridge] CLI version: n/a (using npx)');
            return;
        }
        const result = spawnSync(CMD, ['--version'], { encoding: 'utf8' });
        const out = (result.stdout || result.stderr || '').trim();
        if (out) {
            log(`[Gemini Bridge] CLI version: ${out.split('\n')[0]}`);
        } else {
            log('[Gemini Bridge] CLI version: unknown');
        }
    } catch (e) {
        log(`[Gemini Bridge] CLI version check failed: ${e}`);
    }
}

console.log(`[Gemini Bridge] Starting on port ${PORT}...`);
logCliVersion();

// Start WebSocket Server
const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });
wss.on('listening', () => {
    log(`[Gemini Bridge] WebSocket server listening on 0.0.0.0:${PORT}`);
});
wss.on('error', (err) => {
    log(`[Gemini Bridge] WebSocket server error: ${err}`);
});

let geminiProcess = null;
let acpSessionId = null;
let isAuthPending = false;
let pendingAuthUrl = null; // Store auth URL to resend to reconnecting clients
const pendingToolLatencies = new Map(); // messageId -> startTs
const currentTurnModifiedFiles = new Set();

async function triggerCheckpoint(files) {
    if (!SESSION_ID) return;
    try {
        log(`[Gemini Bridge] Triggering checkpoint for ${files.length} files...`);
        const response = await fetch(`${HOST_API_URL}/api/shadow/checkpoint`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: SESSION_ID,
                files: files,
                bridgeSecret: BRIDGE_SECRET
            })
        });
        if (response.ok) {
            const json = await response.json();
            log(`[Gemini Bridge] Checkpoint created: ${json?.stats?.commitHash || 'success'}`);
            broadcast({
                jsonrpc: '2.0',
                method: 'session/checkpoint_created',
                params: { stats: json.stats }
            });
        } else {
            log(`[Gemini Bridge] Checkpoint failed: ${response.status}`);
        }
    } catch (e) {
        log(`[Gemini Bridge] Checkpoint error: ${e.message}`);
    }
}

// Broadcast to all connected clients
function broadcast(data) {
    const str = JSON.stringify(data);
    log(`[Bridge -> Client] Broadcasting: ${str.substring(0, 200)}...`);
    // Record history for replay (only replay-relevant messages)
    const shouldStore = data?.method === 'session/update' ||
        data?.method === 'session/request_permission' ||
        data?.method === 'gemini/authUrl';
    if (shouldStore) {
        history.push({ timestamp: Date.now(), data: { ...data, __turnId: turnId } });
        if (history.length > MAX_HISTORY_SIZE) history.shift();
    }
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(str);
        }
    });

    // Track chat-related messages for history sync
    // session/streamContent contains AI responses
    // result with text content is a final response
    if (data.method === 'session/streamContent' ||
        (data.result && typeof data.result === 'object')) {
        addChatMessage({
            type: 'assistant',
            data: data,
            timestamp: Date.now()
        });
    }

    // Check for turn completion to trigger checkpoint
    const updateType = data?.params?.update?.sessionUpdate || data.sessionUpdate;
    if (updateType === 'end_of_turn' || updateType === 'response.completed') {
        const stopReason = data.stopReason;
        // Only checkpoint if not an error (or maybe even on error if files were modified?)
        // Let's checkpoint if files were modified regardless, to be safe.
        const filesToCommit = Array.from(currentTurnModifiedFiles);
        if (filesToCommit.length > 0) {
            triggerCheckpoint(filesToCommit);
            currentTurnModifiedFiles.clear();
        }
    }
}

function startGemini() {
    log(`[Gemini Bridge] Spawning: ${CMD} ${ARGS.join(' ')}`);

    try {
        geminiProcess = spawn(CMD, ARGS, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...buildSpawnEnv(PREFER_OFFLINE), FORCE_COLOR: '1' },
            cwd: process.cwd()
        });
    } catch (e) {
        log(`[Gemini Bridge] Failed to spawn process: ${e}`);
        return;
    }

    isAuthPending = false;
    log(`[Gemini Bridge] Spawned PID: ${geminiProcess.pid}`);

    geminiProcess.on('error', (err) => {
        log(`[Gemini Bridge] Process error: ${err}`);
    });

    geminiProcess.on('close', (code, signal) => {
        log(`[Gemini Bridge] Process exited (code: ${code}, signal: ${signal})`);
        geminiProcess = null;
        acpSessionId = null;
        isAuthPending = false;
        // Auto restart
        setTimeout(() => {
            log('[Gemini Bridge] Restarting process...');
            startGemini();
        }, 2000);
    });

    // Handle Stdout (JSON-RPC from Gemini)
    if (geminiProcess.stdout) {
        const rl = readline.createInterface({ input: geminiProcess.stdout });
        rl.on('line', (line) => {
            if (line.trim()) {
                log(`[Gemini STDOUT RAW] ${line}`);
            }
            if (line.trim()) {
                log(`[Gemini STDOUT RAW] ${line}`);
            }
            try {
                // Log non-empty lines
                if (line.trim()) {
                    // Strip ANSI escape sequences before matching
                    // This handles control characters like [?1049h, [2J, [H, etc.
                    const cleanLine = line.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[\?[0-9;]*[a-zA-Z]|\[[0-9]*[GJK]/g, '');

                    // Detect Auth URL using a broader regex to catch stdout that might be split or cluttered
                    // Match any string starting with https://accounts.google.com/o/oauth2
                    const urlMatch = cleanLine.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+)/) ||
                        cleanLine.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s]+)/) ||
                        cleanLine.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\S*)/); // fallback for broken lines


                    if (urlMatch) {
                        const authUrl = urlMatch[1];
                        log(`[Gemini Bridge] Detected Auth URL: ${authUrl.substring(0, 50)}...`);
                        isAuthPending = true;
                        pendingAuthUrl = authUrl; // Store for reconnecting clients
                        broadcast({
                            jsonrpc: '2.0',
                            method: 'gemini/authUrl',
                            params: { url: authUrl }
                        });
                    }

                    // Determine if line is JSON-RPC or plain text
                    if (line.trim().startsWith('{')) {
                        const msg = JSON.parse(line);

                        // Detect Auth Error and Restart
                        if (msg.error && (
                            (msg.error.code === -32603 && msg.error.data?.details?.includes('Failed to authenticate')) ||
                            (msg.error.message && msg.error.message.includes('Failed to authenticate'))
                        )) {
                            log('[Gemini Bridge] Critical Auth Failure detected. Restarting process to clear state...');
                            if (geminiProcess) geminiProcess.kill();
                            broadcast(msg);
                            return;
                        }

                        if (msg?.method === 'fs/read_text_file') {
                            log(`[Gemini -> Bridge] JSON-RPC: ${line.substring(0, 300)}...`);
                            handleFsRead(msg);
                            return;
                        }
                        if (msg?.method === 'fs/write_text_file') {
                            log(`[Gemini -> Bridge] JSON-RPC: ${line.substring(0, 300)}...`);
                            handleFsWrite(msg);
                            return;
                        }
                        log(`[Gemini -> Bridge] JSON-RPC: ${line.substring(0, 300)}...`);

                        broadcast(msg);

                        if (msg.result && msg.result.sessionId) {
                            acpSessionId = msg.result.sessionId;
                            log(`[Gemini Bridge] Session Ready: ${acpSessionId}`);
                        }

                        if (msg.method === 'session/request_permission') {
                            const toolCallId = msg?.params?.toolCall?.toolCallId;
                            const start = (() => {
                                // best effort: use last pending prompt if any
                                const lastKey = pendingToolLatencies.size ? Array.from(pendingToolLatencies.keys()).slice(-1)[0] : null;
                                return lastKey ? pendingToolLatencies.get(lastKey) : null;
                            })();
                            if (start) {
                                const elapsed = Date.now() - start;
                                log(`[Perf] Tool permission latency: ${elapsed}ms (toolCallId=${toolCallId || 'unknown'})`);
                                pendingToolLatencies.clear();
                            }
                        }
                    } else {
                        log(`[Gemini STDOUT] ${line}`);
                    }
                }
            } catch (e) {
                log(`[Gemini STDOUT RAW] ${line}`);
            }
        });
    }

    // Handle Stderr
    if (geminiProcess.stderr) {
        geminiProcess.stderr.on('data', (data) => {
            log(`[Gemini STDERR] ${data}`);
        });
    }
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const addr = ws?._socket?.remoteAddress || 'unknown';
    log(`[Gemini Bridge] Client connected (${addr})`);

    // Replay history for late joiners
    try {
        const query = new URL(req?.url || '', 'ws://localhost').searchParams;
        const limit = query.get('limit') ? parseInt(query.get('limit'), 10) : undefined;
        const since = query.get('since') ? parseInt(query.get('since'), 10) : undefined;
        const before = query.get('before') ? parseInt(query.get('before'), 10) : undefined;

        let replay = history;
        if (since) replay = replay.filter(h => h.timestamp > since);
        if (before) replay = replay.filter(h => h.timestamp < before);
        if (limit && limit > 0) {
            const turnIds = [];
            for (const h of replay) {
                const t = typeof h.data?.__turnId === 'number' ? h.data.__turnId : 0;
                if (turnIds.length === 0 || turnIds[turnIds.length - 1] !== t) {
                    turnIds.push(t);
                }
            }
            const keep = new Set(turnIds.slice(-limit));
            replay = replay.filter(h => keep.has(typeof h.data?.__turnId === 'number' ? h.data.__turnId : 0));
        }

        if (replay.length > 0) {
            log(`[Gemini Bridge] Replaying ${replay.length} messages to client`);
            replay.forEach((h, idx) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'bridge/replay',
                        params: { timestamp: h.timestamp, data: h.data, replayId: `${h.timestamp}-${idx}` }
                    }));
                }
            });
        }
    } catch (e) {
        log(`[Gemini Bridge] Replay handling error: ${e}`);
    }

    // If auth is pending, send the auth URL to the new client immediately
    if (isAuthPending && pendingAuthUrl) {
        log(`[Gemini Bridge] Resending pending auth URL to new client`);
        ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'gemini/authUrl',
            params: { url: pendingAuthUrl }
        }));
    }

    ws.on('message', (message) => {
        if (!geminiProcess || !geminiProcess.stdin) {
            log('[Gemini Bridge] Process not ready');
            return;
        }
        const str = message.toString();
        try {
            const parsed = JSON.parse(str);

            // Handle auth code submission - this is allowed during auth pending
            if (parsed?.method === 'gemini/submitAuthCode') {
                const code = parsed?.params?.code;
                if (code) {
                    log(`[Bridge] Submitting auth code to stdin...`);
                    geminiProcess.stdin.write(code.trim() + '\n');
                    isAuthPending = false;
                    pendingAuthUrl = null;
                }
                return;
            }

            // Handle authenticate request
            if (parsed?.method === 'authenticate') {
                log('[Bridge] Authentication requested. Locking input stream...');
                isAuthPending = true;
                // Forward this to Gemini CLI
                log(`[Client -> Gemini] ${str}`);
                geminiProcess.stdin.write(str + '\n');
                return;
            }

            // Block ALL messages during auth pending (including ping)
            if (isAuthPending) {
                const msgType = parsed?.type || parsed?.method || 'unknown';
                log(`[Bridge] Blocked message during pending auth (${msgType}): ${str.substring(0, 50)}...`);
                return;
            }

            if (parsed?.method === 'session/prompt') {
                // Advance turn id and record prompt for replay (do not broadcast live)
                turnId += 1;
                history.push({ timestamp: Date.now(), data: { ...parsed, __turnId: turnId } });
                if (history.length > MAX_HISTORY_SIZE) history.shift();

                const prompt = parsed?.params?.prompt;
                const messageId = Array.isArray(prompt) ? prompt?.[0]?.messageId : undefined;
                const text = Array.isArray(prompt) ? (prompt?.[0]?.text || '') : '';
                const chars = typeof text === 'string' ? text.length : 0;
                if (messageId) {
                    pendingToolLatencies.set(messageId, Date.now());
                }
                log(`[Perf] Prompt sent: chars=${chars} messageId=${messageId || 'n/a'}`);

                // Track user prompts for history sync
                addChatMessage({
                    type: 'user',
                    data: parsed,
                    timestamp: Date.now()
                });
            }

            // Forward message to Gemini CLI
            const out = JSON.stringify(parsed);
            log(`[Client -> Gemini] ${out}`);
            geminiProcess.stdin.write(out + '\n');
        } catch (e) {
            // If we can't parse the message and auth is pending, block it
            if (isAuthPending) {
                log(`[Bridge] Blocked unparseable message during pending auth: ${str.substring(0, 50)}...`);
                return;
            }
            // Otherwise forward unparseable messages
            log(`[Client -> Gemini] ${str}`);
            geminiProcess.stdin.write(str + '\n');
        }
    });

    ws.on('close', () => {
        log('[Gemini Bridge] Client disconnected');
    });

    ws.on('error', (err) => {
        log(`[Gemini Bridge] Client error: ${err}`);
    });
});

// Start the process
startGemini();
