/**
 * Tool: literature_fulltext_index — extract a PDF to text (pdftotext),
 * chunk it into bounded sections stored in SQLite, and return the section
 * index. The agent must read chunks via literature_fulltext_read, never a
 * whole paper in one context.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { getIndex, indexFulltext, type FulltextIndex } from '../fetch/fulltext.js'

export interface FulltextIndexInput {
  paperId: string
}

export type FulltextIndexOutput = FulltextIndex

export function defineLiteratureFulltextIndex(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_fulltext_index',
    description:
      '将论文 PDF 解析为分块纯文本并返回章节/分块索引。请勿一次性读取全文——先取索引，再用 literature_fulltext_read 按 seq 分块阅读。',
    parameters: {
      paperId: { type: 'string', required: true, description: '论文 id（需先 literature_fetch_pdf 成功）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paperId: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['ok', 'unavailable'] },
          parser: { type: 'string', required: true },
          charCount: { type: 'integer', required: true },
          chunks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                section: { type: 'string', required: true },
                charStart: { type: 'integer', required: true },
                charEnd: { type: 'integer', required: true },
                preview: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: FulltextIndexOutput) => [
        {
          type: 'text',
          text:
            value.status === 'ok'
              ? `全文已分块：${value.charCount} 字符，${value.chunks.length} 块（parser: ${value.parser}）。用 literature_fulltext_read 按 seq 阅读。`
              : `FULLTEXT_UNAVAILABLE：解析文本过短或为空（parser: ${value.parser}）。禁止凭摘要伪装全文精读。`,
        },
      ],
    },
    async execute(args: FulltextIndexInput): Promise<FulltextIndexOutput> {
      const rt = getRt()
      const existing = getIndex(rt.db, args.paperId)
      if (existing) return existing

      const fetchRow = rt.db
        .prepare(
          `SELECT pdf_path FROM fetch_log
           WHERE paper_id = ? AND outcome = 'ok' ORDER BY id DESC LIMIT 1`,
        )
        .get(args.paperId) as { pdf_path: string | null } | undefined

      if (!fetchRow?.pdf_path) {
        // provenance: record the unavailable outcome explicitly
        rt.db.prepare(
          `INSERT INTO fulltexts (paper_id, status, parser, char_count, chunk_count)
           VALUES (?, 'unavailable', 'none', 0, 0)
           ON CONFLICT(paper_id) DO UPDATE SET status='unavailable', parser='none',
             char_count=0, chunk_count=0, analyzed_at=datetime('now')`,
        ).run(args.paperId)
        return {
          paperId: args.paperId,
          status: 'unavailable',
          parser: 'none',
          charCount: 0,
          chunks: [],
        }
      }
      return indexFulltext(rt.db, args.paperId, fetchRow.pdf_path, {
        maxChunkChars: rt.cfg.fulltext.maxChunkChars,
        minChars: rt.cfg.fulltext.minChars,
        parserCommand: rt.cfg.fulltext.parserCommand,
      })
    },
  })
}
