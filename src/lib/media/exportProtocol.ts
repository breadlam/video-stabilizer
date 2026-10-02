export type ExportQuality = 'medium' | 'high' | 'very-high'
export type EdgeFill = 'black' | 'history'

export interface ExportJob {
  file: File
  timestamps: number[]
  /** Per frame: the 6 canvas-order coefficients mapping source-frame pixels → output pixels. */
  matrices: Float64Array
  outWidth: number
  outHeight: number
  fill: EdgeFill
  quality: ExportQuality
  /** When set (Chromium), the file is streamed to this handle instead of being kept in memory. */
  fileHandle?: FileSystemFileHandle
}

export type ToExporter = { type: 'export'; job: ExportJob } | { type: 'cancel' }

export type FromExporter =
  | { type: 'progress'; progress: number }
  | { type: 'done'; buffer: ArrayBuffer | null; mimeType: string; codec: string; warnings: string[] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
