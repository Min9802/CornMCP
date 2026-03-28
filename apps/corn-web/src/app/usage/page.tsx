'use client'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getUsageStats } from '@/lib/api'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

export default function UsagePage() {
  const { data } = useSWR('usage', () => getUsageStats(30), { refreshInterval: 30000 })

  return (
    <DashboardLayout title="Usage" subtitle="Token consumption and LLM cost tracking">
      {/* Top Stats */}
      <div style={{ display: 'flex', gap: 'var(--space-4)', marginBottom: 'var(--space-6)', flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: 1, minWidth: 200, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 800, background: 'var(--gradient-gold)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {data ? formatTokens(data.totalTokens) : '...'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total Tokens (30d)</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 200, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--corn-blue)' }}>
            {data ? formatTokens(data.totalRequests) : '...'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Total Requests</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 200, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--corn-green)' }}>
            {data?.byModel?.length ?? 0}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Models Used</div>
        </div>
      </div>

      {/* By Model */}
      <div className="table-container animate-in" style={{ marginBottom: 'var(--space-6)', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 'var(--space-4) var(--space-6)', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', background: 'linear-gradient(90deg, rgba(251, 191, 36, 0.05) 0%, transparent 100%)' }}>
          <h3 style={{ fontWeight: 600, textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>📈 Token Usage by Model</h3>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Prompt Tokens</th>
              <th>Completion Tokens</th>
              <th>Total</th>
              <th>Requests</th>
            </tr>
          </thead>
          <tbody>
            {data?.byModel && data.byModel.length > 0 ? (
              data.byModel.map((m: any, i: number) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}><code style={{ color: 'var(--corn-gold)', fontSize: '0.85rem', background: 'rgba(251, 191, 36, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>{m.model}</code></td>
                  <td>{formatTokens(m.prompt_tokens)}</td>
                  <td>{formatTokens(m.completion_tokens)}</td>
                  <td style={{ fontWeight: 600, color: 'var(--corn-teal)' }}>{formatTokens(m.total_tokens)}</td>
                  <td>{m.requests}</td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--text-muted)' }}>
                No usage data yet. Token usage is logged when agents use LLM proxy features.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* By Agent */}
      <div className="table-container animate-in" style={{ marginBottom: 'var(--space-6)', padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 'var(--space-4) var(--space-6)', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', background: 'linear-gradient(90deg, rgba(34, 197, 94, 0.05) 0%, transparent 100%)' }}>
          <h3 style={{ fontWeight: 600, textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>🤖 Usage by Agent</h3>
        </div>
        <table className="table">
          <thead>
            <tr><th>Agent</th><th>Total Tokens</th><th>Requests</th></tr>
          </thead>
          <tbody>
            {data?.byAgent && data.byAgent.length > 0 ? (
              data.byAgent.map((a: any, i: number) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{a.agent_id}</td>
                  <td style={{ color: 'var(--corn-teal)' }}>{formatTokens(a.total_tokens)}</td>
                  <td>{a.requests}</td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={3} style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--text-muted)' }}>
                No agent usage data yet.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Daily Trend */}
      {data?.daily && data.daily.length > 0 && (
        <div className="card">
          <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>📅 Daily Token Consumption</h3>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            {data.daily.map((d: any, i: number) => {
              const maxTokens = Math.max(...data.daily.map((x: any) => Number(x.tokens || 0)), 1)
              const height = Math.max(20, Math.round((Number(d.tokens || 0) / maxTokens) * 80))
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-1)' }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: 600 }}>{formatTokens(d.tokens || 0)}</span>
                  <div style={{ width: 32, height, background: 'var(--gradient-gold)', borderRadius: 'var(--radius-sm)', transition: 'height 0.3s ease' }} />
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{d.date?.slice(5)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </DashboardLayout>
  )
}
