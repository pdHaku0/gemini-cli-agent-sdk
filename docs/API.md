# API Reference

This document defines the public API surface for the SDK.

## Module Entrypoints

- `@pdhaku0/gemini-cli-agent-sdk/client`
  - Browser/Next.js client usage
- `@pdhaku0/gemini-cli-agent-sdk/server`
  - Node.js bridge usage
- `@pdhaku0/gemini-cli-agent-sdk/extras`
  - Optional helpers (SYS tag capture, etc.)

## AgentChatClient

```ts
new AgentChatClient(options: AgentChatClientOptions)
```

### AgentChatClientOptions

- `url: string` (required)
- `model?: string`
- `cwd?: string`
- `diffContextLines?: number`
- `sessionId?: string`
- `replay?: { limit?: number; since?: number; before?: number }`

### Methods

- `connect(options?: { autoSession?: boolean }): Promise<void>`
  - Connects the WebSocket.
  - If `sessionId` is already set, the client reuses it and **does not** call `session/new`.
  - If `autoSession` is `true` (default) and no session exists, sends `session/new`.
- `sendMessage(text: string): Promise<void>`
- `sendMessage(text: string, options?: { hidden?: HiddenMode }): Promise<void>`
- `submitAuthCode(code: string): Promise<void>`
- `approveTool(optionId: string): Promise<void>`
- `cancel(): Promise<void>`
- `getMessages(): ChatMessage[]`
- `getMessages(options?: { includeHidden?: boolean }): ChatMessage[]`
- `getAuthUrl(): string | null`
- `getPendingApproval(): PendingApproval | null`
- `getConnectionState(): ConnectionState`
- `prependMessages(messages: ChatMessage[]): void`
  - Prepends messages (for replay/infinite scroll).
- `setSessionId(sessionId: string | null): void`
- `getSessionId(): string | null`
- `dispose(): void`

### Static

- `AgentChatClient.fetchReplay(url, replay, options?): Promise<ChatMessage[]>`
  - Uses bridge replay query params to fetch older messages.
  - `options.idleMs` controls the inactivity timeout once the first replay message arrives.

## AgentChatStore

```ts
new AgentChatStore(client: AgentChatClient)
```

### Methods

- `subscribe(listener): () => void`
- `getState(): AgentChatState`
- `dispose(): void`

## GeminiBridge (server)

```ts
new GeminiBridge(options?: GeminiBridgeOptions)
```

### GeminiBridgeOptions

- `model?: string`
- `port?: number` (default 4444)
- `approvalMode?: string`
- `geminiBin?: string`
- `cliPackage?: string`
- `hostApiUrl?: string`
- `sessionId?: string`
- `bridgeSecret?: string`
- `projectRoot?: string`
- `outgoingTransform?: (msg) => { forward?: any | null; extra?: any[] } | null`

### Methods

- `start(): void`
- `stop(): void`

### Events

- `gemini:message` (message from Gemini CLI)
- `client:message` (message from a WebSocket client)

## Types

See `src/common/types.ts` for canonical type definitions.

### Ordering fields

For UIs that need to reconstruct **receive order** across mixed streams, the SDK provides:

- `ChatMessage.seq?: number` (updated on each `message_update`)
- `ToolCall.seq?: number`
- `AgentChatEventMeta` (optional second argument on many events)

`seq` is monotonically increasing in the order the SDK receives notifications, and is
safe to use for sorting/interleaving (unlike `ts`, which is typically fixed at object creation).
