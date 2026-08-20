import { describe, expect, it } from 'vitest'
import {
  buildHarnessArgs,
  buildInstallArgs,
  buildTaskPrompt,
  resolveProfile,
} from '../bin/dsh-literature-push.mjs'

describe('push CLI profile routing', () => {
  it('uses explicit profile before the environment and compatibility fallback', () => {
    expect(resolveProfile({ profile: 'research' }, { DSH_LITERATURE_PROFILE: 'env-profile' })).toBe('research')
    expect(resolveProfile({ profile: undefined }, { DSH_LITERATURE_PROFILE: 'env-profile' })).toBe('env-profile')
    expect(resolveProfile({ profile: undefined }, {})).toBe('headless')
  })

  it('passes the same profile to install and execution', () => {
    expect(buildInstallArgs('research', '/repo')).toEqual([
      '--profile', 'research', 'add', 'link:/repo',
    ])
    expect(buildHarnessArgs('research', 'topic prompt', '/harness/bin.ts')).toEqual([
      '/harness/bin.ts', '--profile', 'research', 'topic prompt',
    ])
  })

  it('preserves custom topic text in the task prompt', () => {
    expect(buildTaskPrompt('契约分层')).toContain('主题：契约分层')
    expect(buildTaskPrompt('契约分层')).toContain('literature_push_now(topic="契约分层")')
  })

  it('uses configured learning context when no custom topic is supplied', () => {
    const prompt = buildTaskPrompt(undefined)
    expect(prompt).toContain('当前 profile/配置中的学习主题与阶段')
    expect(prompt).not.toContain('足式机器人控制')
  })
})
