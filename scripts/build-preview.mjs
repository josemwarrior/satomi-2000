import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = new URL("../preview.html", import.meta.url);
const html = await readFile(file, "utf8");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/preview.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  minify: true,
  legalComments: "inline",
  write: false,
});
const marker = /<!-- preview:script:start -->[\s\S]*?<!-- preview:script:end -->/;
if (!marker.test(html)) throw new Error("preview.html is missing its script markers.");
const javascript = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
await writeFile(file, html.replace(marker, () =>
  `<!-- preview:script:start -->\n<!-- Generated from src/preview.ts and src/threads.ts. Run npm run build:preview. -->\n<script>\n${javascript}</script>\n<!-- preview:script:end -->`,
));
console.log("Built standalone preview.html with Satomi's shared thread algorithm.");
