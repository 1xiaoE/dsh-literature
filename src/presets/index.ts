/**
 * Curriculum presets — pluggable topic/stage bundles for the domain-agnostic
 * Literature Agent. Add a new domain by adding a preset module here; the core
 * never hardcodes a research area.
 */
import type { StageDef, TopicDef } from '../config.js'
import { LEGGED_ROBOT_STAGES, LEGGED_ROBOT_TOPICS } from './legged-robot-control.js'

export interface CurriculumPreset {
  id: string
  displayName: string
  topics: TopicDef[]
  stages: StageDef[]
}

export const PRESETS: CurriculumPreset[] = [
  {
    id: 'legged-robot-control',
    displayName: '足式机器人控制',
    topics: LEGGED_ROBOT_TOPICS,
    stages: LEGGED_ROBOT_STAGES,
  },
]

export const DEFAULT_PRESET_ID = 'legged-robot-control'

export function presetById(id: string | undefined): CurriculumPreset | undefined {
  if (id === undefined || id === '') return undefined
  return PRESETS.find((preset) => preset.id === id)
}

/** First preset = default; topics/stages come from it. */
export const DEFAULT_TOPICS: TopicDef[] = [...PRESETS[0]!.topics]
export const DEFAULT_STAGES: StageDef[] = [...PRESETS[0]!.stages]
