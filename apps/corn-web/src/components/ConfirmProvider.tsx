'use client'

// Replaces window.confirm() / window.alert() with consistent in-app modals
// + toast notifications. Mirrors the existing modal style used across
// admin pages (`position: fixed`, `card animate-in`, zIndex 200).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

// ── Confirm dialog ──────────────────────────────────────
export interface ConfirmOptions {
  title?: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  // Visual variant — 'danger' renders the confirm button red, 'warning' gold.
  variant?: 'default' | 'danger' | 'warning'
}

interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

// ── Toast ───────────────────────────────────────────────
export type ToastKind = 'success' | 'error' | 'info' | 'warning'
export interface ToastOptions {
  message: ReactNode
  kind?: ToastKind
  durationMs?: number
}
interface ToastEntry extends Required<Pick<ToastOptions, 'kind' | 'durationMs'>> {
  id: number
  message: ReactNode
}

interface ConfirmContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  toast: (opts: ToastOptions) => void
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx.confirm
}

export function useToast() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useToast must be used inside <ConfirmProvider>')
  return ctx.toast
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null)
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  const toastIdRef = useRef(1)

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, resolve })
    })
  }, [])

  const toast = useCallback((opts: ToastOptions) => {
    const id = toastIdRef.current++
    const entry: ToastEntry = {
      id,
      message: opts.message,
      kind: opts.kind ?? 'info',
      durationMs: opts.durationMs ?? (opts.kind === 'error' ? 6000 : 3500),
    }
    setToasts((prev) => [...prev, entry])
  }, [])

  // Auto-dismiss toasts after their duration. Each toast is independent so
  // we set one timer per id.
  useEffect(() => {
    if (toasts.length === 0) return
    const timers = toasts.map((t) =>
      setTimeout(() => {
        setToasts((prev) => prev.filter((p) => p.id !== t.id))
      }, t.durationMs),
    )
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [toasts])

  // Close the dialog on Escape (cancel) and submit on Enter for keyboard
  // parity with native confirm().
  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        state.resolve(false)
        setState(null)
      } else if (e.key === 'Enter') {
        state.resolve(true)
        setState(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  const value = useMemo<ConfirmContextValue>(() => ({ confirm, toast }), [confirm, toast])

  const handleCancel = () => {
    state?.resolve(false)
    setState(null)
  }
  const handleConfirm = () => {
    state?.resolve(true)
    setState(null)
  }

  return (
    <ConfirmContext.Provider value={value}>
      {children}

      {/* ── Confirm modal ─────────────────────────────── */}
      {state && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            zIndex: 300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--space-4)',
          }}
          onClick={handleCancel}
        >
          <div
            className="card animate-in"
            style={{ width: '100%', maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-3)',
              }}
            >
              <div
                style={{
                  fontSize: '1.5rem',
                  width: 40,
                  height: 40,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '50%',
                  background:
                    state.variant === 'danger'
                      ? 'rgba(239,68,68,0.12)'
                      : state.variant === 'warning'
                        ? 'rgba(251,191,36,0.12)'
                        : 'rgba(34,197,94,0.12)',
                }}
              >
                {state.variant === 'danger' ? '⚠️' : state.variant === 'warning' ? '⚡' : '❓'}
              </div>
              <h3 style={{ fontWeight: 700, fontSize: '1rem' }}>{state.title ?? 'Confirm action'}</h3>
            </div>
            <div
              style={{
                fontSize: '0.9rem',
                color: 'var(--text-secondary)',
                marginBottom: 'var(--space-4)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {state.message}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
              <button className="btn btn-secondary" onClick={handleCancel}>
                {state.cancelLabel ?? 'Cancel'}
              </button>
              <button
                className="btn btn-primary"
                style={
                  state.variant === 'danger'
                    ? { background: 'var(--corn-red, #ef4444)', borderColor: 'var(--corn-red, #ef4444)' }
                    : state.variant === 'warning'
                      ? { background: 'var(--corn-gold)', borderColor: 'var(--corn-gold)' }
                      : undefined
                }
                onClick={handleConfirm}
                autoFocus
              >
                {state.confirmLabel ?? (state.variant === 'danger' ? 'Delete' : 'Confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast stack ───────────────────────────────── */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            top: 'var(--space-4)',
            right: 'var(--space-4)',
            zIndex: 400,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            pointerEvents: 'none',
            maxWidth: 420,
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className="card animate-in"
              style={{
                pointerEvents: 'auto',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--space-2)',
                padding: 'var(--space-3) var(--space-4)',
                fontSize: '0.85rem',
                borderColor:
                  t.kind === 'error'
                    ? 'rgba(239,68,68,0.5)'
                    : t.kind === 'success'
                      ? 'rgba(34,197,94,0.5)'
                      : t.kind === 'warning'
                        ? 'rgba(251,191,36,0.5)'
                        : undefined,
                background:
                  t.kind === 'error'
                    ? 'rgba(239,68,68,0.08)'
                    : t.kind === 'success'
                      ? 'rgba(34,197,94,0.08)'
                      : t.kind === 'warning'
                        ? 'rgba(251,191,36,0.08)'
                        : undefined,
              }}
            >
              <span style={{ flexShrink: 0 }}>
                {t.kind === 'error' ? '❌' : t.kind === 'success' ? '✓' : t.kind === 'warning' ? '⚠️' : 'ℹ️'}
              </span>
              <div style={{ flex: 1 }}>{t.message}</div>
              <button
                onClick={() => setToasts((prev) => prev.filter((p) => p.id !== t.id))}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '1rem',
                  lineHeight: 1,
                  padding: 0,
                }}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
