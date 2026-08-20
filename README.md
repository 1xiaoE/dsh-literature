# dsh-literature

> **English** | [中文](README.zh.md)

An AI-assisted literature workflow plugin for DeepSeek Harness. It combines
multi-source retrieval, staged learning, quality-first full-text acquisition,
structured reading reports, and a Literature workbench UI.

## Status

This repository contains plugin and workflow source code. It is not a
standalone application. The project is under active development; the current
database migration level is schema v22.

The repository does not contain a reading library, runtime database, PDFs, or
credentials. Runtime data is kept outside the repository at
`~/dsh-literature/Data/` and is ignored by Git.

## What it provides

- Retrieval from arXiv, OpenAlex, Crossref, and Unpaywall.
- Staged ranking with curriculum and knowledge-gap signals.
- Verified PDF acquisition, chunked full-text reading, and provenance.
- Publisher-browser and manual-download flows for lawful institutional access.
- Human-in-the-loop actions with resumable workflow state.
- Library organization, local PDF import, deep read, and research fields.
- A Harness UI for workflow status, papers, reports, categories, and actions.

The plugin itself does not call an LLM. Model selection, providers, and
credentials remain owned by the Harness profile.

## Requirements

- Node.js >= 22.19
- pnpm
- Poppler's `pdftotext` (`poppler-utils` on Debian/Ubuntu)
- A DeepSeek Harness checkout (installed separately)
- Optional: Playwright and Chromium for publisher-browser access

## Install

Replace `YOUR_REPOSITORY_URL` with the public repository URL:

```sh
git clone YOUR_REPOSITORY_URL
cd dsh-literature
pnpm install
pnpm build
dsh plugin --profile web add link:/path/to/dsh-literature
```

The repository tracks source files only. `lib/` is generated and ignored, so
build the project before linking it into Harness.

## Configure and run

Configuration is defined in `cordis.patch.yml`. An OpenAlex API key is
optional and is read only from the environment:

```sh
export OPENALEX_API_KEY='YOUR_KEY'
node bin/dsh-literature-openalex-status.mjs
```

Typical commands:

```sh
node bin/dsh-literature-push.mjs --profile <profile> --topic "<topic>"
node bin/dsh-literature-push.mjs --profile <profile>
node bin/dsh-literature-push.mjs --resume <pushId>
node bin/dsh-literature-actions.mjs list
node bin/dsh-literature-browser-login.mjs --check
```

The first push needs a topic. Later runs can reuse the saved topic and stage.
The Web UI uses the provider and model selected in the active Harness profile.

## Runtime data and access

Runtime files are stored under `~/dsh-literature/Data/`, including the SQLite
database, PDFs, caches, reports, and isolated browser profiles. Do not commit
`.env` files, credentials, browser profiles, databases, or PDFs.

Use publisher and institutional access only when legally entitled. The
browser-login and manual-PDF flows do not bypass access controls or grant
redistribution rights. Third-party papers remain subject to their own terms.

## Development

```sh
pnpm typecheck
pnpm build
pnpm test
```

The test suite covers retrieval adapters, ranking and stage gates, PDF and
full-text handling, resumable actions, migrations, CLI behavior, and the UI
adapter/client.

## License

Source code is released under the [MIT License](LICENSE). Third-party
dependencies and research materials retain their own licenses and rights.
