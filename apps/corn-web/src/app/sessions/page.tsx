'use client'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getSessions } from '@/lib/api'

function timeAgo(d: string) {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
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
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data?.sessions && data.sessions.length > 0 ? (
              data.sessions.map((s: any) => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.from_agent}</td>
                  <td><code style={{ color: 'var(--corn-gold)', fontSize: '0.8rem' }}>{s.project}</code></td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.task_summary}</td>
                  <td>
                    <span className={`badge badge-${s.status === 'completed' ? 'healthy' : s.status === 'active' ? 'info' : 'warning'}`}>
                      {s.status}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{timeAgo(s.created_at)}</td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)' }}>
                📭 No sessions yet. Sessions appear when agents call <code>corn_session_start</code>.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardLayout>
  )
}
