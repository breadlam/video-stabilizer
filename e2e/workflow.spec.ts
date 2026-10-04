import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeGray, loadCv, makeDriftVideo, outDir, patchShift, probe, truthAt, videoRotation, type DriftVideo } from './fixtures'

let OUT_DIR: string
test.beforeAll(async ({}, info) => {
  OUT_DIR = outDir(info.project.name)
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
  })
})

async function framePoint(page: Page, width: number, height: number, x: number, y: number) {
  const box = (await page.locator('.viewer canvas').first().boundingBox())!
  const k = Math.min(box.width / width, box.height / height)
  return { x: box.x + (box.width - width * k) / 2 + x * k, y: box.y + (box.height - height * k) / 2 + y * k }
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}

async function open(page: Page, video: DriftVideo) {
  await page.goto('/')
  await page.locator('input[type=file]').first().setInputFiles(video.path)
  await expect(page.getByText(`${video.frames} frames`)).toBeVisible()
  // The first frame has been decoded once the reference-frame hint shows.
  await expect(page.getByText(/drag a box around something that never moves/)).toBeVisible()
}

async function savedPositions(page: Page, name: string) {
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save project' }).click()
  const path = join(OUT_DIR, name)
  await (await download).saveAs(path)
  const p = JSON.parse(readFileSync(path, 'utf8'))
  const f64 = (b64: string) => new Float64Array(Uint8Array.from(Buffer.from(b64, 'base64')).buffer)
  return { anchors: p.anchors as { rect: { x: number; y: number; w: number; h: number } }[], x: f64(p.tracking.x), y: f64(p.tracking.y) }
}

test('flags an occluded anchor, and a correction re-tracks from that frame', async ({ page }) => {
  const video = await makeDriftVideo('occluded.mp4', {
    dir: OUT_DIR,
    roll: 0,
    occlude: { from: 40, to: 50, rect: { x: 40, y: 30, w: 140, h: 140 } },
  })
  await open(page, video)
  const W = video.width
  const H = video.height
  await drag(page, await framePoint(page, W, H, 70, 60), await framePoint(page, W, H, 150, 140))
  await page.getByRole('button', { name: 'Track anchors' }).click()
  await expect(page.getByText(`All ${video.frames} frames tracked`)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText(/frames? with an anchor that was not found confidently/)).toBeVisible()

  await page.getByRole('button', { name: 'Next issue' }).click()
  const frameText = await page.locator('.pos span').first().textContent()
  const shown = Number(/Frame (\d+)/.exec(frameText ?? '')![1])
  expect(shown).toBeGreaterThanOrEqual(41)
  expect(shown).toBeLessThanOrEqual(50)

  // Nudge the anchor on frame 70 by a few pixels: the correction is snapped to the true position.
  await page.getByRole('button', { name: 'Last frame' }).click()
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.pos')).toContainText('Frame 70')
  const before = await savedPositions(page, 'occluded-before.json')
  const a = before.anchors[0].rect
  const ref = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const at69 = truthAt(video, 69, ref)
  await drag(page, await framePoint(page, W, H, at69.x, at69.y), await framePoint(page, W, H, at69.x + 3, at69.y - 2))
  const retrack = page.getByRole('button', { name: 'Re-track from frame 70' })
  await expect(retrack).toBeVisible()
  await retrack.click()
  await expect(page.getByText(`All ${video.frames} frames tracked`)).toBeVisible({ timeout: 120_000 })

  const after = await savedPositions(page, 'occluded-after.json')
  let worst = 0
  for (let f = 0; f < video.frames; f++) {
    if (f >= 40 && f < 50) continue
    const t = truthAt(video, f, ref)
    worst = Math.max(worst, Math.hypot(after.x[f] - t.x, after.y[f] - t.y))
  }
  console.log(`max error outside the occlusion after correction: ${worst.toFixed(3)} px`)
  expect(worst).toBeLessThan(0.35)
})

test('handles portrait video with rotation metadata', async ({ page }) => {
  const video = await makeDriftVideo('portrait.mp4', { dir: OUT_DIR, roll: 0, frames: 60, displayRotation: 90 })
  await open(page, video)
  // Displayed upright: width and height swap.
  const W = video.height
  const H = video.width
  await expect(page.getByText(`${W}×${H}`)).toBeVisible()
  await drag(page, await framePoint(page, W, H, 120, 260), await framePoint(page, W, H, 220, 360))
  await page.getByRole('button', { name: 'Track anchors' }).click()
  await expect(page.getByText(`All ${video.frames} frames tracked`)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('Every anchor was found confidently in every frame.')).toBeVisible()

  await page.getByRole('button', { name: 'Export MP4' }).click()
  const link = page.getByRole('link', { name: /Download portrait-stabilized\.mp4/ })
  await expect(link).toBeVisible({ timeout: 120_000 })
  const download = page.waitForEvent('download')
  await link.click()
  const out = join(OUT_DIR, 'portrait-stabilized.mp4')
  await (await download).saveAs(out)

  // Stored like the source: same frame size and the same rotation metadata, rather than rotated pixels.
  const v = probe(out).streams.find((s) => s.codec_type === 'video')!
  expect([v.width, v.height]).toEqual([video.width, video.height])
  expect(videoRotation(out)).toBe(videoRotation(video.path))
  expect(videoRotation(out)).not.toBe(0)
  const cv = await loadCv()
  const frames = decodeGray(out, W, H)
  let residual = 0
  for (let f = 1; f < frames.length; f++) {
    const s = patchShift(cv, frames[0], frames[f], W, H, { x: 140, y: 280, w: 80, h: 80 }, 12)
    residual = Math.max(residual, Math.hypot(s.dx, s.dy))
  }
  console.log(`portrait residual motion: ${residual.toFixed(3)} px`)
  expect(residual).toBeLessThan(0.6)
})
