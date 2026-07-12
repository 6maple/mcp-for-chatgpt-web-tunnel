import { defineConfig } from 'vite-plus'

const generatedPaths = [
  'node_modules/**',
  'dist/**',
  '.turbo/**',
  '.cache/**',
  '.pnpm-store/**',
  '.corepack/**',
  '.codegraph/**',
  '**/*.exe',
  '.claude/**',
  '.mcp.json',
]

export default defineConfig({
  fmt: {
    semi: false,
    singleQuote: true,
    trailingComma: 'es5',
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: 'lf',
    ignorePatterns: [...generatedPaths, 'pnpm-lock.yaml'],
  },

  lint: {
    ignorePatterns: generatedPaths,
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      'no-constant-binary-expression': 'error',
      'no-unreachable': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-console': 'off',
    },
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx'],
        rules: {
          'typescript/no-explicit-any': 'error',
          'typescript/no-unused-vars': [
            'error',
            {
              argsIgnorePattern: '^_',
              varsIgnorePattern: '^_',
              caughtErrorsIgnorePattern: '^_',
            },
          ],
        },
      },
    ],
  },

  staged: {
    '*.{js,mjs,cjs,ts,tsx,json,yml,yaml,md}': 'vp check --fix',
  },
})
