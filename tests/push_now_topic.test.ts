import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.js'
import { createRuntime } from '../src/lib/runtime.js'
import { defineLiteraturePushNow } from '../src/tools/literature_push_now.js'

async function run<T>(tool: { execute: (args: never) => Promise<T> }, args: unknown): Promise<T> {
  return tool.execute(args as never)
}

describe('literature_push_now topic selection', () => {
  it('requires a topic for the first push, then reuses the latest custom topic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-topic-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    const tool = defineLiteraturePushNow(() => rt, () => null)
    try {
      await expect(run(tool, {})).rejects.toThrow(/INVALID_ARGUMENT/)

      const first = await run(tool, { topic: '契约分层' })
      expect(first.topicDisplayName).toBe('契约分层')

      const reused = await run(tool, {})
      expect(reused.topicDisplayName).toBe('契约分层')

      const switched = await run(tool, { topic: '机器人控制' })
      expect(switched.topicDisplayName).toBe('机器人控制')
    } finally {
      rt.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
