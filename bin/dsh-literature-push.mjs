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
 *
 * --install  ensures the plugin is installed into the headless profile
 *            (dsh plugin --profile headless add link:<repo>) before running.
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
  const out = { topic: undefined, install: false, harness: HARNESS }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--topic') out.topic = argv[++i]
    else if (a === '--install') out.install = true
    else if (a === '--harness') out.harness = argv[++i]
    else if (a === '--help') {
      console.log(
        'dsh-literature-push: run one literature push via the dsh headless profile.\n' +
          '  --topic <topic>   override topic\n' +
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
    '3) 若全文不可得（FULLTEXT_UNAVAILABLE），如实以 status=fulltext_unavailable 结束，禁止凭摘要伪装精读。\n' +
    '完成后用不超过 5 句话汇报：推送号、选中论文、报告路径、阶段进度。'
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(join(args.harness, 'apps', 'cli', 'src', 'bin.ts'))) {
    console.error(`[dsh-literature] harness not found at ${args.harness} (use --harness or DSH_HARNESS_DIR)`)
    process.exit(2)
  }
  if (args.install || !pluginInstalled()) {
    installPlugin(args.harness)
  }
  const topic = args.topic ?? '足式机器人控制'
  const prompt = buildTaskPrompt(topic)
  console.error(`[dsh-literature] running headless push for topic: ${topic}`)
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', dshBin(args.harness), 'headless', prompt],
    { cwd: args.harness, stdio: 'inherit', env: process.env, timeout: 30 * 60 * 1000 },
  )
  process.exit(res.status ?? 1)
}

main()
