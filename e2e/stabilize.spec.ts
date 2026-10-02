import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeGray, loadCv, makeDriftVideo, outDir, patchShift, probe, truthAt, type DriftVideo } from './fixtures'

let video: DriftVideo
let OUT_DIR: string

test.beforeAll(async ({}, info) => {
  OUT_DIR = outDir(info.project.name)
  video = await makeDriftVideo('drift.mp4', { dir: OUT_DIR })
})

/** Page coordinates of a frame-pixel position in the viewer (frame is letterboxed into the canvas). */
async function framePoint(page: Page, x: number, y: number) {
  const box = (await page.locator('.viewer canvas').first().boundingBox())!
  const k = Math.min(box.width / video.width, box.height / video.height)
  const ox = (box.width - video.width * k) / 2
  const oy = (box.height - video.height * k) / 2
  return { x: box.x + ox + x * k, y: box.y + oy + y * k }
}

async function drawBox(page: Page, x0: number, y0: number, x1: number, y1: number) {
  const a = await framePoint(page, x0, y0)
  const b = await framePoint(page, x1, y1)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await page.mouse.up()
}

interface SavedProject {
  anchors: { rect: { x: number; y: number; w: number; h: number } }[]
  tracking: { trackedUpTo: number; x: string; y: string; status: string }
}

test('anchors, tracks, previews and exports a stabilized video', async ({ page }) => {
  // Force the in-memory download path (the native save dialog cannot be driven headlessly).
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Pin a still point/ })).toBeVisible()
  await page.locator('input[type=file]').first().setInputFiles(video.path)
  await expect(page.getByText(`${video.frames} frames`)).toBeVisible()
  await expect(page.getByText(/drag a box around something that never moves/)).toBeVisible()

  // Two anchors far apart, so rotation can be measured.
  await drawBox(page, 70, 60, 150, 140)
  await drawBox(page, 470, 210, 560, 300)
  await expect(page.getByText('Anchor 2')).toBeVisible()
  await page.getByText('Position + rotation').click()
  await page.screenshot({ path: join(OUT_DIR, '1-anchors.png') })

  await page.getByRole('button', { name: 'Track anchors' }).click()
  await expect(page.getByText(`All ${video.frames} frames tracked`)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Every anchor was found confidently in every frame.')).toBeVisible()

  // Tracking accuracy, read back through the project file.
  const projectDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save project' }).click()
  const projectPath = join(OUT_DIR, 'project.json')
  await (await projectDownload).saveAs(projectPath)
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as SavedProject
  const f64 = (b64: string) => new Float64Array(Uint8Array.from(Buffer.from(b64, 'base64')).buffer)
  const xs = f64(project.tracking.x)
  const ys = f64(project.tracking.y)
  let worst = 0
  project.anchors.forEach((a, i) => {
    const ref = { x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h / 2 }
    for (let f = 0; f < video.frames; f++) {
      const t = truthAt(video, f, ref)
      const j = f * project.anchors.length + i
      worst = Math.max(worst, Math.hypot(xs[j] - t.x, ys[j] - t.y))
    }
  })
  console.log(`max tracking error: ${worst.toFixed(3)} px`)
  expect(worst).toBeLessThan(0.35)

  // Stabilized preview.
  await page.getByRole('radio', { name: 'Stabilized' }).click()
  await page.getByRole('button', { name: 'Last frame' }).click()
  await page.screenshot({ path: join(OUT_DIR, '2-stabilized.png') })

  // Export.
  await page.getByRole('button', { name: 'Export MP4' }).click()
  const link = page.getByRole('link', { name: /Download drift-stabilized\.mp4/ })
  await expect(link).toBeVisible({ timeout: 120_000 })
  const download = page.waitForEvent('download')
  await link.click()
  const outPath = join(OUT_DIR, 'drift-stabilized.mp4')
  await (await download).saveAs(outPath)

  const info = probe(outPath)
  const v = info.streams.find((s) => s.codec_type === 'video')!
  const a = info.streams.find((s) => s.codec_type === 'audio')
  expect(v.width).toBe(video.width)
  expect(v.height).toBe(video.height)
  expect(Number(v.nb_frames)).toBe(video.frames)
  expect(a?.codec_name).toBe('aac')

  // Residual motion of a pinned detail in the exported video, relative to its first frame.
  const cv = await loadCv()
  const frames = decodeGray(outPath, video.width, video.height)
  expect(frames.length).toBe(video.frames)
  const probeRect = { x: 280, y: 140, w: 80, h: 80 }
  let residual = 0
  for (let f = 1; f < frames.length; f++) {
    const s = patchShift(cv, frames[0], frames[f], video.width, video.height, probeRect, 12)
    residual = Math.max(residual, Math.hypot(s.dx, s.dy))
  }
  console.log(`max residual motion after stabilization: ${residual.toFixed(3)} px`)
  expect(residual).toBeLessThan(0.6)

  expect(errors).toEqual([])
})
