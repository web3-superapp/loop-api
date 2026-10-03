import { URL } from "node:url";
import { mkdir, copyFile } from "node:fs/promises";
const source = new URL("../src/features/ops/web/", import.meta.url);
const target = new URL("../dist/src/features/ops/web/", import.meta.url);
await mkdir(target, { recursive: true });
for (const file of ["index.html", "app.js", "styles.css"])
  await copyFile(new URL(file, source), new URL(file, target));
