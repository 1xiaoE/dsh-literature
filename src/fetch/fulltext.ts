/**
 * Full-text extraction and chunking. The agent NEVER receives the whole
 * paper at once: pdftotext output is split into bounded chunks (headings
 * start new chunks), stored in SQLite, and read back one chunk at a time
 * via literature_fulltext_index / literature_fulltext_read.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Db } from '../db.js'

const execFileAsync = promisify(execFile)

export interface Chunk {
  seq: number
  section: string
  charStart: number
  charEnd: number
  content: string
}

export interface FulltextIndex {
  paperId: string
  status: 'ok' | 'unavailable'
  parser: string
  charCount: number
  chunks: Array<Omit<Chunk, 'content'> & { preview: string }>
}

const HEADING_RE =
  /^\s*(?:\d+(?:\.\d+)*\s+[A-Za-z\u4e00-\u9fff]|Abstract|Introduction|Background|Related Work|Methods?|Approach|Framework|Experiments?|Experimental (?:Setup|Results|Evaluation)|Results|Discussion|Conclusion|Conclusions|Limitations|References|Acknowledgments?)\b/i

/**
 * Split extracted text into bounded chunks. A line that looks like a section
 * heading starts a new chunk; otherwise chunks grow up to maxChars and
 * over-long single lines are hard-split at word boundaries. Offsets are
 * cursor-accumulated (monotone, non-overlapping coverage). Pure function.
 */
export function chunkText(text: string, maxChars: number): Chunk[] {
  const lines = text.split('\n')
  const chunks: Chunk[] = []
  let cur: string[] = []
  let curChars = 0
  let cursor = 0

  const flush = (): void => {
    if (cur.length === 0) return
    const content = cur.join('\n')
    chunks.push({
      seq: chunks.length,
      section: `chunk-${String(chunks.length).padStart(4, '0')}`,
      charStart: cursor,
      charEnd: cursor + content.length,
      content,
    })
    cursor += content.length
    cur = []
    curChars = 0
  }

  /** Append a line, splitting it when it exceeds the remaining room. */
  const pushLine = (line: string): void => {
    let rest = line
    while (rest.length > 0) {
      const sep = cur.length > 0 ? 1 : 0
      if (curChars + sep + rest.length <= maxChars) {
        cur.push(rest)
        curChars += sep + rest.length
        rest = ''
        break
      }
      const room = maxChars - curChars - sep
      if (room <= 0) {
        flush()
        continue
      }
      // prefer a word boundary inside the room
      let cut = room
      const space = rest.lastIndexOf(' ', Math.min(room, rest.length - 1))
      if (space > Math.floor(room / 2)) cut = space
      const slice = rest.slice(0, cut)
      cur.push(slice)
      curChars += sep + slice.length
      rest = rest.slice(cut)
      flush()
    }
  }

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (HEADING_RE.test(raw) && trimmed.length < 120) {
      if (cur.length > 0) flush()
      pushLine(trimmed)
      continue
    }
    pushLine(raw)
  }
  flush()
  return chunks
}

/** Run the configured parser over a PDF; returns raw text. */
export async function extractPdfText(
  pdfPath: string,
  parserCommand = 'pdftotext',
): Promise<{ text: string; parser: string }> {
  const { stdout, stderr } = await execFileAsync(parserCommand, ['-layout', pdfPath, '-'], {
    maxBuffer: 64 * 1024 * 1024,
  })
  const versionMatch = stderr.match(/version\s+([\d.]+)/i)
  const parser = versionMatch ? `pdftotext ${versionMatch[1]}` : parserCommand
  return { text: stdout, parser }
}

/**
 * Extract + chunk a PDF, store chunks and fulltexts row, and return the index.
 * A text shorter than minChars is recorded as status 'unavailable'.
 */
export async function indexFulltext(
  db: Db,
  paperId: string,
  pdfPath: string,
  opts: { maxChunkChars?: number; minChars?: number; parserCommand?: string } = {},
): Promise<FulltextIndex> {
  const maxChars = opts.maxChunkChars ?? 6000
  const minChars = opts.minChars ?? 200
  const { text, parser } = await extractPdfText(pdfPath, opts.parserCommand ?? 'pdftotext')

  if (text.replace(/\s+/g, '').length < minChars) {
    db.prepare(
      `INSERT INTO fulltexts (paper_id, status, parser, char_count, chunk_count)
       VALUES (?, 'unavailable', ?, ?, 0)
       ON CONFLICT(paper_id) DO UPDATE SET status='unavailable', parser=excluded.parser,
         char_count=excluded.char_count, chunk_count=0, analyzed_at=datetime('now')`,
    ).run(paperId, parser, text.length)
    return { paperId, status: 'unavailable', parser, charCount: text.length, chunks: [] }
  }

  const chunks = chunkText(text, maxChars)
  db.prepare('DELETE FROM fulltext_chunks WHERE paper_id = ?').run(paperId)
  const insert = db.prepare(
    'INSERT INTO fulltext_chunks (paper_id, seq, section, char_start, char_end, content) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const c of chunks) {
    insert.run(paperId, c.seq, c.section, c.charStart, c.charEnd, c.content)
  }
  db.prepare(
    `INSERT INTO fulltexts (paper_id, status, parser, char_count, chunk_count)
     VALUES (?, 'ok', ?, ?, ?)
     ON CONFLICT(paper_id) DO UPDATE SET status='ok', parser=excluded.parser,
       char_count=excluded.char_count, chunk_count=excluded.chunk_count, analyzed_at=datetime('now')`,
  ).run(paperId, parser, text.length, chunks.length)

  return {
    paperId,
    status: 'ok',
    parser,
    charCount: text.length,
    chunks: chunks.map((c) => ({
      seq: c.seq,
      section: c.section,
      charStart: c.charStart,
      charEnd: c.charEnd,
      preview: c.content.slice(0, 120),
    })),
  }
}

/** Existing fulltext index for a paper, if any. */
export function getIndex(db: Db, paperId: string): FulltextIndex | undefined {
  const row = db
    .prepare('SELECT status, parser, char_count, chunk_count FROM fulltexts WHERE paper_id = ?')
    .get(paperId) as
    | { status: 'ok' | 'unavailable'; parser: string | null; char_count: number | null }
    | undefined
  if (!row) return undefined
  const chunks = db
    .prepare('SELECT seq, section, char_start, char_end FROM fulltext_chunks WHERE paper_id = ? ORDER BY seq')
    .all(paperId) as Array<{ seq: number; section: string | null; char_start: number; char_end: number }>
  return {
    paperId,
    status: row.status,
    parser: row.parser ?? 'unknown',
    charCount: row.char_count ?? 0,
    chunks: chunks.map((c) => ({
      seq: c.seq,
      section: c.section ?? `chunk-${String(c.seq).padStart(4, '0')}`,
      charStart: c.char_start,
      charEnd: c.char_end,
      preview: '',
    })),
  }
}

/** Read one bounded chunk by seq. */
export function readChunk(db: Db, paperId: string, seq: number): Chunk | undefined {
  const row = db
    .prepare(
      'SELECT seq, section, char_start, char_end, content FROM fulltext_chunks WHERE paper_id = ? AND seq = ?',
    )
    .get(paperId, seq) as
    | { seq: number; section: string | null; char_start: number; char_end: number; content: string }
    | undefined
  if (!row) return undefined
  return {
    seq: row.seq,
    section: row.section ?? `chunk-${String(row.seq).padStart(4, '0')}`,
    charStart: row.char_start,
    charEnd: row.char_end,
    content: row.content,
  }
}
