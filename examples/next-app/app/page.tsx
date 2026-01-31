import AgentChat from '../components/AgentChat';

export default function Page() {
  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 32 }}>Agent Chat</h1>
        <span style={{ color: '#6e6258' }}>Next.js example</span>
      </header>
      <p style={{ marginTop: 8, color: '#6e6258' }}>
        Connects to a local Gemini bridge and renders streaming output, tool calls, and diffs.
      </p>
      <AgentChat />
    </main>
  );
}
