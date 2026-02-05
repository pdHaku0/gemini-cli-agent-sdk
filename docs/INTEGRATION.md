# Integration Guide

This guide focuses on real-world integration details and common pitfalls.

## Use the right entrypoint

- **Browser/Next.js**: `@pdhaku0/gemini-cli-agent-sdk/client`
- **Node.js Bridge**: `@pdhaku0/gemini-cli-agent-sdk/server`

If you import the root package in a client component, Next.js will try to bundle server code (`fs`) and fail.

## Next.js (App Router)

### Use a singleton client/store

React Strict Mode mounts components twice in dev, which can create **multiple WebSocket connections** and inconsistent state.
Use a module-level singleton or a guard to ensure you connect only once.

### Use `use client`

Instantiate `AgentChatClient` in client components only.

### Persist session across reloads

If you want to keep the same ACP session across a page reload, store the session ID and pass it back to the client:

```ts
const sessionId = localStorage.getItem('agentchat_session_id') || undefined;
const client = new AgentChatClient({ url: wsUrl, sessionId });

client.on('session_ready', (id) => localStorage.setItem('agentchat_session_id', id));
await client.connect();
```

### Example reference

See `examples/next-app` for a working App Router implementation (auth, approvals, replay, session persistence).

### Working directory (cwd)

The client sends a `cwd` in `session/new`. For Next apps, you can set:

```bash
NEXT_PUBLIC_GEMINI_CWD=/path/to/project
```

## WebSocket URL in remote/SSH setups

If you SSH into a remote host, `localhost` points to **the remote**, not your local machine.
Set the WebSocket URL accordingly, for example:

```bash
NEXT_PUBLIC_GEMINI_WS_URL=ws://<host>:4444
```

## Auth flow

When `auth_required` fires, you must call `submitAuthCode()` before the CLI will process prompts.

## Tool approvals

Use `pendingApproval.toolCall.toolCallId` to attach permission options to the correct tool block.

## Replay performance tips

- `limit` is in **turns**, not messages.
- Use a small `limit` on connect, then fetch older as needed.
- Replay is in-memory only; restarting the bridge clears history.

## Optional SYS tag capture

If you want to extract structured JSON from assistant output, use the extras helper:

```ts
import { createSysTagTransform } from '@pdhaku0/gemini-cli-agent-sdk/extras';

const bridge = new GeminiBridge({
  outgoingTransform: createSysTagTransform({ mode: 'event' }),
});
```

### Recommended priming prompt

Instruct the agent to use SYS tags for structured data so the bridge can capture it:

```text
When you need to emit machine-readable JSON, wrap it in <SYS_JSON>...</SYS_JSON>.
When you want to group work, use <SYS_BLOCK>{"type":"start"...}</SYS_BLOCK> and
<SYS_BLOCK>{"type":"end"...}</SYS_BLOCK>.
```

## Structured events → backend tools

If you want the assistant to trigger backend tools, use SYS tags and process
`bridge/structured_event` on the bridge:

```ts
bridge.on('client:message', (msg) => {
  if (msg?.method !== 'bridge/structured_event') return;

  const { type, payload } = msg.params || {};
  if (type !== 'sys_json') return;

  if (payload?.type === 'tool.invoke') {
    // Example: run a custom backend tool
    runTool(payload.payload);
  }
});
```

### UI ordering tip (client-side)

If you also render structured events in your UI, prefer ordering by the SDK-provided
`meta.seq` / `message.seq` instead of `ts`, because `ts` may be fixed when the message
object is created while streaming updates arrive later.
