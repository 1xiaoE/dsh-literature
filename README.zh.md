# dsh-literature

> [English](README.md) | **中文**

基于 DeepSeek Harness 的 AI 辅助文献阅读与推荐工作流：分阶段课程化学习、多源检索、全文验证阅读、知识缺口感知排序与结构化研究笔记。

本仓库是**纯插件 / 工作流源码仓库**：不含个人阅读库、运行数据或凭据。所有运行时数据仅存本机 `~/.local/share/dsh-literature/`（见 [运行时数据](#运行时数据)）。

## 特性

- **分阶段课程 + 知识缺口排序** — 多源检索（arXiv / OpenAlex / Crossref / Unpaywall，Recent + Landmark 双池）；确定性预排序（Top 15）→ 一次批量 agent 语义排序，带 stage-relevance 与 curriculum-value 硬门槛
- **Quality First, Access Second** — 论文先按学术质量排序；全文按排名逐篇获取（公开/OA → 出版社浏览器），登录墙停驻为 `AUTH_REQUIRED`（HITL），绝不伪装失败
- **全文验证阅读** — 合法 PDF 回退链 + %PDF- / 大小 / sha256 校验、分块 token 安全阅读、阅读覆盖率溯源（`total_chunks / read_chunks / read_coverage / coverage_basis`）
- **Human-in-the-loop** — 五要素用户待办、从原步骤恢复、可确定性时 0-LLM 收口
- **Harness UI** — 侧边栏 **Literature** 入口打开 Literature Workflow 页面（Execution / Search Keywords / Categories / Papers / Paper Details）；纯表现层，直接读取现有 SQLite
- **文献库组织** — 研究领域分类、本地 PDF 导入、无推送深读（deep-read），全量 SQLite 溯源

## 架构

```
topic → 检索（Recent + Landmark）→ 去重 → 预排序（Top 15）
      → 批量语义排序 → 质量门槛 → 全文 preflight
      → 验证 PDF → 分块索引 → 有界阅读 → 报告（插件侧写入）
      → literature_record（溯源 + 阶段推进）→ 历史
```

- **模型无关**：插件自身不调用 LLM；智能环节由 harness 路由的 agent 执行。
- **数据/代码分离**：代码在此仓库，运行数据在 XDG 目录。
- **插件边界**：作为 DeepSeek Harness 插件安装，从不修改 harness core。

## 环境要求

- Node.js >= 22.19、pnpm、`pdftotext`（poppler-utils）
- DeepSeek Harness checkout（外部依赖，不随本仓库分发）
- 可选：机构访问（publisher_browser / legacy CARSI）需要 `playwright` + Chromium

## 安装

```sh
git clone https://github.com/1xiaoE/dsh-literature.git
cd dsh-literature
pnpm install
dsh plugin --profile web add link:/path/to/dsh-literature
```

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
node bin/dsh-literature-push.mjs --topic "足式机器人控制"   # 一次完整推送
node bin/dsh-literature-push.mjs --resume <pushId>          # 恢复（可确定性时 0-LLM）
node bin/dsh-literature-actions.mjs list | resolve <id>     # Human-in-the-loop 待办
node bin/dsh-literature-browser-login.mjs --push <pushId>   # 出版社登录墙（HITL）
node bin/dsh-literature-browser-login.mjs --url <article>   # 为指定文章页登录
node bin/dsh-literature-browser-login.mjs --check           # 浏览器会话状态
```

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
~/.local/share/dsh-literature/
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

## 测试

Quality-First Rank 硬状态机、PDF 回退链、per-domain 非滑动限流（RATE_LIMITED）、publisher-browser 登录墙分类（AUTH_REQUIRED / ACCESS_DENIED / PDF_NOT_FOUND）、%PDF- / 大小 / sha256 校验、手动 PDF 剪切入库（源文件移入知识库）、机构/手动 provenance（`is_open_access=false`）、分块、排序（OA 与质量解耦）、阶段/毕业门槛、priority-goal 匹配、HITL + 恢复（不重检索/重排序）、报告写入 + 确定性收口、OpenAlex 认证隔离、arXiv 调度/去重/429、迁移（空库初始化 + v13→v14 手动 provenance、v15 acquisition state、v17 文献库组织）、UI adapter / routes / client view-model + 组件、lossless-JSON 输出边界。

## 当前状态

**V0.1** — 稳定；工作流/插件源码仓库，非独立应用。已在真实非 OA 论文上端到端 smoke test（IEEE T-RO 经机构/手动登录获取；出版社登录墙 HITL 流程已验证）。Harness UI 与文献库组织层（schema v17）已发布。

## Roadmap

Zotero 集成 · 更多检索源 · GUI 调度 · PDF 视觉理解。

## License

License not specified yet.
