# dsh-literature

> [English](README.md) | **中文**

基于 DeepSeek Harness 的 AI 辅助文献阅读与推荐工作流：分阶段课程化学习、多源检索、全文验证阅读、知识缺口感知排序与结构化研究笔记。

本仓库是**纯插件 / 工作流源码仓库**：不含个人阅读库、运行数据或凭据。所有运行时数据仅存本机 `~/.local/share/dsh-literature/`（见 [运行时数据](#运行时数据)）。

## 特性

- **多源检索** — arXiv / OpenAlex / Crossref / Unpaywall；RecentPool + LandmarkPool（支持 curated seeds）
- **两阶段排序** — 确定性预排序（Top 15）→ 一次性批量 agent 语义排序，带 stage-relevance 与 curriculum-value 硬门槛
- **知识缺口引导** — priority knowledge goal 加权；`requiredGoals` 阶段毕业门（仅凭论文数量不能毕业）
- **全文验证阅读** — 合法 PDF 回退链、%PDF- 魔数/大小/sha256 校验、分块 token 安全阅读、阅读覆盖率溯源
- **完整 SQLite 溯源** — 论文、评分轨迹、抓取日志、检索记录、各阶段耗时、阶段、用户待办
- **Human-in-the-loop** — 五要素用户待办、从原步骤恢复、0-LLM 确定性收口
- **headless 优先** — cron 友好 CLI；可选 CARSI 机构授权兜底（**机构授权 ≠ 开放获取**）

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
- 可选：CARSI 兜底需要 `playwright` + Chromium

## 安装

```sh
git clone https://github.com/1xiaoE/dsh-literature.git
cd dsh-literature
pnpm install
dsh plugin --profile web add link:/path/to/dsh-literature
```

## 配置

完整配置 schema 见 `cordis.patch.yml` 与 `DESIGN.md`（主题、阶段、知识目标、权重、阈值、`carsi` 块）。

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
node bin/dsh-literature-carsi-login.mjs                     # 可选 CARSI 登录
```

## 课程（Curriculum）

每个阶段定义 scope、关键词、知识目标、`requiredGoals` 与 curated landmark seeds。当论文数达标但 required goal 未覆盖时进入 completion mode：只有全文真正覆盖该目标（agent 判断，非关键词命中）的论文才能毕业。

## 检索源

| 源 | 作用 |
|---|---|
| arXiv | 候选 + 开放 PDF（串行调度、去重、429 熔断） |
| OpenAlex | 元数据 / 引用 / OA 位置（环境变量 API key） |
| Crossref | DOI 元数据 + 出版社链接 |
| Unpaywall | 合法 OA 位置 |
| CARSI（可选） | 机构授权全文兜底 — **≠ 开放获取**，仅私人文献库 |

## 全文处理

顺序：arXiv/OA → Unpaywall → 出版社链接 →（可选）CARSI → `FULLTEXT_UNAVAILABLE`。每次下载均验证（HTTP / Content-Type / %PDF- 魔数 / 非 HTML 登录页 / 大小 / sha256）；文本分块后 token 安全阅读；每次推送记录 `total_chunks / read_chunks / read_coverage / coverage_basis`。

## Human-in-the-loop

资源/认证/权限类问题将推送停驻为五要素待办（卡在哪步 / 缺什么 / 试过什么 / 用户做什么 / 如何继续），绝不把 `AUTH_REQUIRED` 误记为 `FULLTEXT_UNAVAILABLE`；用户处理后从原步骤恢复——复用已持久化的候选、评分与抓取日志。

## 运行时数据

```
~/.local/share/dsh-literature/
├── literature.db      # SQLite 溯源
├── pdfs/<sha256>.pdf  # 内容哈希存储
├── cache/             # 适配器缓存
├── reports/           # canonical 精读报告
└── browser-profile/   # CARSI 浏览器（绝不使用日常浏览器）
```

## 开发

```sh
pnpm typecheck
pnpm build       # tsc → lib/
pnpm test        # vitest
```

## 测试

PDF 回退链、分块、排序、阶段/毕业门槛、priority-goal 匹配、HITL + 恢复、报告写入 + 确定性收口、OpenAlex 认证隔离、arXiv 调度/去重/429、迁移（空库初始化）、lossless-JSON 输出边界。

## 当前状态

**V0.1** — 稳定；工作流/插件源码仓库，非独立应用。

## Roadmap

Zotero 集成 · 更多检索源 · GUI 调度 · PDF 视觉理解。

## License

License not specified yet.
