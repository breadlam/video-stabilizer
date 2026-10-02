import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, type InputVideoTrack } from 'mediabunny'

export interface VideoInfo {
  name: string
  size: number
  /** Display size (after rotation metadata and pixel aspect ratio). */
  width: number
  height: number
  /** Presentation timestamps of every frame, ascending, in seconds. */
  timestamps: number[]
  duration: number
  fps: number
  codec: string | null
  hasAudio: boolean
}

export interface OpenedVideo {
  file: File
  input: Input
  track: InputVideoTrack
  info: VideoInfo
}

export class UnsupportedVideoError extends Error {}

/** Opens a local file and lists its frames (from packet metadata; nothing is decoded). */
export async function openVideo(file: File): Promise<OpenedVideo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  if (!(await input.canRead())) throw new UnsupportedVideoError('This file format is not supported.')
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new UnsupportedVideoError('The file has no video track.')
  const codec = await track.getCodec()
  if (!(await track.canDecode())) {
    throw new UnsupportedVideoError(
      `This browser cannot decode ${codec ? codec.toUpperCase() : 'this'} video. ` +
        (codec === 'hevc' ? 'Try Safari or Chrome on a device with HEVC hardware support. ' : '') +
        'Converting the file to H.264 MP4 first will work everywhere.',
    )
  }
  const timestamps = await listFrameTimestamps(track)
  if (timestamps.length === 0) throw new UnsupportedVideoError('The video track has no frames.')
  const duration = await track.computeDuration()
  const span = timestamps[timestamps.length - 1] - timestamps[0]
  const info: VideoInfo = {
    name: file.name,
    size: file.size,
    width: await track.getDisplayWidth(),
    height: await track.getDisplayHeight(),
    timestamps,
    duration,
    fps: timestamps.length > 1 && span > 0 ? (timestamps.length - 1) / span : 30,
    codec,
    hasAudio: (await input.getPrimaryAudioTrack()) !== null,
  }
  return { file, input, track, info }
}

export async function listFrameTimestamps(track: InputVideoTrack): Promise<number[]> {
  const sink = new EncodedPacketSink(track)
  const out: number[] = []
  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    out.push(packet.timestamp)
  }
  out.sort((a, b) => a - b)
  // Drop duplicates (can appear in broken files) so indices stay unique.
  return out.filter((t, i) => i === 0 || t !== out[i - 1])
}

/** Index of the frame whose timestamp is closest to t. */
export function nearestFrame(timestamps: ArrayLike<number>, t: number): number {
  let lo = 0
  let hi = timestamps.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (timestamps[mid] < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(timestamps[lo - 1] - t) <= Math.abs(timestamps[lo] - t)) return lo - 1
  return lo
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`
}
