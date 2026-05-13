import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  detectCharsPerToken,
  estimateTokenCount,
  estimateComputeTokens,
  estimateTokensSaved,
} from './estimate.js'

describe('detectCharsPerToken', () => {
  test('empty string falls back to default ratio (4)', () => {
    assert.equal(detectCharsPerToken(''), 4)
  })

  test('plain English / markdown uses 4 chars/token', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(8)
    assert.equal(detectCharsPerToken(text), 4)
  })

  test('Vietnamese diacritics drop the ratio to 2.8', () => {
    // Plenty of tones + ô/ă/đ → diacritic share > 5%.
    const text = 'Xin chào, hôm nay là một ngày đẹp trời ở Hà Nội với những đám mây trắng bồng bềnh.'
    assert.equal(detectCharsPerToken(text), 2.8)
  })

  test('CJK ideographs drop the ratio to 2', () => {
    const text = '今天天气很好，我们一起去公园散步吧。这里的风景非常美丽。'
    assert.equal(detectCharsPerToken(text), 2)
  })

  test('JSON-heavy payload drops the ratio to 3.5', () => {
    const text = JSON.stringify({
      tool: 'corn_code_search',
      params: { query: 'hello world', limit: 5, filters: ['ts', 'js', 'tsx'] },
      meta: { branch: 'main', projectId: 'proj-abc' },
    })
    // Confirm fixture really is JSON-heavy + long enough to hit the >=50 char gate.
    assert.ok(text.length >= 50)
    assert.equal(detectCharsPerToken(text), 3.5)
  })

  test('short string skips JSON branch even if punctuation-heavy', () => {
    // Length < 50 → JSON heuristic does not fire, default applies.
    assert.equal(detectCharsPerToken('{"a":1}'), 4)
  })

  test('CJK wins over Vietnamese when both share is high', () => {
    const text = '你好世界 — xin chào — 今日は'
    assert.equal(detectCharsPerToken(text), 2)
  })
})

describe('estimateTokenCount', () => {
  test('empty input → 0 tokens', () => {
    assert.equal(estimateTokenCount(''), 0)
  })

  test('200 English chars → ~50 tokens (range 40-60)', () => {
    const text = 'a'.repeat(200)
    const tokens = estimateTokenCount(text)
    assert.ok(tokens >= 40 && tokens <= 60, `expected 40-60, got ${tokens}`)
  })

  test('Vietnamese-with-diacritics 200 chars → 60-90 tokens', () => {
    // Build a 200-char string dominated by Vietnamese diacritics.
    const seed = 'Hôm nay tôi học lập trình tại Hà Nội với những người bạn thân thiết. '
    let text = ''
    while (text.length < 200) text += seed
    text = text.slice(0, 200)
    const tokens = estimateTokenCount(text)
    assert.ok(tokens >= 60 && tokens <= 90, `expected 60-90, got ${tokens}`)
  })

  test('JSON 500 chars → 120-160 tokens', () => {
    let text = JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i, name: 'item-' + i, ok: true })) })
    // Pad up to ~500 chars while keeping JSON-ish shape.
    while (text.length < 500) text = text.slice(0, -1) + ',"x":"y"}'
    text = text.slice(0, 500)
    const tokens = estimateTokenCount(text)
    assert.ok(tokens >= 120 && tokens <= 160, `expected 120-160, got ${tokens}`)
  })
})

describe('estimateComputeTokens', () => {
  test('empty input and output → 0', () => {
    assert.equal(estimateComputeTokens('', ''), 0)
  })

  test('each side is counted with its own ratio', () => {
    const inputEn = 'a'.repeat(40)
    const outputCjk = '你'.repeat(40)
    // English side ~ 10 tokens, CJK side ~ 20 tokens → ~ 30 total.
    const tokens = estimateComputeTokens(inputEn, outputCjk)
    assert.equal(tokens, 30)
  })
})

describe('estimateTokensSaved', () => {
  const filler = 'a'.repeat(2000) // 2KB English filler — well over MIN_SAVED_OUTPUT_CHARS

  test('unknown tool → 0 saved', () => {
    assert.equal(estimateTokensSaved('not_a_corn_tool', filler), 0)
  })

  test('tool present in map but output below MIN_SAVED_OUTPUT_CHARS → 0', () => {
    const tiny = '{"hits":[]}'
    assert.equal(estimateTokensSaved('corn_code_search', tiny), 0)
  })

  test('corn_code_search with non-empty output → > 0', () => {
    const saved = estimateTokensSaved('corn_code_search', filler)
    assert.ok(saved > 0, `expected > 0, got ${saved}`)
  })

  test('new multiplier corn_memory_store yields a positive saved value', () => {
    const saved = estimateTokensSaved('corn_memory_store', filler)
    assert.ok(saved > 0, `expected corn_memory_store saved > 0, got ${saved}`)
  })

  test('corn_session_start multiplier (=2) applies', () => {
    const saved = estimateTokensSaved('corn_session_start', filler)
    const outputTokens = estimateTokenCount(filler)
    // multiplier 2 → saved factor = m - 1 = 1 → exactly outputTokens.
    assert.equal(saved, outputTokens)
  })

  test('cap: saved never exceeds outputTokens × MAX_SAVED_RATIO (10)', () => {
    // Even if we somehow registered a 9999 multiplier, the cap should clamp it.
    // We can not easily mutate SAVED_MULTIPLIER from outside, so we instead
    // exercise the public top multiplier (5 → ratio 4) and assert ratio ≤ 10.
    const saved = estimateTokensSaved('corn_code_search', filler)
    const outputTokens = estimateTokenCount(filler)
    assert.ok(saved <= outputTokens * 10, `cap violated: saved=${saved} outputTokens=${outputTokens}`)
  })

  test('empty output → 0 saved (guard)', () => {
    assert.equal(estimateTokensSaved('corn_code_search', ''), 0)
  })
})
