import { defineConfig } from "vitest/config";

// The default `test` script must stay fast and browser-free. `test-browser/` needs a real
// Chromium (via Playwright) and takes about a minute; it is run separately with
// `pnpm test:browser` / `vitest.browser.config.ts`.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "test-browser/**"],
  },
});
