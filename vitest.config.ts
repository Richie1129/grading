import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import fs from 'fs';
import path from 'path';

// Load .env file before config evaluation
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach((line) => {
    const [key, ...values] = line.split('=');
    if (key && !key.startsWith('#') && !process.env[key]) {
      process.env[key] = values.join('=').trim().replace(/^"(.*)"$/, '$1');
    }
  });
}

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // tsconfig.json 把 **/*.test.ts 排除在外，vite-tsconfig-paths 不會替測試檔套用 @/ 與 ~/ 別名，
  // 這裡明確宣告，讓 test/ 底下的 import '@/services/...' 也能解析
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'app'),
      '~': path.resolve(__dirname, 'app'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts', './test/polyfills.ts'],
    env: {
      // Use dev database for testing with proper cleanup
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://grading_admin:password@localhost:15432/grading_db',
      NODE_ENV: 'test',
      REDIS_HOST: process.env.REDIS_HOST || 'localhost',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'password',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
      GEMINI_API_KEY2: process.env.GEMINI_API_KEY2 || '',
      GEMINI_API_KEY3: process.env.GEMINI_API_KEY3 || '',
      GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      // PDF Parser API for document parsing tests
      PDF_PARSER_API_URL: process.env.PDF_PARSER_API_URL || 'https://devgradingpdf.grading.software',
      // Use real APIs instead of MSW mocks when set to 'true'
      USE_REAL_APIS: process.env.USE_REAL_APIS || 'false',
    },
    testTimeout: 60000, 
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    
    fileParallelism: false,
    sequence: {
      concurrent: false,
    },
  },
});