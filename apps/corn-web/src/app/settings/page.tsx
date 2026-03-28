'use client'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { checkHealth } from '@/lib/api'

export default function SettingsPage() {
  const { data: health } = useSWR('health', checkHealth, { refreshInterval: 30000 })

  return (
    <DashboardLayout title="Settings" subtitle="System configuration and version info">
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>⚙️ System Info</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Version</span>
            <p style={{ fontWeight: 600, fontSize: '1.1rem' }}>{health?.version || '0.1.0'}</p>
          </div>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</span>
            <p style={{ fontWeight: 600, fontSize: '1.1rem' }}>
              <span className={`status-dot ${health?.status === 'ok' ? 'healthy' : 'warning'}`} style={{ marginRight: 8 }} />
              {health?.status || 'unknown'}
            </p>
          </div>
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Uptime</span>
            <p style={{ fontWeight: 600, fontSize: '1.1rem' }}>{health?.uptime ? `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m` : '—'}</p>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>🔗 Service Endpoints</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {[
            { name: 'MCP Server', url: 'http://localhost:8317/mcp' },
            { name: 'Dashboard API', url: 'http://localhost:4000' },
            { name: 'Health (MCP)', url: 'http://localhost:8317/health' },
            { name: 'Health (API)', url: 'http://localhost:4000/health' },
          ].map((ep) => (
            <div key={ep.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-3) var(--space-4)', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontWeight: 500 }}>{ep.name}</span>
              <code style={{ fontSize: '0.8rem', color: 'var(--corn-gold)' }}>{ep.url}</code>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ fontWeight: 600, marginBottom: 'var(--space-4)' }}>📋 MCP Config</h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-4)', fontSize: '0.9rem' }}>
          Add this to your AI agent&apos;s MCP configuration:
        </p>
        <pre style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', overflow: 'auto', fontSize: '0.8rem', color: 'var(--corn-gold)' }}>
{`{
  "mcpServers": {
    "corn-hub": {
      "url": "http://localhost:8317/mcp",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}`}
        </pre>
      </div>
    </DashboardLayout>
  )
}
