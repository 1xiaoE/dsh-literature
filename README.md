# dsh-literature — Literature Agent for DeepSeek Harness

按周期自动检索、筛选、下载、分块精读、总结与归档**科研论文**的 Harness 插件。V0.1 主题：足式机器人控制。

## 设计要点

- **模型无关**：插件代码**不调用任何 LLM、不写死模型 id**。智能环节（语义排序、全文理解、报告撰写）由 Harness 路由的 agent（DeepSeek 或 OpenAI 均可）完成；插件只提供确定性基础设施。
- **数据/代码分离**：代码在本仓库；运行数据在 `~/.local/share/dsh-literature/`（SQLite、PDF、缓存），不进入 git。
- **可安装/可卸载插件**：通过 `dsh plugin --profile <name> add link:<repo>` 安装，不修改 Harness core。
- **headless 优先**：周期推送由 OS cron/systemd 调用 `bin/dsh-literature-push.mjs`，走官方 headless profile 完成一次完整流程后退出。

## 闭环

```
topic → search → deduplicate → pre-rank(Top 8-12) → agent rank(Top 1) → PDF(多源回退)
      → fulltext index → chunked read → analyze → report → history
```

- 全文**绝不一次性**进入上下文：`literature_fulltext_index` 返回章节索引，`literature_fulltext_read` 按块读取。
- 全文不可得时如实记录 `FULLTEXT_UNAVAILABLE`，禁止凭摘要伪装精读。
- 阶段契合门控：`stage_relevance_score` 低于阈值（默认 0.6）的论文不可选为 Top 1；阶段推进只统计符合当前阶段的论文。

## 工具

| 工具 | 作用 |
|---|---|
| `literature_push_now` | 创建推送并返回分步工作流指令 |
| `literature_sources` | 多源检索 + 确定性预排序（权重可配置） |
| `literature_fetch_pdf` | PDF 多源回退下载（sha256 + 溯源；CARSI 兜底；manualPdfPath 手动登记） |
| `literature_fulltext_index` | pdftotext → 分块 → 索引 |
| `literature_fulltext_read` | 按块读取（token 安全） |
| `literature_record` | 状态/评分追溯/阶段门控推进 |
| `literature_user_action` | Human-in-the-loop：注册/完成 NEED_USER_ACTION 待办（五要素） |
| `literature_resume` | 从原步骤恢复被暂停/中断的推送（不重新检索/评分） |

## Human-in-the-loop（NEED_USER_ACTION）

遇到**资源访问 / 认证 / 权限 / 下载渠道 / 研究选择**问题、且你比自动化更容易解决时，流程**不会盲目重试、也不会直接判失败**——进入 `NEED_USER_ACTION` 状态并明确告知五要素：

1. 卡在哪一步（step）
2. 缺少什么资源/权限/信息（issue）
3. 已尝试过哪些方法（attempts）
4. 你需要做什么（whatUserShouldDo）
5. 完成后如何继续（howToContinue）

典型场景：CARSI/学校认证失效、出版社需人工登录、PDF 需人工确认下载入口、经典论文无公开全文但可能有机构访问、多版本无法判断优先、候选论文质量不足需调整主题/阶段。

- **状态**：push 记 `status=user_action_required`（`errorCode=AUTH_REQUIRED / USER_RESOURCE_NEEDED / MANUAL_PDF_NEEDED / VERSION_CHOICE / TOPIC_DECISION` 等）；**不得**把 `AUTH_REQUIRED / USER_RESOURCE_NEEDED` 误记为 `FULLTEXT_UNAVAILABLE`（record 强制校验）。
- **查看/完成待办**：
  ```sh
  node bin/dsh-literature-actions.mjs list                 # 五要素清单
  node bin/dsh-literature-actions.mjs resolve <actionId>   # 处理完成后标记
  ```
  CARSI 重新登录成功（`dsh-literature-carsi-login`）会自动 resolve 所有 `carsi_relogin` 待办。
- **从原步骤继续（不重新检索/评分）**：候选、评分、selection 轨迹、fetch 尝试都已持久化。
  ```sh
  node bin/dsh-literature-push.mjs --resume <pushId>
  ```
  agent 调用 `literature_resume(pushId)` 得到 resumeFrom（sources/selection/fetch_pdf/fulltext_index/report/record）与待办清单后继续。
- **手动下载 PDF**：`literature_fetch_pdf(manualPdfPath=<路径>)` 校验（%PDF-/大小）→ sha256 → 入库（source=manual，非 OA）。

## CARSI 机构授权全文兜底（可选 provider）

公开/OA 链（arXiv → OpenAlex OA → Unpaywall → Crossref 出版社链接）**全部失败**、且论文已通过 ranking 质量门时，`literature_fetch_pdf` 可经 `allowCarsi=true` 最后尝试 **CARSI 机构授权**（`https://ds.carsi.edu.cn`）。

- **非 OA**：provenance 记录 `source=carsi`、`access_type=institutional`、`is_open_access=false`；PDF 只进私人文献库，不标记 OA、不对外发布。
- **独立浏览器 profile**：`~/.local/share/dsh-literature/browser-profile/`（`launchPersistentContext`），**绝不读取/复制日常浏览器 Cookie**。
- **首次认证（一次性）**：
  ```sh
  pnpm build
  node bin/dsh-literature-carsi-login.mjs         # headed 登录，完成后按 Enter
  node bin/dsh-literature-carsi-login.mjs --check # 会话检查
  ```
- **状态**：`PDF_OK`（机构授权下载成功）/ `AUTH_REQUIRED`（会话失效——**不进入 cooldown**，提示重新登录）/ `ACCESS_DENIED` / `PDF_NOT_FOUND` / `FULLTEXT_UNAVAILABLE`。`AUTH_REQUIRED` 的 push 记 `status=auth_required`、`errorCode=AUTH_REQUIRED`。
- **严格低频**：`carsi.enabled`（默认开）、`maxPerPush=1`、`minIntervalMinutes=120`；preflight 不探测 CARSI；不批量抓取。
- **下载验证**：HTTP 成功 → Content-Type（可得时）→ `%PDF-` 文件头 → 非 HTML 登录页 → 最小体积 → sha256。
- 依赖：`playwright`（npm）+ `npx playwright install chromium`（用户缓存，非系统级）；未安装时 provider 自动降级禁用。

## 安装

```sh
# web profile（GUI 会话内使用）
dsh plugin --profile web add link:/home/eternal/dsh-literature
# headless profile（cron 推送用）
dsh plugin --profile headless add link:/home/eternal/dsh-literature
```

卸载：`dsh plugin --profile <name> rm dsh-literature`

## 周期推送（OS cron）

```sh
# 每 2 天 09:00
0 9 */2 * * /usr/bin/env DSH_HARNESS_DIR=/home/eternal/deepseek-harness node /home/eternal/dsh-literature/bin/dsh-literature-push.mjs --install >> ~/.local/share/dsh-literature/push.log 2>&1
```

## 配置（插件行 config，cordis patch 覆盖）

```yaml
- insert:
    - id: literature
      name: 'dsh-literature'
      config:
        topics: ['足式机器人控制']
        libraryRoot: '~/Desktop/文献阅读'
        targetPapersPerStage: 3
        preRankTopN: 10
        ranking: { recency: 0.15, impact: 0.15, topicSimilarity: 0.2, fulltextAvailability: 0.2, stageRelevance: 0.3 }
        agentRanking: { relevance: 0.4, learningValue: 0.3, representativeness: 0.2, novelty: 0.1 }
```

## 开发

```sh
pnpm build       # tsc 构建到 lib/
pnpm typecheck
pnpm test        # vitest
```

## 数据

`~/.local/share/dsh-literature/`
- `reports/` — canonical 精读报告（Desktop 导出由外层脚本/Zotero 处理）
- `literature.db` — papers / candidates（评分追溯）/ fetch_log / fulltexts+chunks / pushes / stages
- `pdfs/<sha256>.pdf` — 按内容哈希
- `cache/` — 检索缓存
- `push.log` — cron 日志

## 路线图

- [x] V0.1：闭环 + headless CLI + SQLite 溯源
- [x] V0.2：Literature Query Planner
- [x] V0.3：curriculum_value / knowledge coverage 门控 / Top-K 全文预检选择 / landmark seeds
- [x] V0.3 收口：selection 语义拆分（agent_rank vs preflight_attempt_order）+ SELECTED 不变式 / priority-goal 知识缺口引导 / curated seeds 锚点（topic 规范化 / stage 感知查询 / Recent+Landmark 双池 / 检索溯源 / 离题过滤）
- [ ] GUI 内后台任务（ctx.jobs）与定时面板
- [ ] Semantic Scholar 适配器
- [ ] Zotero 同步（Linux/Windows）
