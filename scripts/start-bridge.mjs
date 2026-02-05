import { GeminiBridge } from '../dist/server.js';
import { createSysTagTransform } from '../dist/extras/index.js';

const env = process.env;

const model = env.GEMINI_MODEL || 'gemini-3-flash-preview';
const approvalMode = env.GEMINI_APPROVAL_MODE || 'default';
const port = Number.parseInt(env.GEMINI_PORT || '4444', 10);
const geminiBin = env.GEMINI_BIN || undefined;
const cliPackage = env.GEMINI_CLI_PACKAGE || '@google/gemini-cli';
const hostApiUrl = env.HOST_API_URL || undefined;
const sessionId = env.DEV_SESSION_ID || undefined;
const bridgeSecret = env.GEMINI_BRIDGE_SECRET || undefined;
const projectRoot = env.PROJECT_ROOT || undefined;

// SYS tag capture:
// - event: strip SYS tags and emit bridge/structured_event
// - raw: do nothing (no capture)
// - both: keep text and emit bridge/structured_event
const sysTagMode = env.SYS_TAG_MODE || 'event';

const bridge = new GeminiBridge({
  model,
  approvalMode,
  port: Number.isFinite(port) ? port : 4444,
  geminiBin,
  cliPackage,
  hostApiUrl,
  sessionId,
  bridgeSecret,
  projectRoot,
  outgoingTransform: createSysTagTransform({ mode: sysTagMode }),
});

bridge.start();

const stop = () => {
  try {
    bridge.stop();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

