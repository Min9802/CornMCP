'use client'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getKnowledgeDocs } from '@/lib/api'

export default function KnowledgePage() {
  const { data } = useSWR('knowledge', () => getKnowledgeDocs(), { refreshInterval: 15000 })

  return (
    <DashboardLayout title="Knowledge" subtitle="Browse and search the shared knowledge base">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 'var(--space-4)' }}>
        {data?.documents && data.documents.length > 0 ? (
          data.documents.map((doc: any) => {
            const tags = (() => { try { return JSON.parse(doc.tags || '[]') } catch { return [] } })()
            return (
              <div key={doc.id} className="card animate-in">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-3)' }}>
                  <h3 style={{ fontWeight: 600, fontSize: '1rem' }}>📄 {doc.title}</h3>
                  <span className={`badge badge-${doc.source === 'agent' ? 'info' : 'healthy'}`}>{doc.source}</span>
                </div>
                {doc.content_preview && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 'var(--space-3)' }}>
                    {doc.content_preview}
                  </p>
                )}
                {tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
                    {tags.map((t: string) => (
                      <span key={t} style={{ padding: '2px 8px', background: 'var(--bg-accent)', borderRadius: '99px', fontSize: '0.7rem', color: 'var(--corn-gold)' }}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  <span>👁️ {doc.hit_count} hits</span>
                  {doc.source_agent_id && <span>🤖 {doc.source_agent_id}</span>}
                </div>
              </div>
            )
          })
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)', gridColumn: '1 / -1' }}>
            📚 No knowledge documents yet. Agents contribute knowledge via <code>corn_knowledge_store</code>.
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
