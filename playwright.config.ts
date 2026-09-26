import { defineConfig, devices } from '@playwright/test';

const executablePath = process.env.AXIOM_CHROMIUM ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    launchOptions: { executablePath },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } },
    {
      name: 'tablet',
      use: { ...devices['iPad Pro 11'], browserName: 'chromium', launchOptions: { executablePath } },
      grep: /@touch/,
    },
  ],
  webServer: [
    { command: 'npm run build && npm run preview', port: 4173, reuseExistingServer: true, timeout: 180_000 },
    { command: 'node server/relay.mjs --port 4455', port: 4455, reuseExistingServer: true },
  ],
});
