import { defineConfig, devices } from '@playwright/test'

const port = 4173

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
    actionTimeout: 15_000,
  },
  projects: [
    // The installed Google Chrome: Playwright's Chromium may lack the proprietary H.264 codecs.
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1400, height: 900 } } },
    // Cross-browser runs (CROSS=1); needs `npx playwright install firefox webkit`.
    ...(process.env.CROSS
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1400, height: 900 } } },
          { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1400, height: 900 } } },
        ]
      : []),
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
