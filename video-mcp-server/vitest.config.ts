import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Los tests lanzan ffmpeg y Chrome: en paralelo se pisan y agotan el tiempo por defecto (5 s).
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
