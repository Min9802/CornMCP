// ─── Advisory Tools (S7.7 + S7.8 + S7.10) ──────────────
// Three MCP tools that expose dispatcher-backed tasks without any
// persistent side effects:
//   - corn_anomaly_check   — flag anomalous values in numeric series
//   - corn_token_count     — estimate BPE token counts
//   - corn_chat            — free-form chat completion (single turn)
//
// All three register their dispatcher tasks on import so admins can
// toggle engine/model/provider in the Task Engines tab. The tools
// themselves just format dispatcher output as markdown.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpEnv } from '@corn/shared-types'

import { runTask } from '../services/task-dispatcher.js'
import {
  ANOMALY_DETECTION_TASK_NAME,
  registerAnomalyDetectionTask,
  type AnomalyInput,
  type AnomalyResult,
} from './anomaly-detection.js'
import {
  TOKEN_COUNT_TASK_NAME,
  registerTokenCountTask,
  type TokenCountInput,
  type TokenCountResult,
} from './token-count.js'
import {
  CHAT_ASSISTANT_TASK_NAME,
  registerChatTask,
  type ChatInput,
  type ChatResult,
} from './chat.js'

function severityIcon(severity: 'low' | 'medium' | 'high'): string {
  if (severity === 'high') return '🔴'
  if (severity === 'medium') return '🟠'
  return '🟡'
}

export function registerAdvisoryTools(server: McpServer, env: McpEnv) {
  // Wire all three dispatcher tasks up-front. Idempotent.
  registerAnomalyDetectionTask()
  registerTokenCountTask()
  registerChatTask()

  // ── corn_anomaly_check (S7.7) ─────────────────────────
  server.tool(
    'corn_anomaly_check',
    'Flag anomalous values in numeric time-series metrics. Heuristic = z-score test (|z|≥2). LLM mode asks a model to reason about the pattern. Returns findings sorted by severity. Advisory — no persistence.',
    {
      metrics: z
        .array(
          z.object({
            name: z.string().describe('Metric name (e.g. "cost_usd_hour").'),
            values: z.array(z.number()).min(1).describe('Ordered values oldest → newest.'),
            baseline: z
              .object({ mean: z.number(), stddev: z.number() })
              .optional()
              .describe('Optional explicit baseline. If omitted, derived from the first 80% of values.'),
            unit: z.string().optional().describe('Optional unit label for display.'),
          }),
        )
        .min(1)
        .describe('One or more metric series to inspect.'),
      zThreshold: z
        .number()
        .positive()
        .optional()
        .describe('z-score threshold for flagging. Default 2.'),
      baselineFraction: z
        .number()
        .min(0.1)
        .max(0.95)
        .optional()
        .describe('Fraction of each series used to derive a baseline when none is supplied. Default 0.8.'),
    },
    async ({ metrics, zThreshold, baselineFraction }) => {
      try {
        const { result, metadata } = await runTask<AnomalyInput, AnomalyResult>(
          ANOMALY_DETECTION_TASK_NAME,
          { metrics, zThreshold, baselineFraction },
          env,
        )
        const fallback = metadata.fellBack ? ` · fallback (${metadata.llmError ?? 'llm error'})` : ''
        const engine = metadata.engineUsed === 'llm' ? '🤖 LLM' : '⚙️ Heuristic'
        const lines: string[] = [
          `🚨 **Anomaly Check** (${engine}${fallback}) — ${result.anomalies.length} finding(s)`,
          '',
        ]
        if (result.anomalies.length === 0) {
          lines.push('✅ No anomalies detected above the configured threshold.')
        } else {
          lines.push('| # | Metric | Idx | Value | Severity | Reason |')
          lines.push('|---|--------|-----|-------|----------|--------|')
          result.anomalies.forEach((a, i) => {
            const reason = a.reason.replace(/\|/g, '\\|').slice(0, 160)
            lines.push(
              `| ${i + 1} | \`${a.metric}\` | ${a.index} | ${a.value} | ${severityIcon(a.severity)} ${a.severity} | ${reason} |`,
            )
          })
        }
        if (result.baselines.length > 0) {
          lines.push('', '### Baselines used')
          lines.push('| Metric | Mean | Stddev | Source |')
          lines.push('|--------|------|--------|--------|')
          for (const b of result.baselines) {
            lines.push(`| \`${b.metric}\` | ${b.mean.toFixed(3)} | ${b.stddev.toFixed(3)} | ${b.source} |`)
          }
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Anomaly check error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  // ── corn_token_count (S7.8) ───────────────────────────
  server.tool(
    'corn_token_count',
    'Estimate BPE token count for a text blob. Heuristic = chars/4 with CJK 1.5× multiplier. LLM mode asks a model to count (fallback for non-English or provider-specific tokenizers). Returns an integer and the method used.',
    {
      text: z.string().describe('Text to count tokens for.'),
      model: z
        .string()
        .optional()
        .describe('Target provider model (e.g. "gpt-4o-mini"). Optional — echoed back in the result.'),
    },
    async ({ text, model }) => {
      try {
        const { result, metadata } = await runTask<TokenCountInput, TokenCountResult>(
          TOKEN_COUNT_TASK_NAME,
          { text, model },
          env,
        )
        const fallback = metadata.fellBack ? ` · fallback (${metadata.llmError ?? 'llm error'})` : ''
        const engine = metadata.engineUsed === 'llm' ? '🤖 LLM' : '⚙️ Heuristic'
        const modelLine = result.model ? `\nTarget model: \`${result.model}\`` : ''
        return {
          content: [
            {
              type: 'text' as const,
              text: `🔢 **Token Count** (${engine}${fallback}): **${result.tokens}** tokens${modelLine}\nMethod: ${result.method}`,
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Token count error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    },
  )

  // ── corn_chat (S7.10) ─────────────────────────────────
  server.tool(
    'corn_chat',
    'Free-form chat completion via the configured LLM provider. Single-turn or short multi-turn, non-streaming. REQUIRES the chat_assistant task to have engine=llm in admin UI — heuristic mode returns guidance. Cost + usage are surfaced per call.',
    {
      messages: z
        .array(
          z.object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().min(1),
          }),
        )
        .min(1)
        .describe('Messages array. At least one message required.'),
      systemPrompt: z
        .string()
        .optional()
        .describe('Optional system prompt prepended when no system message is present.'),
    },
    async ({ messages, systemPrompt }) => {
      try {
        const { result, metadata } = await runTask<ChatInput, ChatResult>(
          CHAT_ASSISTANT_TASK_NAME,
          { messages, systemPrompt },
          env,
        )
        const cached = result.cached ? ' (cached)' : ''
        const engine = metadata.engineUsed === 'llm' ? '🤖 LLM' : '⚙️ Heuristic'
        const usage = `tokens: ${result.inputTokens} in / ${result.outputTokens} out · cost: $${result.costUsd.toFixed(5)}${cached}`
        return {
          content: [
            {
              type: 'text' as const,
              text: `💬 **Chat** (${engine}, ${result.model})\n${usage}\n\n---\n\n${result.content}`,
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Chat error: ${error instanceof Error ? error.message : 'Unknown'}`,
            },
          ],
          isError: true,
        }
      }
    },
  )
}
