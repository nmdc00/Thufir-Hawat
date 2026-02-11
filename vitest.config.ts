import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      all: true,
      clean: true,
      reportsDirectory: 'coverage',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/vendor/**',
        'dist/**',
        'tests/**',
        'vendor/**',
        '**/vendor/**',
        '**/node_modules/**',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
      excludeAfterRemap: true,
      thresholds: {
        lines: 20,
        functions: 15,
        branches: 15,
        statements: 20,
      },
    },
  },
});
