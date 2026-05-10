import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  runHeuristic,
  registerChatTask,
  CHAT_ASSISTANT_TASK_NAME,
  ChatHeuristicUnsupportedError,
  type ChatInput,
  type ChatResult,
} from './chat.js'
import {
  _resetFetchImplForTests,
  _resetTaskConfigCacheForTests,
  _resetTaskRegistryForTests,
  _setFetchImplForTests,
  runTask,
  type TaskEngineConfig,
} from '../services/task-dispatcher.js'
import type { McpEnv } from '@corn/shared-types'

const env: McpEnv = {
  QDRANT_URL: '',
  DASHBOARD_API_URL: 'http://test.local',
  DASHBOARD_API_KEY: 'test-key',
  MCP_SERVER_NAME: 'corn-mcp-test',
  MCP_SERVER_VERSION: '0.0.0',
  API_KEYS: '',
}

function makeConfig(overrides: Partial<TaskEngineConfig> = {}): TaskEngineConfig {
  return {
    task_name: CHAT_ASSISTANT_TASK_NAME,
    engine: 'llm',
    provider_id: 'test-provider',
    model: 'gpt-4o-mini',
    enabled: 1,
    // Chat-specific: never fall back to heuristic (heuristic throws anyway).
    fallback_to_heuristic: 0,
    prompt_template: null,
    timeout_ms: 60_000,
    max_input_tokens: 8000,
    max_output_tokens: 1024,
    temperature: 0.3,
    cache_ttl_sec: 3600,
    cost_cap_usd_per_day: 0,
    description: null,
    ...overrides,
  }
}

function makeChatResponse(content: string, overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      content,
      inputTokens: 50,
      outputTokens: 40,
      costUsd: 0.0001,
      latencyMs: 200,
      cached: false,
      providerId: 'test-provider',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tokensEstimated: false,
      ...overrides,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('chat — heuristic', () => {
  test('heuristic throws ChatHeuristicUnsupportedError', () => {
    assert.throws(
      () => runHeuristic({ messages: [{ role: 'user', content: 'hi' }] }),
      ChatHeuristicUnsupportedError,
    )
  })

  test('error message includes admin-ui guidance', () => {
    try {
      runHeuristic({ messages: [] })
      assert.fail('expected throw')
    } catch (err) {
      assert.equal((err as Error).name, 'ChatHeuristicUnsupportedError')
      assert.ok((err as Error).message.toLowerCase().includes('admin'))
    }
  })
})

describe('chat — dispatcher integration', () => {
  beforeEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
    registerChatTask()
  })

  afterEach(() => {
    _resetFetchImplForTests()
    _resetTaskConfigCacheForTests()
    _resetTaskRegistryForTests()
  })

  test('llm happy path returns trimmed content + usage', async () => {
    _setFetchImplForTests(async () => makeChatResponse('  Hello, world!  '))
    const { result, metadata } = await runTask<ChatInput, ChatResult>(
      CHAT_ASSISTANT_TASK_NAME,
      { messages: [{ role: 'user', content: 'hi' }] },
      env,
      { config: makeConfig() },
    )
    assert.equal(result.content, 'Hello, world!')
    assert.equal(result.inputTokens, 50)
    assert.equal(result.outputTokens, 40)
    assert.ok(result.costUsd > 0)
    assert.equal(metadata.engineUsed, 'llm')
  })

  test('systemPrompt is prepended when messages lack a system role', async () => {
    let capturedBody: Record<string, unknown> = {}
    _setFetchImplForTests(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string)
      return makeChatResponse('ok')
    })
    await runTask<ChatInput, ChatResult>(
      CHAT_ASSISTANT_TASK_NAME,
      {
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: 'Be brief.',
      },
      env,
      { config: makeConfig() },
    )
    const messages = capturedBody['messages'] as { role: string; content: string }[]
    assert.equal(messages[0]?.role, 'system')
    assert.equal(messages[0]?.content, 'Be brief.')
    assert.equal(messages[1]?.role, 'user')
  })

  test('existing system message is preserved as-is', async () => {
    let capturedBody: Record<string, unknown> = {}
    _setFetchImplForTests(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string)
      return makeChatResponse('ok')
    })
    await runTask<ChatInput, ChatResult>(
      CHAT_ASSISTANT_TASK_NAME,
      {
        messages: [
          { role: 'system', content: 'Original.' },
          { role: 'user', content: 'hi' },
        ],
        systemPrompt: 'Should be ignored.',
      },
      env,
      { config: makeConfig() },
    )
    const messages = capturedBody['messages'] as { role: string; content: string }[]
    assert.equal(messages[0]?.content, 'Original.')
    assert.equal(messages.length, 2)
  })

  test('malformed messages array throws', async () => {
    await assert.rejects(
      runTask<ChatInput, ChatResult>(
        CHAT_ASSISTANT_TASK_NAME,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [{ foo: 'bar' } as any] },
        env,
        { config: makeConfig() },
      ),
      /empty or malformed/,
    )
  })

  test('empty LLM content throws', async () => {
    _setFetchImplForTests(async () => makeChatResponse('   '))
    await assert.rejects(
      runTask<ChatInput, ChatResult>(
        CHAT_ASSISTANT_TASK_NAME,
        { messages: [{ role: 'user', content: 'hi' }] },
        env,
        { config: makeConfig() },
      ),
      /empty content/,
    )
  })

  test('heuristic engine throws the guidance error', async () => {
    await assert.rejects(
      runTask<ChatInput, ChatResult>(
        CHAT_ASSISTANT_TASK_NAME,
        { messages: [{ role: 'user', content: 'hi' }] },
        env,
        { config: makeConfig({ engine: 'heuristic' }) },
      ),
      /has no heuristic engine/,
    )
  })

  test('fallback_to_heuristic=1 surfaces guidance error after LLM failure', async () => {
    _setFetchImplForTests(async () => makeChatResponse(''))
    await assert.rejects(
      runTask<ChatInput, ChatResult>(
        CHAT_ASSISTANT_TASK_NAME,
        { messages: [{ role: 'user', content: 'hi' }] },
        env,
        { config: makeConfig({ fallback_to_heuristic: 1 }) },
      ),
      /has no heuristic engine|empty content/,
    )
  })

  test('registerChatTask is idempotent', () => {
    registerChatTask()
    registerChatTask()
  })
})
