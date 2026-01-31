import type { PendingApproval, ToolCall } from '@pdhaku0/gemini-cli-agent-sdk/client';

export default function ToolCallView({
  call,
  pendingApproval,
  onApprove,
}: {
  call: ToolCall;
  pendingApproval: PendingApproval | null;
  onApprove: (optionId: string) => void;
}) {
  const approval =
    pendingApproval?.toolCall?.toolCallId === call.id ? pendingApproval : null;

  return (
    <div style={{ marginTop: 8, padding: 12, border: '1px solid #e2d7c8', background: '#fffaf2' }}>
      <div style={{ fontSize: 12, color: '#6e6258' }}>
        tool: {call.name} - {call.status}
      </div>
      {call.title && <div style={{ marginTop: 4 }}>{call.title}</div>}
      {call.description && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#6e6258' }}>
          purpose: {call.description}
        </div>
      )}
      {call.workingDir && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#6e6258' }}>
          cwd: {call.workingDir}
        </div>
      )}
      {call.input && (
        <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {call.input}
        </pre>
      )}
      {call.args && (
        <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {JSON.stringify(call.args, null, 2)}
        </pre>
      )}
      {approval && (
        <div style={{ marginTop: 8, padding: 8, background: '#e8f4ff' }}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>Tool permission required:</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {approval.options.map((opt) => (
              <button key={opt.optionId} onClick={() => onApprove(opt.optionId)}>
                {opt.label || opt.optionId}
              </button>
            ))}
          </div>
        </div>
      )}
      {call.diff?.unified && (
        <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 12 }}>{call.diff.unified}</pre>
      )}
      {call.result && !call.diff?.unified && (
        <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', fontSize: 12 }}>{call.result}</pre>
      )}
    </div>
  );
}
