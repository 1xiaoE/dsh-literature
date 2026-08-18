/** Explicit reading of an already-library-owned PDF.  This is intentionally
 * pushless: it reuses fulltext indexing/chunks/reads/report storage without
 * touching retrieval, ranking, quality gates, or acquisition. */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { getPaper } from '../db.js'
import { getIndex, indexFulltext, readChunk } from '../fetch/fulltext.js'
import { writeReportAtomic } from './report.js'
import type { LiteratureRuntime } from './runtime.js'
import { resolveLibraryRoot } from './paths.js'

function pdfPathOf(rt: LiteratureRuntime, paperId: string): string | null {
  const rows = rt.db.prepare(
    "SELECT pdf_path FROM fetch_log WHERE paper_id = ? AND outcome IN ('ok','PDF_OK') AND pdf_path IS NOT NULL ORDER BY id DESC",
  ).all(paperId) as Array<{ pdf_path: string | null }>
  return rows.map((row) => row.pdf_path).find((path) => {
    try { return path !== null && statSync(path).isFile() && statSync(path).size > 0 } catch { return false }
  }) ?? null
}

function safeReportName(title: string, paperId: string): string {
  const stem = title.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 72) || paperId.replace(/[^\w-]+/g, '_')
  const identity = createHash('sha256').update(paperId).digest('hex').slice(0, 12)
  return `${stem}_${identity}_deep_read.md`
}

export function readingState(rt: LiteratureRuntime, paperId: string): { status: string | null; readChunks: number; totalChunks: number } {
  const job = rt.db.prepare('SELECT status, read_chunks, total_chunks FROM paper_reading_jobs WHERE paper_id = ?').get(paperId) as
    | { status: string; read_chunks: number; total_chunks: number } | undefined
  if (job) return { status: job.status, readChunks: job.read_chunks, totalChunks: job.total_chunks }
  const index = getIndex(rt.db, paperId)
  const read = rt.db.prepare('SELECT COUNT(DISTINCT seq) AS n FROM fulltext_reads WHERE paper_id = ?').get(paperId) as { n: number }
  return { status: null, readChunks: read.n, totalChunks: index?.chunks.length ?? 0 }
}

export function startDeepRead(rt: LiteratureRuntime, paperId: string): { started: boolean; errorCode?: 'PAPER_NOT_FOUND' | 'PDF_NOT_AVAILABLE' | 'ALREADY_RUNNING' | 'ALREADY_COMPLETE' } {
  if (!getPaper(rt.db, paperId)) return { started: false, errorCode: 'PAPER_NOT_FOUND' }
  if (!pdfPathOf(rt, paperId)) return { started: false, errorCode: 'PDF_NOT_AVAILABLE' }
  const current = readingState(rt, paperId)
  if (current.status === 'running') return { started: false, errorCode: 'ALREADY_RUNNING' }
  if (current.totalChunks > 0 && current.readChunks / current.totalChunks >= rt.cfg.fulltext.minReadCoverage) return { started: false, errorCode: 'ALREADY_COMPLETE' }
  rt.db.prepare(
    `INSERT INTO paper_reading_jobs (paper_id,status,read_chunks,total_chunks,error_detail,started_at,finished_at,updated_at)
     VALUES (?, 'running', 0, 0, NULL, datetime('now'), NULL, datetime('now'))
     ON CONFLICT(paper_id) DO UPDATE SET status='running', read_chunks=0, total_chunks=0, error_detail=NULL,
       started_at=datetime('now'), finished_at=NULL, updated_at=datetime('now')`,
  ).run(paperId)
  void runDeepRead(rt, paperId)
  return { started: true }
}

/** Exported for deterministic tests and command-side callers. */
export async function runDeepRead(rt: LiteratureRuntime, paperId: string): Promise<void> {
  rt.db.prepare(
    `INSERT INTO paper_reading_jobs (paper_id,status,read_chunks,total_chunks,started_at,updated_at)
     VALUES (?, 'running', 0, 0, datetime('now'), datetime('now'))
     ON CONFLICT(paper_id) DO NOTHING`,
  ).run(paperId)
  try {
    const paper = getPaper(rt.db, paperId)
    const pdfPath = pdfPathOf(rt, paperId)
    if (!paper || !pdfPath) throw new Error('PDF_NOT_AVAILABLE')
    let index = getIndex(rt.db, paperId)
    if (!index || index.status !== 'ok') {
      index = await indexFulltext(rt.db, paperId, pdfPath, {
        maxChunkChars: rt.cfg.fulltext.maxChunkChars,
        minChars: rt.cfg.fulltext.minChars,
        parserCommand: rt.cfg.fulltext.parserCommand,
      })
    }
    if (index.status !== 'ok' || index.chunks.length === 0) throw new Error('FULLTEXT_UNAVAILABLE')
    const total = index.chunks.length
    const insertRead = rt.db.prepare('INSERT INTO fulltext_reads (push_id,paper_id,seq) SELECT NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM fulltext_reads WHERE paper_id = ? AND seq = ?)')
    const excerpts: string[] = []
    for (const chunk of index.chunks) {
      // Read the same bounded chunk representation exposed by the existing
      // pipeline before writing its durable read-log entry.
      const content = readChunk(rt.db, paperId, chunk.seq)
      if (!content) throw new Error(`FULLTEXT_CHUNK_MISSING:${chunk.seq}`)
      excerpts.push(`### ${chunk.seq + 1}. ${content.section}\n\n${content.content.replace(/\s+/g, ' ').slice(0, 360)}${content.content.length > 360 ? '…' : ''}`)
      insertRead.run(paperId, chunk.seq, paperId, chunk.seq)
      const read = rt.db.prepare('SELECT COUNT(DISTINCT seq) AS n FROM fulltext_reads WHERE paper_id = ?').get(paperId) as { n: number }
      rt.db.prepare("UPDATE paper_reading_jobs SET read_chunks=?, total_chunks=?, updated_at=datetime('now') WHERE paper_id=?").run(read.n, total, paperId)
    }
    const content = [
      `# Deep Read: ${paper.title}`,
      '',
      '## Reading record',
      `- Source: existing managed PDF (${basename(pdfPath)})`,
      `- Fulltext chunks read: ${total}/${total}`,
      '- This canonical report is an extract-backed reading record. It does not invent ranking, acquisition, or model-generated claims.',
      '',
      '## Chunk index',
      ...excerpts,
      '',
    ].join('\n')
    const reportPath = await writeReportAtomic(resolveLibraryRoot(rt.cfg), 'Imported Papers', safeReportName(paper.title, paperId), content)
    rt.db.prepare(
      `INSERT INTO reports (paper_id,report_path,source,created_at,updated_at)
       VALUES (?, ?, 'deep_read', datetime('now'), datetime('now'))
       ON CONFLICT(paper_id) DO UPDATE SET report_path=excluded.report_path,source='deep_read',updated_at=excluded.updated_at`,
    ).run(paperId, reportPath)
    rt.db.prepare("UPDATE paper_reading_jobs SET status='completed', read_chunks=?, total_chunks=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE paper_id=?").run(total, total, paperId)
  } catch (error) {
    rt.db.prepare("UPDATE paper_reading_jobs SET status='failed', error_detail=?, finished_at=datetime('now'), updated_at=datetime('now') WHERE paper_id=?").run(String(error instanceof Error ? error.message : error), paperId)
  }
}
