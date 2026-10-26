import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/desktop", "packages/*", "tools/*"],
  },
});
