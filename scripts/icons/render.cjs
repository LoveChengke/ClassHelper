/**
 * 用 Electron 渲染 SVG 并导出应用图标（PNG + ICO）。
 *
 * 为什么用 Electron：可以复用系统字体渲染中文标识，且无需任何图形库/ImageMagick。
 *
 * 产物：
 *   packages/web-admin/public/icon-{192,512}.png      PWA 图标
 *   packages/web-admin/public/apple-touch-icon.png    iOS 图标
 *   packages/web-admin/public/favicon.svg             浏览器标签页图标
 *   packages/desktop-client/build/icon.png            512×512（electron-builder 用）
 *   packages/desktop-client/build/icon.ico            多尺寸 ICO（安装包/EXE 图标）
 *   build/icon.ico                                    服务端安装程序图标
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const SIZES = [16, 24, 32, 48, 64, 128, 180, 192, 256, 512];

/** 品牌图形：蓝色渐变圆角方块 + 白色"班"字 + 书本底纹 */
function logoSvg(size) {
  const radius = Math.round(size * 0.22);
  const fontSize = Math.round(size * 0.52);
  const bookY = Math.round(size * 0.74);
  const bookWidth = Math.round(size * 0.5);
  const bookX = Math.round((size - bookWidth) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4facfe"/>
      <stop offset="55%" stop-color="#409eff"/>
      <stop offset="100%" stop-color="#1f6feb"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#g)"/>
  <text x="50%" y="52%" text-anchor="middle" dominant-baseline="central"
        font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-weight="700"
        font-size="${fontSize}" fill="#ffffff">班</text>
  <rect x="${bookX}" y="${bookY}" width="${bookWidth}" height="${Math.max(2, Math.round(size * 0.045))}"
        rx="${Math.round(size * 0.02)}" fill="#ffffff" opacity="0.9"/>
</svg>`;
}

function htmlFor(size) {
  return `<!doctype html><html><head><meta charset="utf-8" /><style>
    html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
    svg{display:block}
  </style></head><body>${logoSvg(size)}</body></html>`;
}

/** 把若干 PNG 打包成 ICO 容器（ICO 允许直接内嵌 PNG 数据） */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const directory = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const payloads = [];

  entries.forEach((entry, index) => {
    const base = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 0); // width
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1); // height
    directory.writeUInt8(0, base + 2); // palette
    directory.writeUInt8(0, base + 3); // reserved
    directory.writeUInt16LE(1, base + 4); // color planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
    payloads.push(entry.data);
  });

  return Buffer.concat([header, directory, ...payloads]);
}

async function renderSizes() {
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });

  const tempDir = path.join(ROOT, '.cache', 'icons');
  fs.mkdirSync(tempDir, { recursive: true });

  const pngBySize = new Map();

  for (const size of SIZES) {
    const file = path.join(tempDir, `logo-${size}.html`);
    fs.writeFileSync(file, htmlFor(size), 'utf8');
    window.setContentSize(size, size);
    await window.loadFile(file);
    await new Promise((resolve) => setTimeout(resolve, 150));

    let buffer = (await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).toPNG();

    // 隐藏窗口在部分环境下会截到空图，短暂显示后重试
    if (!buffer || buffer.length === 0) {
      window.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 250));
      buffer = (await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).toPNG();
      window.hide();
    }

    if (!buffer || buffer.length === 0) {
      throw new Error(`渲染 ${size}×${size} 图标失败：截图为空`);
    }
    console.log(`[icons] ${size}×${size} -> ${buffer.length} 字节`);
    pngBySize.set(size, buffer);
  }

  window.destroy();
  return pngBySize;
}

function writeIfChanged(file, data) {
  if (!data || (Buffer.isBuffer(data) && data.length === 0)) {
    throw new Error(`拒绝写入空内容：${path.relative(ROOT, file)}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`[icons] 写入 ${path.relative(ROOT, file)} (${data.length} 字节)`);
}

app.whenReady().then(async () => {
  try {
    const pngBySize = await renderSizes();

    // Web 管理端（PWA）
    const webPublic = path.join(ROOT, 'packages', 'web-admin', 'public');
    writeIfChanged(path.join(webPublic, 'icon-192.png'), pngBySize.get(192));
    writeIfChanged(path.join(webPublic, 'icon-512.png'), pngBySize.get(512));
    writeIfChanged(path.join(webPublic, 'apple-touch-icon.png'), pngBySize.get(180));
    writeIfChanged(path.join(webPublic, 'favicon.svg'), Buffer.from(logoSvg(64), 'utf8'));
    writeIfChanged(path.join(webPublic, 'favicon.png'), pngBySize.get(64));

    // 桌面客户端（electron-builder）
    const desktopBuild = path.join(ROOT, 'packages', 'desktop-client', 'build');
    writeIfChanged(path.join(desktopBuild, 'icon.png'), pngBySize.get(512));

    // ICO（安装包 / EXE 图标）：包含常用尺寸
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const ico = buildIco(icoSizes.map((size) => ({ size, data: pngBySize.get(size) })));
    writeIfChanged(path.join(desktopBuild, 'icon.ico'), ico);
    writeIfChanged(path.join(ROOT, 'build', 'icon.ico'), ico);
    writeIfChanged(path.join(ROOT, 'build', 'icon.png'), pngBySize.get(512));

    console.log('[icons] 全部图标生成完成');
    app.exit(0);
  } catch (error) {
    console.error('[icons] 生成失败', error);
    app.exit(1);
  }
});
