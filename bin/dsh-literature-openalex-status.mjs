#!/usr/bin/env node
/**
 * dsh-literature-openalex-status — OpenAlex 配额轻量检查。
 *
 * 使用当前 OPENALEX_API_KEY（或匿名）调用官方 /rate-limit 端点，
 * 只输出四项配额数字，绝不输出 API key。
 *
 *   node bin/dsh-literature-openalex-status.mjs
 *
 * 环境变量：
 *   OPENALEX_API_KEY   可选；存在时以 api_key 认证（日志只显示 configured）
 *
 * 需要先构建 lib：pnpm build
 */
import { fetchOpenAlexRateLimit } from '../lib/sources/openalex.js'

function main() {
  const key = process.env.OPENALEX_API_KEY
  if (key) console.log('OpenAlex API key configured')
  else console.log('openalex_auth_mode=anonymous')
  fetchOpenAlexRateLimit({ timeoutMs: 15000 })
    .then((r) => {
      console.log('--- OpenAlex rate limit ---')
      console.log(`daily budget:  ${r.dailyBudget ?? 'n/a'}`)
      console.log(`used:          ${r.used ?? 'n/a'}`)
      console.log(`remaining:     ${r.remaining ?? 'n/a'}`)
      console.log(`reset time:    ${r.resetTime ?? 'n/a'}`)
    })
    .catch((err) => {
      console.error(`❌ rate-limit 查询失败：${String(err)}`)
      process.exit(1)
    })
}

main()
