/**
 * Tool: literature_fulltext_read — read ONE bounded chunk by seq. Token-safe
 * by construction: the tool returns at most one chunk (maxChunkChars).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { readChunk } from '../fetch/fulltext.js'

export interface FulltextReadInput {
  paperId: string
  seq: number
  pushId?: number
}

export interface FulltextReadOutput {
  paperId: string
  seq: number
  found: boolean
  section?: string
  charStart?: number
  charEnd?: number
  content?: string
}

export function defineLiteratureFulltextRead(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_fulltext_read',
    description:
      '按 seq 读取论文的一个分块（有界文本，不会返回整篇）。配合 literature_fulltext_index 使用。',
    parameters: {
      paperId: { type: 'string', required: true, description: '论文 id' },
      seq: { type: 'integer', required: true, description: '分块序号（来自索引）' },
      pushId: { type: 'integer', description: '推送号；提供时自动记录本次阅读（fulltext_reads，供完成前覆盖率校验）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paperId: { type: 'string', required: true },
          seq: { type: 'integer', required: true },
          found: { type: 'boolean', required: true },
          section: { type: 'string' },
          charStart: { type: 'integer' },
          charEnd: { type: 'integer' },
          content: { type: 'string' },
        },
      },
      render: (_args, value: FulltextReadOutput) => [
        {
          type: 'text',
          text: value.found
            ? `[chunk ${value.seq} | ${value.section} | chars ${value.charStart}-${value.charEnd}]\n${value.content}`
            : `chunk ${value.seq} 不存在（先运行 literature_fulltext_index）`,
        },
      ],
    },
    async execute(args: FulltextReadInput): Promise<FulltextReadOutput> {
      const rt = getRt()
      const t0 = performance.now()
      const chunk = readChunk(rt.db, args.paperId, args.seq)
      if (!chunk) {
        return { paperId: args.paperId, seq: args.seq, found: false }
      }
      if (args.pushId !== undefined) {
        rt.perf.add(args.pushId, { fulltextReadMs: performance.now() - t0 })
      }
      if (args.pushId !== undefined) {
        rt.db
          .prepare('INSERT INTO fulltext_reads (push_id, paper_id, seq) VALUES (?, ?, ?)')
          .run(args.pushId, args.paperId, args.seq)
      }
      return {
        paperId: args.paperId,
        seq: chunk.seq,
        found: true,
        section: chunk.section,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        content: chunk.content,
      }
    },
  })
}
