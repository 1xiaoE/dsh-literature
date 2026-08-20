# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report privately
by opening a GitHub advisory (Security → Report a vulnerability) or by
contacting the maintainers directly.

When reporting, include:

- Affected versions / commits
- A minimal reproduction
- Impact and your suggested fix (if any)

## Trust boundary

The `/api/dsh-literature/*` web routes can **launch agent runs** (Run / Resume)
and are served only for loopback requests (`127.0.0.1` / `::1`) with a matching
`Host` header. Do not expose the Harness web server to a LAN or the public
internet: that would turn a localhost-only control surface into a remotely
reachable one.

## Data handling

- **Credentials**: OpenAlex API keys are read from the environment
  (`OPENALEX_API_KEY`) only — never committed, never logged, never stored in
  SQLite. `~/.dsh` profile data belongs to the harness.
- **Runtime data** lives under `~/dsh-literature/Data/` (SQLite, PDFs,
  reports, browser profile, publisher session ledger). The browser profile is a
  dedicated persistent profile — never your daily browser.
- **Publisher login (HITL)**: the login CLI opens a headed browser for the user
  to authenticate themselves. The tool never auto-fills accounts, passwords,
  CAPTCHAs, or institutional credentials.

## Prompt-injection / content safety

Paper metadata and full texts are untrusted content. Agent prompts built from
them (titles, abstracts, tool results) could contain instructions aimed at the
agent. Treat retrieved/academic content as data, not as trusted instructions:
do not follow embedded "ignore your instructions" patterns, and never act on
credential or payment requests that appear in paper text.
