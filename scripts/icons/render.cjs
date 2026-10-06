/**
 * 应用图标导出器（`pnpm icons`）—— **全项目所有图标都从这里出**。
 *
 * ## 图形源（唯一）
 *
 * 仓库根 `build/` 下那两份是**手工放入的设计导出**，不要用 `pnpm icons` 去覆盖它们：
 *
 *   build/classhelper.png   345×339 PNG（调色板 + tRNS，带透明）—— 所有 PNG 尺寸由它重采样；
 *   build/classhelper.ico   9 个尺寸（16/24/32/48/64/72/96/128/256，BMP 载荷）—— 由设计工具
 *                           **逐尺寸栅格化**，比把位图缩下去干净，因此**原样透传**，不重新生成。
 *
 * 历史上这里是用 Electron 渲染一段内联 SVG（"蓝色圆角块 + 白色『班』字"）生成全套图标；
 * 换成设计导出的位图之后，那套 SVG 已删除，本脚本只做重采样与分发。
 *
 * ## 产物
 *
 *   packages/web-admin/public/icon-192.png              PWA 图标
 *   packages/web-admin/public/icon-512.png              PWA 图标（manifest 里也当 maskable 用）
 *   packages/web-admin/public/apple-touch-icon.png      iOS 主屏图标（180）
 *   packages/web-admin/public/favicon.png               标签页图标（64）
 *   packages/web-admin/public/favicon.svg               标签页图标（内嵌 128 位图的 SVG 壳）
 *   packages/web-admin/public/logo.png                  **界面内**的品牌标（侧栏 / 登录页，128）
 *   packages/classisland-plugin/icon.png                ClassIsland 插件图标（256）
 *   packages/desktop-client/build/classhelper.{png,ico} 图标源在客户端的镜像
 *   packages/desktop-client/build/icon.{png,ico}        electron-builder 的**兜底约定名**
 *                                                       （`win.icon` 显式指向 classhelper.ico，
 *                                                       这两个是与它同步的副本，别再删）
 *   packages/desktop-client/public/tray.png             系统托盘图标（32）
 *   packages/desktop-client/public/logo.png             **界面内**的品牌标（侧栏 / 登录页，128）
 *   website/assets/icon.png                             官网（favicon / apple-touch / 页面内 brand）
 *
 * ## 为什么还是 Electron
 *
 * 要把一张位图重采样到 8 个尺寸（其中 512 那档是**放大**），仓库里没有任何图形库；
 * 而 Electron 自带 Chromium 的 canvas，重采样质量比 `nativeImage.resize()` 好得多
 * （后者一步到位、没有逐级折半，345→16 会走样）。为这一个脚本引 sharp/jimp 进
 * devDependencies 更不划算 —— 这条流水线从有图标那天起就是跑在 Electron 上的。
 *
 * ## 三条实现要点
 *
 * ① **非正方形源**：345×339 直接 `drawImage` 到正方形画布会拉变形，必须等比缩放后居中、
 *    四周补透明（补边只有 1.7%，肉眼不可见）；
 * ② **逐级折半**：canvas 的降采样是一次双线性，345 → 16 一步到位会糊成一团，
 *    先折到目标的两倍以内再出最后一步；
 * ③ 图片以 `data:` URL 进页面：`data:` 图**不会污染 canvas**，`toDataURL()` 拿得到数据；
 *    换成 `file://` 就会因跨源被拒（Chromium 里 file:// 页面是 opaque origin）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const BUILD_DIR = path.join(ROOT, 'build');
const SOURCE_PNG = path.join(BUILD_DIR, 'classhelper.png');
const SOURCE_ICO = path.join(BUILD_DIR, 'classhelper.ico');

/** 需要从源 PNG 重采样出来的全部尺寸（去重后每个尺寸只渲染一次） */
const PNG_SIZES = [32, 64, 128, 180, 192, 256, 512];

/** 客户端产物目录（electron-builder 的 buildResources） */
const DESKTOP_BUILD = path.join(ROOT, 'packages', 'desktop-client', 'build');

function readSourceDataUrl() {
  if (!fs.existsSync(SOURCE_PNG)) {
    throw new Error(`缺少图形源 ${path.relative(ROOT, SOURCE_PNG)}（设计导出，需手工放入）`);
  }
  return `data:image/png;base64,${fs.readFileSync(SOURCE_PNG).toString('base64')}`;
}

/**
 * 页面侧的重采样脚本。返回一张 `size×size`、内容等比居中、四周透明的 PNG（data URL）。
 *
 * 以字符串形式注入页面主世界执行（`executeJavaScript` 默认就在主世界，
 * 不受 `contextIsolation` 影响），因此这里不能用反引号。
 */
function resampleScript(size, sourceUrl) {
  return `(async () => {
  const SIZE = ${size};
  const img = new Image();
  img.src = ${JSON.stringify(sourceUrl)};
  await img.decode();

  // 等比放进 SIZE×SIZE 的目标框
  const fit = Math.min(SIZE / img.naturalWidth, SIZE / img.naturalHeight);
  const boxW = Math.max(1, Math.round(img.naturalWidth * fit));
  const boxH = Math.max(1, Math.round(img.naturalHeight * fit));

  // 逐级折半：一步到位降采样会走样，先折到目标的两倍以内
  let current = img;
  while (Math.round(current.width / 2) >= boxW && Math.round(current.height / 2) >= boxH) {
    const half = document.createElement('canvas');
    half.width = Math.max(1, Math.round(current.width / 2));
    half.height = Math.max(1, Math.round(current.height / 2));
    const halfCtx = half.getContext('2d');
    halfCtx.imageSmoothingEnabled = true;
    halfCtx.imageSmoothingQuality = 'high';
    halfCtx.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }

  // 最后一次：按 current 的实际比例重算一次落位尺寸，避免折半取整带来的亚像素拉伸
  const finalFit = Math.min(SIZE / current.width, SIZE / current.height);
  const drawW = Math.max(1, Math.round(current.width * finalFit));
  const drawH = Math.max(1, Math.round(current.height * finalFit));

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(current, Math.floor((SIZE - drawW) / 2), Math.floor((SIZE - drawH) / 2), drawW, drawH);
  return canvas.toDataURL('image/png');
})()`;
}

async function renderSizes(window, sourceUrl) {
  const pngBySize = new Map();
  for (const size of PNG_SIZES) {
    const dataUrl = await window.webContents.executeJavaScript(resampleScript(size, sourceUrl));
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error(`渲染 ${size}×${size} 失败：页面没有返回 PNG data URL`);
    }
    const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    if (buffer.length === 0) throw new Error(`渲染 ${size}×${size} 失败：数据为空`);
    console.log(`[icons] ${size}×${size} -> ${buffer.length} 字节`);
    pngBySize.set(size, buffer);
  }
  return pngBySize;
}

/** ICO 容器头解析，只用来核对设计导出里到底带了哪几个尺寸 */
function readIcoSizes(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error(`${path.relative(ROOT, SOURCE_ICO)} 不是合法的 ICO 容器`);
  }
  const count = buffer.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const base = 6 + index * 16;
    sizes.push(`${buffer[base] || 256}×${buffer[base + 1] || 256}`);
  }
  return sizes;
}

/**
 * 标签页图标的 SVG 壳。
 *
 * 设计只给了位图，没有矢量源 —— 所以这里不做"假矢量"，而是把一张 128 的 PNG 原样嵌进去。
 * 保留 `favicon.svg` 这个文件名是为了不动 `index.html` 里那条 `<link rel="icon" type="image/svg+xml">`：
 * 现代浏览器优先取 SVG 那条，删掉它反而要改 HTML、改文档。
 * 128 足够覆盖任何真实标签页尺寸（32px @4x = 128 物理像素）。
 */
function buildFaviconSvg(png128) {
  const base64 = png128.toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <image href="data:image/png;base64,${base64}" width="128" height="128" />
</svg>
`;
}

/** 内容一致就不写盘：反复跑 `pnpm icons` 不该在 git 里刷出无意义的改动 */
function writeIfChanged(file, data) {
  if (!data || data.length === 0) {
    throw new Error(`拒绝写入空内容：${path.relative(ROOT, file)}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (existing && existing.equals(data)) {
    console.log(`[icons] 未变化 ${path.relative(ROOT, file)}`);
    return;
  }
  fs.writeFileSync(file, data);
  console.log(`[icons] 写入 ${path.relative(ROOT, file)} (${data.length} 字节)`);
}

app.whenReady().then(async () => {
  try {
    const sourceUrl = readSourceDataUrl();
    const icoBytes = fs.readFileSync(SOURCE_ICO);
    const icoSizes = readIcoSizes(icoBytes);
    console.log(`[icons] 图形源 ${path.relative(ROOT, SOURCE_PNG)}`);
    console.log(`[icons] ICO 尺寸 ${icoSizes.join(' / ')}`);

    // 尺寸由页面里的 canvas 决定，窗口本身多大都行 —— 用 64×64 就够，且必须隐藏
    const window = new BrowserWindow({
      width: 64,
      height: 64,
      show: false,
      webPreferences: { offscreen: false, backgroundThrottling: false },
    });
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><title>icons</title>')}`,
    );

    const pngBySize = await renderSizes(window, sourceUrl);
    window.destroy();

    // ── Web 管理端（PWA + 标签页） ───────────────────────────────────────────
    const webPublic = path.join(ROOT, 'packages', 'web-admin', 'public');
    writeIfChanged(path.join(webPublic, 'icon-192.png'), pngBySize.get(192));
    writeIfChanged(path.join(webPublic, 'icon-512.png'), pngBySize.get(512));
    writeIfChanged(path.join(webPublic, 'apple-touch-icon.png'), pngBySize.get(180));
    writeIfChanged(path.join(webPublic, 'favicon.png'), pngBySize.get(64));
    writeIfChanged(path.join(webPublic, 'favicon.svg'), Buffer.from(buildFaviconSvg(pngBySize.get(128)), 'utf8'));
    // 界面内的品牌标（侧栏 / 登录页）。与 favicon 分开一份的理由：favicon 是给浏览器标签页用的，
    // 而这张是**渲染进页面**的（`<img src="/logo.png">`），尺寸与缓存策略都不该混在一起。
    writeIfChanged(path.join(webPublic, 'logo.png'), pngBySize.get(128));

    // ── ClassIsland 插件（清单同目录的 icon.png，ClassIsland 按约定读取） ──────
    writeIfChanged(path.join(ROOT, 'packages', 'classisland-plugin', 'icon.png'), pngBySize.get(256));

    // ── 桌面客户端 ──────────────────────────────────────────────────────────
    // classhelper.* 是源的镜像；icon.* 是 electron-builder 的兜底约定名（默认找 build/icon.ico），
    // 两套都留在客户端产物目录里，免得哪天显式配置被拿掉就悄悄退回旧图标。
    writeIfChanged(path.join(DESKTOP_BUILD, 'classhelper.png'), fs.readFileSync(SOURCE_PNG));
    writeIfChanged(path.join(DESKTOP_BUILD, 'classhelper.ico'), icoBytes);
    writeIfChanged(path.join(DESKTOP_BUILD, 'icon.png'), pngBySize.get(512));
    writeIfChanged(path.join(DESKTOP_BUILD, 'icon.ico'), icoBytes);

    // 托盘：Windows 通知区域在 100% DPI 下就是 16×16，给 32×32 让它在
    // 150% / 200% DPI 上也有原生像素可用（原先直接丢了一张 345×339 的应用图标进去，
    // 非正方形会被系统拉伸）。
    writeIfChanged(path.join(ROOT, 'packages', 'desktop-client', 'public', 'tray.png'), pngBySize.get(32));

    // 界面内的品牌标（侧栏 / 登录页）。
    // **客户端必须经 `BRAND_LOGO_URL`（src/renderer/config.ts）绑定给 `:src`**：
    // 生产环境是 file:// 加载 dist/renderer/index.html，根绝对路径会解析到盘符根目录；
    // 而字面量的相对 `src` 又会被 Vite 当成模块导入去解析、直接构建失败。
    writeIfChanged(path.join(ROOT, 'packages', 'desktop-client', 'public', 'logo.png'), pngBySize.get(128));

    // ── 官网（纯静态站，图标同样是页面里的 brand 标记） ──────────────────────
    writeIfChanged(path.join(ROOT, 'website', 'assets', 'icon.png'), pngBySize.get(512));

    console.log('[icons] 全部图标生成完成');
    app.exit(0);
  } catch (error) {
    console.error('[icons] 生成失败', error);
    app.exit(1);
  }
});
