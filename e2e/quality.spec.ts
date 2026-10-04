import { expect, test, type Page } from '@playwright/test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  decodeYuv,
  makeColorDriftVideo,
  outDir,
  psnr,
  streamMd5,
  videoPts,
  videoStream,
  type DriftVideo,
} from './fixtures'

// BASELINE=1 only logs the measurements (used to compare pipelines).
const baseline = !!process.env.BASELINE

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  })
})

async function framePoint(page: Page, v: DriftVideo, x: number, y: number) {
  const box = (await page.locator('.viewer canvas').first().boundingBox())!
  const k = Math.min(box.width / v.width, box.height / v.height)
  return { x: box.x + (box.width - v.width * k) / 2 + x * k, y: box.y + (box.height - v.height * k) / 2 + y * k }
}

/** Anchors, tracking with rotation, zoom 1 (no crop, so output frames align with the source), export. */
async function stabilizeAndExport(page: Page, video: DriftVideo, dir: string, outName: RegExp): Promise<string> {
  await page.goto('/')
  await page.locator('input[type=file]').first().setInputFiles(video.path)
  await expect(page.getByText(/drag a box around something that never moves/)).toBeVisible()
  for (const [x0, y0, x1, y1] of [
    [70, 60, 150, 140],
    [470, 210, 560, 300],
  ]) {
    const a = await framePoint(page, video, x0, y0)
    const b = await framePoint(page, video, x1, y1)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 4 })
    await page.mouse.up()
  }
  await page.getByText('Position + rotation').click()
  await page.getByRole('button', { name: 'Track anchors' }).click()
  await expect(page.getByText(`All ${video.frames} frames tracked`)).toBeVisible({ timeout: 120_000 })
  await page.getByText('Custom zoom').click()
  await page.getByRole('button', { name: /^Export/ }).click()
  const link = page.getByRole('link', { name: outName })
  await expect(link).toBeVisible({ timeout: 120_000 })
  const download = page.waitForEvent('download')
  await link.click()
  const d = await download
  const out = join(dir, d.suggestedFilename())
  await d.saveAs(out)
  return out
}

interface Report {
  frame0: { y: number; u: number; v: number }
  minInteriorY: number
  meanInteriorY: number
}

function measure(src: string, out: string, v: DriftVideo, bits: 8 | 10): Report {
  const a = decodeYuv(src, v.width, v.height, bits)
  const b = decodeYuv(out, v.width, v.height, bits)
  expect(b.length).toBe(a.length)
  const max = bits === 8 ? 255 : 1023
  const W = v.width
  const H = v.height
  const full = { x: 0, y: 0, w: W, h: H }
  const fullC = { x: 0, y: 0, w: W / 2, h: H / 2 }
  // Frame 0 is the reference: its transform is the identity, so this isolates colour/encoding loss.
  const frame0 = {
    y: psnr(a[0].y, b[0].y, W, full, max),
    u: psnr(a[0].u, b[0].u, W / 2, fullC, max),
    v: psnr(a[0].v, b[0].v, W / 2, fullC, max),
  }
  // Every stabilized frame should reproduce frame 0 wherever it is covered.
  const m = 64
  const interior = { x: m, y: m, w: W - 2 * m, h: H - 2 * m }
  const ys = b.map((f) => psnr(a[0].y, f.y, W, interior, max))
  return {
    frame0,
    minInteriorY: Math.min(...ys),
    meanInteriorY: ys.reduce((s, x) => s + x, 0) / ys.length,
  }
}

function describeStream(path: string, frames: number) {
  const s = videoStream(path)
  const seconds = frames / 30
  return {
    codec: `${s.codec_name} ${s.profile ?? ''} ${s.pix_fmt}`,
    color: `${s.color_range}/${s.color_space}/${s.color_transfer}/${s.color_primaries}`,
    size: `${s.width}x${s.height}`,
    mbps: ((statSync(path).size * 8) / seconds / 1e6).toFixed(1),
  }
}

for (const format of ['h264', 'vp9-10'] as const) {
  test(`stabilized export keeps the source quality (${format})`, async ({ page, browserName }, info) => {
    const dir = outDir(info.project.name)
    const ext = format === 'h264' ? 'mp4' : 'webm'
    const video = await makeColorDriftVideo(`quality-${format}.${ext}`, { dir, format })
    const out = await stabilizeAndExport(page, video, dir, /Download quality-/)

    if (format === 'vp9-10' && browserName !== 'chromium') {
      // Firefox ignores VP9 quality settings: the export switches to H.264 (in Matroska) and says so.
      await expect(page.getByText(/cannot encode VP9 at full quality/)).toBeVisible()
      expect(out.endsWith('.mkv')).toBe(true)
      expect(videoStream(out).codec_name).toBe('h264')
      const r = measure(video.path, out, video, 10)
      console.log(`[${format}/fallback] frame-0 PSNR Y ${r.frame0.y.toFixed(2)} U ${r.frame0.u.toFixed(2)} V ${r.frame0.v.toFixed(2)}; stabilized Y min ${r.minInteriorY.toFixed(2)}`)
      if (!baseline) expect(r.frame0.y).toBeGreaterThan(46)
      return
    }
    const bits = format === 'h264' ? 8 : 10
    const r = measure(video.path, out, video, bits)
    const src = describeStream(video.path, video.frames)
    const dst = describeStream(out, video.frames)
    console.log(
      `[${format}] source ${JSON.stringify(src)}\n[${format}] output ${JSON.stringify(dst)}\n` +
        `[${format}] frame-0 PSNR Y ${r.frame0.y.toFixed(2)} U ${r.frame0.u.toFixed(2)} V ${r.frame0.v.toFixed(2)} dB; ` +
        `stabilized-vs-reference Y min ${r.minInteriorY.toFixed(2)} mean ${r.meanInteriorY.toFixed(2)} dB`,
    )
    if (baseline) return

    // Same encoding as the source.
    expect(out.endsWith(`.${ext}`)).toBe(true)
    expect(dst.codec).toBe(src.codec)
    expect(dst.color).toBe(src.color)
    expect(dst.size).toBe(src.size)
    expect(videoPts(out)).toEqual(videoPts(video.path))
    expect(streamMd5(out, 'a:0')).toBe(streamMd5(video.path, 'a:0'))

    // Effectively lossless. Chrome hands over YUV planes directly; Firefox only provides 8-bit RGB
    // frames, whose colour round trip costs a little chroma precision.
    const yuv = browserName === 'chromium'
    expect(r.frame0.y).toBeGreaterThan(yuv ? 50 : 48)
    expect(Math.min(r.frame0.u, r.frame0.v)).toBeGreaterThan(yuv ? 50 : 45)
    expect(r.minInteriorY).toBeGreaterThan(yuv ? 46 : 44)
  })
}
