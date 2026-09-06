import { build } from "vite";
import { copyFile, cp, mkdir } from "node:fs/promises";
await import("./notices.mjs");
await build({
  configFile: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: { app: "app.html", popup: "popup.html" } },
  },
});
await build({
  configFile: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/background/index.ts",
      formats: ["es"],
      fileName: () => "background.js",
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
await build({
  configFile: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/content/index.ts",
      name: "UploadLedgerCapture",
      formats: ["iife"],
      fileName: () => "content.js",
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
await copyFile("manifest.template.json", "dist/manifest.json");
await copyFile("THIRD_PARTY_NOTICES.md", "dist/THIRD_PARTY_NOTICES.md");
await copyFile("LICENSE", "dist/LICENSE");
await mkdir("dist/pdfjs", { recursive: true });
await cp("node_modules/pdfjs-dist/cmaps", "dist/pdfjs/cmaps", {
  recursive: true,
});
await cp(
  "node_modules/pdfjs-dist/standard_fonts",
  "dist/pdfjs/standard_fonts",
  { recursive: true },
);
