// One-off build tool: rasterizes assets/icon.svg into assets/icon.png at a
// few sizes, using Electron's own bundled Chromium instead of pulling in an
// image-conversion dependency just for this. Run with:
//   node_modules/.bin/electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// This sandboxed dev environment has no usable GPU/compositor, which makes
// capturePage() fail with UnknownVizError under normal hardware-accelerated
// rendering. Software rendering fixes it and is plenty for a one-off,
// build-time icon render.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer', 'false');
app.commandLine.appendSwitch('use-gl', 'swiftshader');

const SVG_PATH = path.join(__dirname, '..', 'assets', 'icon.svg');
// Just the one size: it's the only file any code or build config here
// references (main.js's tray/window icon, and electron-builder's single-file
// icon config, which generates whatever per-platform sizes it needs from this).
const SIZES = [1024];

app.whenReady().then(async () => {
  const svgMarkup = fs.readFileSync(SVG_PATH, 'utf8');
  const html = `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;}
    svg{display:block;}
  </style></head><body>${svgMarkup}</body></html>`;
  const htmlPath = path.join(__dirname, '_render.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  for (const size of SIZES) {
    const win = new BrowserWindow({
      width: size,
      height: size,
      show: false,
      transparent: true,
      webPreferences: { offscreen: false },
    });
    await win.loadFile(htmlPath);
    // Force the SVG element itself to exactly the render size regardless of
    // its own width/height attributes, so every output size is crisp.
    await win.webContents.executeJavaScript(`
      const el = document.querySelector('svg');
      el.setAttribute('width', '${size}');
      el.setAttribute('height', '${size}');
    `);
    const image = await win.webContents.capturePage();
    const outPath = size === 1024
      ? path.join(__dirname, '..', 'assets', 'icon.png')
      : path.join(__dirname, '..', 'assets', `icon-${size}.png`);
    fs.writeFileSync(outPath, image.toPNG());
    console.log(`wrote ${outPath}`);
    win.destroy();
  }

  fs.unlinkSync(htmlPath);
  app.quit();
});
