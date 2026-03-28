'use client'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getQualityReports, getQualityTrends } from '@/lib/api'

function timeAgo(d: string) {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function QualityPage() {
  const { data } = useSWR('quality', () => getQualityReports(), { refreshInterval: 15000 })
  const { data: trends } = useSWR('quality-trends', getQualityTrends, { refreshInterval: 30000 })

  return (
    <DashboardLayout title="Quality" subtitle="Quality reports with 4D scoring and grade trends">
      {/* Trends */}
      {trends?.trends && trends.trends.length > 0 && (
        <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
          <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>📈 Grade Trend (Last 30 Days)</h3>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            {trends.trends.map((t: any, i: number) => (
              <div key={i} style={{ textAlign: 'center', padding: 'var(--space-2) var(--space-3)', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem' }}>
                <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{Math.round(t.avg_score)}</div>
                <div style={{ color: 'var(--text-muted)' }}>{t.date?.slice(5)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reports Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Grade</th>
              <th>Score</th>
              <th>Gate</th>
              <th>Agent</th>
              <th>Build</th>
              <th>Regression</th>
              <th>Standards</th>
              <th>Traceability</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data?.reports && data.reports.length > 0 ? (
              data.reports.map((r: any) => (
                <tr key={r.id}>
                  <td><span className={`grade-${r.grade}`} style={{ fontWeight: 800, fontSize: '1.2rem' }}>{r.grade}</span></td>
                  <td style={{ fontWeight: 600 }}>{r.score_total}/100</td>
                  <td><code style={{ color: 'var(--corn-gold)', fontSize: '0.8rem' }}>{r.gate_name}</code></td>
                  <td>{r.agent_id}</td>
                  <td>{r.score_build}/25</td>
                  <td>{r.score_regression}/25</td>
                  <td>{r.score_standards}/25</td>
                  <td>{r.score_traceability}/25</td>
                  <td style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{timeAgo(r.created_at)}</td>
                </tr>
              ))
            ) : (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)' }}>
                🏆 No quality reports yet. Reports appear when agents call <code>corn_quality_report</code>.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardLayout>
  )
}
