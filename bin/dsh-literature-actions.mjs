#!/usr/bin/env node
/**
 * dsh-literature-actions — 查看/完成 Human-in-the-loop 待办（NEED_USER_ACTION）。
 *
 *   node bin/dsh-literature-actions.mjs list                 # 列出所有 open 待办（五要素）
 *   node bin/dsh-literature-actions.mjs list --push <id>     # 只看某个 push
 *   node bin/dsh-literature-actions.mjs resolve <actionId> [--note ...]
 *
 * 用户处理完待办后 resolve；对应 push 回到 running，即可用
 * dsh-literature-push.mjs --resume <pushId> 从原步骤继续（不重新检索/评分）。
 * 需要先构建 lib：pnpm build
 */
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'
import { listOpenActions, openActionsOfPush, resolveUserAction } from '../lib/lib/user_actions.js'

const DEFAULT_DATA_DIR = join(homedir(), 'dsh-literature', 'Data')

function parseArgs(argv) {
  const out = { cmd: undefined, dataDir: DEFAULT_DATA_DIR, push: undefined, note: undefined, actionId: undefined }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--data-dir') out.dataDir = argv[++i]
    else if (a === '--push') out.push = Number(argv[++i])
    else if (a === '--note') out.note = argv[++i]
    else if (a === '--help') {
      console.log(
        'dsh-literature-actions: 查看/完成 Human-in-the-loop 待办。\n' +
          '  list                     列出所有 open 待办（五要素）。\n' +
          '  list --push <id>         只看某个 push 的待办。\n' +
          '  resolve <actionId> [--note 说明]  标记完成。\n' +
          '  --data-dir <dir>         数据目录（默认 ~/dsh-literature/Data）。',
      )
      process.exit(0)
    }
    else positional.push(a)
  }
  out.cmd = positional[0]
  if (positional[1]) out.actionId = Number(positional[1])
  return out
}

function dumpAction(a, pushId) {
  const att = (() => {
    try { return JSON.parse(a.attempts ?? '[]').join('；') } catch { return a.attempts ?? '' }
  })()
  console.log(`#${a.id} [${a.state}] push=${a.push_id} kind=${a.kind} step=${a.step}${a.paper_id ? ` paper=${a.paper_id}` : ''}`)
  console.log(`   卡点:     ${a.issue}`)
  console.log(`   已尝试:   ${att || '无'}`)
  console.log(`   用户需要: ${a.what_user_should_do}`)
  console.log(`   如何继续: ${a.how_to_continue}`)
  console.log(`   创建于:   ${a.created_at}${a.resolved_at ? `，解决于 ${a.resolved_at}` : ''}`)
  if (a.state === 'open' && a.kind !== 'carsi_relogin' && a.kind !== 'publisher_login') {
    console.log(`   完成:     dsh-literature-actions resolve ${a.id}`)
  }
  console.log('')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  mkdirSync(args.dataDir, { recursive: true })
  const db = openDb(args.dataDir)
  if (args.cmd === 'resolve') {
    if (!args.actionId) {
      console.error('用法: dsh-literature-actions resolve <actionId> [--note 说明]')
      process.exit(2)
    }
    const row = resolveUserAction(db, args.actionId)
    if (!row) {
      console.error(`action #${args.actionId} 不存在`)
      process.exit(1)
    }
    console.log(`✅ action #${row.id} 已标记完成（${row.kind}）`)
    const push = db.prepare('SELECT status FROM pushes WHERE id = ?').get(row.push_id)
    console.log(`push #${row.push_id} 当前状态：${push?.status ?? '?'}${push?.status === 'running' ? '（可 --resume 继续）' : ''}`)
    process.exit(0)
  }
  if (args.cmd === 'list') {
    const rows = args.push !== undefined ? openActionsOfPush(db, args.push) : listOpenActions(db)
    if (rows.length === 0) {
      console.log('没有 open 待办 ✅')
      process.exit(0)
    }
    console.log(`open 待办 ${rows.length} 项：\n`)
    for (const a of rows) dumpAction(a, args.push)
    process.exit(0)
  }
  console.error('用法: dsh-literature-actions list | resolve <actionId>（--help 查看详情）')
  process.exit(2)
}

main()
