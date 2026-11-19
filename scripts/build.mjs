import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    popup: "src/popup/popup.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
};

async function copyStatic() {
  await cp("manifest.json", "dist/manifest.json");
  await cp("src/popup/popup.html", "dist/popup.html");
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{ name: "static", setup: (b) => b.onEnd(copyStatic) }],
  });
  await ctx.watch();
} else {
  await build(options);
  await copyStatic();
}
