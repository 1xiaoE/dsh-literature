# Literature Agent V0.1 — 设计定稿

> 状态：已确认（含 8 项调整），编码中。
> 仓库：`~/dsh-literature`（代码）｜ 数据：`~/.local/share/dsh-literature/`（XDG，非 git）

## 0. 架构总原则

1. **模型无关由构造保证**：本插件业务代码**不调用任何 LLM、不写死任何模型 id**。智能环节（排序、选题、全文理解、报告撰写）全部交给 agent 自身完成——Harness 的 agent 由 `ctx.llm` 路由（DeepSeek 或 OpenAI 皆可），插件只提供确定性基础设施（源适配、去重、PDF、全文分块、SQLite、归档）。
2. **数据与代码分离**：代码在 `~/dsh-literature`（git），运行数据在 XDG data 路径。
3. **可安装/可卸载插件**：通过 profile `package.json` 依赖 + `dsh.profile.bundles` 行挂载；移除即卸载。不修改 Harness core。
4. **headless 优先，不嵌套 jobs**：周期触发由 OS cron/systemd timer 直接调用 Harness 官方 headless profile，headless agent 完成一次完整 workflow 后退出。`ctx.jobs` 留给未来 GUI 内后台长任务。

## 1. 目录结构

```
~/dsh-literature/                          # 代码（git 仓库）
├── package.json                           # @dsh-literature；file: 依赖挂进 profile
├── tsconfig.json
├── README.md
├── DESIGN.md                               # 本文件
├── schema.sql                              # SQLite schema（与 db.ts 迁移一致）
├── cordis.patch.yml                        # 挂载补丁（web/headless 共用）
├── bin/
│   ├── dsh-literature-push.mjs             # headless CLI 包装（OS cron 调用；--resume 恢复）
│   ├── dsh-literature-carsi-login.mjs      # CARSI 人工登录 / 会话检查 CLI（独立 profile；成功后自动 resolve carsi 待办）
│   └── dsh-literature-actions.mjs          # NEED_USER_ACTION 待办 list / resolve CLI
├── src/
│   ├── index.ts                            # plugin: name/inject/apply/Config
│   ├── config.ts                           # Config schema（主题/阶段/排名权重/路径/CARSI）
│   ├── db.ts                               # node:sqlite 打开 + 迁移（user_version，现 v9）
│   ├── sources/
│   │   ├── types.ts                        # SourceAdapter 统一接口 + Candidate/Metadata 类型
│   │   ├── arxiv.ts                        # 适配器：arXiv（预印本 + 开放 PDF）
│   │   ├── openalex.ts                     # 适配器：OpenAlex（metadata/citation/venue/OA location）
│   │   ├── crossref.ts                     # 适配器：Crossref（DOI metadata fallback）
│   │   └── registry.ts                     # 适配器注册/选择/合并去重（arxiv→openalex→unpaywall→crossref）
│   ├── providers/
│   │   ├── types.ts                        # PdfProvider 接口 + ProviderResult（AUTH_REQUIRED 等）
│   │   └── carsi.ts                        # CARSI 机构授权 provider（浏览器/会话/登录墙/验证/低频门）
│   ├── fetch/
│   │   ├── pdf.ts                          # 多源 fallback（公开链 → providers → 终态）+ sha256 + 溯源
│   │   └── fulltext.ts                     # pdftotext → 分块纯文本 → SQLite
│   ├── lib/
│   │   ├── paths.ts                        # XDG data 路径解析
│   │   ├── history.ts                      # 去重/已读查询
│   │   ├── stages.ts                       # 阶段进度（target_papers 门控）
│   │   ├── ranking.ts                      # 确定性 pre-ranking（权重配置化）
│   │   ├── report.ts                       # 报告归档到文献库子目录
│   │   └── user_actions.ts                 # NEED_USER_ACTION 待办（open/resolve/五要素）
│   ├── tools/
│   │   ├── literature_sources.ts           # tool：候选检索（结构化 JSON）
│   │   ├── literature_fetch_pdf.ts         # tool：PDF 多源下载
│   │   ├── literature_fulltext_index.ts    # tool：章节索引
│   │   ├── literature_fulltext_read.ts     # tool：按章节/范围读
│   │   ├── literature_record.ts            # tool：推送完成写入历史 + 阶段推进
│   │   └── literature_push_now.ts          # tool：主入口（返回工作流指令，无 LLM）
│   └── lib/
│       ├── paths.ts                        # XDG data 路径解析
│       ├── history.ts                      # 去重/已读查询
│       ├── stages.ts                       # 阶段进度（target_papers 门控）
│       ├── ranking.ts                      # 确定性 pre-ranking（权重配置化）
│       └── report.ts                       # 报告归档到文献库子目录
└── tests/

~/.local/share/dsh-literature/             # 运行数据（非 git）
├── literature.db                          # SQLite (WAL)
├── pdfs/<sha256>.pdf                      # 按内容哈希
├── cache/<adapter>/<query>.json           # 检索缓存
├── fulltext/<paper_id>/<seq>.txt          # 分块全文（或存 SQLite，见 schema）
├── browser-profile/                       # CARSI 独立持久浏览器 profile（绝不触碰日常 profile）
└── carsi/session.json                     # CARSI 会话/低频账本（lastAuthAt/lastAttemptAt/outcome）
```

## 2. V0.1 闭环与数据流

```
topic → search → deduplicate → pre-rank → select → PDF → fulltext index/read
      → analyze → report → history
```

```
OS cron/systemd ──► dsh-literature-push.mjs
        └─► dsh --profile headless --patch cordis.patch.yml "<task>"
                └─► headless agent（官方 runner：建 agent → 提交 task → 等静默 → 退出）
                      ├─ literature_sources(topic)        → 候选 JSON（多适配器合并）
                      ├─ [程序] pre-ranking（确定性）        → Top 8~12
                      ├─ [agent] semantic ranking          → Top 1
                      ├─ literature_fetch_pdf(id)          → PDF 落盘 + sha256
                      ├─ literature_fulltext_index(pdf)    → 分块 + 索引
                      ├─ literature_fulltext_read(sec)     → 按块读取（token 安全）
                      ├─ [agent] 全文精读 → 报告 markdown
                      ├─ 归档到文献库子目录
                      └─ literature_record(...)            → SQLite + 阶段推进
```

**关键约束**：
- 若 fulltext 状态为 `FULLTEXT_UNAVAILABLE`，流程必须停止并如实记录，禁止根据摘要伪装全文精读。
- 全文**绝不一次性**进入上下文：`fulltext_index` 给章节索引，`fulltext_read` 按章节/范围返回有界文本。

## 3. Literature Query Planner（V0.2）

- **Topic normalization**：`TopicDef{id, displayName, canonicalQueries, secondaryQueries, negativeTerms}`；中文显示名仅用于追踪，学术检索全部使用英文 canonical/secondary 查询。
- **Stage-aware query expansion**：查询 = topic 查询 ∪ 当前 stage 的 `searchQueries`；后期 stage 关键词不会污染早期 stage（按构造保证）。
- **Source-specific query style**：
  - OpenAlex：semantic `search=`（官方能力）+ 年份 filter（recent）/ `sort=cited_by_count:desc`（landmark），捕获 `relevance_score`；
  - arXiv：`ti:"q" OR abs:"q"` + 机器人相关 category（cs.RO/cs.LG/cs.AI/eess.SY/math.OC）辅助约束，recent 加 submittedDate 窗口，**不用**宽泛 `all:`；
  - Crossref：仅 bibliographic/DOI/venue 元数据补全，其搜索结果不作为领域相关性真值（search 返回空）。
- **RecentPool / LandmarkPool 分离**（禁止"移除年份过滤"式取巧）：
  - RecentPool：`recent_years` 窗口；
  - LandmarkPool：不限年份，但须通过 `landmarkEligibility`（stage 契合 ≥1 个 preferred 概念 + hint ≥ 阈值 + impact + venue 加分），并按 `landmarkMaxCandidates` 上限截断；高引本身不构成 landmark。
  - 候选带 `candidate_pool = recent | landmark`，合并时 recent 优先标签。
- **候选规模**：多查询合并 raw 30~60 → 去重 → 负向词过滤 + 离题过滤（`minTopicSimilarity`）→ 确定性预排序 Top 15 → agent 语义排序（≥10 篇评分）→ Top 1。
- **Retrieval provenance**：`retrievals` 表保存 generated_query / query_language / source_adapter / retrieval_score / candidate_pool / retrieved_at，可审计"为什么检索到这篇"。
- 确定性预排序权重含 `stageRelevance`（默认 0.3）；stage-excluded 论文预排序分 ×0.6 惩罚。

## 3b. SourceAdapter 统一接口（调整 2）

```ts
interface SourceAdapter {
  readonly name: 'arxiv' | 'openalex' | 'crossref'
  /** 按主题+年份检索候选 */
  search(params: { topic: string; years: number[]; limit: number }): Promise<Candidate[]>
  /** 由 id 补齐元数据（DOI/venue/citation/OA 位置） */
  expand(id: string): Promise<Metadata | null>
  /** 给出合法 PDF 候选 */
  pdfCandidates(id: string): Promise<Array<{ url: string; license: 'oa' | 'author' | 'publisher' }>>
}
```

- V0.1 实现：**arxiv**（预印本 + 开放 PDF）、**openalex**（metadata/citation/venue/OA location）、**crossref**（DOI metadata fallback）。
- **Semantic Scholar 暂缓**（留接口，不实现）。
- `registry.ts` 负责注册、并行检索、按 `doi`/`arxiv_id`/`title` 规范化去重合并；业务逻辑不得散落具体 API 调用。

## 3c. Curriculum Value 与 Knowledge Coverage（V0.3）

- **curriculum_value**：回答"对系统学习当前阶段，这篇论文是否核心/代表性/值得优先读"。agent 评分（foundational importance / method centrality / learning value / representativeness / prerequisite suitability；过于具体的应用/机构设计案例低分）；程序侧给 `curriculum_hint`（centrality 关键词 + 顶级 venue 加分，case-study 词减分）。Fundamentals 阶段 `curriculumWeight=0.35` 提高权重。门槛 `curriculumValueThreshold=0.5`，与 stage_relevance 门控并列强制。
- **Knowledge goals**：每阶段 `knowledgeGoals[{id,label,keywords}]`；Fundamentals 定义 template dynamics / balance & stability / contact & force / impedance & compliance / whole-body locomotion 5 个目标。成功精读论文由 agent 标记覆盖的 goals（`knowledge_coverage` 表 + `stages.covered_goals`）；候选带 `knowledgeGapHint`（未覆盖 goal 的关键词命中数，进入预排序权重）。
- **阶段推进**：`papers_in_stage >= target` 且 `coveredGoals >= minKnowledgeCoverage`（默认 3）双条件满足才推进；`advanceStage=true` 强制。
- **全文选择协议（DB v15 硬状态机）**：BATCH 语义评分后先调用 `literature_rank_candidates` 固化唯一 `agent_rank`；每个质量门达标候选必须按 `RankN → public preflight → public fetch → publisher_browser` 完成整条 acquisition chain 后才可考虑下一 Rank。`AUTH_REQUIRED / RATE_LIMITED` 均停留当前 Rank；仅 `ACCESS_DENIED / PDF_NOT_FOUND / FULLTEXT_UNAVAILABLE / PDF_FAILED` 可下移。`literature_pdf_preflight` / `literature_fetch_pdf` 会硬拒绝跳 Rank，`SELECTED` 后硬停止。
- **Landmark 增强**：`landmark_confidence`（seeds→1.0，否则 eligibility/impact/venue/hint 合成）+ `methodological_centrality`（agent 评分）；`StageDef.landmarkSeeds` 支持每阶段配置少量 curated seeds（接口就绪，暂不建大表）。

## 3d. Selection 语义拆分、Knowledge-gap 引导、Curated Seeds（V0.3 收口）

- **selection 语义拆分**（DB v5）：`agent_rank`（语义排名，final_score 序或 agent 显式指定）与 `preflight_attempt_order`（预检顺序，1-based 连续）分离；`selection_outcome` / `selection_rejection_reason` 独立记录。弃用混义的 `selection_rank`。
- **不变式**（程序强制 + 测试）：语义评分先固化全局 `agent_rank`；`attemptOrder` 必须对应当前最高的质量门达标候选且 1..n 连续；`AUTH_REQUIRED / RATE_LIMITED` 不推进队列；只有论文级终态才推进；一旦 SELECTED 出现，之后不得再有 acquisition；每 push 至多一个 SELECTED。
- **priority knowledge goal**：= 阶段 knowledgeGoals 顺序中第一个未覆盖 goal（Fundamentals 顺序：balance_stability → impedance_compliance → template_dynamics → contact_force → whole_body）。候选带 `priorityGoalMatch`，进入预排序权重 `priorityGoal`（0.1）；agent curriculum 排序同样对 priority goal 匹配显著加权——不绕过质量门。
- **curated landmark seeds**（仅检索/课程锚点，不绕过任何门槛）：Fundamentals 配置 2 颗——VMC（Pratt 2001，goals: impedance_compliance + balance_stability）、Instantaneous Capture Input（Pratt 2006，goals: template_dynamics + balance_stability）。seeds 无条件进入 landmark 池（landmark_confidence=1，curriculum hint 下限 0.75），其标题作为 landmark 检索锚查询；无全文时不强制选择，可扩展相关候选。

## 3e. CARSI 机构授权全文兜底（V0.4，可选 provider）

- **定位**：公开/OA 链（arxiv → openalex OA → unpaywall → crossref publisher）全部失败后、仅对**已过 ranking 质量门**的论文，经 `literature_fetch_pdf(allowCarsi=true)` 最后尝试 CARSI（`ds.carsi.edu.cn`）。CARSI **不是 OA 源**：provenance `source=carsi / access_type=institutional / is_open_access=false`，PDF 仅进私人文献库。
- **架构**：独立 `PdfProvider` 层（`src/providers/types.ts` + `src/providers/carsi.ts`），`fetch/pdf.ts` 只做通用编排（公开候选 → providers 链 → 终态）；CARSI 特例（浏览器驱动、登录墙检测、会话账本、低频门）全部在 provider 内，不散落。
- **浏览器会话**：独立持久 profile `~/.local/share/dsh-literature/browser-profile/`（`launchPersistentContext`），**不读取/复制日常浏览器 Cookie 库**；首次认证用 `bin/dsh-literature-carsi-login.mjs` headed 人工登录，后续 headless 复用；失效返回 `AUTH_REQUIRED`（≠ FULLTEXT_UNAVAILABLE）。
- **状态机（DB v7）**：fetch_log outcome 扩展 `PDF_OK / AUTH_REQUIRED / ACCESS_DENIED / PDF_NOT_FOUND`（表重建扩 CHECK）+ `access_type / is_open_access` 溯源列；pushes status 增加 `auth_required`（表重建）。**cooldown 仅 FULLTEXT_UNAVAILABLE**；AUTH_REQUIRED 永不 cooldown，提示重新登录。
- **下载验证（req 5）**：HTTP 成功 → Content-Type（可得时）→ `%PDF-` magic → 非 HTML 登录页 → ≥ minPdfBytes → sha256 落盘 `pdfs/<sha256>.pdf`。
- **严格低频**：`carsi.{enabled,maxPerPush:1,minIntervalMinutes:120}` + provider 会话账本（`carsi/session.json`）；preflight 不探测 CARSI；每会话一篇论文；不批量抓取。
- **依赖**：`playwright`（npm，动态 import）+ `npx playwright install chromium`（~/.cache/ms-playwright，非系统级）；缺失时 provider 自动降级。

## 3f. Human-in-the-loop（NEED_USER_ACTION，V0.4）

- **触发**：资源访问/认证/权限/下载渠道/研究选择问题且用户比自动化更容易解决时——不盲目重试、不直接判失败。典型：CARSI 失效、出版社需人工登录、PDF 需人工确认入口、经典论文无公开全文但可能有机构访问、多版本无法判断、候选质量不足需调整主题/阶段。
- **状态机（DB v8）**：`pushes.status` 增加 `user_action_required`（CHECK 扩展，表重建）；新表 `user_actions`（step/kind/state open|resolved/issue/attempts/what_user_should_do/how_to_continue）。open 时 push 置 `user_action_required`（errorCode=NEED_USER_ACTION）；全部 resolve 后自动回 `running`。**record 强制校验**：`user_action_required` 必须有 open 待办；`errorCode=AUTH_REQUIRED` 只允许 `auth_required`/`user_action_required`——**禁止把 AUTH_REQUIRED / USER_RESOURCE_NEEDED 误记为 FULLTEXT_UNAVAILABLE**。
- **恢复**：`literature_resume(pushId)` 只读汇报卡点/待办（五要素）+ `resumeFrom`（sources/selection/fetch_pdf/fulltext_index/report/record，纯函数 `inferResumeFrom` 推断）。候选、评分、selection 轨迹、fetch_log 全部持久化——**恢复不重新检索、不重新评分**；唯一例外是用户自己决定调整主题（kind=topic_decision → sources，属用户驱动的重检索而非盲目重试）。
- **用户渠道**：`bin/dsh-literature-actions.mjs list|resolve`（五要素 CLI）；`dsh-literature-carsi-login` 成功后自动 resolve 所有 `carsi_relogin` 待办；`bin/dsh-literature-push.mjs --resume <pushId>` 恢复 headless 推送。手动下载的 PDF 经 `literature_fetch_pdf(manualPdfPath)` 登记（校验 + sha256，source=manual，非 OA）——**剪切语义**：入库后删除用户侧源文件（`~/Downloads` 副本不再残留；rename 优先、跨设备 fallback 复制+删除，失败仅降级并在 reason 中报告）。
- **修复**：`literature_fulltext_index` 现在接受 `PDF_OK`（CARSI/manual 下载的 PDF 可建全文索引）。

## 3g. V0.1 correctness 收口（DB v9）

- **priority_goal_match 写入修复**：此前 `literature_sources` 的 candidate INSERT/UPDATE 不含 `priority_goal_match` 列——preRank 计算并消费了该信号（权重 `ranking.priorityGoal`，默认 0.1），但**从未写入 SQLite**，DB 恒为 DEFAULT 0。修复：INSERT + ON CONFLICT UPDATE 均写入。
- **匹配强度数值化**：`priorityGoalMatchScore(text, goal)` 返回 0~1 强度（0.35/命中概念，封顶 1.0），替代原 0/1 布尔；`preRank` 按数值消费权重。DB v9 将 `candidates.priority_goal_match` 重建为 `REAL NOT NULL DEFAULT 0`（旧 0/1 数据无损保留）。
- **keyword 概念映射补全**：`gait_representation` 增 `gait synthesis / gait pattern / gait cycle / footstep / step-to-step`；`impedance_compliance` 增 `impedance control / compliance control / stiffness control / damper / spring / spring-damper / force position compliance`（此前 Paredes & Hereid 2022 的 "footstep location" 无法命中 gait 概念）。
- **全文阅读 coverage provenance**：`literature_record`（completed）计算并持久化到 pushes；默认 `fulltext.minReadCoverage=1.0`，因此所有 indexed chunks 必须 read 后才能 completed：`total_chunks`（indexed chunk 数）、`read_chunks`（fulltext_reads distinct seq）、`read_coverage`、`coverage_basis`（`full_read` 全部 read；`index_exposed` 未读 chunk 的 preview 已由 `literature_fulltext_index` 暴露——报告必须如实写 M/N，**禁止** read_coverage<1 时声称"全部精读"；`read_log` 无 index）。push_now 指令要求报告记录四字段。

## 3h. Quality-First 硬状态机与确定性收口（DB v15）

- 新增 `literature_rank_candidates`：BATCH 评分完成后一次性持久化语义分数、`final_score` 与稳定唯一的 `agent_rank`，任何 PDF 操作前必须完成。
- `candidates` 新增 `public_preflight_status / acquisition_outcome / acquisition_reason`；`RATE_LIMITED` 是非终态，禁止伪装成 `PDF_NOT_FOUND`。
- publisher_browser 的 per-domain 限流被阻塞时**不再写 lastAttempt**，避免反复重试形成滑动锁死。
- `literature_record` 与 0-LLM `--resume` 共用 `finalizeCompletedPush`：统一校验质量门、SELECTED、全文阅读覆盖、canonical 报告，并在同一事务中完成 `picked / knowledge_coverage / stage progression / completed`。
- 新 push 将规范化配置写入 `pushes.policy_json`；CLI resume 使用创建时 policy snapshot，避免配置漂移。旧 push 无 snapshot 时安全回退到 agent resume。
- 性能计数 flush 仅覆盖明确提供的数值，避免 `undefined` 擦掉 earlier-tool 已记录的 `agentRankingMs / llmCallCount`。
- 检索延迟优化：普通源每 pool 默认最多 8 条均衡 query，并以 `sourceConcurrency=4` 有界并发；arXiv 每 pool 默认最多 4 条均衡核心 query，仍严格保持 ≥3.1 s 串行间隔。以基础阶段原 12+12 planned queries 计，arXiv 最坏请求数从 24 降到 8（无 429 时仅调度等待理论上约从 71 s 降到 22 s）。

## 4. 两阶段 Ranking（调整 3）与 Stage Relevance（约束）

- 每个阶段带 `StageDef`：`label` / `scope` / `preferredKeywords` / `downweightKeywords` / `excludeKeywords`。
- 程序侧计算确定性 `stage_relevance_hint`（关键词重叠，exclude 命中即 0 并标记 `stage_excluded`），随候选返回并落库 `candidates.stage_relevance_hint`。
- agent 语义排序必须给出 `stage_relevance_score`（0~1）并写入 `candidates.stage_relevance_score`，rationale 说明为何适合当前阶段。
- **门控**：`stage_relevance_score < threshold`（默认 0.6）或缺失 → `literature_record` 拒绝 completed；即使 overall impact 很高也不可选为 Top 1。
- **阶段推进只统计真正符合当前阶段的成功论文**（`stage_matched`）；duplicate 与不匹配论文均不计入 `papers_in_stage`。
- `targetPapersPerStage` 默认 **3**。



**Stage A — deterministic pre-ranking（程序侧，无 LLM）**
- 输入：全部候选（已去重）
- 计算：`recency_score`（年份衰减）、`impact_score`（citation 归一化）、`is_seen`（历史去重标记）、`fulltext_availability`（open PDF 是否可得）、`topic_similarity`（标题/摘要关键词重叠）
- 输出：加权总分 → **Top 8~12**
- 权重配置化（`config.ranking`）

**Stage B — agent semantic ranking（模型侧，模型无关）**
- 输入：Top 8~12 候选 + 评分规则
- agent 依据：relevance、learning value、method representativeness、novelty，并参考阅读阶段主线
- 输出：Top 1 + `rationale`

## 5. SQLite schema（调整 4/5/6，见 schema.sql）

- `papers`：主表（含 `metadata_source` 溯源）
- `candidates`：**PRIMARY KEY(push_id, paper_id)** + 6 个评分字段 + `final_score` + `rationale` + `is_seen`
- `fetch_log`：多源尝试记录 + `outcome`（ok / FULLTEXT_UNAVAILABLE / …）+ `sha256` + `pdf_source`
- `fulltexts`：状态 + `parser` + 分块元信息
- `fulltext_chunks`：`PRIMARY KEY(paper_id, seq)`，`section` 索引
- `pushes`：**status ∈ {running, completed, failed, no_candidate, fulltext_unavailable}** + `started_at`/`finished_at`/`error_code`/`error_detail`
- `stages`：按 topic 存 `current` + `papers_in_stage` + `target_papers`（调整 6）

**阶段推进规则（调整 6）**：不自动 +1。`stages.papers_in_stage` 达到 `target_papers`（config 默认 2 篇/阶段）或人工切换（`literature_record` 传 `advance_stage: true`）才进入下一阶段。

## 6. Provenance（调整 8）

报告与数据库统一保留：
| 字段 | 来源 |
|---|---|
| `metadata_source` | 提供元数据的适配器名（arxiv/openalex/crossref） |
| `pdf_source` | 实际下载源 URL + license |
| `pdf_sha256` | 下载后计算 |
| `fulltext_parser` | `pdftotext <ver>` |
| `analyzed_at` | 报告生成时间 |
| `model_route` | 若可用：`ctx.agentDefaultModel.currentSelection()` 的 `{provider, model}`；**业务代码不硬编码模型 id**，取不到则为 null |

## 7. 工具清单（注册于 ctx.tools）

| 工具 | 输入 | 输出 | 备注 |
|---|---|---|---|
| `literature_sources` | topic, years?, limit? | 候选 JSON（含评分字段） | 调 registry；做 pre-ranking 标注 |
| `literature_fetch_pdf` | paper_id, allowCarsi?, manualPdfPath? | {pdf_path, sha256, source, outcome} | 多源 fallback → CARSI → 手动 PDF；AUTH_REQUIRED 等 |
| `literature_fulltext_index` | paper_id | 章节/分块索引 | pdftotext 后分块；接受 ok/PDF_OK |
| `literature_fulltext_read` | paper_id, section/range | 有界纯文本 | token 安全 |
| `literature_record` | push 结果 | 写库 + 阶段推进 | 幂等；HITL 状态强校验 |
| `literature_push_now` | — | 工作流指令（阶段化） | 无 LLM；headless agent 执行 |
| `literature_user_action` | open/resolve + 五要素 | actionId/状态 | NEED_USER_ACTION 注册/完成 |
| `literature_resume` | pushId | 卡点/待办/resumeFrom/指令 | 断点恢复，不重新检索/评分 |

## 8. Harness 接入（调整 7）

- **挂载**：profile `package.json` `dependencies` 加 `"dsh-literature": "file:~/dsh-literature"`，`dsh.profile.bundles` 加 `"dsh-literature"`；`cordis.patch.yml` 可覆盖 config。
- **headless 运行**：`dsh --profile headless --patch ~/dsh-literature/cordis.patch.yml "<task>"`（官方 runner：单次 task → 等静默 → 退出，exit 0/1）。bin 包装此调用，供 OS cron。
- **不用 ctx.jobs 包 push 流程**；不改 agent-loop、不动 SessionEventMap、不碰 harness core。

## 9. 报告存储（约束 5）

- canonical：`~/.local/share/dsh-literature/reports/<阶段>/<作者_年份_关键词>.md`（`libraryRoot` 为空时默认）。
- 不为写 `~/Desktop/文献阅读` 放宽 Harness sandbox；Desktop 导出由外层脚本或 Zotero 同步完成。

## 10. V0.1 Acceptance Criteria

**必须满足**
1. `pnpm build` / `tsc --noEmit` 通过；插件可挂载进 web profile，卸载无残留。
2. 源码 `grep -riE "deepseek|openai|gpt-" src` 0 命中（无硬编码模型）。
3. 一条真实 push 跑通闭环并产出报告归档；报告基于全文。
4. FULLTEXT_UNAVAILABLE 分支：流程停止、状态记录、无虚假精读（有测试）。
5. PDF 多源 fallback：404/403/空正文回退；全失败记录 attempts（有测试）。
6. 去重生效：已推论文 `is_seen=1` 排除或明确标记。
7. SQLite 迁移幂等（v2）；运行数据全在 `~/.local/share/dsh-literature/`，`git status` 干净。
8. headless CLI 无 GUI 可用（OS cron 可调）。

**非目标（V0.1）**：GUI cron、Semantic Scholar、Zotero、PDF 视觉理解。

## 11. Library / Retrieved-pool 分离（DB v18）

**核心不变式**：`检索到过 ≠ 进入知识库`。

- **已检索池（Retrieved）**：`papers` 行 + `retrievals` / `candidates` 历史——候选/搜索历史池，可删除。
- **知识库（Library）**：`isLibraryPaper(db, paperId)` 为真——Selected / 手动导入 PDF / 有 PDF・fulltext・read・report / 收藏 / manual category。Read/report/favorite 只可能因论文已入库而存在，作为旧数据兼容保护。
- **研究领域/主题只统计 Library**：`listResearchFields` 的 count 与 `listCategories` 的 topic 计数均 JOIN `libraryPaperExistsSql('p')`；`listPapers` 的 field 过滤加 Library 限制。仅检索候选永不污染 Research Fields / Topics。
- **分类触发时机**：`resolvePaperFields` 仅对 Library 论文分类；对仅检索论文清理其历史 auto 分类（保留 manual）。触发点：`markAcquisitionOutcome(outcome=SELECTED)`、`importLocalPdf` 成功、`upsertPaper`（内部自行判断）。
- **安全删除检索记录**：`removeRetrievedRecordSafely` / `removeRetrievedBatch` 只删 `retrievals` 与（非 SELECTED 的）`candidates`；**SELECTED 候选行保留**（它是论文入库凭证，删除即丢失 Selected 状态）。Library 论文的 PDF / fulltext / reads / report / categories / favorite 永不随检索历史删除。`isPaperOrphaned`（无剩余引用 + 非 Library + 无 open user action）为真才清理 `papers` 行。批量删除逐条保护检查，绝不 `DELETE FROM papers WHERE id IN (...)`，返回 `removedRetrievedCount / protectedLibraryCount / orphanPaperDeletedCount / failedCount`。
- **收藏**：`papers.is_favorite INTEGER NOT NULL DEFAULT 0`（v18 迁移），`togglePaperFavorite` 切换；favorites 分类 = `is_favorite=1`；收藏即 Library 成员（受孤立清理保护），与论文分类联动（收藏论文出现在详情面板分类与领域统计）。
- **旧数据 backfill**：v18 迁移执行 `cleanRetrievedOnlyAutoCategories`——删除仅检索论文的 auto 分类（保留 manual 与全部 Library 论文分类），幂等。
