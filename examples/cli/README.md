# CLI Example

This is a minimal Node CLI that connects to the bridge and prints streaming output.

## Run

1) Start the bridge in repo root:

```bash
npm run start:bridge
```

2) Run the example:

```bash
node examples/cli/index.js
```

You can set the bridge URL with:

```bash
GEMINI_WS_URL=ws://localhost:4444 node examples/cli/index.js
```

## SYS tags (optional)

If your bridge is configured with SYS tag parsing (see `docs/USAGE.md`), this CLI will
print structured events as `[SYS_EVENT] ...`.

It also prints the optional receive-order sequence number (`meta.seq`) when available,
so you can interleave these events with chat message updates in UI/timeline renderers.

Minimal bridge setup (server-side):

```ts
import { GeminiBridge } from '@pdhaku0/gemini-cli-agent-sdk/server';
import { createSysTagTransform } from '@pdhaku0/gemini-cli-agent-sdk/extras';

const bridge = new GeminiBridge({
  outgoingTransform: createSysTagTransform({ mode: 'event' }),
});

bridge.start();
```
