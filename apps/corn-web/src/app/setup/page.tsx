'use client'
import DashboardLayout from "@/components/layout/DashboardLayout"

const _apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'
const _mcpUrl = process.env.NEXT_PUBLIC_MCP_URL || 'http://localhost:8317'

function useServiceUrls() {
  if (typeof window === 'undefined') return { host: 'localhost', apiUrl: _apiUrl, mcpUrl: _mcpUrl, webUrl: '' }
  const webUrl = `${window.location.protocol}//${window.location.host}`
  return {
    host: new URL(_apiUrl).hostname,
    apiUrl: _apiUrl,
    mcpUrl: _mcpUrl,
    webUrl,
  }
}

export default function SetupPage() {
  const { host, apiUrl, mcpUrl, webUrl } = useServiceUrls()
  return (
    <DashboardLayout title="Installation" subtitle="Get Corn Hub running in your IDE in under 2 minutes">

      {/* Prerequisites */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', gap: 8 }}>
          📋 Prerequisites
        </h3>
        <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200, padding: 'var(--space-4)', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: 'var(--space-2)' }}>⬢</div>
            <div style={{ fontWeight: 600 }}>Node.js 22+</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>Required for the MCP server runtime</div>
          </div>
          <div style={{ flex: 1, minWidth: 200, padding: 'var(--space-4)', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: 'var(--space-2)' }}>📦</div>
            <div style={{ fontWeight: 600 }}>pnpm 10+</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>Monorepo package manager</div>
          </div>
          <div style={{ flex: 1, minWidth: 200, padding: 'var(--space-4)', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: 'var(--space-2)' }}>🐳</div>
            <div style={{ fontWeight: 600 }}>Docker <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>(optional)</span></div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 4 }}>Only needed for the Analytics Dashboard</div>
          </div>
        </div>
      </div>

      {/* Step 1: Clone & Build */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: 'var(--gradient-gold)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontSize: '1.2rem', fontWeight: 800 }}>1</span>
          Clone & Build
        </h3>
        <pre style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', overflow: 'auto', fontSize: '0.85rem', lineHeight: 1.6, border: '1px solid rgba(255,255,255,0.06)' }}>
          <code style={{ color: '#e2e8f0' }}>{`# Clone the repository
git clone https://github.com/Min9802/CornMCP.git
cd CornMCP

# Install dependencies & build
pnpm install
pnpm build`}</code>
        </pre>
      </div>

      {/* Step 2: IDE Configuration */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: 'var(--gradient-gold)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontSize: '1.2rem', fontWeight: 800 }}>2</span>
          Connect to Your IDE
        </h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-4)', fontSize: '0.9rem' }}>
          Add Corn Hub as an MCP server in your IDE. Replace the path with your actual clone location.
        </p>

        {/* Antigravity / Codex */}
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ fontWeight: 600, marginBottom: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--corn-blue)' }}>⚡</span> Antigravity / Codex (VS Code)
          </div>
          <pre style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', overflow: 'auto', fontSize: '0.82rem', lineHeight: 1.5, border: '1px solid rgba(255,255,255,0.06)' }}>
            <code style={{ color: '#e2e8f0' }}>{`// STDIO (local):
{
  "mcpServers": {
    "corn": {
      "command": "node",
      "args": ["/path/to/corn-hub/apps/corn-mcp/dist/cli.js"]
    }
  }
}

// HTTP (remote):
{
  "mcpServers": {
    "corn-hub": {
      "url": "${mcpUrl}/mcp",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}`}</code>
          </pre>
        </div>

        {/* Cursor */}
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ fontWeight: 600, marginBottom: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--corn-teal)' }}>▶</span> Cursor
          </div>
          <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', fontSize: '0.85rem', lineHeight: 1.8, border: '1px solid rgba(255,255,255,0.06)' }}>
            <div>1. <strong>Settings</strong> → <strong>Features</strong> → <strong>MCP</strong></div>
            <div>2. Click <strong>+ Add new MCP server</strong></div>
            <div>3. Name: <code style={{ color: 'var(--corn-gold)', background: 'rgba(251,191,36,0.1)', padding: '1px 6px', borderRadius: 4 }}>corn</code> · Type: <code style={{ color: 'var(--corn-gold)', background: 'rgba(251,191,36,0.1)', padding: '1px 6px', borderRadius: 4 }}>command</code></div>
            <div>4. Command: <code style={{ color: 'var(--corn-gold)', background: 'rgba(251,191,36,0.1)', padding: '1px 6px', borderRadius: 4 }}>node /path/to/corn-hub/apps/corn-mcp/dist/cli.js</code></div>
          </div>
        </div>

        {/* Claude Code */}
        <div>
          <div style={{ fontWeight: 600, marginBottom: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--corn-green)' }}>🟢</span> Claude Code
          </div>
          <pre style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', overflow: 'auto', fontSize: '0.82rem', lineHeight: 1.5, border: '1px solid rgba(255,255,255,0.06)' }}>
            <code style={{ color: '#e2e8f0' }}>{`claude mcp add corn -- node /path/to/corn-hub/apps/corn-mcp/dist/cli.js`}</code>
          </pre>
        </div>
      </div>

      {/* Step 3: Dashboard */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ background: 'var(--gradient-gold)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontSize: '1.2rem', fontWeight: 800 }}>3</span>
          Launch Dashboard <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
        </h3>
        <pre style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', overflow: 'auto', fontSize: '0.85rem', lineHeight: 1.6, border: '1px solid rgba(255,255,255,0.06)', marginBottom: 'var(--space-4)' }}>
          <code style={{ color: '#e2e8f0' }}>{`docker compose -f infra/docker-compose.yml up -d --build`}</code>
        </pre>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          {[
            { name: 'Dashboard', url: webUrl || apiUrl, color: 'var(--corn-blue)' },
            { name: 'API', url: apiUrl, color: 'var(--corn-green)' },
            { name: 'MCP Gateway', url: mcpUrl, color: 'var(--corn-teal)' },
            { name: 'Qdrant', url: `http://${host}:6333`, color: 'var(--corn-gold)' },
          ].map(s => (
            <div key={s.name} style={{ padding: 'var(--space-3)', background: 'rgba(255,255,255,0.03)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,255,255,0.06)', minWidth: 120, textAlign: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{s.name}</div>
              <div style={{ color: s.color, fontWeight: 700, fontSize: '0.9rem', fontFamily: 'monospace' }}>{s.url}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Environment Variables */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-4)', display: 'flex', alignItems: 'center', gap: 8 }}>
          ⚙️ Environment Variables
        </h3>
        <div className="table-container" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr><th>Variable</th><th>Default</th><th>Description</th></tr>
            </thead>
            <tbody>
              {[
                ['OPENAI_API_KEY', '—', 'Voyage AI / OpenAI API key for embeddings'],
                ['OPENAI_API_BASE', 'https://api.voyageai.com/v1', 'Embedding API base URL'],
                ['MEM9_EMBEDDING_MODEL', 'voyage-code-3', 'Primary embedding model'],
                ['MEM9_EMBEDDING_DIMS', '1024', 'Embedding vector dimensions'],
                ['MEM9_FALLBACK_MODELS', 'voyage-4-large,...', 'Fallback model rotation chain'],
                ['DASHBOARD_API_URL', apiUrl || 'http://localhost:4000', 'Dashboard API URL'],
                ['DASHBOARD_API_KEY', '—', 'API key for MCP → API communication'],
                ['AUTH_JWT_SECRET', 'changeme', 'JWT secret for user authentication'],
                ['CORS_ORIGIN', 'http://localhost:3000', 'Allowed CORS origin for dashboard'],
                ['GEMINI_API_KEY', '—', 'Google Gemini API key (optional)'],
                ['QDRANT_URL', 'http://<host>:6333', 'Vector database URL'],
              ].map(([name, def, desc]) => (
                <tr key={name}>
                  <td><code style={{ color: 'var(--corn-gold)', fontSize: '0.82rem', background: 'rgba(251,191,36,0.1)', padding: '2px 6px', borderRadius: 4 }}>{name}</code></td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{def}</td>
                  <td style={{ fontSize: '0.85rem' }}>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Notes */}
      <div className="card" style={{ borderLeft: '3px solid var(--corn-gold)' }}>
        <h3 style={{ fontWeight: 700, marginBottom: 'var(--space-4)' }}>📝 Notes</h3>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <li style={{ display: 'flex', gap: 8, fontSize: '0.9rem' }}>
            <span style={{ color: 'var(--corn-gold)', flexShrink: 0 }}>⚡</span>
            <span><strong>Model Rotation:</strong> When the primary Voyage model hits rate limits, Corn Hub auto-rotates: <code style={{ color: 'var(--corn-gold)', fontSize: '0.82rem' }}>voyage-code-3 → voyage-4-large → voyage-4 → voyage-code-2 → voyage-4-lite</code></span>
          </li>
          <li style={{ display: 'flex', gap: 8, fontSize: '0.9rem' }}>
            <span style={{ color: 'var(--corn-green)', flexShrink: 0 }}>✅</span>
            <span><strong>Quality Gates:</strong> All plans must score ≥80% on <code style={{ color: 'var(--corn-gold)', fontSize: '0.82rem' }}>corn_plan_quality</code> before execution. All tasks must submit a <code style={{ color: 'var(--corn-gold)', fontSize: '0.82rem' }}>corn_quality_report</code> ≥60/100.</span>
          </li>
          <li style={{ display: 'flex', gap: 8, fontSize: '0.9rem' }}>
            <span style={{ color: 'var(--corn-blue)', flexShrink: 0 }}>💾</span>
            <span><strong>Local Fallback:</strong> If no API key is set, embeddings use a local hash-based provider (lower quality but zero external dependencies).</span>
          </li>
          <li style={{ display: 'flex', gap: 8, fontSize: '0.9rem' }}>
            <span style={{ color: 'var(--corn-teal)', flexShrink: 0 }}>🪟</span>
            <span><strong>Windows:</strong> Use forward slashes or escaped backslashes in JSON config paths. The MCP server works on Windows, macOS, and Linux.</span>
          </li>
          <li style={{ display: 'flex', gap: 8, fontSize: '0.9rem' }}>
            <span style={{ color: '#ef4444', flexShrink: 0 }}>⚠️</span>
            <span><strong>Build Required:</strong> You must run <code style={{ color: 'var(--corn-gold)', fontSize: '0.82rem' }}>pnpm build</code> after cloning. The <code style={{ color: 'var(--corn-gold)', fontSize: '0.82rem' }}>dist/</code> folder is not committed to Git.</span>
          </li>
        </ul>
      </div>

    </DashboardLayout>
  )
}
