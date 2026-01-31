'use client';

import { useEffect, useMemo, useState } from 'react';
import { AgentChatClient, AgentChatStore } from '@pdhaku0/gemini-cli-agent-sdk/client';
import type { AgentChatState, ChatMessage } from '@pdhaku0/gemini-cli-agent-sdk/client';
import ToolCallView from './ToolCallView';

const INITIAL_REPLAY_LIMIT = 15;
const LOAD_OLDER_LIMIT = 10;
const SESSION_STORAGE_KEY = 'agentchat_session_id';

let sharedClient: AgentChatClient | null = null;
let sharedStore: AgentChatStore | null = null;

function getClientStore(url: string, sessionId: string | null) {
  if (!sharedClient) {
    const defaultCwd = process.env.NEXT_PUBLIC_GEMINI_CWD || 'examples/next-app/playground';
    sharedClient = new AgentChatClient({
      url,
      replay: { limit: INITIAL_REPLAY_LIMIT },
      cwd: defaultCwd,
      sessionId: sessionId || undefined,
    });
    sharedStore = new AgentChatStore(sharedClient);
  }
  return { client: sharedClient, store: sharedStore as AgentChatStore };
}

export default function AgentChat() {
  const [input, setInput] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [lastReplayTs, setLastReplayTs] = useState<number | null>(null);

  const resolvedUrl = useMemo(() => {
    if (process.env.NEXT_PUBLIC_GEMINI_WS_URL) return process.env.NEXT_PUBLIC_GEMINI_WS_URL;
    if (typeof window !== 'undefined' && window.location?.hostname) {
      return `ws://${window.location.hostname}:4444`;
    }
    return 'ws://localhost:4444';
  }, []);

  const storedSessionId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(SESSION_STORAGE_KEY);
  }, []);

  const { client, store } = useMemo(
    () => getClientStore(resolvedUrl, storedSessionId),
    [resolvedUrl, storedSessionId]
  );
  const [state, setState] = useState<AgentChatState>(() => store.getState());
  const loadedTurns = useMemo(
    () => state.messages.filter((m) => m.role === 'user').length,
    [state.messages]
  );

  useEffect(() => {
    const unsubscribe = store.subscribe(setState);
    const handleSessionReady = (sessionId: string) => {
      if (typeof window === 'undefined') return;
      window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    };
    client.on('session_ready', handleSessionReady);
    client.connect().catch((err) => console.error(err));
    return () => {
      client.off('session_ready', handleSessionReady);
      unsubscribe();
    };
  }, [client, store]);

  const oldestTimestamp = (messages: ChatMessage[]) => {
    let oldest: number | null = null;
    for (const msg of messages) {
      if (typeof msg.ts === 'number') {
        if (oldest === null || msg.ts < oldest) oldest = msg.ts;
      }
    }
    return oldest;
  };

  const loadOlder = async () => {
    if (isLoadingOlder) return;
    const beforeRaw = oldestTimestamp(state.messages);
    const before = beforeRaw !== null ? Math.max(0, beforeRaw - 1) : null;
    if (before === null) return;
    if (lastReplayTs !== null && before >= lastReplayTs) return;
    setIsLoadingOlder(true);
    try {
      const older = await AgentChatClient.fetchReplay(
        resolvedUrl,
        { before, limit: LOAD_OLDER_LIMIT },
        { idleMs: 300 }
      );
      client.prependMessages(older);
      if (older.length > 0) setLastReplayTs(before);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingOlder(false);
    }
  };

  return (
    <section style={{ marginTop: 20, border: '1px solid #e2d7c8', padding: 16, background: '#fffaf2' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: '#6e6258' }}>
        <span>status: {state.connectionState}</span>
        <span>streaming: {state.isStreaming ? 'yes' : 'no'}</span>
        {state.lastStopReason && <span>stop: {state.lastStopReason}</span>}
        {Boolean(state.lastError) && <span>error: {String(state.lastError)}</span>}
      </div>

      {state.authUrl && (
        <div style={{ marginTop: 12, padding: 12, background: '#fff4cc' }}>
          <div>Authentication required:</div>
          <a href={state.authUrl} target="_blank" rel="noreferrer">{state.authUrl}</a>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder="Paste auth code"
              style={{ flex: 1 }}
            />
            <button
              onClick={() => {
                const trimmed = authCode.trim();
                if (!trimmed) return;
                setAuthCode('');
                client.submitAuthCode(trimmed).catch(console.error);
              }}
            >
              Submit
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: '#6e6258' }}>
            loaded: {state.messages.length} msgs / {loadedTurns} turns (initial {INITIAL_REPLAY_LIMIT} turns, older +{LOAD_OLDER_LIMIT} turns)
          </div>
          <button onClick={loadOlder} disabled={isLoadingOlder}>
            {isLoadingOlder ? 'Loading...' : 'Load older'}
          </button>
        </div>
        {state.messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600 }}>{m.role}</div>
            {'content' in m ? (
              m.content.map((part, idx) => {
                if (part.type === 'text') {
                  return <div key={`${m.id}-text-${idx}`}>{part.text}</div>;
                }
                if (part.type === 'thought') {
                  return (
                    <div key={`${m.id}-thought-${idx}`} style={{ marginTop: 6, fontSize: 12, color: '#6e6258' }}>
                      <div style={{ fontWeight: 600 }}>thought</div>
                      <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{part.thought}</pre>
                    </div>
                  );
                }
                if (part.type === 'tool_call') {
                  return (
                    <ToolCallView
                      key={`${m.id}-tool-${part.call.id}`}
                      call={part.call}
                      pendingApproval={state.pendingApproval}
                      onApprove={(optionId) => client.approveTool(optionId)}
                    />
                  );
                }
                return null;
              })
            ) : (
              <div>{m.text}</div>
            )}
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = input.trim();
          if (!trimmed) return;
          setInput('');
          client.sendMessage(trimmed).catch(console.error);
        }}
        style={{ display: 'flex', gap: 8, marginTop: 12 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          style={{ flex: 1 }}
        />
        <button type="submit">Send</button>
      </form>
    </section>
  );
}
