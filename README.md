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

## 工具

| 工具 | 作用 |
|---|---|
| `literature_push_now` | 创建推送并返回分步工作流指令 |
| `literature_sources` | 多源检索 + 确定性预排序（权重可配置） |
| `literature_fetch_pdf` | PDF 多源回退下载（sha256 + 溯源） |
| `literature_fulltext_index` | pdftotext → 分块 → 索引 |
| `literature_fulltext_read` | 按块读取（token 安全） |
| `literature_record` | 状态/评分追溯/阶段门控推进 |

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
        targetPapersPerStage: 2
        preRankTopN: 10
        ranking: { recency: 0.2, impact: 0.25, topicSimilarity: 0.3, fulltextAvailability: 0.25 }
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
- `literature.db` — papers / candidates（评分追溯）/ fetch_log / fulltexts+chunks / pushes / stages
- `pdfs/<sha256>.pdf` — 按内容哈希
- `cache/` — 检索缓存
- `push.log` — cron 日志

## 路线图

- [x] V0.1：闭环 + headless CLI + SQLite 溯源
- [ ] GUI 内后台任务（ctx.jobs）与定时面板
- [ ] Semantic Scholar 适配器
- [ ] Zotero 同步（Linux/Windows）
