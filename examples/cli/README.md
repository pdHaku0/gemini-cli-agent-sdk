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
