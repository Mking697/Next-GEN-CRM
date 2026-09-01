// Next's standalone output does not include `public/` or `.next/static`.
// Copy them in so `node .next/standalone/server.js` serves a complete app.
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  console.error(
    "[postbuild] .next/standalone missing. Is `output: \"standalone\"` set in next.config.ts?",
  );
  process.exit(1);
}

const publicDir = path.join(root, "public");
if (existsSync(publicDir)) {
  await cp(publicDir, path.join(standalone, "public"), { recursive: true });
  console.log("[postbuild] copied public/");
}

const staticDir = path.join(root, ".next", "static");
if (existsSync(staticDir)) {
  await mkdir(path.join(standalone, ".next"), { recursive: true });
  await cp(staticDir, path.join(standalone, ".next", "static"), {
    recursive: true,
  });
  console.log("[postbuild] copied .next/static/");
}

console.log("[postbuild] standalone bundle ready -> npm start");
