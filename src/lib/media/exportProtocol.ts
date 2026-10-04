export type ExportQuality = 'lossless' | 'maximum' | 'compact'
export type EdgeFill = 'black' | 'history'

export interface ExportJob {
  file: File
  timestamps: number[]
  /** Per frame: the 6 canvas-order coefficients mapping source display pixels → output display pixels. */
  matrices: Float64Array
  /** Output size in display orientation. */
  outWidth: number
  outHeight: number
  fill: EdgeFill
  quality: ExportQuality
  /** When set (Chromium), the file is streamed to this handle instead of being kept in memory. */
  fileHandle?: FileSystemFileHandle
}

export interface ExportSummary {
  container: string
  /** File extension of the container actually written. */
  extension: string
  /** Codec, string, bit depth and rate control actually used. */
  video: string
  /** How frames were processed. */
  processing: string
  audio: string
  /** Deviations from the source encoding (empty when it matches). */
  notes: string[]
}

export type ToExporter = { type: 'export'; job: ExportJob } | { type: 'cancel' }

export type FromExporter =
  | { type: 'progress'; progress: number }
  | { type: 'done'; buffer: ArrayBuffer | null; mimeType: string; summary: ExportSummary }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
