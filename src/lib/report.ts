/**
 * Report archiving into the literature library (output/archive target) and
 * push-record appending. The library layout mirrors the repo conventions:
 * <libraryRoot>/<category>/<AuthorYear_keyword>.md
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expandHome } from './paths.js'

/** Map a reading-stage label to a library subdirectory. */
export function categoryForStage(stageLabel: string): string {
  switch (stageLabel) {
    case '基础控制':
      return 'Fundamentals'
    case '动力学/接触控制':
      return 'Foot & Contact Control'
    case 'MPC':
      return 'Model-Based Control'
    case 'RL locomotion':
      return 'Reinforcement Learning'
    case '鲁棒控制':
      return 'Robust Locomotion'
    case 'terrain adaptation':
      return 'Terrain Adaptation'
    case 'sim-to-real':
      return 'Sim2Real'
    default:
      return 'Landmark Papers'
  }
}

export interface ArchiveReportOptions {
  libraryRoot: string
  category: string
  /** e.g. 'Pratt2001_virtual_model_control.md' */
  filename: string
  content: string
}

/** Write a report into the library; returns the absolute path. */
export async function archiveReport(opts: ArchiveReportOptions): Promise<string> {
  const root = expandHome(opts.libraryRoot)
  const dir = join(root, opts.category)
  await mkdir(dir, { recursive: true })
  const path = join(dir, opts.filename)
  await writeFile(path, opts.content, 'utf8')
  return path
}

/** Append a push-record entry to <libraryRoot>/Templates/push_record.md. */
export async function appendPushRecord(libraryRoot: string, entry: string): Promise<void> {
  const root = expandHome(libraryRoot)
  const dir = join(root, 'Templates')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'push_record.md')
  await appendFile(path, `\n${entry}\n`, 'utf8')
}
