# dsh-literature

> [English](README.md) | **中文**

基于 DeepSeek Harness 的 AI 辅助文献阅读与推荐工作流：分阶段课程化学习、多源检索、全文验证阅读、知识缺口感知排序与结构化研究笔记。

本仓库是**纯插件 / 工作流源码仓库**：不含个人阅读库、运行数据或凭据。所有运行时数据仅存本机 `~/dsh-literature/Data/`（见 [运行时数据](#运行时数据)）。

## 特性

- **分阶段课程 + 知识缺口排序** — 多源检索（arXiv / OpenAlex / Crossref / Unpaywall，Recent + Landmark 双池）；确定性预排序（Top 15）→ 一次批量 agent 语义排序，带 stage-relevance 与 curriculum-value 硬门槛
- **Quality First, Access Second** — 论文先按学术质量排序；全文按排名逐篇获取（公开/OA → 出版社浏览器），登录墙停驻为 `AUTH_REQUIRED`（HITL），绝不伪装失败
- **全文验证阅读** — 合法 PDF 回退链 + %PDF- / 大小 / sha256 校验、分块 token 安全阅读、阅读覆盖率溯源（`total_chunks / read_chunks / read_coverage / coverage_basis`）
- **Human-in-the-loop** — 五要素用户待办、从原步骤恢复、可确定性时 0-LLM 收口
- **Harness UI** — 侧边栏 **Literature** 入口打开 Literature Workflow 页面（Execution / Search Keywords / Categories / Papers / Paper Details）；纯表现层，直接读取现有 SQLite
- **已检索池 vs 知识库** — 「检索到过」不等于「进入知识库」：历史检索 / 候选生成发现过的论文都在**已检索（Retrieved）**池（候选/搜索历史）；**知识库（Library）**只含用户真正拥有的论文——工作流 Selected、手动导入 PDF、或有实际内容（PDF / 精读 / 报告 / 收藏 / 人工分类）
- **知识库范围的研究领域** — 研究领域与研究主题只统计、只筛选知识库论文；仅被检索的候选永不污染分类；自动分类在 SELECTED / 手动导入时触发，而非检索时
- **安全删除检索记录** — 已检索页面支持单条 / 批量删除检索历史；知识库论文受保护（其 Selected / PDF / 精读 / 报告 / 分类 / 收藏一律不动），只有真正孤立的检索论文元数据可被清理
- **收藏** — 一等知识库信号（`papers.is_favorite`），与论文分类联动；计入工作流计数、保护论文免于孤立清理、可在论文详情面板切换
- **文献库组织** — 研究领域分类、本地 PDF 导入、无推送深读（deep-read），全量 SQLite 溯源

## 架构

```
topic → 检索（Recent + Landmark）→ 去重 → 预排序（Top 15）
      → 批量语义排序 → 质量门槛 → 全文 preflight
      → 验证 PDF → 分块索引 → 有界阅读 → 报告（插件侧写入）
      → literature_record（溯源 + 阶段推进）→ 历史
```

- **模型无关**：插件自身不调用 LLM；智能环节由 harness 路由的 agent 执行。
- **数据/代码分离**：源码与构建产物留在仓库，运行数据仅存于 `~/dsh-literature/Data/`。
- **插件边界**：作为 DeepSeek Harness 插件安装，从不修改 harness core。

## 环境要求

- Node.js >= 22.19、pnpm、`pdftotext`（poppler-utils）
- DeepSeek Harness checkout（外部依赖，不随本仓库分发）
- 可选：机构访问（publisher_browser / legacy CARSI）需要 `playwright` + Chromium

## 安装

```sh
git clone https://github.com/1xiaoE/dsh-literature.git
cd dsh-literature
pnpm install      # `prepare` 自动执行 pnpm build；可用 DSH_LIT_SKIP_PREPARE=1 跳过
pnpm build        # 显式构建（tsc → lib/ + 客户端 bundle）——link 前必须执行
dsh plugin --profile web add link:/path/to/dsh-literature
```

仓库只提交源码（`lib/` 被 git 忽略），全新 clone 必须先构建才能加载插件。`prepare`/`prepack` 会在安装/打包时为消费者自动构建；`pnpm build` 随时可再跑。

## 配置

完整配置 schema 见 `cordis.patch.yml` 与 `DESIGN.md`（主题、阶段、知识目标、排序权重、阈值、`publisherBrowser` 块、legacy `carsi` 块）。

| 键 | 默认 | 含义 |
|---|---|---|
| `publisherBrowser.enabled` | `true` | 通用出版社浏览器机构访问总开关 |
| `publisherBrowser.minIntervalMinutes` | `2` | 按出版社域名限流（IEEE ≠ Springer）；登录后清除，resume 立即重试 |
| `carsi.enabled` | `false` | LEGACY CARSI 门户导航 — 仅供历史/测试 |
| `ranking.fulltextAvailability` | `0.03` | OA 可得性仅是获取成本提示，绝非质量信号 |
| `fulltext.minReadCoverage` | `1.0` | completed 前最低全文阅读覆盖率；默认要求所有 indexed chunks 均读过 |
| `retrieval.maxQueriesPerPool` | `8` | 普通检索源每个 pool 的均衡 query 上限 |
| `retrieval.arxivMaxQueriesPerPool` | `4` | arXiv 每个 pool 的更严格 query 上限（保留串行礼貌间隔） |
| `retrieval.sourceConcurrency` | `4` | 非 arXiv 检索源的有界并发数 |

### OpenAlex API key（可选但推荐）

```sh
export OPENALEX_API_KEY='YOUR_KEY'
```

仅从环境变量读取——不写入源码、日志、SQLite 或 Git。配额查询：`node bin/dsh-literature-openalex-status.mjs`。仓库提供 `.env.example` 模板；切勿提交真实 `.env`。

## 使用

```sh
node bin/dsh-literature-push.mjs --profile <profile> --topic "<你的主题>"  # 首次推送：选择自己的主题
node bin/dsh-literature-push.mjs --profile <profile>                         # 后续推送：复用已保存的学习主题/阶段
node bin/dsh-literature-push.mjs --resume <pushId>          # 恢复（可确定性时 0-LLM）
node bin/dsh-literature-actions.mjs list | resolve <id>     # Human-in-the-loop 待办
node bin/dsh-literature-browser-login.mjs --push <pushId>   # 出版社登录墙（HITL）
node bin/dsh-literature-browser-login.mjs --url <article>   # 为指定文章页登录
node bin/dsh-literature-browser-login.mjs --check           # 浏览器会话状态
```

首次新推送必须输入主题。插件会把主题随 push 持久化，后续省略主题时沿用当前学习阶段；显式传入 `--topic` 可切换学习主线。模型 adapter、provider、model 与凭据均由所选 Harness `--profile` 决定。

Web UI 运行时，文献工作流会在同一个正在运行的 Harness profile 内创建临时 Agent，直接使用 Harness 模型对话框当前选择的 provider/model，以及该 profile 的 adapter 和凭据。插件不会提供 provider、model 或凭据，也不会在错误后偷偷切换 provider。命令行 runner 仍是独立自动化入口：未配置专用 profile 时使用 `headless`；需要专用 profile 时，在启动宿主进程的环境中设置 `DSH_LITERATURE_PROFILE=<工作流profile>`，并在 Harness 中自行安装和配置它。

文献工作台中的模型选择器会把选中的 provider/model 写入当前 Harness profile 的默认模型设置；下一次 Web 工作流会使用这一精确选择，不会改变正在运行的工作流。provider 安装和凭据仍由 Harness 管理；选择当前 profile 不可用的模型时返回 `INVALID_MODEL`，不会自动切换到其他 provider。

> **手动 PDF 剪切入库**：登录墙/限流时，用户在浏览器里手动下载论文 PDF 到 `~/Downloads`，再把路径告诉 agent；agent 调用 `literature_fetch_pdf(pushId, paperId, manualPdfPath=<路径>)` 校验后**剪切**进知识库（源文件不再残留）。详见 [Human-in-the-loop](#human-in-the-loop)。

### 每篇候选的全文获取顺序

```
Rank #1 → 质量门通过？→ public/OA 链（arXiv / OpenAlex OA / Unpaywall / 出版社公开 PDF）
  ├─ 可得 → SELECTED
  └─ 不可得 → publisher_browser（DOI 直连 → 出版社文章页 → PDF）
       ├─ PDF_OK → SELECTED
       ├─ AUTH_REQUIRED（登录墙）→ HITL 停驻，绝不跳过高质量 Rank#1 去选低质量 OA Rank#2
       │    └─ 用户登录（browser-login）或自行下载 PDF
       │         → literature_fetch_pdf(manualPdfPath) 剪切入库（move）→ SELECTED
       ├─ ACCESS_DENIED（403 / 无订阅）→ 下一排名候选
       └─ PDF_NOT_FOUND → 下一排名候选
然后 Rank #2、#3…… — 一旦 SELECTED 立即停止后续获取（每推送 ≤ 1 篇）
```

## 文献库组织

与工作流主题相互独立：`categories` / `paper_categories` 按研究领域组织文献库（确定性、本地分类），而 `pushes` / `stages` 保留各自的课程语义。

- **研究领域** — 论文可标记领域（自动或手动）；计数与管理在 Harness UI 的 Categories 面板中提供
- **本地 PDF 导入** — 直接导入 PDF 入库存档（`/api/dsh-literature/import-pdf` 二进制上传）；元数据经现有源适配器补全（`lookupMetadata`，优先 DOI），不创建 push
- **Deep read** — 对已有 PDF 无推送重读（`/papers/:id/deep-read`），复用全文索引 / 分块阅读 / 报告存储
- **报告表** — 每次工作流或 deep-read 报告都记录到 `reports`；阅读任务状态见 `paper_reading_jobs`

## 知识库与已检索池

「检索到过」≠「进入知识库」。

```
              已检索池 RETRIEVED（候选/历史池）
                      │
        ┌─────────────┴─────────────┐
        │                           │
   未选择候选                    SELECTED
        │                           │
        │                           ▼
        │                     知识库 LIBRARY ──► 自动分类 ──► 研究领域
        │
        └── 可以清理（孤立检索论文）
```

- **已检索（Retrieved，UI 左侧第一个分类）**：历史检索 / 候选生成中发现过的论文——`papers` 行 + `retrievals` / `candidates` 历史。它本质是候选池 / 搜索历史，不是正式知识库。
- **知识库（Library）**：`isLibraryPaper` 为真的论文——**Selected**（`candidates.selection_outcome='SELECTED'`）、**手动导入 PDF**（`fetch_log.access_type IN ('manual','manual_upload')`）、有可用 PDF / fulltext / read / report、**收藏**（`papers.is_favorite=1`）、或带 **manual category**。Read/report/favorite 行只可能因论文已入库而存在，因此作为旧数据兼容保护条件。
- **研究领域 / 研究主题只统计知识库**：仅被检索的候选不参与自动分类、不进研究领域与长期主题统计。`resolvePaperFields` 仅在论文进入知识库时（SELECTED / 手动导入）触发；对仅检索论文会清理其历史 auto 分类。
- **安全删除检索记录**：`已检索` 页面支持单条 / 批量删除。删除只移除 `retrievals` 与（非 SELECTED 的）`candidates` 历史——知识库论文的 Selected / PDF / 精读 / 报告 / 分类 / 收藏全部保留；SELECTED 候选行是论文的入库凭证，被保留。只有真正孤立的仅检索论文（`isPaperOrphaned`：无剩余引用、非知识库、无 open user action）才可清理其 `papers` 行。批量删除逐条执行保护检查，绝不 `DELETE FROM papers WHERE id IN (...)`，并返回 `removedRetrievedCount / protectedLibraryCount / orphanPaperDeletedCount / failedCount`。

## 课程（Curriculum）

每个阶段定义 scope、关键词、知识目标、`requiredGoals` 与 curated landmark seeds。当论文数达标但 required goal 未覆盖时进入 completion mode：只有全文真正覆盖该目标（agent 判断，非关键词命中）的论文才能毕业。

## 检索源

| 源 | 作用 |
|---|---|
| arXiv | 候选 + 开放 PDF（串行调度、去重、429 熔断） |
| OpenAlex | 元数据 / 引用 / OA 位置（环境变量 API key） |
| Crossref | DOI 元数据 + 出版社链接 |
| Unpaywall | 合法 OA 位置 |
| publisher_browser（默认） | 机构访问：通用出版社浏览器直连 — **Quality First, Access Second**，**≠ 开放获取**，仅私人文献库 |
| CARSI（legacy，默认关闭） | 保留历史/测试；需在 `carsi.enabled` 显式开启 |

## 全文处理

**Quality First, Access Second**：论文先批量语义评分并由 `literature_rank_candidates` 固化唯一 `agent_rank`；之后由代码状态机逐篇完成整条 acquisition chain，agent 无法跳 Rank。每篇候选顺序：公开/OA preflight → 公开下载链 → publisher_browser（DOI 直连 → 出版社文章页 → PDF）。`AUTH_REQUIRED` 与 `RATE_LIMITED` 都会停留在当前 Rank；只有 `ACCESS_DENIED / PDF_NOT_FOUND / FULLTEXT_UNAVAILABLE / PDF_FAILED` 等明确论文级终态才允许进入下一 Rank。登录墙将推送停驻为 `AUTH_REQUIRED`（HITL：`bin/dsh-literature-browser-login`），绝不伪装失败。每次下载均验证（HTTP / Content-Type / %PDF- 魔数 / 非 HTML 登录页 / 大小 / sha256）；文本分块后 token 安全阅读；每次推送记录 `total_chunks / read_chunks / read_coverage / coverage_basis`。

## Human-in-the-loop

资源/认证/权限类问题将推送停驻为五要素待办（卡在哪步 / 缺什么 / 试过什么 / 用户做什么 / 如何继续），绝不把 `AUTH_REQUIRED` 误记为 `FULLTEXT_UNAVAILABLE`；用户处理后从原步骤恢复——复用已持久化的候选、评分与抓取日志。

登录流程：

```sh
# 1. 推送因 AUTH_REQUIRED 停驻（kind=publisher_login）
node bin/dsh-literature-actions.mjs list          # 查看五要素待办
# 2. 用同一持久 profile 的 headed 浏览器打开文章页
node bin/dsh-literature-browser-login.mjs --push <pushId>
#    （自行完成合法登录——工具绝不代填凭据）
# 3. 从原步骤恢复，不重新检索 / 不重新排序
node bin/dsh-literature-push.mjs --resume <pushId>
```

登录会清除全部限流时间戳，同一论文可立即重试。若登录成功但机构无订阅权限，provider 报告 `ACCESS_DENIED`，管线继续下一排名候选。

手动下载流程（自动浏览器仍无法获取 PDF 时的首选路径）：

```sh
# 1. 推送停驻期间（AUTH_REQUIRED / RATE_LIMITED 等），你在 headed 浏览器
#    中自行下载文章 PDF → 保存到 ~/Downloads
# 2. 把文件路径交给 agent（如「已下载到 ~/Downloads/xxx.pdf」），
#    它调用 literature_fetch_pdf(pushId, paperId, manualPdfPath=<路径>)
# 3. PDF 经校验（%PDF- / 大小 / sha256）后**剪切（move）**进知识库
#    pdfs/<sha256>.pdf —— ~/Downloads 副本随即移除，不留重复文件
# 4. 恢复后照常进入全文索引 + 精读 + 报告
```

手动登记的 PDF 记录为 `access_type=manual`、`is_open_access=0`（私人、非 OA 获取），其溯源（原路径、sha256、moved 标志）保留在 `fetch_log`。

## 运行时数据

```
~/dsh-literature/Data/
├── literature.db      # SQLite 溯源（papers / pushes / categories / reports / …）
├── pdfs/<sha256>.pdf  # 内容哈希存储
├── cache/             # 适配器缓存
├── reports/           # canonical 精读报告
├── browser-profile/   # 专用出版社浏览器（绝不使用日常浏览器）
├── publisher_browser/ # per-domain 限流 ledger
└── carsi/             # legacy CARSI ledger（默认禁用）
```

## Harness UI（Literature Workflow）

侧边栏 **Literature** 入口打开 **Literature Workflow** 页面：**Execution**（真实 push 状态，含 `AUTH_REQUIRED` 卡片与 Open Publisher / Resume）、**Search Keywords**（Run / Resume 调用现有 CLI runner）、**Categories**（workflow + 研究领域 + workflow 主题）、**Papers**（真实 SQLite 记录，带 agentRank / score / SELECTED / PDF / READ / REPORT 标记）、**Paper Details**（真实字段按 schema 映射，缺失字段显示 `-`）。UI 只是表现层——所有数据都来自本插件 node 半端提供的 `/api/dsh-literature/*` 路由，这些路由直接读取**现有** SQLite。没有第二套数据库、没有重新实现 retrieval/ranking/acquisition、没有复制独立 workflow。

- `src/ui/` — node 半端适配层 + HTTP 路由（dashboard、push 状态、论文、PDF/报告流式预览、本地 PDF 导入、研究领域管理、deep-read、run/resume）
- `src/client/` — 浏览器半端：侧边栏入口 + 工作台 React 树（view-model 驱动的各面板）
- 路由家族不可达时，开发构建可使用明确标注的 **Demo** 数据；production 显示 **后端不可用** 与 **重试**，不会静默用 mock 替代真实数据

在 GUI 中打开：重启 `dsh web`（client bundle 在启动时被发现），然后点击侧边栏书本形 **Literature** 入口。

## 开发

```sh
pnpm typecheck   # node 半端 + client 半端（tsconfig.json + tsconfig.client.json）
pnpm build       # tsc → lib/，再 tsdown → lib/client.js（Harness UI bundle）
pnpm test        # vitest
pnpm watch       # tsdown --watch（client bundle HMR）
```

PDF 文本提取依赖 Poppler 的 `pdftotext`。Debian/Ubuntu 请安装
`poppler-utils`；CI 会在测试前自动安装该软件包。

## 测试

Quality-First Rank 硬状态机、PDF 回退链、per-domain 非滑动限流（RATE_LIMITED）、publisher-browser 登录墙分类（AUTH_REQUIRED / ACCESS_DENIED / PDF_NOT_FOUND）、%PDF- / 大小 / sha256 校验、手动 PDF 剪切入库（源文件移入知识库）、机构/手动 provenance（`is_open_access=false`）、分块、排序（OA 与质量解耦）、阶段/毕业门槛、priority-goal 匹配、HITL + 恢复（不重检索/重排序）、报告写入 + 确定性收口、OpenAlex 认证隔离、arXiv 调度/去重/429、迁移（空库初始化 + v13→v14 手动 provenance、v15 acquisition state、v17 文献库组织）、UI adapter / routes / client view-model + 组件、lossless-JSON 输出边界。

## 当前状态

**V0.1** — 稳定；工作流/插件源码仓库，非独立应用。已在真实非 OA 论文上端到端 smoke test（IEEE T-RO 经机构/手动登录获取；出版社登录墙 HITL 流程已验证）。Harness UI 与文献库组织层（schema v17）已发布。

## Roadmap

Zotero 集成 · 更多检索源 · GUI 调度 · PDF 视觉理解。

## 许可与内容权利

本仓库的源代码以 [MIT License](LICENSE) 发布，按“原样”提供且不提供担保；
复制代码的重要部分时，请保留版权与许可声明。完整且具有约束力的许可文本
见 [`LICENSE`](LICENSE)。

本项目还会处理第三方材料。元数据、摘要、出版社页面、PDF 与补充材料的
权利及使用条件，仍分别受其提供方、出版社、作者或其他权利人的约束。
`手动导入` / 本地导入只记录来源，不授予访问权，也不代表文档为开放获取。

- 仅导入、下载、阅读和分享你依法有权访问的文档；遵守机构订阅、作者分享
  条款、服务商条款、访问频率限制与版权限制。
- 不得借助浏览器/登录流程绕过访问控制、共享凭据，或再分发非开放获取 PDF。
  项目刻意要求用户自行完成合法认证。
- 报告与摘要仅用于辅助研究，不能替代原始文献。引用、发布或再分发内容前，
  请核实事实、引用原作，并确认适用的许可条件。

第三方依赖仍适用其各自许可证；分发衍生构建前请查阅相应声明和包元数据。
本节是操作与权利提示，不构成法律意见。
