#!/usr/bin/env node
/**
 * dsh-literature-push — headless CLI wrapper for OS cron/systemd.
 *
 * Runs one complete literature push through the OFFICIAL dsh headless
 * profile (single task → wait for quiescence → exit 0/1), avoiding any
 * ctx.jobs nesting. The headless agent executes literature_push_now and the
 * rest of the workflow with the plugin's tools.
 *
 * Usage:
 *   node bin/dsh-literature-push.mjs [--topic <topic>] [--install] [--harness <dir>]
 *   node bin/dsh-literature-push.mjs --resume <pushId> [--install] [--harness <dir>]
 *
 * --install  ensures the plugin is installed into the headless profile
 *            (dsh plugin --profile headless add link:<repo>) before running.
 * --resume   continues a parked push (NEED_USER_ACTION / interrupted) from
 *            its original step — candidates and scores are reused, never
 *            re-retrieved/re-scored.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(fileURLToPath(new URL('..', import.meta.url)))
const HARNESS =
  process.env.DSH_HARNESS_DIR ?? '/home/eternal/deepseek-harness'
const HEADLESS_PROFILE = join(homedir(), '.dsh', 'profiles', 'headless')

function parseArgs(argv) {
  const out = { topic: undefined, install: false, harness: HARNESS, resume: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--topic') out.topic = argv[++i]
    else if (a === '--resume') out.resume = Number(argv[++i])
    else if (a === '--install') out.install = true
    else if (a === '--harness') out.harness = argv[++i]
    else if (a === '--help') {
      console.log(
        'dsh-literature-push: run one literature push via the dsh headless profile.\n' +
          '  --topic <topic>   override topic\n' +
          '  --resume <pushId> continue a parked/interrupted push from its original step\n' +
          '  --install         ensure plugin installed in the headless profile first\n' +
          '  --harness <dir>   dsh harness repo (default: ' + HARNESS + ')',
      )
      process.exit(0)
    }
  }
  return out
}

function dshBin(harness) {
  return join(harness, 'apps', 'cli', 'src', 'bin.ts')
}

function pluginInstalled() {
  try {
    const manifest = JSON.parse(
      readFileSync(join(HEADLESS_PROFILE, 'package.json'), 'utf8'),
    )
    return Boolean(manifest.dependencies && manifest.dependencies['dsh-literature'])
  } catch {
    return false
  }
}

function installPlugin(harness) {
  console.error('[dsh-literature] installing into headless profile…')
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', dshBin(harness), 'plugin', '--profile', 'headless', 'add', `link:${REPO}`],
    { cwd: harness, stdio: 'inherit', env: process.env },
  )
  if (res.status !== 0) {
    console.error('[dsh-literature] plugin install failed')
    process.exit(res.status ?? 1)
  }
}

function buildTaskPrompt(topic) {
  return (
    '执行文献精选推送工作流（Literature Agent）。主题：' +
    topic +
    '。\n' +
    '步骤：1) 调用 literature_push_now 获取工作流指令与 pushId（优先近5年高质量论文，允许里程碑经典；' +
    '先查历史避免重复推荐，遵循阅读阶段主线递进）。\n' +
    '2) 按 literature_push_now 返回的 instructions 逐步执行：检索→语义排序精选1篇→下载PDF→分块全文精读→' +
    '撰写结构化 Markdown 精读报告并归档到文献库→用 literature_record 提交结果。\n' +
    '2b) 性能要求：语义排序必须 BATCH（一次至多两次 LLM 调用评估全部 Top 15，禁止逐篇独立调用）；候选排序阶段目标 ≤ 2 分钟；' +
    'literature_record 时自报 llmCallCount/llmRetryCount/agentRankingMs/reportGenerationMs。\n' +
    '3) Human-in-the-loop（NEED_USER_ACTION）规则：遇到资源访问/认证/权限/下载渠道/研究选择问题且用户更容易解决时，' +
    '不要盲目重试、不要直接判定失败——用 literature_user_action(open) 注册待办（五要素：卡在哪步/缺什么/试过什么/用户做什么/如何继续），' +
    '再用 literature_record 提交 status=user_action_required（errorCode=AUTH_REQUIRED 等），并在汇报中完整展示五要素；' +
    '用户处理后可运行 --resume 恢复。禁止把 AUTH_REQUIRED / USER_RESOURCE_NEEDED 误记为 FULLTEXT_UNAVAILABLE。\n' +
    '4) 若全文不可得且不属于上述 HITL 场景（FULLTEXT_UNAVAILABLE），如实以 status=fulltext_unavailable 结束，禁止凭摘要伪装精读。\n' +
    '完成后用不超过 5 句话汇报：推送号、选中论文、报告路径、阶段进度（若为 NEED_USER_ACTION 则汇报五要素与恢复命令）。'
  )
}

function buildResumePrompt(pushId) {
  return (
    '恢复文献推送 workflow（Literature Agent）。pushId=' +
    pushId +
    '。\n' +
    '步骤：1) 调用 literature_resume(pushId=' +
    pushId +
    ') 获取卡点、待办与 resumeFrom 步骤。\n' +
    '2) 若返回 openActions（NEED_USER_ACTION 待办）：先明确展示五要素（卡在哪步/缺什么/试过什么/用户做什么/如何继续），' +
    '并说明「用户处理完成后重新运行 dsh-literature-push.mjs --resume ' +
    pushId +
    '」；若待办已解决（用户已处理），按其 howToContinue 继续。\n' +
    '3) 不要重新运行 literature_sources、不要重新评分——候选与评分已持久化；严格按 resumeFrom 指示的步骤继续' +
    '（fetch_pdf 可用 allowCarsi=true 或 manualPdfPath；fulltext_index → literature_fulltext_read 逐块精读 → 报告 → literature_record）。\n' +
    '完成后用不超过 5 句话汇报：恢复的步骤、最终状态、报告路径（或仍待用户处理的事项）。'
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(join(args.harness, 'apps', 'cli', 'src', 'bin.ts'))) {
    console.error(`[dsh-literature] harness not found at ${args.harness} (use --harness or DSH_HARNESS_DIR)`)
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
      console.error(`[dsh-literature] deterministic finalize 不可用：${out.reason} — 回退到 headless agent resume`)
    } catch (err) {
      console.error(`[dsh-literature] deterministic finalize 检查失败（回退 headless）：${String(err)}`)
    }
  }

  if (args.install || !pluginInstalled()) {
    installPlugin(args.harness)
  }
  const prompt = args.resume !== undefined
    ? buildResumePrompt(args.resume)
    : buildTaskPrompt(args.topic ?? '足式机器人控制')
  console.error(
    `[dsh-literature] running headless ${args.resume !== undefined ? `resume of push #${args.resume}` : `push for topic: ${args.topic ?? '足式机器人控制'}`}`,
  )
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', dshBin(args.harness), '--profile', 'headless', prompt],
    { cwd: args.harness, stdio: 'inherit', env: process.env, timeout: 30 * 60 * 1000 },
  )
  process.exit(res.status ?? 1)
}

/** XDG data dir for the deterministic resume DB read. */
function resolveDataDir() {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share')
  return join(base, 'dsh-literature')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
