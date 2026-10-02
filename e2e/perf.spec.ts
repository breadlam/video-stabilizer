import { expect, test, type Page } from '@playwright/test'
import { makeDriftVideo, outDir } from './fixtures'

// Throughput check on larger videos; run with PERF=1 (slow to generate fixtures).
test.skip(!process.env.PERF, 'set PERF=1 to run')

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

for (const [width, height, frames] of [
  [1920, 1080, 150],
  [3840, 2160, 60],
] as const) {
  test(`throughput at ${width}×${height}`, async ({ page }, info) => {
    const dir = outDir(info.project.name)
    const video = await makeDriftVideo(`perf-${height}.mp4`, { dir, width, height, frames, roll: 0.02 })
    await page.goto('/')
    await page.locator('input[type=file]').first().setInputFiles(video.path)
    await expect(page.getByText(/drag a box around something that never moves/)).toBeVisible()
    for (const [x, y] of [
      [0.15, 0.2],
      [0.75, 0.7],
    ]) {
      const s = 0.08 * width
      const a = await framePoint(page, width, height, x * width, y * height)
      const b = await framePoint(page, width, height, x * width + s, y * height + s)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move(b.x, b.y, { steps: 5 })
      await page.mouse.up()
    }
    await page.getByText('Position + rotation').click()

    let t = Date.now()
    await page.getByRole('button', { name: 'Track anchors' }).click()
    await expect(page.getByText(`All ${frames} frames tracked`)).toBeVisible({ timeout: 170_000 })
    const trackSeconds = (Date.now() - t) / 1000
    await expect(page.getByText('Every anchor was found confidently in every frame.')).toBeVisible()

    t = Date.now()
    await page.getByRole('button', { name: 'Export MP4' }).click()
    await expect(page.getByRole('link', { name: /Download/ })).toBeVisible({ timeout: 170_000 })
    const exportSeconds = (Date.now() - t) / 1000
    console.log(
      `${width}×${height}: tracking ${(frames / trackSeconds).toFixed(1)} fps (incl. OpenCV load), ` +
        `export ${(frames / exportSeconds).toFixed(1)} fps`,
    )
  })
}
