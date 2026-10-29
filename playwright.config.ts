import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    locale: 'en-GB',
    timezoneId: 'Asia/Kuala_Lumpur',
    colorScheme: 'light',
  },
});
