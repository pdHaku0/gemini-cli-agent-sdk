# Troubleshooting

## Connected but no UI messages

- Ensure you render using `content[]` for assistant messages.
- Ensure you listen to `message_update` (or use `AgentChatStore`).
- User messages are **not echoed** from the server; render them locally.

## WebSocket connects but session never initializes

- Verify `session/new` is being sent (unless you provide `sessionId`).
- Confirm Gemini CLI is running with `--experimental-acp`.
- Check bridge logs for JSON-RPC errors.

## New session after page reload

- A full page reload reinitializes the client and creates a new session.
- Persist `sessionId` (localStorage) and pass it back to the client to reuse a session.
- If the bridge restarts, the previous session ID is invalid and a new session is expected.
- If you keep reusing an invalid session, clear the stored session ID and refresh.

## History replay not working

- `limit` is **turns**, not messages.
- Make sure you pass `before` as a UNIX timestamp in **ms**.
- Replay relies on bridge in-memory history; restarting the bridge clears it.

## SYS_EVENT / `bridge/structured_event` not appearing

- Ensure SYS tag capture is enabled on the bridge:
  - Default: `npm run start:bridge`
  - Disable capture: `SYS_TAG_MODE=raw npm run start:bridge`
  - Keep tags + emit events: `SYS_TAG_MODE=both npm run start:bridge`
  - Legacy bridge (no SYS tags): `npm run start:bridge:legacy`

## Replay returns empty even though bridge says "Replaying"

- Ensure you are running the updated SDK build (rebuild after local changes if using `file:` dependency).
- Increase `idleMs` if the bridge or browser is slow.

## Tool approval UI does not show

- Approvals are per tool call. Match on `toolCallId` and render inside that tool's block.

## "WebSocket constructor not found"

- In Node, ensure `ws` is installed and Node >= 18.
- In Next.js, instantiate the client in a `use client` component.

## "Blocked message during pending auth"

- Gemini CLI requires auth. Use the URL from `auth_required` and call `submitAuthCode()`.
