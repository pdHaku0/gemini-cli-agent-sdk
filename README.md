# Agent Chat SDK

A TypeScript SDK for building chat UIs on top of the Gemini CLI Agent via ACP (Agent Chat Protocol). It provides a browser-safe client, a bridge for the CLI, and a UI-friendly event model.

## Features

- **WebSocket transport** with reconnect + ACP framing
- **Client event model** tuned for UI rendering
- **Tool call parsing** (permissions, inputs, diff rendering)
- **Replay support** for late joiners / infinite scroll
- **Bridge process** to run Gemini CLI via stdio
- **Optional store** (`AgentChatStore`) for React/GUI state

## Installation

```bash
npm install @pdhaku0/gemini-cli-agent-sdk
```

## Requirements

- Node.js 18+ (bridge and any server usage)
- Gemini CLI with `--experimental-acp`
- Browser client or Node with `ws`

## Quick Start

### 1) Start the bridge

```bash
npm run start:bridge
```

### 2) Connect a client

```ts
import { AgentChatClient } from '@pdhaku0/gemini-cli-agent-sdk/client';

const client = new AgentChatClient({
  url: 'ws://localhost:4444',
  cwd: '/path/to/project',
  replay: { limit: 15 },
});

client.on('text_delta', ({ delta }) => process.stdout.write(delta));
client.on('tool_update', ({ toolCall }) => {
  console.log(`[tool] ${toolCall.name} ${toolCall.status}`);
});

await client.connect();
await client.sendMessage('List files in the current directory.');
```

### 3) Replay older turns (infinite scroll)

```ts
const older = await AgentChatClient.fetchReplay('ws://localhost:4444', {
  before: oldestTimestampMs,
  limit: 10,
});
client.prependMessages(older);
```

### 4) Optional SYS tags (structured capture)

Use SYS tags in assistant output and capture them on the bridge:

```ts
import { GeminiBridge } from '@pdhaku0/gemini-cli-agent-sdk/server';
import { createSysTagTransform } from '@pdhaku0/gemini-cli-agent-sdk/extras';

const bridge = new GeminiBridge({
  outgoingTransform: createSysTagTransform({ mode: 'event' }),
});
bridge.start();
```

### 5) Hidden initial prompt

```ts
await client.sendMessage('System priming...', { hidden: 'turn' });
```

## Examples

- `examples/next-app` — full Next.js App Router UI (auth, approvals, replay, session persistence)
- `examples/cli` — minimal Node CLI (streaming + tool approvals)

Examples are **kept in the repo** but **excluded from npm** to keep the package lean.

## Documentation

- `docs/USAGE.md` — full end-to-end guide
- `docs/API.md` — API surface
- `docs/EVENTS.md` — event model + rendering rules
- `docs/INTEGRATION.md` — Next/Node integration patterns
- `docs/TROUBLESHOOTING.md` — common pitfalls

## Development

- Build: `npm run build`
- Bridge: `npm run start:bridge`
- CLI example: `node examples/cli/index.js`

## Notes

- The bridge keeps **in-memory replay only**. Restarting the bridge clears replay history.
- Reusing sessions across reloads is supported by passing a saved `sessionId` to the client.
- Replay `limit` is **turns**, not messages.
