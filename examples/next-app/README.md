# Next.js Example

This is a full UI example using the SDK in a Next.js App Router project.

## 1) Start the bridge (in repo root)

```bash
npm run start:bridge
```

## 2) Install deps (inside this folder)

```bash
cd examples/next-app
npm install
```

## 3) Run the app

```bash
npm run dev
```

Open http://localhost:3000 and chat.

## Optional: custom bridge URL

Set `NEXT_PUBLIC_GEMINI_WS_URL`:

```bash
NEXT_PUBLIC_GEMINI_WS_URL=ws://localhost:4444 npm run dev
```

## Optional: set working directory (cwd)

By default, the Next app sends `examples/next-app/playground`. You can override it:

```bash
NEXT_PUBLIC_GEMINI_CWD=/home/yohaku/gemini-cli-agent-sdk npm run dev
```

## Session persistence

The example stores `sessionId` in localStorage and reuses it after page reload.
If the bridge restarts, a new session is created automatically.
