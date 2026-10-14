/** Regenerate checked-in brand assets from the approved Seedream master. Requires ImageMagick 7. */
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = join(root, "assets/branding");
const output = join(root, "public/assets");
const scratch = await mkdtemp(join(tmpdir(), "codemux-icons-"));

async function magick(...args: string[]): Promise<void> {
  const child = Bun.spawn(["magick", ...args], { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("ImageMagick failed to generate a brand asset");
}

try {
  const mask = join(scratch, "mark.png");
  const accent = join(scratch, "accent.png");
  const mark = join(scratch, "foreground.png");
  const blue = join(scratch, "blue.png");
  const artwork = join(scratch, "artwork.png");
  const tileMask = join(scratch, "tile-mask.png");
  const tile = join(scratch, "tile.png");

  // Remove generated texture and bevels while retaining the generated contours.
  await magick(join(source, "icon-master.png"), "-fx",
    "max(0,min(1,(max(r,max(g,b))-0.4)/0.4))", "-alpha", "off", mask);
  await magick(join(source, "icon-master.png"), "-fx",
    "max(0,min(1,(b-r-0.12)/0.25))*max(0,min(1,(b-0.4)/0.4))", "-alpha", "off", accent);
  await magick("-size", "2048x2048", "xc:#F3F6FA", mask, "-alpha", "off",
    "-compose", "CopyOpacity", "-composite", mark);
  await magick("-size", "2048x2048", "xc:#77AFFF", accent, "-alpha", "off",
    "-compose", "CopyOpacity", "-composite", blue);
  await magick("-size", "2048x2048", "gradient:#293642-#1C2631", mark,
    "-compose", "Over", "-composite", blue, "-composite", "-resize", "1024x1024", artwork);

  // macOS and desktop launchers need transparent space outside the app tile.
  await magick("-size", "896x896", "xc:none", "-fill", "white", "-draw",
    "roundrectangle 0,0 895,895 198,198", tileMask);
  await magick(artwork, "-resize", "896x896", tileMask, "-alpha", "off",
    "-compose", "CopyOpacity", "-composite", "-compose", "Over", "-gravity", "center", "-background", "none",
    "-extent", "1024x1024", tile);
  await copyFile(tile, join(output, "icon.png"));
  await magick(tile, "-resize", "512x512", join(output, "logo.png"));
  await copyFile(join(output, "logo.png"), join(root, "assets/logo.png"));
  await copyFile(join(output, "logo.png"), join(root, "website/public/logo.png"));
  for (const size of [192, 512]) {
    await magick(tile, "-resize", `${size}x${size}`, join(output, `favicon-${size}.png`));
  }

  // Apple owns home-screen corner masking; Android requires a full-bleed safe area.
  await magick(artwork, "-resize", "180x180", join(output, "apple-touch-icon.png"));
  await magick(mark, blue, "-compose", "Over", "-composite", "-trim", "+repage",
    "-resize", "600x600", "-gravity", "center", "-background", "none", "-extent", "1024x1024",
    join(scratch, "maskable-mark.png"));
  await magick("-size", "1024x1024", "gradient:#293642-#1C2631", join(scratch, "maskable-mark.png"),
    "-compose", "Over", "-composite", "-resize", "512x512", join(output, "pwa-maskable-512.png"));

  // Render the optical small-size master at high resolution before downsampling.
  await magick("-background", "none", "-density", "768", join(source, "tray-mark.svg"),
    "-resize", "18x18", join(output, "trayTemplate.png"));
  await magick("-background", "none", "-density", "768", join(source, "tray-mark.svg"),
    "-resize", "36x36", join(output, "trayTemplate@2x.png"));

  const smallSvg = (await Bun.file(join(source, "tray-mark.svg")).text())
    .replace(/#000/g, "#F3F6FA")
    .replace('id="prompt"', 'id="prompt" fill="#77AFFF"');
  const smallTile = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
    <rect x=".5" y=".5" width="23" height="23" rx="5.5" fill="#23303D"/>
    <g transform="translate(3 2.5)">${smallSvg.replace(/<\/?svg[^>]*>/g, "")}</g>
  </svg>`;
  await writeFile(join(scratch, "small.svg"), smallTile);
  const icoImages: string[] = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
    const destination = join(scratch, `icon-${size}.png`);
    if (size <= 48) {
      await magick("-background", "none", "-density", "768", join(scratch, "small.svg"),
        "-resize", `${size}x${size}`, destination);
    } else {
      await magick(tile, "-resize", `${size}x${size}`, destination);
    }
    icoImages.push(destination);
    if ([16, 32, 48].includes(size)) {
      await copyFile(destination, join(output, `favicon-${size}x${size}.png`));
    }
    if (size === 32) await copyFile(destination, join(output, "tray.png"));
  }
  await magick(...icoImages, join(output, "icon.ico"));
  await copyFile(join(output, "favicon-32x32.png"), join(root, "website/public/favicon.png"));
  console.log("Generated desktop, tray, web, PWA, and website brand assets.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
