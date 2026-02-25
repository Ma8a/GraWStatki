const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: ['tests/ui-smoke.spec.js'],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: 0,
  reporter: [['line']],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3000/health',
    timeout: 180_000,
    reuseExistingServer: true,
  },
});
