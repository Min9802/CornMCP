import { serve } from '@hono/node-server'
import app from './index.js'

const port = Number(process.env.PORT) || 8317

serve({ fetch: app.fetch, port }, () => {
  console.log(`🌽 Corn MCP Server listening on http://localhost:${port}`)
  console.log(`   Health: http://localhost:${port}/health`)
  console.log(`   MCP:    http://localhost:${port}/mcp`)
})
