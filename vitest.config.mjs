import { configDefaults, defineConfig } from "vitest/config";

// macOS can create AppleDouble metadata on external volumes. These binary
// sidecars are not source or suites, just as .gitignore already defines.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "**/._*"] },
});
