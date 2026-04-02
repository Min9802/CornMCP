'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { getMe } from '@/lib/auth'
import { logout } from '@/lib/auth'
import styles from './DashboardLayout.module.css'

const NAV_ITEMS = [
  { href: '/', icon: '🏠', label: 'Dashboard' },
  { href: '/sessions', icon: '🔄', label: 'Sessions' },
  { href: '/quality', icon: '🏆', label: 'Quality' },
  { href: '/projects', icon: '📁', label: 'Projects' },
  { href: '/knowledge', icon: '📚', label: 'Knowledge' },
  { href: '/providers', icon: '🧠', label: 'Providers' },
  { href: '/usage', icon: '📊', label: 'Usage' },
  { href: '/keys', icon: '🔑', label: 'API Keys' },
  { href: '/orgs', icon: '🏢', label: 'Organizations' },
  { href: '/users', icon: '👥', label: 'Users', adminOnly: true },
  { href: '/settings', icon: '⚙️', label: 'Settings' },
  { href: '/setup', icon: '📖', label: 'Installation' },
]

function UserAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const colors = ['#fbbf24', '#3b82f6', '#22c55e', '#a855f7', '#ef4444']
  const color = colors[name.charCodeAt(0) % colors.length]
  const initials = name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `${color}22`, border: `2px solid ${color}55`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 700, color, flexShrink: 0,
    }}>
      {initials}
    </div>
  )
}

export default function DashboardLayout({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { data: user, isLoading } = useSWR('auth-me', getMe, { revalidateOnFocus: false })

  useEffect(() => {
    if (!isLoading && user === null) {
      router.replace('/login')
    }
  }, [isLoading, user, router])

  const visibleNav = NAV_ITEMS.filter((item) => {
    if (item.adminOnly && user?.role !== 'admin') return false
    return true
  })

  return (
    <div className={styles.shell}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className={styles.overlay} onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
        <div className={styles.logo}>
          <span className={styles.logoIcon}>🌽</span>
          <span className={styles.logoText}>Corn Hub</span>
        </div>

        <nav className={styles.nav}>
          {visibleNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navItem} ${pathname === item.href ? styles.navItemActive : ''}`}
              onClick={() => setSidebarOpen(false)}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              <span className={styles.navLabel}>{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          {user ? (
            <div className={styles.userSection}>
              <div className={styles.userInfo}>
                <UserAvatar name={user.name} />
                <div className={styles.userText}>
                  <div className={styles.userName}>{user.name}</div>
                  <div className={styles.userRole}>{user.role === 'admin' ? '👑 Admin' : '👤 User'}</div>
                </div>
              </div>
              <button className={styles.logoutBtn} onClick={logout} title="Sign out">
                ⏻
              </button>
            </div>
          ) : (
            <span className={styles.version}>v0.1.2</span>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className={styles.main}>
        <header className={styles.header}>
          <button
            className={styles.hamburger}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Toggle menu"
          >
            ☰
          </button>
          <div>
            <h1 className={styles.title}>{title}</h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
        </header>

        <div className={styles.content}>{children}</div>
      </main>
    </div>
  )
}
