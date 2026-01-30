# Technical Specification

This document details the internal architecture, protocol specifications, and custom logic implementation of the `agent-chat-sdk` and `gemini-bridge`.

## Architecture Overview

The system follows a 3-tier architecture to enable browser/client access to the local Gemini CLI.

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
- **AgentChatClient**: The core class managing the WebSocket connection, session state, and event emission.
- **Event System**: Emits normalized events (`text_delta`, `thought_delta`, `tool_update`) to the UI.
- **Tool Parsing**: Implements robust logic to recover structured tool data from raw CLI output.

### 2. Bridge (`scripts/gemini-bridge.cjs`)
- **Process Management**: Spawns the `gemini` binary with `--experimental-acp`.
- **Protocol Translation**: Forwards JSON-RPC messages between WebSocket and Stdio.
- **Log Management**: Handles `gemini-acp.log` rotation (max 2MB).
- **History Sync**: (Optional) Syncs chat history to a host API if configured.

## ACP Protocol & Extensions

The communication relies on the Agent Chat Protocol (ACP).

### Session Handshake
1. Client connects via WebSocket.
2. Bridge spawns Gemini CLI.
3. Client sends `session/new`.
4. Bridge relays response with `sessionId`.

### Message Flow
- **User Input**: Client sends `session/prompt` with text.
- **Streaming Response**: CLI sends `session/update` events.
    - `agent_thought_chunk`: Internal reasoning (Chain of Thought).
    - `agent_message_chunk`: User-facing text response.
    - `tool_call`: Request to execute a tool.

### Custom Logic: Tool Description Parsing

The Gemini CLI (v0.21.2) does not consistently emit a `description` field in the `tool_call` object. The SDK implements the following logic to recover it:

1. **Title Parsing**: The `title` field is analyzed.
2. **Nested Parentheses**: A backward-scanning text parser extracts the *last balanced parenthetical group* at the end of the title string.
    - Example Title: `"ls -F [cwd] (List files (detailed))"`
    - Extracted Description: `"List files (detailed)"`
3. **CWD Extraction**: The string `[current working directory ...]` is identified and stored as `workingDir`.
4. **Fallback**: If no description is found in the title, the `description` field is left empty (no artificial defaults).

## Operational Details

### Log Rotation
The `gemini-bridge.cjs` script checks `gemini-acp.log` size on startup.
- **Limit**: 2MB (2 * 1024 * 1024 bytes).
- **Action**: Renames current log to `.old` if limit exceeded.

### Environment Variables
- `GEMINI_PORT`: WebSocket port (default: 4444).
- `GEMINI_MODEL`: Model ID (default: `gemini-3-flash-preview`).
- `GEMINI_APPROVAL_MODE`: Tool approval mode (default: `default`).
