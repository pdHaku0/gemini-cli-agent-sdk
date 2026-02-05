# Usage Guide

This guide aims for a complete, no-surprises integration: bridge + client + UI. It assumes Node 18+.

## 0) Prerequisites

- Gemini CLI installed and working with `--experimental-acp`
- Node 18+ for the bridge
- A WebSocket-capable runtime for the client (browser or Node with `ws`)

## 1) Start the bridge

```bash
npm run start:bridge
```

If you prefer using the class directly:

```ts
import { GeminiBridge } from '@pdhaku0/gemini-cli-agent-sdk/server';

const bridge = new GeminiBridge({ port: 4444 });
bridge.start();
```

## 2) Minimal client

```ts
import { AgentChatClient } from '@pdhaku0/gemini-cli-agent-sdk/client';

const client = new AgentChatClient({
  url: 'ws://localhost:4444',
  cwd: '/path/to/project',
});

client.on('text_delta', ({ delta }) => process.stdout.write(delta));

await client.connect();
await client.sendMessage('Hello!');
```

## 3) Render messages correctly (important)

The server **does not echo user messages**. You must render them from local state.
For assistant messages, always use `content[]` to preserve the correct order of
text, thoughts, and tool calls.

Recommended UI pattern:

```ts
messages.map((m) => {
  if (m.role === 'user') return renderUser(m.text);
  return m.content.map((part) => {
    if (part.type === 'text') return renderText(part.text);
    if (part.type === 'thought') return renderThought(part.thought);
    if (part.type === 'tool_call') return renderTool(part.call);
  });
});
```

For React UIs, use `AgentChatStore` to receive `message_update` events automatically.

```ts
import { AgentChatStore } from '@pdhaku0/gemini-cli-agent-sdk/client';

const store = new AgentChatStore(client);
store.subscribe((state) => {
  // state.messages, state.isStreaming, state.pendingApproval, etc
});
```

## 4) Session persistence (page reloads)

If the page reloads, a new session is created unless you restore the old session ID.
You can store it and pass it back to the client:

```ts
const client = new AgentChatClient({
  url: 'ws://localhost:4444',
  sessionId: localStorage.getItem('agentchat_session_id') || undefined,
});

client.on('session_ready', (sessionId) => {
  localStorage.setItem('agentchat_session_id', sessionId);
});

await client.connect();
```

Notes:
- The session only survives while the **bridge and CLI process stay alive**.
- If the bridge restarts, the stored session becomes invalid; clear it to create a new session.

## 5) Auth flow

When Gemini CLI requires auth, the SDK emits `auth_required` with a URL.
You must obtain the code and call `submitAuthCode` before prompts will process.

```ts
client.on('auth_required', (url) => openAuthWindow(url));
await client.submitAuthCode(code);
```

## 6) Tool approvals

Approvals are tied to a tool call via `toolCallId`. Render permission UI next to the tool entry.

```ts
client.on('permission_required', (approval) => {
  // approval.options contains allow/deny choices
});
```

## 7) Replay / infinite scroll

The bridge keeps a small in-memory history. You can replay on connect:

```ts
const client = new AgentChatClient({
  url: 'ws://localhost:4444',
  replay: { limit: 15 }, // turns, not messages
});
await client.connect();
```

Or fetch older:

```ts
const older = await AgentChatClient.fetchReplay('ws://localhost:4444', {
  before: oldestTimestampMs,
  limit: 10, // turns, not messages
});
client.prependMessages(older);
```

Notes:
- `limit` is **turns**, not messages.
- `before`/`since` are UNIX timestamps in **ms**.
- Restarting the bridge clears history.
- If replay feels empty on slow networks, increase `idleMs`.

## 8) Diff handling

Tool results may include diffs. The SDK normalizes those into `toolCall.diff.unified`.
In UI, prefer:

1) `toolCall.diff.unified` (best)
2) `toolCall.result`

## 9) Hidden messages

You can send prompts that should not appear in the UI:

```ts
await client.sendMessage('System priming...', { hidden: 'turn' });
```

Hidden modes:

- `none` (default): show everything
- `user`: hide the user message only
- `assistant`: hide the assistant response (including tool/thought)
- `turn`: hide both user and assistant for the turn

If a hidden assistant turn requests tool approval, the SDK will auto-reject.

### Initial system priming (recommended)

If you want to give the agent a long initial prompt but **never show it in UI**:

```ts
await client.sendMessage('You are a long-running agent. Use SYS tags for structured events...', {
  hidden: 'turn',
});
```

## 10) Reconnect behavior

The WebSocket transport reconnects automatically. If a page reloads, use session persistence
(section 4) to reuse the same session ID.

## 11) Optional SYS tags (structured capture)

If you want the assistant to emit structured JSON that should **not** be shown
in the UI, you can wrap it in SYS tags and parse them on the bridge.

Example:

```
<SYS_JSON>{"type":"tool.invoke","payload":{"name":"ping"}}</SYS_JSON>
<SYS_BLOCK>{"type":"start","id":"b1","title":"Data Collection"}</SYS_BLOCK>
```

Use the optional extras helper on the bridge:

```ts
import { GeminiBridge } from '@pdhaku0/gemini-cli-agent-sdk/server';
import { createSysTagTransform } from '@pdhaku0/gemini-cli-agent-sdk/extras';

const bridge = new GeminiBridge({
  outgoingTransform: createSysTagTransform({ mode: 'event' }),
});

bridge.start();
```

`mode` can be:
- `event`: strip SYS tags from UI and emit `bridge/structured_event`
- `raw`: do nothing (no capture)
- `both`: keep text and emit `bridge/structured_event`

### Pattern: JSON tools without UI leakage

Use SYS tags for machine-readable JSON, while keeping normal assistant text visible:

```
I will fetch the data now.
<SYS_JSON>{"type":"tool.invoke","payload":{"tool":"fetch","args":{"url":"..."}}}</SYS_JSON>
```

On the bridge, capture SYS_JSON and execute your backend tool using the structured event payload.

## 12) Example UI

A complete Next.js App Router implementation is provided:

- `examples/next-app`

A minimal CLI example is also available:

- `examples/cli`

It includes auth UI, tool approvals, replay, and session persistence.

## 13) Structured events: backend tool execution

When you use SYS tags, the bridge emits `bridge/structured_event`. You can use it to
run backend tools **without leaking JSON to the UI**.

On the **client**, `AgentChatClient` also re-emits this as an SDK event:

```ts
client.on('bridge/structured_event', (params, meta) => {
  // params.__eventMeta / meta include ordering info (seq) and replay info.
});
```

Example (pseudo):

```ts
bridge.on('client:message', (msg) => {
  if (msg?.method !== 'bridge/structured_event') return;
  const { type, payload } = msg.params || {};

  if (type === 'sys_json' && payload?.type === 'tool.invoke') {
    // Run your tool here
    runTool(payload.payload);
  }
});
```

## 14) Blocked UI pattern (long-running agents)

For long-running agents, you can group output into collapsible blocks.
Ask the agent to emit SYS blocks:

```
<SYS_BLOCK>{"type":"start","id":"b1","title":"Data Collection"}</SYS_BLOCK>
...normal text...
<SYS_BLOCK>{"type":"end","id":"b1","summary":"Collected 120 items"}</SYS_BLOCK>
```

UI behavior:
- On `start`, open a block with the title.
- Append subsequent text to that block.
- On `end`, close it and show the summary.

Use `bridge/structured_event` to receive these block signals and update the UI state.
