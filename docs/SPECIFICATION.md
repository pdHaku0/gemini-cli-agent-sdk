# Technical Specification

This document details the internal architecture, protocol specifications, and custom logic implementation of the SDK and bridge.

## Architecture Overview

```
[ Client Application (SDK) ]
        |
        | WebSocket (JSON-RPC 2.0)
        |
[ Node.js Bridge (gemini-bridge.cjs) ]
        |
        | Stdio (Pipe)
        |
[ Gemini CLI Binary ]
```

### 1. Client SDK (`src/core/`)

- **AgentChatClient**: Manages the WebSocket connection, session state, and event emission.
- **Event System**: Emits normalized events (`text_delta`, `thought_delta`, `tool_update`) to the UI.
- **Tool Parsing**: Recovers structured tool data from Gemini CLI output.

### 2. Bridge (`scripts/gemini-bridge.cjs`)

- **Process Management**: Spawns the `gemini` binary with `--experimental-acp`.
- **Protocol Translation**: Forwards JSON-RPC between WebSocket and stdio.
- **Log Management**: Handles `gemini-acp.log` rotation (max 2MB).
- **History Replay**: Maintains a small in-memory history for late-joiners.

## ACP Protocol & Extensions

### Session Handshake

1. Client connects via WebSocket.
2. Bridge spawns Gemini CLI.
3. Client sends `session/new` (unless reusing a stored session ID).
4. Bridge relays response with `sessionId`.

### Session Reuse

Clients may reuse an existing session by supplying a known `sessionId` and skipping `session/new`.
This is useful for page reloads. It only works while the bridge/CLI process remains alive.

### Message Flow

- **User Input**: Client sends `session/prompt` with text and `sessionId`.
- **Streaming Response**: CLI sends `session/update` events.
  - `agent_thought_chunk`: Internal reasoning text.
  - `agent_message_chunk`: User-facing assistant text.
  - `tool_call`: Request to execute a tool.

## Backend Event Hooks

`GeminiBridge` extends `EventEmitter` and emits:

- `gemini:message`: JSON-RPC messages from Gemini CLI.
- `client:message`: JSON-RPC messages from WebSocket clients.

## Custom Logic: Tool Description Parsing

The Gemini CLI does not consistently emit a `description` field in the `tool_call` object. The SDK implements:

1. **Title Parsing**: Analyze the tool title string.
2. **Nested Parentheses**: Extract the *last balanced parentheses group*.
   - Example: `"ls -F [cwd] (List files (detailed))"` => `"List files (detailed)"`
3. **CWD Extraction**: Capture `[current working directory ...]` as `workingDir`.
4. **Fallback**: Leave `description` empty if not found.

## Operational Details

### Log Rotation

The `gemini-bridge.cjs` script checks `gemini-acp.log` size on startup.

- **Limit**: 2MB (2 * 1024 * 1024 bytes)
- **Action**: Renames current log to `.old` if limit exceeded

### History Replay (Late Joiners)

The bridge keeps an in-memory ring buffer of recent JSON-RPC messages (max 2000).
Clients can request a replay using WebSocket query params:

- `limit`: last N **turns** (to avoid slicing a response mid-stream)
- `since`: only messages after this UNIX timestamp (ms)
- `before`: only messages before this UNIX timestamp (ms)

### Environment Variables

- `GEMINI_PORT`: WebSocket port (default 4444)
- `GEMINI_MODEL`: Model ID (default `gemini-3-flash-preview`)
- `GEMINI_APPROVAL_MODE`: Tool approval mode (default `default`)
