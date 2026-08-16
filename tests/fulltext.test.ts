import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/fetch/fulltext.js'

describe('chunkText', () => {
  it('splits long text into bounded chunks', () => {
    const text = 'word '.repeat(2000) // ~10k chars, max 6000
    const chunks = chunkText(text, 6000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(6000)
      expect(c.content.length).toBeGreaterThan(0)
    }
    // offsets are monotone and non-overlapping
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.charStart).toBeGreaterThanOrEqual(chunks[i - 1]!.charEnd)
    }
  })

  it('starts a new chunk at a heading line', () => {
    const text = 'Intro paragraph here.\nIntroduction\nThis is the intro body.\nMethods\nBody of methods.'
    const chunks = chunkText(text, 6000)
    const sections = chunks.map((c) => c.content)
    expect(sections.some((s) => s.startsWith('Introduction'))).toBe(true)
    expect(sections.some((s) => s.startsWith('Methods'))).toBe(true)
  })

  it('handles empty text', () => {
    expect(chunkText('', 100)).toEqual([])
  })
})
