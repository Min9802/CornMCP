#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './index.js'
import type { Env } from './types.js'

async function run() {
  // Map process.env to the Env format expected by our tools
  const env: Env = {
    QDRANT_URL: process.env.QDRANT_URL || 'http://localhost:6333',
    DASHBOARD_API_URL: process.env.DASHBOARD_API_URL || 'http://localhost:4000',
    MCP_SERVER_NAME: process.env.MCP_SERVER_NAME || 'corn-hub-local',
    MCP_SERVER_VERSION: process.env.MCP_SERVER_VERSION || '0.1.0',
    API_KEYS: '', // Not needed for local STDIO
  }

  // Inject a special owner ID for local IDE usage
  const envWithOwner = { ...env, API_KEY_OWNER: 'local-ide' }

  const server = createMcpServer(envWithOwner)
  const transport = new StdioServerTransport()

  // Intercept console.log/error to prevent breaking STDIO JSON-RPC
  const originalConsoleLog = console.log
  const originalConsoleError = console.error
  
  console.log = (...args) => {
    // Redirect stdout logs to stderr so they don't corrupt the MCP protocol
    originalConsoleError('[corn-mcp stdout]', ...args)
  }
  
  try {
    await server.connect(transport)
    originalConsoleError('🌽 Corn MCP Server running locally via STDIO transport')
  } catch (error) {
    originalConsoleError('Fatal error starting Corn MCP Server:', error)
    process.exit(1)
  }
}

run().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})
