'use client'
import DashboardLayout from '@/components/layout/DashboardLayout'
import useSWR from 'swr'
import { getMemories, deleteMemory } from '@/lib/api'
import { useConfirm, useToast } from '@/components/ConfirmProvider'

export default function MemoryPage() {
  const { data, mutate } = useSWR('memories', () => getMemories(), { refreshInterval: 15000 })
  const confirm = useConfirm()
  const toast = useToast()

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: 'Delete memory preview',
      message: 'Delete this memory preview? Vector entry in MCP local store stays until full sync.',
      variant: 'danger',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await deleteMemory(id)
      mutate()
      toast({ kind: 'success', message: 'Memory preview deleted' })
    } catch (err) {
      toast({
        kind: 'error',
        message: `Delete failed: ${err instanceof Error ? err.message : err}`,
      })
    }
  }

  return (
    <DashboardLayout title="Memory" subtitle="Agent memories stored via corn_memory_store (MCP)">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 'var(--space-4)' }}>
        {data?.memories && data.memories.length > 0 ? (
          data.memories.map((mem: any) => {
            const tags = (() => { try { return JSON.parse(mem.tags || '[]') } catch { return [] } })()
            return (
              <div key={mem.id} className="card animate-in">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-3)' }}>
                  <h3 style={{ fontWeight: 600, fontSize: '0.95rem', wordBreak: 'break-word' }}>💭 {mem.id}</h3>
                  <button
                    onClick={() => handleDelete(mem.id)}
                    className="btn btn-secondary btn-sm"
                    style={{ padding: '2px 8px', fontSize: '0.7rem' }}
                    title="Delete memory preview"
                  >
                    ✕
                  </button>
                </div>
                {mem.content_preview && (
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 'var(--space-3)' }}>
                    {mem.content_preview}
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
                <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: '0.7rem', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                  {mem.agent_id && <span>🤖 {mem.agent_id}</span>}
                  {mem.project_id && <span>📁 {mem.project_id}</span>}
                  {mem.branch && <span>🌿 {mem.branch}</span>}
                  <span>👁️ {mem.hit_count ?? 0}</span>
                </div>
              </div>
            )
          })
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)', gridColumn: '1 / -1' }}>
            💭 No memories yet. Agents store memories via <code>corn_memory_store</code>.
            <br />
            <small style={{ display: 'block', marginTop: 'var(--space-3)' }}>
              Note: This page shows preview rows. Full vector content lives in MCP&apos;s local mem9 store and is searched via <code>corn_memory_search</code>.
            </small>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
