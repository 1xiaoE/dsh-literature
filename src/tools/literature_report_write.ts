/**
 * Tool: literature_report_write — the ONLY way the canonical report is
 * persisted. The agent never writes the canonical path through its shell
 * (the harness sandbox may not reach the XDG data dir); the plugin process
 * owns it: mkdir recursive → temp write → atomic rename.
 *
 * On internal write failure the tool returns { ok: false, errorCode:
 * 'REPORT_WRITE_FAILED' | 'SYSTEM_ERROR' } — the agent must then record the
 * push as status=failed with that errorCode, NEVER as a Human-in-the-loop
 * USER_RESOURCE_NEEDED (the user cannot fix a plugin-side write failure).
 *
 * literature_record validates the canonical report exists and is non-empty
 * before accepting status=completed.
 */
import { stat } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LiteratureRuntime } from '../lib/runtime.js'
import { resolveLibraryRoot } from '../lib/paths.js'
import { writeReportAtomic } from '../lib/report.js'
import { jsonSafe } from '../lib/json_safe.js'

const SAFE_NAME = /^[A-Za-z0-9_\-\u4e00-\u9fff]+\.md$/

export interface ReportWriteInput {
  pushId: number
  /** stage label used as the canonical subdirectory (e.g. 基础控制) */
  stageLabel: string
  /** e.g. 'Pratt2001_virtual_model_control.md' */
  filename: string
  content: string
}

export interface ReportWriteOutput {
  ok: boolean
  reportPath?: string
  bytes?: number
  errorCode?: 'REPORT_WRITE_FAILED' | 'SYSTEM_ERROR'
  reason?: string
}

export function defineLiteratureReportWrite(getRt: () => LiteratureRuntime) {
  return defineTool({
    name: 'literature_report_write',
    description:
      '写 canonical 精读报告（plugin 进程负责，不经过你的 shell）：~/.local/share/dsh-literature/reports/<stageLabel>/<filename>.md，mkdir recursive + temp write + atomic rename，返回 reportPath。失败返回 REPORT_WRITE_FAILED/SYSTEM_ERROR（此时用 literature_record 记 status=failed，不要当作需要用户介入）。',
    parameters: {
      pushId: { type: 'integer', required: true, description: '推送号' },
      stageLabel: { type: 'string', required: true, description: '阶段标签（作为 canonical 子目录，如 基础控制）' },
      filename: { type: 'string', required: true, description: '文件名，如 Pratt2001_virtual_model_control.md（仅字母数字-_中文+.md）' },
      content: { type: 'string', required: true, description: '报告完整 Markdown 内容' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reportPath: { type: 'string' },
          bytes: { type: 'integer' },
          errorCode: { type: 'string', enum: ['REPORT_WRITE_FAILED', 'SYSTEM_ERROR'] },
          reason: { type: 'string' },
        },
      },
      render: (_args, value: ReportWriteOutput) => [
        {
          type: 'text',
          text: value.ok
            ? `canonical 报告已写入：${value.reportPath}（${value.bytes} bytes）`
            : `报告写入失败（${value.errorCode}）：${value.reason ?? '未知'} — literature_record 记 status=failed，非 HITL`,
        },
      ],
    },
    async execute(args: ReportWriteInput): Promise<ReportWriteOutput> {
      const rt = getRt()
      if (!SAFE_NAME.test(args.filename)) {
        return jsonSafe({
          ok: false,
          errorCode: 'REPORT_WRITE_FAILED' as const,
          reason: `非法文件名（仅允许字母/数字/_-/中文 + .md）：${args.filename}`,
        })
      }
      try {
        const reportPath = await writeReportAtomic(
          resolveLibraryRoot(rt.cfg),
          args.stageLabel,
          args.filename,
          args.content,
        )
        const info = await stat(reportPath)
        if (info.size <= 0) {
          return jsonSafe({
            ok: false,
            errorCode: 'REPORT_WRITE_FAILED' as const,
            reason: `canonical 报告写入后为空文件：${reportPath}`,
          })
        }
        // provenance: remember the canonical path on the push row right away
        rt.db.prepare('UPDATE pushes SET report_path = ? WHERE id = ?').run(reportPath, args.pushId)
        const push = rt.db.prepare('SELECT paper_id FROM pushes WHERE id = ?').get(args.pushId) as { paper_id: string | null } | undefined
        if (push?.paper_id) {
          // Version history: append a new report row instead of overwriting.
          rt.db.prepare(
            `INSERT INTO reports (paper_id,report_path,source,created_at,updated_at)
             VALUES (?, ?, 'workflow', datetime('now'), datetime('now'))`,
          ).run(push.paper_id, reportPath)
        }
        return jsonSafe({ ok: true, reportPath, bytes: info.size })
      } catch (err) {
        const e = err as { code?: string; message?: string }
        const internal = ['EACCES', 'ENOENT', 'ENOTDIR', 'EROFS', 'EEXIST', 'EISDIR'].includes(e.code ?? '')
          ? false
          : true
        return jsonSafe({
          ok: false,
          errorCode: (internal ? 'SYSTEM_ERROR' : 'REPORT_WRITE_FAILED') as 'REPORT_WRITE_FAILED' | 'SYSTEM_ERROR',
          reason: `${e.code ?? ''} ${e.message ?? String(err)}`,
        })
      }
    },
  })
}
