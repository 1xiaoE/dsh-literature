/**
 * RunnerService — one place that owns the Web UI → child-process lifecycle.
 *
 * Every Run / Resume goes through this service: it spawns the existing CLI
 * workflow runner, captures stdout/stderr to <dataDir>/runs/runner-*.log,
 * persists a `runner_jobs` row (runId / kind / pushId / pid / status /
 * started / heartbeat / exitCode / logPath), and detects immediate crashes so
 * the UI sees the real error instead of a silent "started". The Execution
 * panel no longer has to guess which phase the workflow is in from retrieval
 * rows — it can read the live job row.
 *
 * The workflow itself is never re-implemented: the CLI
 * (bin/dsh-literature-push.mjs → selected Harness profile) stays the single
 * executor.
 */
import { spawn, type StdioOptions } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db.js'
import { classifyWorkflowError, failureFor, redactSensitiveText, type WorkflowErrorCode } from './workflow_errors.js'

export type RunnerKind = 'push' | 'resume'
export type RunnerStatus = 'running' | 'exited' | 'failed'

export interface RunnerJob {
  runId: number
  kind: RunnerKind
  pushId: number | null
  pid: number | null
  status: RunnerStatus
  startedAt: string
  heartbeatAt: string
  finishedAt: string | null
  exitCode: number | null
  logPath: string | null
  message: string | null
  errorCode: WorkflowErrorCode | null
  retryable: boolean | null
  provider: string | null
  model: string | null
}

export interface RunnerJobRecord {
  run_id: number
  kind: RunnerKind
  push_id: number | null
  pid: number | null
  status: RunnerStatus
  started_at: string
  heartbeat_at: string
  finished_at: string | null
  exit_code: number | null
  log_path: string | null
  message: string | null
  error_code: WorkflowErrorCode | null
  retryable: number | null
  provider: string | null
  model: string | null
}

export interface RunOutcome {
  ok: boolean
  runId: number | null
  pid: number | null
  logPath: string | null
  message: string
  errorCode?: WorkflowErrorCode
  retryable?: boolean
  provider?: string | null
  model?: string | null
}

/** A live Harness Agent task accepted by the in-process workflow runner. */
export interface InProcessRun {
  /** Settles when the Agent reaches its terminal idle outcome. */
  done: Promise<void>
}

export interface RunnerServiceOptions {
  dataDir?: string | null
  /** early-exit detection window (default 5000ms) */
  graceMs?: number
  /** explicit working directory for the child (default process.cwd()) */
  cwd?: string
}

/** Env keys the harness treats as internal/sensitive and scrubs from children. */
const SENSITIVE_ENV_PATTERN = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i
/** Explicit allowlist: legitimate runner config that may look "sensitive". */
const RUNNER_ENV_ALLOWLIST = new Set(['OPENALEX_API_KEY', 'DSH_LITERATURE_PROFILE'])
/** Max chars of the runner log tail embedded in the failure message. */
const FAILURE_TAIL_CHARS = 800

function mapJob(row: RunnerJobRecord): RunnerJob {
  return {
    runId: row.run_id, kind: row.kind, pushId: row.push_id, pid: row.pid,
    status: row.status, startedAt: row.started_at, heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at, exitCode: row.exit_code, logPath: row.log_path, message: row.message,
    errorCode: row.error_code, retryable: row.retryable === null ? null : row.retryable === 1,
    provider: row.provider, model: row.model,
  }
}

function toRow(row: RunnerJob): RunnerJobRecord {
  return {
    run_id: row.runId, kind: row.kind, push_id: row.pushId, pid: row.pid, status: row.status,
    started_at: row.startedAt, heartbeat_at: row.heartbeatAt, finished_at: row.finishedAt,
    exit_code: row.exitCode, log_path: row.logPath, message: row.message,
    error_code: row.errorCode, retryable: row.retryable === null ? null : row.retryable ? 1 : 0,
    provider: row.provider, model: row.model,
  }
}

/**
 * Complete a captured child-process log before reading it.  `exit` can fire
 * before a piped WriteStream has flushed its final stderr chunk, which used to
 * hide the useful failure line from the UI.
 */
function closeLog(log: WriteStream | undefined): Promise<void> {
  if (log === undefined || log.destroyed || log.writableFinished) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => resolve()
    log.once('finish', done)
    log.once('error', done)
    try { log.end() } catch { resolve() }
  })
}

export class RunnerService {
  private readonly db: Db
  private readonly options: Required<Pick<RunnerServiceOptions, 'graceMs' | 'cwd'>> & { logDir: string | null }
  private readonly active = new Set<number>()

  constructor(db: Db, options: RunnerServiceOptions = {}) {
    this.db = db
    const logDir = options.dataDir === undefined || options.dataDir === null || options.dataDir === ''
      ? null
      : join(options.dataDir, 'runs')
    this.options = { graceMs: options.graceMs ?? 5000, cwd: options.cwd ?? process.cwd(), logDir }
  }

  /** True when a runner job is currently alive (running, not stale). */
  isActive(staleMs = 10 * 60 * 1000): boolean {
    const row = this.db.prepare(
      `SELECT status, heartbeat_at FROM runner_jobs ORDER BY run_id DESC LIMIT 1`,
    ).get() as { status: string; heartbeat_at: string } | undefined
    if (row === undefined || row.status !== 'running') return false
    const last = Date.parse(`${row.heartbeat_at.replace(' ', 'T')}Z`)
    return Number.isNaN(last) ? false : Date.now() - last < staleMs
  }

  /** Latest persisted job (the live one when running), or null. */
  latestJob(): RunnerJob | null {
    const row = this.db.prepare(
      `SELECT run_id, kind, push_id, pid, status, started_at, heartbeat_at, finished_at, exit_code, log_path, message,
              error_code, retryable, provider, model
       FROM runner_jobs ORDER BY run_id DESC LIMIT 1`,
    ).get() as RunnerJobRecord | undefined
    return row === undefined ? null : mapJob(row)
  }

  /** Newest captured runner log tail, or null when nothing has run yet. */
  latestLog(maxChars = 8000): { path: string; content: string } | null {
    const logDir = this.options.logDir
    if (logDir === null || !existsSync(logDir)) return null
    const files = readdirSync(logDir)
      .filter((name) => name.startsWith('runner-') && name.endsWith('.log'))
      .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    const newest = files[0]
    if (newest === undefined) return null
    const path = join(logDir, newest.name)
    return { path, content: readFileSync(path, 'utf8').slice(-maxChars) }
  }

  /**
   * Register a workflow driven by an Agent in this Harness process. The caller
   * creates the Agent before resolving `start`, so configuration failures reach
   * the HTTP response; the longer Agent turn continues in the background.
   */
  async startInProcess(
    kind: RunnerKind,
    selection: { provider: string; model: string },
    start: () => Promise<InProcessRun>,
  ): Promise<RunOutcome> {
    if (this.isActive()) {
      return { ...failureFor('WORKFLOW_ALREADY_RUNNING'), runId: null, pid: null, logPath: null }
    }
    const insert = this.db.prepare(
      `INSERT INTO runner_jobs (kind, push_id, pid, status, started_at, heartbeat_at, message, provider, model)
       VALUES (?, NULL, NULL, 'running', datetime('now'), datetime('now'), ?, ?, ?)`,
    ).run(kind, 'started in current Harness profile', selection.provider, selection.model)
    const runId = Number(insert.lastInsertRowid)
    this.active.add(runId)
    const finish = (status: RunnerStatus, exitCode: number, message: string, failure?: ReturnType<typeof classifyWorkflowError>): void => {
      this.active.delete(runId)
      this.db.prepare(
        `UPDATE runner_jobs SET status = ?, exit_code = ?, finished_at = datetime('now'), message = ?,
                error_code = ?, retryable = ?, provider = ?, model = ?
         WHERE run_id = ?`,
      ).run(
        status,
        exitCode,
        message,
        failure?.errorCode ?? null,
        failure === undefined ? null : failure.retryable ? 1 : 0,
        selection.provider,
        selection.model,
        runId,
      )
    }
    try {
      const run = await start()
      const heartbeat = setInterval(() => this.persistHeartbeat(runId), 60_000)
      void run.done.then(
        () => {
          clearInterval(heartbeat)
          finish('exited', 0, 'completed in current Harness profile')
        },
        (error: unknown) => {
          clearInterval(heartbeat)
          const failure = classifyWorkflowError(error instanceof Error ? error.message : String(error), selection)
          finish('exited', 1, failure.message, failure)
        },
      )
      return {
        ok: true,
        runId,
        pid: null,
        logPath: null,
        provider: selection.provider,
        model: selection.model,
        message: 'started in current Harness profile',
      }
    } catch (error) {
      const failure = classifyWorkflowError(error instanceof Error ? error.message : String(error), selection)
      finish('failed', 1, failure.message, failure)
      return { ...failure, runId, pid: null, logPath: null }
    }
  }

  /**
   * Spawn one workflow run and persist its job row. Returns the outcome with
   * the runId/pid/logPath; a crash inside the grace window is reported with
   * the actual failure detail.
   */
  async start(kind: RunnerKind, args: string[], opts: { bin: string; pushId?: number | null; message?: string }): Promise<RunOutcome> {
    if (this.isActive()) {
      return {
        ...failureFor('WORKFLOW_ALREADY_RUNNING'),
        runId: null,
        pid: null,
        logPath: null,
      }
    }
    const logDir = this.options.logDir
    const logPath = logDir === null ? null : (mkdirSync(logDir, { recursive: true }), join(logDir, `runner-${Date.now()}.log`))
    const insert = this.db.prepare(
      `INSERT INTO runner_jobs (kind, push_id, pid, status, started_at, heartbeat_at, log_path, message)
       VALUES (?, ?, NULL, 'running', datetime('now'), datetime('now'), ?, ?)`,
    ).run(kind, opts.pushId ?? null, logPath, opts.message ?? null)
    const runId = Number(insert.lastInsertRowid)
    this.active.add(runId)

    const stdio: StdioOptions = logPath !== null ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore']
    const child = spawn(opts.bin, args, { detached: true, stdio, env: runnerChildEnv(), cwd: this.options.cwd })
    const pid = child.pid ?? null
    this.db.prepare('UPDATE runner_jobs SET pid = ? WHERE run_id = ?').run(pid, runId)
    this.persistHeartbeat(runId)

    let log: WriteStream | undefined
    let capturedOutput = ''
    const captureOutput = (chunk: Buffer | string): void => {
      capturedOutput = `${capturedOutput}${chunk.toString()}`.slice(-FAILURE_TAIL_CHARS)
    }
    if (logPath !== null) {
      log = createWriteStream(logPath)
      child.stdout?.pipe(log)
      child.stderr?.pipe(log)
    }
    // Keep a small in-memory tail as well as the durable log. This is the
    // authoritative early-exit detail after `close`, while the file remains
    // the durable UI log for a live runner.
    child.stdout?.on('data', captureOutput)
    child.stderr?.on('data', captureOutput)
    const finish = (
      status: RunnerStatus,
      exitCode: number | null,
      message: string | null,
      failure?: ReturnType<typeof classifyWorkflowError>,
    ): void => {
      this.active.delete(runId)
      this.db.prepare(
        `UPDATE runner_jobs SET status = ?, exit_code = ?, finished_at = datetime('now'), message = COALESCE(?, message),
                error_code = COALESCE(?, error_code), retryable = COALESCE(?, retryable),
                provider = COALESCE(?, provider), model = COALESCE(?, model)
         WHERE run_id = ?`,
      ).run(
        status,
        exitCode,
        message,
        failure?.errorCode ?? null,
        failure === undefined ? null : failure.retryable ? 1 : 0,
        failure?.provider ?? null,
        failure?.model ?? null,
        runId,
      )
    }

    const earlyExit = await new Promise<{ code: number | null; signal: string | null; spawnError?: string } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.options.graceMs)
      // `close`, unlike `exit`, waits until the stdio pipes have closed. That
      // prevents an immediate crash from being recorded before its stderr has
      // reached the log/captured tail.
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      child.once('error', (error) => {
        clearTimeout(timer)
        const detail = error instanceof Error
          ? `${error.message}${'code' in error ? ` (${String((error as NodeJS.ErrnoException).code)})` : ''}`
          : String(error)
        resolve({ code: -1, signal: null, spawnError: detail })
      })
    })
    if (earlyExit !== null) {
      await closeLog(log)
      if (earlyExit.code !== 0) {
        const rawFailure = earlyExit.spawnError ?? (capturedOutput || (logPath !== null && existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''))
        const failure = classifyWorkflowError(rawFailure)
        const message = earlyExit.spawnError !== undefined
          ? redactSensitiveText(`runner spawn failed: ${earlyExit.spawnError}`)
          : `${failure.message} ${formatRunnerFailure(earlyExit.code, earlyExit.signal, rawFailure)}`
        finish(earlyExit.spawnError !== undefined ? 'failed' : 'exited', earlyExit.code, message, failure)
        return { ...failure, message, runId, pid, logPath }
      }
      finish('exited', 0, `finished ${opts.bin} ${args.join(' ')} (exit 0)`)
      return { ok: true, runId, pid, logPath, message: `finished ${opts.bin} ${args.join(' ')} (exit 0)` }
    }

    // Runner survived the grace window → it is live. Keep a heartbeat going as
    // long as the child lives (best-effort; the CLI itself also finalizes the
    // job when it completes).
    const heartbeat = setInterval(() => {
      try { this.persistHeartbeat(runId) } catch { /* db closed */ }
    }, 60_000)
    child.once('exit', (code) => {
      clearInterval(heartbeat)
      if (code !== null && code !== 0) {
        const failure = classifyWorkflowError(capturedOutput)
        finish('exited', code, failure.message, failure)
      } else {
        finish('exited', code, null)
      }
      if (log !== undefined) { try { log.end() } catch { /* closed */ } }
    })
    child.once('error', () => {
      clearInterval(heartbeat)
      const failure = classifyWorkflowError('runner process error')
      finish('failed', -1, failure.message, failure)
      if (log !== undefined) { try { log.end() } catch { /* closed */ } }
    })
    child.unref()
    return { ok: true, runId, pid, logPath, message: `started ${opts.bin} ${args.join(' ')}` }
  }

  private persistHeartbeat(runId: number): void {
    this.db.prepare('UPDATE runner_jobs SET heartbeat_at = datetime(\'now\') WHERE run_id = ?').run(runId)
  }
}

/** Human-readable runner failure line (pure — testable). */
export function formatRunnerFailure(code: number | null, signal: string | null, tail: string): string {
  const where = code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`
  const detail = redactSensitiveText(tail).trim().split('\n').slice(-8).join(' | ').trim().slice(0, FAILURE_TAIL_CHARS)
  return `runner exited early (${where})${detail !== '' ? `: ${detail}` : ''}`
}

/**
 * Child env for the workflow runner: the parent env minus harness-internal
 * DSH_* entries and credential-shaped keys, plus an explicit allowlist.
 */
export function runnerChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (RUNNER_ENV_ALLOWLIST.has(key)) { env[key] = value; continue }
    if (upper.startsWith('DSH_')) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    env[key] = value
  }
  return env
}
