import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve @aviator/shared from TypeScript source ("source" export condition) in tests.
const nodeResolve = {
  resolve: { conditions: ['source', ...defaultServerConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...nodeResolve,
        test: {
          name: 'shared',
          root: './packages/shared',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        ...nodeResolve,
        test: {
          name: 'server',
          root: './apps/server',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: './apps/web/vite.config.ts',
        test: {
          name: 'web',
          root: './apps/web',
          include: ['test/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
