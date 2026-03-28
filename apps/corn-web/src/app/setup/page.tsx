import DashboardLayout from "@/components/layout/DashboardLayout"
import styles from "../page.module.css"

export default function SetupPage() {
  return (
    <DashboardLayout title="Setup">
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.title}>Welcome to Corn</h1>
          <p className={styles.description}>
            Let's get your agent intelligence hub set up.
          </p>
        </div>

        <div className={styles.metricsGrid}>
          <div className={styles.metricCard}>
            <h3>Agent Connect</h3>
            <p>Connect your LLM providers to proxy requests securely.</p>
            <a href="/providers" className={styles.actionButton}>Configure Providers</a>
          </div>

          <div className={styles.metricCard}>
            <h3>Code Intelligence</h3>
            <p>Index your repositories for semantic search and context.</p>
            <a href="/projects" className={styles.actionButton}>Add Projects</a>
          </div>

          <div className={styles.metricCard}>
            <h3>MCP Server</h3>
            <p>Generate API keys for your MCP clients.</p>
            <a href="/keys" className={styles.actionButton}>Create API Key</a>
          </div>
        </div>
      </div>
    </DashboardLayout>
  )
}
