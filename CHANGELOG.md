# Changelog

## 0.1.4 - 2026-02-05
- Fix: broadcast `session/prompt` (user prompts) to other connected clients in real time using a `bridge/replay`-compatible envelope, so UIs reconstruct prompts consistently with replay.
- Add: regression test for real-time prompt broadcast.

## 0.1.3 - 2026-02-05
- Add: event ordering metadata (`seq`) and replay metadata to unify ordering across real-time and replay streams.
- Fix: honor server-injected hidden mode in live stream so hidden turns behave consistently.
- Add: documentation set (API/EVENTS/INTEGRATION/USAGE/TROUBLESHOOTING) and ordering guidance.
- Add: example apps (CLI, Next.js) and session handling improvements.

## 0.1.2 - 2026-02-04
- Fix: SYS tag parsing no longer causes cross-turn "chunk warp" by flushing buffered output on stopReason responses.
- Fix: SYS structured events are now emitted at the correct position in the stream by splitting message chunks.
- Fix: SYS tag end-tags split across chunks are handled correctly (prevents tags from being merged / JSON parse errors).
- Add: Bridge trace logging (`BRIDGE_TRACE_ACP=1`) and SYS tag debug logging (`SYS_TAG_DEBUG=1`) to aid debugging.
- Add: Regression tests for SYS tag chunk-boundary handling.

## 0.1.1 - 2026-02-01
- Fix: preserve hidden turns during replay by storing hidden mode in bridge history and restoring it in the client.
- Fix: attach hidden metadata to prompts and strip it before forwarding to Gemini CLI.

## 0.1.0 - 2026-01-31
- Initial release.
