import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      import: importPlugin,
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      
      // Import boundary rules - Phase A: warnings during refactor
      'import/no-restricted-paths': [
        'warn',
        {
          zones: [
            // === Rule 1: Prevent cross-feature imports ===
            {
              target: './src/tui/features/conversation',
              from: './src/tui/features',
              except: ['./conversation'],
            },
            {
              target: './src/tui/features/workflow',
              from: './src/tui/features',
              except: ['./workflow'],
            },
            {
              target: './src/tui/features/input',
              from: './src/tui/features',
              except: ['./input'],
            },
            {
              target: './src/tui/features/layout',
              from: './src/tui/features',
              except: ['./layout'],
            },
            
            // === Rule 2: Enforce unidirectional architecture ===
            // Features cannot import from app layer
            {
              target: './src/tui/features',
              from: ['./src/tui', './src'],
            },
            
            // Shared cannot import from features
            {
              target: ['./src/tui/components', './src/tui/hooks', './src/tui/types', './src/tui/utils'],
              from: './src/tui/features',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/tui/**/*.ts', 'src/tui/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'import/no-restricted-paths': 'warn',
    },
  },
);
