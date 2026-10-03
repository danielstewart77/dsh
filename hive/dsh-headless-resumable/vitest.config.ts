import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

// The same resolution facade the upstream root config uses: tsconfig.base.json's
// paths map every `@deepseek-ai/*` specifier to that package's `src`, so these
// tests run against source rather than an unbuilt `lib/`.
export default defineConfig({
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['../../tsconfig.base.json'] })],
  test: { include: ['tests/**/*.spec.ts'] },
})
