'use client'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getSessions } from '@/lib/api'
import { timeAgo } from '@/lib/date'

function parseAutoClose(rawContext: unknown): { autoClosed: boolean; reason?: string } {
  if (typeof rawContext !== 'string' || !rawContext) return { autoClosed: false }
  try {
    const ctx = JSON.parse(rawContext) as Record<string, unknown>
    if (ctx['autoClosed']) {
      return { autoClosed: true, reason: typeof ctx['autoCloseReason'] === 'string' ? (ctx['autoCloseReason'] as string) : undefined }
    }
  } catch {
    // ignore — corrupt context
  }
  return { autoClosed: false }
}

export default function SessionsPage() {
  const { data } = useSWR('sessions', () => getSessions(), { refreshInterval: 10000 })

  return (
    <DashboardLayout title="Sessions" subtitle="Agent work sessions and handoffs">
      <div className="table-container animate-in" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Project</th>
              <th>Task</th>
              <th>Status</th>
              <th>Last activity</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data?.sessions && data.sessions.length > 0 ? (
              data.sessions.map((s: any) => {
                const { autoClosed, reason } = parseAutoClose(s.context)
                const badgeClass =
                  s.status === 'completed' ? 'healthy'
                  : s.status === 'active' ? 'info'
                  : s.status === 'abandoned' ? 'warning'
                  : 'warning'
                const tooltip = autoClosed
                  ? `Auto-closed by server (${reason || 'inactivity'})`
                  : undefined
                return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.from_agent}</td>
                    <td><code style={{ color: 'var(--corn-gold)', fontSize: '0.8rem' }}>{s.project}</code></td>
                    <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.task_summary}</td>
                    <td>
                      <span className={`badge badge-${badgeClass}`} title={tooltip}>
                        {s.status}{autoClosed ? ' · auto' : ''}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {s.last_activity_at ? timeAgo(s.last_activity_at) : '—'}
                    </td>
                    <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{timeAgo(s.created_at)}</td>
                  </tr>
                )
              })
            ) : (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)' }}>
                📭 No sessions yet. Sessions appear when agents call <code>corn_session_start</code>.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardLayout>
  )
}
