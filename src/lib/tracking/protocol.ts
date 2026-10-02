import type { ObsBatch } from './observations'
import type { ResumeState, SessionConfig } from './session'

export interface TrackJob {
  file: File
  timestamps: number[]
  config: SessionConfig
  resume?: ResumeState
}

export type ToTracker = { type: 'track'; job: TrackJob } | { type: 'cancel' }

export type FromTracker =
  | { type: 'loading' }
  | { type: 'started'; startIndex: number }
  | { type: 'batch'; batch: ObsBatch }
  | { type: 'done'; cancelled: boolean; processed: number; seconds: number }
  | { type: 'error'; message: string }
