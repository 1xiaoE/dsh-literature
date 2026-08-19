import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.js'
import { createRuntime } from '../src/lib/runtime.js'
import { importLocalPdf } from '../src/lib/library_import.js'
import { runDeepRead, startDeepRead } from '../src/lib/deep_read.js'
import { listPapers } from '../src/ui/adapter.js'

function pdf(text: string): Buffer {
  // A compact valid PDF accepted by pdftotext; the text is deliberately long
  // enough for the existing fulltext minimum when deep reading is exercised.
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n%%EOF\n`
  return Buffer.concat([Buffer.from(body, 'latin1'), Buffer.alloc(12 * 1024, 0x20)])
}

describe('local PDF import', () => {
  it('validates, stores by SHA256, classifies, and stays unread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-import-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    try {
      const result = await importLocalPdf(rt, {
        filename: '../../quadruped.pdf',
        mimeType: 'application/pdf',
        bytes: pdf(`Learning Robust Quadruped Locomotion\nJane Doe\nAbstract\n${'robot control reinforcement learning '.repeat(20)}\nDOI: 10.1000/local-test`),
        enrich: false,
      })
      expect(result.duplicateDetected).toBe(false)
      expect(result.pdfAttached).toBe(true)
      expect(result.readStatus).toBe('unread')
      expect(result.paperId).toBe('doi:10.1000/local-test')
      expect(existsSync(join(dir, 'pdfs', `${result.sha256}.pdf`))).toBe(true)
      expect(listPapers(rt.db, { category: 'to-read' }).map((p) => p.id)).toContain(result.paperId)
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM fulltext_reads WHERE paper_id = ?').get(result.paperId)).toEqual({ n: 0 })
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM candidates WHERE paper_id = ?').get(result.paperId)).toEqual({ n: 0 })
    } finally {
      rt.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deduplicates the exact PDF before creating a second paper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-import-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    try {
      const input = { filename: 'paper.pdf', mimeType: 'application/pdf', bytes: pdf(`A Local Paper\nAbstract\n${'control '.repeat(50)}`), enrich: false }
      const first = await importLocalPdf(rt, input)
      const duplicate = await importLocalPdf(rt, input)
      expect(duplicate.duplicateDetected).toBe(true)
      expect(duplicate.paperId).toBe(first.paperId)
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM papers').get()).toEqual({ n: 1 })
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM fetch_log').get()).toEqual({ n: 1 })
    } finally {
      rt.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('duplicate import reports the paper truthfully read/report status, never fixed unread/none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-import-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    try {
      const input = { filename: 'read.pdf', mimeType: 'application/pdf', bytes: pdf(`Read Again\nAbstract\n${'full text '.repeat(60)}`), enrich: false }
      const imported = await importLocalPdf(rt, input)
      expect(imported.readStatus).toBe('unread')
      expect(imported.reportStatus).toBe('none')
      // Simulate a completed deep read on the existing paper.
      rt.db.prepare("INSERT INTO fulltexts (paper_id,status,parser,char_count,chunk_count) VALUES (?, 'ok','test',500,2)").run(imported.paperId)
      rt.db.prepare('INSERT INTO fulltext_chunks (paper_id,seq,section,char_start,char_end,content) VALUES (?,0,?,0,250,?)').run(imported.paperId, 'Abstract', 'evidence')
      rt.db.prepare('INSERT INTO fulltext_chunks (paper_id,seq,section,char_start,char_end,content) VALUES (?,1,?,250,500,?)').run(imported.paperId, 'Method', 'evidence')
      await runDeepRead(rt, imported.paperId)
      // Re-importing the same bytes must reflect the real read/report state.
      const duplicate = await importLocalPdf(rt, input)
      expect(duplicate.duplicateDetected).toBe(true)
      expect(duplicate.readStatus).toBe('read')
      expect(duplicate.reportStatus).toBe('available')
    } finally {
      rt.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not mark a paper enriched when the provider lookup fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-import-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    try {
      // enrich: true with a registry that cannot resolve anything — the import
      // must remain valid but the enriched flag must stay false.
      Object.assign(rt, {
        registry: {
          lookupMetadata: async () => { throw new Error('provider unavailable') },
        },
      })
      const result = await importLocalPdf(rt, {
        filename: 'unresolvable.pdf', mimeType: 'application/pdf',
        bytes: pdf(`Unresolvable Local Paper\nAbstract\n${'unknown topic words '.repeat(20)}`),
        enrich: true,
      })
      expect(result.metadataStatus.enriched).toBe(false)
      const row = rt.db.prepare('SELECT metadata_enriched_at FROM papers WHERE id = ?').get(result.paperId) as { metadata_enriched_at: string | null }
      expect(row.metadata_enriched_at).toBeNull()
      expect(result.metadataStatus.complete).toBe(false) // no authors parsed yet
    } finally {
      rt.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a serialized empty author array as missing authors (metadata incomplete)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-import-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    try {
      rt.db.prepare(
        `INSERT INTO papers (id,title,authors,venue,year,doi,metadata_source)
         VALUES ('paper:no-authors','Title Only','[]','Venue',2026,NULL,'test')`,
      ).run()
      const duplicate = await importLocalPdf(rt, {
        filename: 'no-authors.pdf', mimeType: 'application/pdf',
        bytes: pdf(`Title Only\nAbstract\n${'text '.repeat(30)}`),
        enrich: false,
      })
      // "[]" is not an author list: metadata must be reported incomplete and
      // the enriched flag must be false.
      expect(duplicate.metadataStatus.complete).toBe(false)
      expect(duplicate.metadataStatus.enriched).toBe(false)
    } finally {
      rt.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects non-PDF bytes before SQLite or managed storage writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-import-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    try {
      await expect(importLocalPdf(rt, { filename: 'not.pdf', mimeType: 'application/pdf', bytes: Buffer.from('not a pdf') })).rejects.toThrow('INVALID_PDF')
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM papers').get()).toEqual({ n: 0 })
    } finally {
      rt.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deep reads the existing PDF without creating a push, ranking, or acquisition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-import-'))
    const rt = createRuntime(normalizeConfig({ dataDir: dir }))
    try {
      const imported = await importLocalPdf(rt, { filename: 'read.pdf', mimeType: 'application/pdf', bytes: pdf(`Read Me\nAbstract\n${'full text '.repeat(60)}`), enrich: false })
      rt.db.prepare("INSERT INTO fulltexts (paper_id,status,parser,char_count,chunk_count) VALUES (?, 'ok','test',500,2)").run(imported.paperId)
      rt.db.prepare('INSERT INTO fulltext_chunks (paper_id,seq,section,char_start,char_end,content) VALUES (?,0,?,0,250,?)').run(imported.paperId, 'Abstract', 'evidence')
      rt.db.prepare('INSERT INTO fulltext_chunks (paper_id,seq,section,char_start,char_end,content) VALUES (?,1,?,250,500,?)').run(imported.paperId, 'Method', 'evidence')
      await runDeepRead(rt, imported.paperId)
      expect(rt.db.prepare('SELECT status, read_chunks, total_chunks FROM paper_reading_jobs WHERE paper_id=?').get(imported.paperId)).toEqual({ status: 'completed', read_chunks: 2, total_chunks: 2 })
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE paper_id=?').get(imported.paperId)).toEqual({ n: 1 })
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM pushes').get()).toEqual({ n: 0 })
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM candidates').get()).toEqual({ n: 0 })
      expect(rt.db.prepare('SELECT COUNT(*) AS n FROM retrievals').get()).toEqual({ n: 0 })
      expect(startDeepRead(rt, imported.paperId)).toEqual({ started: false, errorCode: 'ALREADY_COMPLETE' })
    } finally {
      rt.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
