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
│   └── dsh-literature-push.mjs             # headless CLI 包装（OS cron 调用）
├── src/
│   ├── index.ts                            # plugin: name/inject/apply/Config
│   ├── config.ts                           # Config schema（主题/阶段/排名权重/路径）
│   ├── db.ts                               # node:sqlite 打开 + 迁移（user_version）
│   ├── sources/
│   │   ├── types.ts                        # SourceAdapter 统一接口 + Candidate/Metadata 类型
│   │   ├── arxiv.ts                        # 适配器：arXiv（预印本 + 开放 PDF）
│   │   ├── openalex.ts                     # 适配器：OpenAlex（metadata/citation/venue/OA location）
│   │   ├── crossref.ts                     # 适配器：Crossref（DOI metadata fallback）
│   │   └── registry.ts                     # 适配器注册/选择/合并去重
│   ├── fetch/
│   │   ├── pdf.ts                          # 多源 fallback 下载 + sha256 + 结果记录
│   │   └── fulltext.ts                     # pdftotext → 分块纯文本 → SQLite
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
└── fulltext/<paper_id>/<seq>.txt          # 分块全文（或存 SQLite，见 schema）
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

## 3. SourceAdapter 统一接口（调整 2）

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

## 4. 两阶段 Ranking（调整 3）

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
| `literature_fetch_pdf` | paper_id | {pdf_path, sha256, source, outcome} | 多源 fallback；后台可选项（V0.1 同步） |
| `literature_fulltext_index` | paper_id | 章节/分块索引 | pdftotext 后分块 |
| `literature_fulltext_read` | paper_id, section/range | 有界纯文本 | token 安全 |
| `literature_record` | push 结果 | 写库 + 阶段推进 | 幂等 |
| `literature_push_now` | — | 工作流指令（阶段化） | 无 LLM；headless agent 执行 |

## 8. Harness 接入（调整 7）

- **挂载**：profile `package.json` `dependencies` 加 `"dsh-literature": "file:~/dsh-literature"`，`dsh.profile.bundles` 加 `"dsh-literature"`；`cordis.patch.yml` 可覆盖 config。
- **headless 运行**：`dsh --profile headless --patch ~/dsh-literature/cordis.patch.yml "<task>"`（官方 runner：单次 task → 等静默 → 退出，exit 0/1）。bin 包装此调用，供 OS cron。
- **不用 ctx.jobs 包 push 流程**；不改 agent-loop、不动 SessionEventMap、不碰 harness core。

## 9. V0.1 Acceptance Criteria

**必须满足**
1. `pnpm build` / `tsc --noEmit` 通过；插件可挂载进 web profile，卸载无残留。
2. 源码 `grep -riE "deepseek|openai|gpt-" src` 0 命中（无硬编码模型）。
3. 一条真实 push 跑通闭环并产出报告归档；报告基于全文。
4. FULLTEXT_UNAVAILABLE 分支：流程停止、状态记录、无虚假精读（有测试）。
5. PDF 多源 fallback：404/403/空正文回退；全失败记录 attempts（有测试）。
6. 去重生效：已推论文 `is_seen=1` 排除或明确标记。
7. SQLite 迁移幂等；运行数据全在 `~/.local/share/dsh-literature/`，`git status` 干净。
8. headless CLI 无 GUI 可用（OS cron 可调）。

**非目标（V0.1）**：GUI cron、Semantic Scholar、Zotero、PDF 视觉理解。
