"use client"

import { useEffect, useState } from "react"
import styles from "../../page.module.css"

export default function SetupCallback() {
  const [status, setStatus] = useState("Processing OAuth callback...")

  useEffect(() => {
    // In a real implementation, handle OAuth fragments/query params
    setTimeout(() => {
      setStatus("Setup Complete. Redirecting...")
      setTimeout(() => window.location.href = "/", 1000)
    }, 1500)
  }, [])

  return (
    <div className={styles.container} style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
      <div className={styles.metricCard} style={{ textAlign: 'center' }}>
        <h2>{status}</h2>
      </div>
    </div>
  )
}
