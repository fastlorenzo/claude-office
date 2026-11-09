// Render build/icon.svg to build/icon.png (512px). electron-builder derives the
// Windows .ico and Linux icon sizes from the PNG. Run: bun run icon
import sharp from "sharp";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "build");
await sharp(join(dir, "icon.svg"), { density: 384 })
  .resize(512, 512)
  .png()
  .toFile(join(dir, "icon.png"));
console.log("wrote build/icon.png");
