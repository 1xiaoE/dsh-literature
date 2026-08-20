/**
 * RunnerService tests: the Web UI → child-process lifecycle ledger.
 * - start() persists a runner_jobs row with runId/kind/pid/status/logPath;
 * - an immediate crash (non-zero exit inside the grace window) is reported
 *   with the real failure detail and the job is marked exited/failed;
 * - a surviving runner is 'running', and latestJob()/isActive() reflect it;
 * - a stale heartbeat stops counting as active.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { RunnerService, formatRunnerFailure } from '../src/lib/runner_service.js'

function tempEnv(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lit-runner-'))
  return { db: openDb(dir), dir }
}

describe('runner service', () => {
  it('records the selected active-profile model for an in-process run', async () => {
    const t = tempEnv()
    try {
      let finish: (() => void) | undefined
      const done = new Promise<void>((resolve) => { finish = resolve })
      const service = new RunnerService(t.db, { dataDir: t.dir })
      const out = await service.startInProcess(
        'push',
        { provider: 'web-provider', model: 'web-model' },
        async () => ({ done }),
      )
      expect(out).toMatchObject({ ok: true, provider: 'web-provider', model: 'web-model' })
      expect(service.latestJob()).toMatchObject({ status: 'running', provider: 'web-provider', model: 'web-model' })

      finish?.()
      await new Promise((resolve) => setImmediate(resolve))
      expect(service.latestJob()).toMatchObject({ status: 'exited', exitCode: 0 })
    } finally {
      t.db.close()
      rmSync(t.dir, { recursive: true, force: true })
    }
  })

  it('persists a job row and reports an immediate crash with the real error', async () => {
    const t = tempEnv()
    try {
      const service = new RunnerService(t.db, { dataDir: t.dir, graceMs: 2000 })
      const out = await service.start('push', ['-e', "require('node:fs').writeSync(2, 'BOOT_FAIL\\n'); process.exit(3)"], { bin: process.execPath })
      expect(out.ok).toBe(false)
      expect(out.runId).toBe(1)
      expect(out.message).toContain('exit code 3')
      expect(out.message).toContain('BOOT_FAIL')
      const job = service.latestJob()!
      expect(job.status).toBe('exited')
      expect(job.exitCode).toBe(3)
      expect(job.kind).toBe('push')
      expect(service.isActive()).toBe(false)
    } finally {
      t.db.close()
      rmSync(t.dir, { recursive: true, force: true })
    }
  })

  it('keeps a surviving runner running and blocks a second launch', async () => {
    const t = tempEnv()
    try {
      const service = new RunnerService(t.db, { dataDir: t.dir, graceMs: 800 })
      const out = await service.start('push', ['-e', 'setTimeout(() => {}, 60000)'], { bin: process.execPath })
      expect(out.ok).toBe(true)
      expect(service.isActive()).toBe(true)
      expect(service.latestJob()?.status).toBe('running')
      const second = await service.start('push', ['-e', 'process.exit(0)'], { bin: process.execPath })
      expect(second.ok).toBe(false)
      expect(second.message).toBe('文献工作流已在运行。')
    } finally {
      t.db.close()
      rmSync(t.dir, { recursive: true, force: true })
    }
  })

  it('resume jobs carry the pushId and a successful finish marks exited with code 0', async () => {
    const t = tempEnv()
    try {
      const service = new RunnerService(t.db, { dataDir: t.dir, graceMs: 2000 })
      const out = await service.start('resume', ['-e', 'process.exit(0)'], { bin: process.execPath, pushId: 42 })
      expect(out.ok).toBe(true)
      const job = service.latestJob()!
      expect(job.kind).toBe('resume')
      expect(job.pushId).toBe(42)
      expect(job.status).toBe('exited')
      expect(job.exitCode).toBe(0)
    } finally {
      t.db.close()
      rmSync(t.dir, { recursive: true, force: true })
    }
  })

  it('a stale heartbeat no longer counts as active', () => {
    const t = tempEnv()
    try {
      t.db.prepare(
        `INSERT INTO runner_jobs (kind, status, started_at, heartbeat_at)
         VALUES ('push', 'running', datetime('now'), datetime('now', '-30 minutes'))`,
      ).run()
      const service = new RunnerService(t.db, { dataDir: t.dir })
      expect(service.latestJob()?.status).toBe('running')
      expect(service.isActive(10 * 60 * 1000)).toBe(false)
    } finally {
      t.db.close()
      rmSync(t.dir, { recursive: true, force: true })
    }
  })

  it('formats runner failures with the log tail', () => {
    expect(formatRunnerFailure(3, null, 'boom early\nmore')).toContain('exit code 3')
    expect(formatRunnerFailure(3, null, 'boom early\nmore')).toContain('boom early')
    expect(formatRunnerFailure(null, 'SIGTERM', '')).toContain('signal SIGTERM')
  })

  it('persists structured authentication failure details', async () => {
    const t = tempEnv()
    try {
      const service = new RunnerService(t.db, { dataDir: t.dir, graceMs: 2000 })
      const out = await service.start(
        'push',
        ['-e', "require('node:fs').writeSync(2, 'Authentication Fails, Your api key: secret is invalid\\n'); process.exit(1)"],
        { bin: process.execPath },
      )
      expect(out).toMatchObject({ ok: false, errorCode: 'AUTH', retryable: false, provider: null, model: null })
      expect(service.latestJob()).toMatchObject({ errorCode: 'AUTH', retryable: false, provider: null, model: null })
      expect(out.message).not.toContain('secret')
    } finally {
      t.db.close()
      rmSync(t.dir, { recursive: true, force: true })
    }
  })
})
