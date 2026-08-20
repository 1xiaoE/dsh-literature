# dsh-literature

> [English](README.md) | **中文**

基于 DeepSeek Harness 的 AI 辅助文献工作流插件，提供多源检索、分阶段学习、质量优先的全文获取、结构化精读报告和 Literature 工作台 UI。

## 当前状态

本仓库是插件与工作流源码，不是独立应用，项目仍在持续开发中；当前数据库迁移版本为 schema v22。

仓库不包含个人文献库、运行数据库、PDF 或凭据。运行数据位于仓库之外的
`~/dsh-literature/Data/`，并由 Git 忽略。

## 主要能力

- 支持 arXiv、OpenAlex、Crossref、Unpaywall 检索。
- 支持分阶段排序、课程价值和知识缺口信号。
- 支持 PDF 校验、分块全文阅读和来源溯源。
- 支持出版社浏览器访问及合法的手动下载流程。
- 支持人工介入、待办记录和断点恢复。
- 支持知识库组织、本地 PDF 导入、deep read 和研究领域。
- 提供 Harness UI，用于查看工作流、论文、报告、分类和待办。

插件自身不调用 LLM；模型、provider 和凭据由 Harness profile 管理。

## 环境要求

- Node.js >= 22.19
- pnpm
- Poppler 的 `pdftotext`（Debian/Ubuntu 可安装 `poppler-utils`）
- 单独安装的 DeepSeek Harness
- 可选：用于出版社浏览器访问的 Playwright 和 Chromium

## 安装

将 `YOUR_REPOSITORY_URL` 替换为项目公开仓库地址：

```sh
git clone YOUR_REPOSITORY_URL
cd dsh-literature
pnpm install
pnpm build
dsh plugin --profile web add link:/path/to/dsh-literature
```

仓库只提交源码，`lib/` 为被忽略的构建产物；链接到 Harness 前请先执行构建。

## 配置与使用

配置见 `cordis.patch.yml`。OpenAlex API key 可选，只从环境变量读取：

```sh
export OPENALEX_API_KEY='YOUR_KEY'
node bin/dsh-literature-openalex-status.mjs
```

常用命令：

```sh
node bin/dsh-literature-push.mjs --profile <profile> --topic "<主题>"
node bin/dsh-literature-push.mjs --profile <profile>
node bin/dsh-literature-push.mjs --resume <pushId>
node bin/dsh-literature-actions.mjs list
node bin/dsh-literature-browser-login.mjs --check
```

首次推送需要提供主题，后续运行可以复用已保存的主题和阶段。Web UI 使用
当前 Harness profile 选择的 provider 与 model。

## 运行数据与访问权

运行文件位于 `~/dsh-literature/Data/`，包括 SQLite 数据库、PDF、缓存、报告和
隔离的浏览器 profile。不要提交 `.env`、凭据、浏览器 profile、数据库或 PDF。

仅在依法有权访问时使用出版社或机构资源。浏览器登录和手动 PDF 流程不会绕过
访问控制，也不会授予再分发权；第三方论文仍受其自身许可和版权条款约束。

## 开发

```sh
pnpm typecheck
pnpm build
pnpm test
```

测试覆盖检索适配器、排序与阶段门槛、PDF/全文处理、人工介入与恢复、数据库迁移、
CLI 行为以及 UI adapter/client。

## 许可证

源代码以 [MIT License](LICENSE) 发布。第三方依赖和研究资料仍适用其各自的许可与权利条款。
