import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `reolink-baichuan-js` is a symlink to the library repo; without this
    // vitest walks into it and runs the library's own suite too.
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "reolink-baichuan-js/**"],
  },
});
