import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { resolveConfig, oxcConfig } from './vite.config.ts'

export default defineConfig({
  resolve: resolveConfig,
  oxc: oxcConfig,
  test: {
    include: ['src/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
    fileParallelism: false,
    testTimeout: 120_000,
  },
})
