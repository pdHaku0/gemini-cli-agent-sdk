import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as readline from 'readline';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';

export interface GeminiBridgeOptions {
    model?: string;
    port?: number;
    approvalMode?: string;
    geminiBin?: string;
    cliPackage?: string;
    hostApiUrl?: string;
    sessionId?: string;
    bridgeSecret?: string;
    projectRoot?: string;
    outgoingTransform?: (msg: any) => { forward?: any | null; extra?: any[] } | null;
}

import { EventEmitter } from 'events';
import * as url from 'url';

export class GeminiBridge extends EventEmitter {
    private options: Omit<Required<GeminiBridgeOptions>, 'outgoingTransform'> & {
        model: string;
        port: number;
        approvalMode: string;
        geminiBin: string;
        cliPackage: string;
        hostApiUrl: string;
        sessionId: string;
        bridgeSecret: string;
        projectRoot: string;
        outgoingTransform: ((msg: any) => { forward?: any | null; extra?: any[] } | null) | null;
    };
    private wss: WebSocketServer | null = null;
    private geminiProcess: ChildProcess | null = null;
    private acpSessionId: string | null = null;
    private isAuthPending = false;
    private pendingAuthUrl: string | null = null;
    private currentTurnModifiedFiles = new Set<string>();
    private turnHiddenModes = new Map<number, string>();
    private logFile: string;
    private projectRootReal: string;

    // History Persistence
    private history: { timestamp: number; data: any }[] = [];
    private readonly MAX_HISTORY_SIZE = 2000;
    private turnId = 0;

    constructor(options: GeminiBridgeOptions = {}) {
        super();
        const cwd = options.projectRoot || process.cwd();
        this.projectRootReal = this.resolveRealPath(cwd);

        this.options = {
            model: options.model || 'gemini-3-flash-preview',
            port: options.port !== undefined ? options.port : 4444,
            approvalMode: options.approvalMode || 'default',
            geminiBin: options.geminiBin || process.env.GEMINI_BIN || '',
            cliPackage: options.cliPackage || '@google/gemini-cli',
            hostApiUrl: options.hostApiUrl || 'http://localhost:3000',
            sessionId: options.sessionId || '',
            bridgeSecret: options.bridgeSecret || '',
            projectRoot: cwd,
            outgoingTransform: options.outgoingTransform || null
        };

        this.logFile = path.join(this.projectRootReal, 'gemini-acp.log');
        this.rotateLog();
    }

    public start() {
        this.log(`[Gemini Bridge] Starting on port ${this.options.port}...`);
        this.logCliVersion();

        this.wss = new WebSocketServer({ port: this.options.port, host: '0.0.0.0' });

        this.wss.on('listening', () => {
            this.log(`[Gemini Bridge] WebSocket server listening on 0.0.0.0:${this.options.port}`);
        });

        this.wss.on('error', (err: Error) => {
            this.log(`[Gemini Bridge] WebSocket server error: ${err}`);
        });

        this.wss.on('connection', (ws: WebSocket, req: any) => {
            this.handleConnection(ws, req);
        });

        this.startGemini();
    }

    public stop() {
        if (this.wss) {
            const server = this.wss;
            this.wss = null; // Clear reference first to prevent restart
            server.close();
        }
        if (this.geminiProcess) {
            this.geminiProcess.kill();
            this.geminiProcess = null;
        }
    }

    private resolveRealPath(p: string): string {
        try {
            return fs.realpathSync(p);
        } catch {
            return path.resolve(p);
        }
    }

    private rotateLog() {
        try {
            if (fs.existsSync(this.logFile)) {
                const stats = fs.statSync(this.logFile);
                if (stats.size > 2 * 1024 * 1024) { // 2MB
                    const oldLog = this.logFile + '.old';
                    fs.renameSync(this.logFile, oldLog);
                    this.log(`[Gemini Bridge] Rotated log file to ${oldLog}`);
                }
            }
        } catch (e: any) {
            console.error(`[Gemini Bridge] Log rotation failed: ${e.message}`);
        }
    }

    private log(msg: string) {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${msg}\n`;
        try {
            fs.appendFileSync(this.logFile, line);
        } catch { }
        console.log(line.trim());
    }

    private logCliVersion() {
        const launch = this.resolveGeminiLaunch();
        if (!launch.command || launch.command === 'npx') {
            this.log('[Gemini Bridge] CLI version: n/a (using npx)');
            return;
        }

        try {
            const result = spawnSync(launch.command, ['--version'], { encoding: 'utf8' });
            const out = (result.stdout || result.stderr || '').trim();
            if (out) {
                this.log(`[Gemini Bridge] CLI version: ${out.split('\n')[0]}`);
            } else {
                this.log('[Gemini Bridge] CLI version: unknown');
            }
        } catch (e) {
            this.log(`[Gemini Bridge] CLI version check failed: ${e}`);
        }
    }

    private resolveGeminiLaunch(): { command: string; args: string[]; preferOffline: boolean } {
        const baseArgs = ['-m', this.options.model, '--experimental-acp'];
        if (this.options.approvalMode) {
            baseArgs.push('--approval-mode', this.options.approvalMode);
        }

        const candidates = [
            this.options.geminiBin,
            path.join(this.projectRootReal, 'node_modules/.bin/gemini'),
            'gemini',
            'google-gemini',
            'google-gemini-cli',
        ].filter(Boolean) as string[];

        for (const candidate of candidates) {
            const resolved = this.resolveExecutablePath(candidate);
            if (resolved) {
                return { command: resolved, args: baseArgs, preferOffline: false };
            }
        }

        return {
            command: 'npx',
            args: ['--yes', this.options.cliPackage, ...baseArgs],
            preferOffline: true,
        };
    }

    private resolveExecutablePath(raw: string): string | null {
        if (!raw) return null;
        const value = raw.trim();
        if (!value) return null;

        if (value.includes(path.sep) || value.startsWith('.')) {
            const abs = path.isAbsolute(value) ? value : path.resolve(this.projectRootReal, value);
            return fs.existsSync(abs) ? abs : null;
        }

        const result = spawnSync('which', [value], { encoding: 'utf8' });
        if (result && result.status === 0) {
            const located = (result.stdout || '').trim();
            if (located) return located;
        }
        return null;
    }

    private startGemini() {
        const launch = this.resolveGeminiLaunch();
        this.log(`[Gemini Bridge] Spawning: ${launch.command} ${launch.args.join(' ')}`);

        try {
            const env = { ...process.env };
            if (launch.preferOffline) {
                env.NPM_CONFIG_PREFER_OFFLINE = 'true';
                env.npm_config_prefer_offline = 'true';
                env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
            }

            this.geminiProcess = spawn(launch.command, launch.args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...env, FORCE_COLOR: '1' },
                cwd: this.projectRootReal
            });
        } catch (e: any) {
            this.log(`[Gemini Bridge] Failed to spawn process: ${e.message}`);
            return;
        }

        this.isAuthPending = false;
        this.log(`[Gemini Bridge] Spawned PID: ${this.geminiProcess.pid}`);

        this.geminiProcess.on('error', (err) => {
            this.log(`[Gemini Bridge] Process error: ${err}`);
        });

        this.geminiProcess.on('close', (code, signal) => {
            this.log(`[Gemini Bridge] Process exited (code: ${code}, signal: ${signal})`);
            this.geminiProcess = null;
            this.acpSessionId = null;
            this.isAuthPending = false;

            // Auto restart check
            if (this.wss) {
                setTimeout(() => {
                    if (this.wss) {
                        this.log('[Gemini Bridge] Restarting process...');
                        this.startGemini();
                    }
                }, 2000);
            }
        });

        if (this.geminiProcess.stdout) {
            const rl = readline.createInterface({ input: this.geminiProcess.stdout });
            rl.on('line', (line) => this.handleGeminiOutput(line));
        }

        if (this.geminiProcess.stderr) {
            this.geminiProcess.stderr.on('data', (data) => {
                this.log(`[Gemini STDERR] ${data}`);
            });
        }
    }

    private handleGeminiOutput(line: string) {
        if (!line.trim()) return;

        // Strip ANSI escape sequences
        const cleanLine = line.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\[\?[0-9;]*[a-zA-Z]|\[[0-9]*[GJK]/g, '');

        // Detect Auth URL
        const urlMatch = cleanLine.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\s]+)/) ||
            cleanLine.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s]+)/) ||
            cleanLine.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\S*)/);

        if (urlMatch) {
            const authUrl = urlMatch[1];
            this.log(`[Gemini Bridge] Detected Auth URL: ${authUrl.substring(0, 50)}...`);
            this.isAuthPending = true;
            this.pendingAuthUrl = authUrl;
            this.broadcast({
                jsonrpc: '2.0',
                method: 'gemini/authUrl',
                params: { url: authUrl }
            });
        }

        if (cleanLine.trim().startsWith('{')) {
            try {
                const msg = JSON.parse(cleanLine);

                // Special handlers for bridge-emulated tools
                if (msg?.method === 'fs/read_text_file') {
                    this.handleFsRead(msg);
                    return;
                }
                if (msg?.method === 'fs/write_text_file') {
                    this.handleFsWrite(msg);
                    return;
                }

                this.broadcast(msg);
                this.emit('gemini:message', msg); // Hook

                if (msg.result && msg.result.sessionId) {
                    this.acpSessionId = msg.result.sessionId;
                    this.log(`[Gemini Bridge] Session Ready: ${this.acpSessionId}`);
                }
            } catch (e: any) {
                this.log(`[Gemini Bridge] JSON Parse Error: ${e.message} (Line: ${cleanLine.substring(0, 100)})`);
            }
        } else {
            this.log(`[Gemini STDOUT] ${line}`);
        }
    }

    private handleConnection(ws: WebSocket, req: any) {
        const addr = (ws as any)._socket?.remoteAddress || 'unknown';
        this.log(`[Gemini Bridge] Client connected (${addr})`);

        // Handle Replay logic
        try {
            const query = url.parse(req.url || '', true).query;
            const limit = query.limit ? parseInt(Array.isArray(query.limit) ? query.limit[0] : query.limit, 10) : undefined;
            const since = query.since ? parseInt(Array.isArray(query.since) ? query.since[0] : query.since, 10) : undefined;
            const before = query.before ? parseInt(Array.isArray(query.before) ? query.before[0] : query.before, 10) : undefined;

            let replay = this.history;

            if (since) {
                replay = replay.filter(h => h.timestamp > since);
            }
            if (before) {
                replay = replay.filter(h => h.timestamp < before);
            }

            // Apply limit as "turn count" to avoid slicing mid-stream
            if (limit && limit > 0) {
                const turnIds: number[] = [];
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
                this.log(`[Gemini Bridge] Replaying ${replay.length} messages to client`);
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
            this.log(`[Gemini Bridge] Replay handling error: ${e}`);
        }

        if (this.isAuthPending && this.pendingAuthUrl) {
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                method: 'gemini/authUrl',
                params: { url: this.pendingAuthUrl }
            }));
        }

        ws.on('message', (message: Buffer | string) => {
            if (!this.geminiProcess || !this.geminiProcess.stdin) {
                this.log('[Gemini Bridge] Gemini process not ready');
                return;
            }

            const str = message.toString();
            try {
                const parsed = JSON.parse(str);
                this.emit('client:message', parsed); // Hook

                if (parsed?.method === 'gemini/submitAuthCode') {
                    const code = parsed?.params?.code;
                    if (code) {
                        this.log(`[Bridge] Submitting auth code to stdin...`);
                        this.geminiProcess.stdin.write(code.trim() + '\n');
                        this.isAuthPending = false;
                        this.pendingAuthUrl = null;
                    }
                    return;
                }

                if (parsed?.method === 'authenticate') {
                    this.isAuthPending = true;
                    this.geminiProcess.stdin.write(str + '\n');
                    return;
                }

                if (this.isAuthPending) {
                    this.log(`[Bridge] Blocked message during pending auth: ${str.substring(0, 50)}...`);
                    return;
                }

                // Record client prompts for replay and advance turn id
                if (parsed?.method === 'session/prompt') {
                    const hiddenMode = parsed?.params?.prompt?.[0]?.meta?.hidden;
                    this.turnId += 1;
                    if (typeof hiddenMode === 'string') {
                        this.turnHiddenModes.set(this.turnId, hiddenMode);
                    }
                    this.history.push({
                        timestamp: Date.now(),
                        data: { ...parsed, __turnId: this.turnId, __hiddenMode: hiddenMode },
                    });
                    if (this.history.length > this.MAX_HISTORY_SIZE) this.history.shift();
                    if (parsed?.params?.prompt?.[0]?.meta?.hidden) {
                        delete parsed.params.prompt[0].meta.hidden;
                        if (parsed.params.prompt[0].meta && Object.keys(parsed.params.prompt[0].meta).length === 0) {
                            delete parsed.params.prompt[0].meta;
                        }
                    }
                }
                this.geminiProcess.stdin.write(JSON.stringify(parsed) + '\n');
            } catch {
                this.geminiProcess.stdin.write(str + '\n');
            }
        });

        ws.on('close', () => {
            this.log('[Gemini Bridge] Client disconnected');
        });
    }

    private broadcast(data: any) {
        const transform = this.options.outgoingTransform ? this.options.outgoingTransform(data) : null;
        const forward = transform && 'forward' in transform ? transform.forward : data;
        const extra = transform?.extra || [];

        if (forward) {
            this.broadcastPayload(forward);
        }

        if (extra.length > 0) {
            for (const item of extra) {
                this.broadcastPayload(item, true);
            }
        }
    }

    private broadcastPayload(data: any, forceStore = false) {
        // Record History (only replay-relevant messages)
        const shouldStore = forceStore ||
            data?.method === 'session/update' ||
            data?.method === 'session/request_permission' ||
            data?.method === 'gemini/authUrl' ||
            data?.method === 'bridge/structured_event';
        if (shouldStore) {
            const timestamp = Date.now();
            const tagged = { ...data, __turnId: this.turnId, __hiddenMode: this.turnHiddenModes.get(this.turnId) };
            this.history.push({ timestamp, data: tagged });
            if (this.history.length > this.MAX_HISTORY_SIZE) {
                this.history.shift(); // remove oldest
            }
        }

        if (!this.wss) return;
        const str = JSON.stringify(data);
        this.wss.clients.forEach((client: WebSocket) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(str);
            }
        });

        // Trigger checkpoint on turn end
        const updateType = data?.params?.update?.sessionUpdate || data.sessionUpdate;
        if (updateType === 'end_of_turn' || updateType === 'response.completed') {
            if (this.currentTurnModifiedFiles.size > 0) {
                this.triggerCheckpoint(Array.from(this.currentTurnModifiedFiles));
                this.currentTurnModifiedFiles.clear();
            }
        }
    }

    private async triggerCheckpoint(files: string[]) {
        if (!this.options.sessionId || !this.options.hostApiUrl) return;

        try {
            this.log(`[Gemini Bridge] Triggering checkpoint for ${files.length} files...`);
            const response = await fetch(`${this.options.hostApiUrl}/api/shadow/checkpoint`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.options.sessionId,
                    files: files,
                    bridgeSecret: this.options.bridgeSecret
                })
            });
            if (response.ok) {
                const json: any = await response.json();
                this.broadcast({
                    jsonrpc: '2.0',
                    method: 'session/checkpoint_created',
                    params: { stats: json.stats }
                });
            }
        } catch (e: any) {
            this.log(`[Gemini Bridge] Checkpoint error: ${e.message}`);
        }
    }

    private handleFsRead(msg: any) {
        const id = msg.id;
        const params = msg.params || {};
        const reqPath = params.path;
        const line = typeof params.line === 'number' ? params.line : null;
        const limit = typeof params.limit === 'number' ? params.limit : null;
        const abs = this.safeResolveProjectPath(reqPath);

        if (!abs) {
            this.respondError(id, -32602, 'Invalid path');
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
            this.sendToGemini({ jsonrpc: '2.0', id, result: { content } });
        } catch (e: any) {
            if (e && e.code === 'ENOENT') {
                this.sendToGemini({ jsonrpc: '2.0', id, result: { content: '' } });
                return;
            }
            this.respondError(id, -32000, 'File read error', e.message);
        }
    }

    private handleFsWrite(msg: any) {
        const id = msg.id;
        const params = msg.params || {};
        const abs = this.safeResolveProjectPath(params.path);

        if (!abs) {
            this.respondError(id, -32602, 'Invalid path');
            return;
        }

        try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            const content = params.content ?? '';
            fs.writeFileSync(abs, String(content), 'utf8');
            if (params.path) this.currentTurnModifiedFiles.add(params.path);
            this.sendToGemini({ jsonrpc: '2.0', id, result: null });
        } catch (e: any) {
            this.respondError(id, -32000, 'File write error', e.message);
        }
    }

    private safeResolveProjectPath(p: string): string | null {
        try {
            if (!p) return null;
            const abs = path.resolve(this.projectRootReal, p);
            const relative = path.relative(this.projectRootReal, abs);
            if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
                return abs;
            }
            return null;
        } catch {
            return null;
        }
    }

    private sendToGemini(payload: any) {
        if (this.geminiProcess && this.geminiProcess.stdin) {
            this.geminiProcess.stdin.write(JSON.stringify(payload) + '\n');
        }
    }

    private respondError(id: any, code: number, message: string, data?: any) {
        this.sendToGemini({ jsonrpc: '2.0', id, error: { code, message, data } });
    }
}
