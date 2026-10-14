# CodeMux product icons

The existing three wireless bands, terminal frame, chevron, and underscore remain the product mark. The palette uses graphite (`#23303D`), soft white (`#F3F6FA`), and blue (`#77AFFF`). Texture, bevels, and glow are removed from the shipped assets.

`icon-master.png` is the original Seedream 5.0 Pro output, generated once on 2026-10-14 with `doubao-seedream-5-0-pro-260628`. `icon-reference.png` is the previous product icon used as its edit reference. The exact request is in `icon-prompt.txt`. Generation used the existing VOLC image skill helper and account; regeneration of the platform assets is entirely local.

Run from the repository root with Bun and ImageMagick 7 installed:

```sh
bun scripts/generate-brand-icons.ts
```

The script exports:

- A 1024 px desktop icon with rounded corners and transparent outer margins, plus matching app, website, README, and PWA icons.
- A Windows ICO containing 16, 20, 24, 32, 40, 48, 64, 128, and 256 px representations.
- A dedicated small-size mark for favicons and trays. The three signal bands become solid at small sizes so they remain separated. The editable optical master is `tray-mark.svg`.
- An 18 px monochrome macOS template with a 36 px Retina representation. macOS supplies the menu-bar color; do not resize away its representations or bake in a light/dark background.
- An opaque Apple touch icon without pre-applied corners, and an Android maskable icon whose complete mark fits inside the central 80% diameter safe circle.

Desktop app icons and tray templates are deliberately separate assets. Running, focused, and inactive taskbar indicators remain owned by the operating system; no simulated task state badges are baked into the artwork.
