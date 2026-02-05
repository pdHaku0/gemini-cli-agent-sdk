# Events and Rendering Rules

This document defines the event model and how to render messages correctly without ordering bugs.

## Core Events (AgentChatClient)

## Event metadata (ordering)

Many events now include an optional second argument `meta` with ordering info:

- `meta.seq`: a monotonically increasing sequence number assigned in **arrival order**
- `meta.receivedAt`: local timestamp when the SDK received the notification
- `meta.replayId` / `meta.replayTimestamp`: present for events that came from replay

This is intended to let UIs interleave `messages` and out-of-band events (like
`bridge/structured_event`) in the true receive order without relying on `ts`
(which is often fixed at message creation time).

### Connection

- `connection_state_changed`
  - payload: `{ state: ConnectionState }`
  - values: `connecting | connected | reconnecting | disconnected`
- `session_ready`
  - payload: `sessionId: string`
- `error`
  - payload: `unknown`

### Messages

- `message`
  - emitted when a **new message object** is created (user or assistant)
  - handler: `(msg: ChatMessage, meta?: AgentChatEventMeta) => void`
- `message_update`
  - emitted when streaming text/thought/tool updates modify a message
  - handler: `(msg: ChatMessage, meta?: AgentChatEventMeta) => void`

### Streaming deltas

- `text_delta`
- `assistant_text_delta`
- `thought_delta`
- `assistant_thought_delta`
  - payload: `{ messageId, delta, text|thought }`
  - handler: `(payload, meta?: AgentChatEventMeta) => void`

### Tools

- `tool_update`
- `tool_call_started`
- `tool_call_updated`
- `tool_call_completed`
  - payload: `{ messageId, toolCall }`
  - handler: `(payload, meta?: AgentChatEventMeta) => void`

### Turn lifecycle

- `turn_started`
  - payload: `{ userMessageId }`
  - handler: `(payload, meta?: AgentChatEventMeta) => void`
- `turn_completed`
  - payload: `stopReason` (string)
  - handler: `(stopReason: string, meta?: AgentChatEventMeta) => void`

### Auth / Permission

- `auth_required` (string URL)
- `auth_resolved`
- `permission_required` (PendingApproval)
- `approval_required` (PendingApproval)
- `approval_resolved`

### Replay

- `messages_replayed`
  - payload: `{ count }`
  - emitted after `prependMessages()`

### Structured events (optional)

- `bridge/structured_event`
  - payload: `{ type, payload, raw, error?, __eventMeta?, __replay? }`
    - `__eventMeta`: same as the `meta` argument
    - `__replay`: `{ replayId, timestamp }` when replayed
  - emitted when SYS tags are captured by the bridge (see `docs/USAGE.md`)

## Rendering Rules (Important)

### 1) Always render assistant content using `content[]`

The SDK maintains a `content` array on assistant messages that preserves the **true order** of:

- text
- thought
- tool calls

If you render `m.text` + `m.toolCalls` separately, tool calls can appear out of order.

### 2) Render tool approvals next to the tool call

Tool approvals are tied to a specific tool call via `toolCallId`. Put the approval UI inside the matching tool block.

### 3) User messages are local

The server does **not** echo user messages. You must render them from SDK state (`message` event or store state).

### 4) Interleave by `seq` when mixing streams

If you render extra logs (e.g. `bridge/structured_event`) together with chat messages,
sort by `seq` (or append in `seq` order) instead of sorting by message `ts`.

## Suggested UI Pattern

```ts
messages.map((msg) => {
  if (msg.role === 'user') renderUser(msg.text);
  if (msg.role === 'assistant') {
    msg.content.map((part) => {
      if (part.type === 'text') renderText(part.text);
      if (part.type === 'thought') renderThought(part.thought);
      if (part.type === 'tool_call') renderTool(part.call);
    });
  }
});
```
