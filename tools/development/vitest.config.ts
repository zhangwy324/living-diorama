import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    // The whole-world tests here can outrun vitest's 5 s default when the machine is
    // busy (a soak or build running alongside `pnpm check`). Tests that set their own
    // timeout keep it.
    testTimeout: 30_000,
  },
});
