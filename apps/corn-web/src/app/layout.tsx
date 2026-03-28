import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Corn Hub — AI Agent Intelligence',
  description: 'Self-hosted AI Agent Intelligence Platform with persistent memory, knowledge base, and quality enforcement',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
