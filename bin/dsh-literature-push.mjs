#!/usr/bin/env node
/**
 * dsh-literature-push — headless CLI wrapper for OS cron/systemd.
 *
 * Runs one complete literature push through the selected Harness profile
 * (single task → wait for quiescence → exit 0/1), avoiding any ctx.jobs
 * nesting. The profile agent executes literature_push_now and the rest of
 * the workflow with the plugin's tools.
 *
 * Usage:
 *   node bin/dsh-literature-push.mjs [--topic <topic>] [--install] [--harness <dir>]
 *   node bin/dsh-literature-push.mjs --resume <pushId> [--install] [--harness <dir>]
 *
 * --install  ensures the plugin is installed into the selected profile
 *            (dsh plugin --profile <name> add link:<repo>) before running.
 * --resume   continues a parked push (NEED_USER_ACTION / interrupted) from
 *            its original step — candidates and scores are reused, never
 *            re-retrieved/re-scored.
 */
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyWorkflowError, redactSensitiveText, retryPolicy } from '../lib/lib/workflow_errors.js'
import { buildResumePrompt, buildTaskPrompt } from '../lib/lib/workflow_prompt.js'

export { buildResumePrompt, buildTaskPrompt }

const REPO = join(fileURLToPath(new URL('..', import.meta.url)))
const DEFAULT_PROFILE = 'headless'

/**
 * Discover the DeepSeek Harness checkout without hardcoding a personal path:
 *  1. $DSH_HARNESS_DIR wins when set;
 *  2. `dsh` on $PATH → its parent repo (bin/dsh lives inside the harness repo);
 *  3. `dsh` CLI resolves to a symlink (global install) → resolve to the repo;
 *  4. common repo locations (~/deepseek-harness, ~/dsh, $XDG checkout) as a
 *     last resort for interactive convenience;
 *  5. explicit --harness always overrides everything.
 */
function discoverHarness(flagValue) {
  if (flagValue) return flagValue
  if (process.env.DSH_HARNESS_DIR) return process.env.DSH_HARNESS_DIR
  const which = (cmd) => {
    try {
      const r = spawnSync('which', [cmd], { encoding: 'utf8' })
      return r.status === 0 ? r.stdout.trim() : null
    } catch { return null }
  }
  const binPath = which('dsh')
  if (binPath) {
    const resolved = (() => {
      try {
        const r = spawnSync('readlink', ['-f', binPath], { encoding: 'utf8' })
        return r.status === 0 ? r.stdout.trim() : binPath
      } catch { return binPath }
    })()
    // bin/dsh lives at the harness repo root; walk up one level.
    const candidate = join(resolved, '..')
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  for (const dir of [join(homedir(), 'deepseek-harness'), join(homedir(), 'dsh'), join(homedir(), 'work', 'deepseek-harness')]) {
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return null
}

export function parseArgs(argv) {
  const out = { topic: undefined, install: false, harness: undefined, resume: undefined, profile: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--topic') out.topic = argv[++i]
    else if (a === '--resume') out.resume = Number(argv[++i])
    else if (a === '--install') out.install = true
    else if (a === '--harness') out.harness = argv[++i]
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--help') {
      console.log(
        'dsh-literature-push: run one literature push via the selected Harness profile.\n' +
          '  --topic <topic>   override topic\n' +
          '  --resume <pushId> continue a parked/interrupted push from its original step\n' +
          '  --profile <name>  Harness profile (default: $DSH_LITERATURE_PROFILE or headless)\n' +
          '  --install         ensure plugin installed in the selected profile first\n' +
          '  --harness <dir>   dsh harness repo (default: $DSH_HARNESS_DIR, then `dsh` on PATH)',
      )
      process.exit(0)
    }
  }
  return out
}

export function resolveProfile(args, env = process.env) {
  const profile = args.profile?.trim() || env.DSH_LITERATURE_PROFILE?.trim() || DEFAULT_PROFILE
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw new Error('INVALID_ARGUMENT: profile must be a simple Harness profile name')
  }
  return profile
}

function dshBin(harness) {
  return join(harness, 'apps', 'cli', 'src', 'bin.ts')
}

function pluginInstalled(profile) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(homedir(), '.dsh', 'profiles', profile, 'package.json'), 'utf8'),
    )
    return Boolean(manifest.dependencies && manifest.dependencies['dsh-literature'])
  } catch {
    return false
  }
}

export function buildInstallArgs(profile, repo = REPO) {
  return ['--profile', profile, 'add', `link:${repo}`]
}

function installPlugin(harness, profile) {
  console.error(`[dsh-literature] installing into profile ${profile}…`)
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', dshBin(harness), 'plugin', ...buildInstallArgs(profile)],
    { cwd: harness, stdio: 'inherit', env: process.env },
  )
  if (res.status !== 0) {
    console.error('[dsh-literature] plugin install failed')
    process.exit(res.status ?? 1)
  }
}

export function buildHarnessArgs(profile, prompt, cliPath) {
  return [cliPath, '--profile', profile, prompt]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const profile = resolveProfile(args)
  args.harness = discoverHarness(args.harness)
  if (!args.harness || !existsSync(join(args.harness, 'apps', 'cli', 'src', 'bin.ts'))) {
    console.error(
      '[dsh-literature] DeepSeek Harness checkout not found.\n' +
        '  Provide it with --harness <dir> or set DSH_HARNESS_DIR, or ensure the `dsh` CLI is on $PATH.',
    )
    process.exit(2)
  }

  // --resume: try the deterministic 0-LLM finalize path FIRST (push #16-style:
  // everything done, only a user action was pending and is now resolved).
  // Only when the state cannot be finalized programmatically do we start a
  // headless agent for the LLM-driven resume (literature_resume).
  if (args.resume !== undefined) {
    const dataDir = resolveDataDir()
    try {
      const { openDb } = await import('../lib/db.js')
      const { tryDeterministicFinalize } = await import('../lib/lib/resume.js')
      const db = openDb(dataDir)
      const out = tryDeterministicFinalize(db, args.resume)
      db.close()
      if (out.finalized) {
        console.log(`[dsh-literature] deterministic resume finalize: push #${out.pushId} → completed`)
        console.log(`  paper:        ${out.paperId}`)
        console.log(`  report:       ${out.reportPath}`)
        console.log(`  resume_ms:    ${out.resumeMs}ms`)
        console.log(`  llm calls:    ${out.resumeLlmCallCount} (0 = no agent reasoning, no re-run of retrieval/ranking/PDF/fulltext/report)`)
        process.exit(0)
      }
      console.error(`[dsh-literature] deterministic finalize 不可用：${out.reason} — 回退到 profile ${profile} agent resume`)
    } catch (err) {
      console.error(`[dsh-literature] deterministic finalize 检查失败（回退 profile ${profile}）：${String(err)}`)
    }
  }

  if (args.install || !pluginInstalled(profile)) {
    installPlugin(args.harness, profile)
  }
  const prompt = args.resume !== undefined
    ? buildResumePrompt(args.resume)
    : buildTaskPrompt(args.topic)
  console.error(
    `[dsh-literature] running profile ${profile} ${args.resume !== undefined ? `resume of push #${args.resume}` : `push for topic: ${args.topic ?? 'configured learning context'}`}`,
  )
  process.exit(runHarness(args.harness, profile, prompt))
}

function sleepSync(ms) {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, ms)
}

function runHarness(harness, profile, prompt) {
  let retries = 0
  const initialWorkflow = workflowSnapshot()
  while (true) {
    const res = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', ...buildHarnessArgs(profile, prompt, dshBin(harness))],
      { cwd: harness, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, encoding: 'utf8', timeout: 30 * 60 * 1000 },
    )
    const output = redactSensitiveText(`${res.stdout ?? ''}${res.stderr ?? ''}`)
    if (output !== '') process.stderr.write(output)
    if (res.status === 0) return 0

    const failure = classifyWorkflowError(output)
    const policy = retryPolicy(failure.errorCode)
    if (workflowSnapshot() !== initialWorkflow) {
      console.error('[dsh-literature] workflow state was persisted; automatic retry stopped to avoid duplicating the push')
      return res.status ?? 1
    }
    if (retries >= policy.maxRetries) {
      console.error(`[dsh-literature] ${failure.errorCode}: ${failure.message}`)
      return res.status ?? 1
    }
    retries += 1
    const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retries - 1))
    console.error(`[dsh-literature] ${failure.errorCode}: retry ${retries}/${policy.maxRetries} in ${delay}ms`)
    sleepSync(delay)
  }
}

function workflowSnapshot() {
  const path = join(resolveDataDir(), 'literature.db')
  if (!existsSync(path)) return null
  try {
    const db = new DatabaseSync(path)
    const row = db.prepare('SELECT id, status, started_at FROM pushes ORDER BY id DESC LIMIT 1').get()
    db.close()
    if (row === undefined) return null
    const value = row
    return `${value.id}:${value.status}:${value.started_at}`
  } catch {
    return null
  }
}

/** Isolated data dir for the deterministic resume DB read. */
function resolveDataDir() {
  return join(homedir(), 'dsh-literature', 'Data')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
