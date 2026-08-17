#!/usr/bin/env node
/**
 * dsh-literature-browser-login — generic publisher login (Human-in-the-loop).
 *
 * Opens the SAME independent persistent browser profile that the automated
 * pipeline uses, pointed at either a stuck publisher article page or the
 * paper's DOI, so the USER can complete a legal login / institutional sign-in
 * themselves. The tool never auto-fills accounts, passwords, CAPTCHAs or
 * institutional credentials.
 *
 * Usage:
 *   node bin/dsh-literature-browser-login.mjs --url "<publisher article url>"
 *   node bin/dsh-literature-browser-login.mjs --push <pushId>   # uses the push's AUTH_REQUIRED paper
 *   node bin/dsh-literature-browser-login.mjs --check           # session status
 *
 * After the user confirms the article is accessible and presses Enter, the
 * session ledger is marked authenticated and every parked publisher_login /
 * carsi_relogin user action is resolved, so the push can be resumed:
 *   node bin/dsh-literature-push.mjs --resume <pushId>
 *
 * Requires a build first: pnpm build
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PublisherBrowserProvider } from '../lib/providers/publisher_browser.js'
import { CarsiPdfProvider } from '../lib/providers/carsi.js'
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
    url: undefined,
    push: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--data-dir') out.dataDir = argv[++i]
    else if (a === '--profile-dir') out.profileDir = argv[++i]
    else if (a === '--timeout-min') out.timeoutMin = Number(argv[++i]) || 15
    else if (a === '--check') out.check = true
    else if (a === '--url') out.url = argv[++i]
    else if (a === '--push') out.push = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      console.log(
        'dsh-literature-browser-login: 通用出版社登录（Human-in-the-loop）。\n' +
          '  默认（无参数）：headed 打开浏览器到 CARSI/出版社门户，用户完成合法登录后按 Enter。\n' +
          '  --url <url>      打开指定出版社文章页（优先使用 DOI 直连后的页面）。\n' +
          '  --push <id>      使用该 push 的 AUTH_REQUIRED 论文（自动取 DOI/URL）。\n' +
          '  --check          只检查会话状态，不打开浏览器。\n' +
          '  --data-dir       数据目录（默认 XDG ~/.local/share/dsh-literature）。\n' +
          '  --profile-dir    浏览器 profile 目录（默认 <data-dir>/browser-profile）。\n' +
          '  --timeout-min    登录等待上限分钟（默认 15）。',
      )
      process.exit(0)
    }
  }
  return out
}

/** Resolve the target article URL from a push's AUTH_REQUIRED paper. */
function paperUrlFromPush(db, pushId) {
  const row = db
    .prepare(
      `SELECT ua.paper_id FROM user_actions ua
       JOIN pushes p ON p.id = ua.push_id
       WHERE ua.push_id = ? AND ua.state = 'open'
         AND ua.kind IN ('publisher_login', 'carsi_relogin')
         AND ua.paper_id IS NOT NULL
       ORDER BY ua.id DESC LIMIT 1`,
    )
    .get(pushId)
  if (!row) return null
  const paper = db.prepare('SELECT doi, url FROM papers WHERE id = ?').get(row.paper_id)
  if (!paper) return null
  if (paper.doi) return `https://doi.org/${encodeURIComponent(paper.doi)}`
  return paper.url || null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const provider = new PublisherBrowserProvider({
    dataDir: args.dataDir,
    enabled: true,
    minIntervalMinutes: 120,
    headless: false,
    timeoutMs: 90000,
    profileDir: args.profileDir ?? DEFAULT_PROFILE_DIR,
    userAgent: DEFAULT_CARSI_USER_AGENT,
  })
  const carsi = new CarsiPdfProvider({
    dataDir: args.dataDir,
    enabled: true,
    minIntervalMinutes: 120,
    headless: false,
    timeoutMs: 90000,
    profileDir: args.profileDir ?? DEFAULT_PROFILE_DIR,
    userAgent: DEFAULT_CARSI_USER_AGENT,
  })

  if (args.check) {
    const status = await provider.sessionStatus()
    console.log('Publisher Browser 会话状态：')
    console.log(`  浏览器可用:   ${status.available ? '是' : '否（playwright/chromium 未安装）'}`)
    console.log(`  profile:      ${status.profileDir}`)
    console.log(`  上次认证:     ${status.lastAuthAt ?? '从未'}`)
    console.log(`  上次尝试:     ${status.lastAttemptAt ?? '从未'}（outcome=${status.lastOutcome ?? '-'}）`)
    console.log(`  尝试总数:     ${status.attemptsCount}`)
    process.exit(status.available ? 0 : 2)
  }

  // resolve target URL (explicit --url, or the push's stuck paper)
  let openUrl = args.url
  if (!openUrl && args.push !== undefined) {
    const db = openDb(args.dataDir)
    openUrl = paperUrlFromPush(db, args.push)
    db.close()
    if (!openUrl) {
      console.error(`❌ push #${args.push} 没有找到待登录的论文（无 open publisher_login/carsi_relogin 待办或论文无 DOI/URL）。`)
      process.exit(1)
    }
    console.log(`push #${args.push} 的待登录论文 → ${openUrl}`)
  }

  console.log('———————————————————————————————————————————————————————————')
  console.log('Publisher Browser 人工登录（Human-in-the-loop）')
  console.log('———————————————————————————————————————————————————————————')
  console.log(`浏览器即将打开${openUrl ? `：${openUrl}` : '出版社/机构门户'}（使用独立持久 profile）`)
  console.log(`  ${provider.getProfileDir()}`)
  console.log('步骤：')
  console.log('  1. 在页面中完成合法登录（账号密码/扫码/机构身份认证）；')
  console.log('  2. 确认文章/全文可以访问后，回到本终端按 Enter 结束；')
  console.log('  3. 会话自动保存，后续自动推送可复用。')
  console.log('⚠️ 本工具绝不自动填写账号、密码、验证码或学校认证信息。')
  console.log(`超时上限：${args.timeoutMin} 分钟（可随时按 Enter 提前结束）。`)
  console.log('———————————————————————————————————————————————————————————')

  const done = new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', resolve)
  })

  // Headed open via the same persistent profile; wait for Enter.
  const { launchPersistentBrowser } = await import('../lib/providers/browser_lib.js')
  let browser = null
  try {
    browser = await launchPersistentBrowser(provider.getProfileDir(), {
      headless: false,
      userAgent: DEFAULT_CARSI_USER_AGENT,
    })
    const page = await browser.newPage()
    await page.goto(openUrl ?? 'https://www.google.com', {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(args.timeoutMin * 60 * 1000, 60000),
    }).catch((err) => {
      console.warn(`⚠️ 初始页面加载异常（可忽略，若页面已打开请继续）: ${String(err).slice(0, 120)}`)
    })
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('登录等待超时')), args.timeoutMin * 60 * 1000),
      ),
    ])
    provider.markAuthenticated()
    carsi.markAuthenticated()
    console.log('✅ 认证完成，会话已保存到独立 profile。')
  } catch (err) {
    console.error(`❌ 认证未完成：${String(err)}`)
    process.exit(1)
  } finally {
    if (browser) await browser.close().catch(() => undefined)
  }

  // Human-in-the-loop: resolve every parked publisher/carsi login action.
  try {
    const db = openDb(args.dataDir)
    let n = resolveUserActionsByKind(db, 'publisher_login')
    n += resolveUserActionsByKind(db, 'carsi_relogin')
    if (n > 0) {
      console.log(`✅ 已自动标记 ${n} 个登录待办为完成——对应推送可用 --resume 从原步骤继续。`)
    }
    db.close()
  } catch (err) {
    console.warn(`⚠️ 自动标记待办失败（可手动用 dsh-literature-actions resolve 完成）：${String(err)}`)
  }
  if (args.push !== undefined) {
    console.log(`\n继续推送：node bin/dsh-literature-push.mjs --resume ${args.push}`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
