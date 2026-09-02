<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Testing

- Быстрые unit: `npm test`; coverage gate: `npm run test:coverage`.
- PostgreSQL integration и handler E2E: `npm run test:integration`, затем `npm run test:e2e`.
- Browser smoke: `npm run test:smoke`; полный desktop/mobile Playwright: `npm run test:playwright`.
- Полная последовательность: `npm run test:all`. Подробности и требования к `_test` базе: `TESTING.md`.
- Для новой функции добавляйте тест; для bug fix — regression test; каждую ветку нового conditional проверяйте отдельно.
- Не коммитьте код, который ломает существующие тесты или снижает coverage ниже настроенных порогов.
