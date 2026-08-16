#!/usr/bin/env node
/**
 * dsh-literature-carsi-login — CARSI 人工登录 / 会话检查 CLI。
 *
 * 首次使用（或 AUTH_REQUIRED 之后）：
 *   node bin/dsh-literature-carsi-login.mjs
 * 会以 headed 浏览器打开 CARSI 门户，使用**独立持久 profile**
 * （默认 ~/.local/share/dsh-literature/browser-profile/，绝不读取日常浏览器
 * 的 Cookie）。完成学校统一身份认证登录后回到终端按 Enter 结束；
 * 会话由后续 headless 推送自动复用。
 *
 * 会话检查：
 *   node bin/dsh-literature-carsi-login.mjs --check
 *
 * 选项：--data-dir <dir>  --profile-dir <dir>  --timeout-min <n>
 *       --headless（调试用）  --help
 *
 * 需要先构建 lib：pnpm build
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CarsiPdfProvider, CARSI_PORTAL_URL } from '../lib/providers/carsi.js'
import { DEFAULT_CARSI_USER_AGENT } from '../lib/config.js'
import { openDb } from '../lib/db.js'
import { resolveUserActionsByKind } from '../lib/lib/user_actions.js'

const XDG = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
const DEFAULT_DATA_DIR = join(XDG, 'dsh-literature')
const DEFAULT_PROFILE_DIR = join(DEFAULT_DATA_DIR, 'browser-profile')

function parseArgs(argv) {
  const out = {
    dataDir: DEFAULT_DATA_DIR,
    profileDir: undefined,
    timeoutMin: 15,
    check: false,
    headless: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--data-dir') out.dataDir = argv[++i]
    else if (a === '--profile-dir') out.profileDir = argv[++i]
    else if (a === '--timeout-min') out.timeoutMin = Number(argv[++i]) || 15
    else if (a === '--check') out.check = true
    else if (a === '--headless') out.headless = true
    else if (a === '--help') {
      console.log(
        'dsh-literature-carsi-login: CARSI 人工登录 / 会话检查。\n' +
          '  默认：headed 打开 CARSI 门户，登录完成后按 Enter 结束。\n' +
          '  --check         只检查会话状态，不打开浏览器。\n' +
          '  --data-dir      数据目录（默认 XDG ~/.local/share/dsh-literature）。\n' +
          '  --profile-dir   浏览器 profile 目录（默认 <data-dir>/browser-profile）。\n' +
          '  --timeout-min   登录等待上限分钟（默认 15）。\n' +
          '  --headless      调试用（headless 打开门户，无法人工输入）。',
      )
      process.exit(0)
    }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const provider = new CarsiPdfProvider({
    dataDir: args.dataDir,
    enabled: true,
    minIntervalMinutes: 120,
    headless: args.headless,
    timeoutMs: 90000,
    profileDir: args.profileDir ?? DEFAULT_PROFILE_DIR,
    userAgent: DEFAULT_CARSI_USER_AGENT,
  })

  if (args.check) {
    const status = await provider.sessionStatus()
    console.log('CARSI 会话状态：')
    console.log(`  浏览器可用:   ${status.available ? '是' : '否（playwright/chromium 未安装）'}`)
    console.log(`  profile:      ${status.profileDir}`)
    console.log(`  上次认证:     ${status.lastAuthAt ?? '从未'}`)
    console.log(`  上次尝试:     ${status.lastAttemptAt ?? '从未'}（outcome=${status.lastOutcome ?? '-'}）`)
    console.log(`  尝试总数:     ${status.attemptsCount}`)
    process.exit(status.available ? 0 : 2)
  }

  console.log('———————————————————————————————————————————————————————————')
  console.log('CARSI 人工登录')
  console.log('———————————————————————————————————————————————————————————')
  console.log(`浏览器即将打开 CARSI 门户：${CARSI_PORTAL_URL}`)
  console.log('使用独立持久 profile（不读取你日常浏览器的任何 Cookie）：')
  console.log(`  ${provider.getProfileDir()}`)
  console.log('步骤：')
  console.log('  1. 在门户中选择你的学校/机构（如已登录可跳过）；')
  console.log('  2. 完成学校统一身份认证（账号密码/扫码）；')
  console.log('  3. 回到门户页面并确认可访问资源后，回到本终端按 Enter 结束；')
  console.log('  4. 之后 headless 推送会自动复用该会话。')
  console.log(`超时上限：${args.timeoutMin} 分钟（可随时按 Enter 提前结束）。`)
  console.log('———————————————————————————————————————————————————————————')

  const done = new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', resolve)
  })
  const res = await provider.authenticate({
    headless: args.headless,
    waitFor: done,
    timeoutMs: args.timeoutMin * 60 * 1000,
  })
  if (res.ok) {
    console.log('✅ 认证完成，会话已保存到独立 profile。')
    // Human-in-the-loop: mark every parked carsi_relogin action as resolved
    // so the corresponding pushes can be resumed (dsh-literature-push --resume).
    try {
      const db = openDb(args.dataDir)
      const n = resolveUserActionsByKind(db, 'carsi_relogin')
      if (n > 0) {
        console.log(`✅ 已自动标记 ${n} 个 CARSI 重新登录待办为完成——对应推送可用 --resume 从原步骤继续。`)
      }
      db.close()
    } catch (err) {
      console.warn(`⚠️ 自动标记待办失败（可手动用 dsh-literature-actions resolve 完成）：${String(err)}`)
    }
    process.exit(0)
  }
  console.error(`❌ 认证未完成：${res.reason ?? '未知原因'}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
