import fs from 'node:fs';
import path from 'node:path';
import {
  defaultIslandLayouts,
  islandNode,
  normalizeIslandLayouts,
  ISLAND_SHADOW_PAD,
} from '@classhelper/shared';
import { getConfig, saveConfig } from './config.js';
import { island } from './island.js';

/** 常驻岛始终用隔离的冒烟配置和本地消息；不读取或标记真实班级通知。 */
export async function verifyResidentSmoke(
  check: (name: string, action: () => Promise<boolean | string> | boolean) => Promise<void>,
) {
  const win = island.getWindow()!;
  const originalTouchMode = island.getTouchMode();
  const originalAppearance = island.getAppearance();
  island.setAppearance({ animations: true, speed: 1 });
  island.setTouchMode(false);
  island.setHitTestCursor({ x: 0, y: 0 });
  const pause = (ms = 600) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function shot(name: string) {
    if (!process.env.ISLAND_SHOTS_DIR || process.env.ELECTRON_SMOKE_MODE !== 'visual') return;
    fs.mkdirSync(process.env.ISLAND_SHOTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.ISLAND_SHOTS_DIR, `${name}.png`),
      (
        await win.webContents.capturePage(
          island.getEditingLayout()
            ? undefined
            : (() => {
                const r = island.getHitRect();
                return r
                  ? {
                      x: Math.max(0, Math.floor(r.x - 8)),
                      y: Math.max(0, Math.floor(r.y - 8)),
                      width: Math.ceil(r.width + 16),
                      height: Math.ceil(r.height + 16),
                    }
                  : undefined;
              })(),
        )
      ).toPNG(),
    );
  }
  const fixture = defaultIslandLayouts();
  fixture.layout = 'custom';
  fixture.residentEnabled = true;
  const compactText = islandNode('text', 'resident-compact-text');
  compactText.settings.text = '常驻概览';
  const expandedText = islandNode('text', 'resident-expanded-text');
  expandedText.settings.text = '今日安排';
  const scheme = fixture.schemes[0]!;
  scheme.rows[0]!.nodes = [
    islandNode('clock', 'resident-clock'),
    islandNode('separator', 'resident-separator'),
    compactText,
  ];
  scheme.expandedRows[0]!.nodes = [islandNode('date', 'resident-date'), expandedText];
  island.handleAction({ action: 'dismiss-all' });
  await pause();
  await check('旧岛配置默认关闭常驻，并兼容补齐空闲展开布局', () => {
    const legacy = JSON.parse(JSON.stringify(fixture));
    delete legacy.residentEnabled;
    delete legacy.schemes[0].expandedRows;
    const value = normalizeIslandLayouts(legacy);
    const oversized = JSON.parse(JSON.stringify(fixture));
    Object.assign(oversized.schemes[0], { scale: 99, radius: 99, opacity: -1, spacing: 999 });
    const bounds = normalizeIslandLayouts(oversized).schemes[0]!;
    return (
      !value.residentEnabled &&
      value.schemes[0]!.expandedRows[0]!.nodes.length > 0 &&
      bounds.scale === 2.5 &&
      bounds.radius === 20 &&
      bounds.opacity === 0 &&
      bounds.spacing === 150
    );
  });
  saveConfig({ islandLayout: fixture });
  island.syncCustomLayout();
  await pause(800);
  let compactWidth = 0;
  await check('无通知常驻岛显示自定义内容，并为铃铛预留对齐空间', async () => {
    const layout = await win.webContents.executeJavaScript(`(() => {
      const card=document.querySelector('.custom-card'), strip=card?.querySelector('.resident-compact'), bell=card?.querySelector('.resident-bell'), clock=card?.querySelector('.clock'), text=card?.querySelector('.text span'), digits=clock?.querySelector('span');
      if(!card||!strip||!bell||!clock||!text||!digits)return null;
      const b=bell.getBoundingClientRect(), c=clock.getBoundingClientRect(), r=card.getBoundingClientRect();
      const t=text.getBoundingClientRect(),d=digits.getBoundingClientRect();
      return {width:r.width, height:r.height, content:card.textContent.includes('常驻概览'), hidden:bell.classList.contains('bell-empty')&&!bell.querySelector('span'), aligned:Math.abs(b.top+b.height/2-c.top-c.height/2)<=1 && Math.abs(t.top+t.height/2-d.top-d.height/2)<=4};
    })()`);
    compactWidth = layout?.width ?? 0;
    return Boolean(
      layout?.content &&
      layout.hidden &&
      layout.aligned &&
      Math.abs(layout.height - 40) <= 1 &&
      island.getState().mode === 'hidden',
    );
  });
  await shot('resident-compact');
  await check('鼠标移入常驻背景淡化至5%并穿透，移出恢复', async () => {
    const normalOpacity = win.getOpacity();
    const rect = await win.webContents.executeJavaScript(
      `(() => {const r=document.querySelector('.clock').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
    const box = win.getBounds();
    island.setHitTestCursor({ x: box.x + rect.x, y: box.y + rect.y });
    await pause(120);
    const faded = Math.abs(win.getOpacity() - normalOpacity * 0.05) < 0.01 && !island.getInteractive();
    island.setHitTestCursor({ x: 0, y: 0 });
    await pause(120);
    return faded && Math.abs(win.getOpacity() - normalOpacity) < 0.01;
  });
  await check('右侧展开入口不避让，触摸交互暂停指针淡化', async () => {
    const rect = await win.webContents.executeJavaScript(
      `(() => {const r=document.querySelector('.resident-bell').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
    const box = win.getBounds(),
      normalOpacity = win.getOpacity();
    island.setHitTestCursor({ x: box.x + rect.x, y: box.y + rect.y });
    await pause(120);
    const controlAvailable =
      Math.abs(win.getOpacity() - normalOpacity) < 0.01 && (!win.isVisible() || island.getInteractive());
    island.setTouchMode(true);
    island.noteResidentTouch();
    island.setHitTestCursor({ x: box.x + 20, y: box.y + 20 });
    await pause(120);
    const touchAvailable = Math.abs(win.getOpacity() - normalOpacity) < 0.01;
    island.setHitTestCursor({ x: 0, y: 0 });
    island.setTouchMode(false);
    await pause(1100);
    return controlAvailable && touchAvailable;
  });
  await check('ClassIsland 反转淡化和关闭淡化设置生效', async () => {
    const config = getConfig().islandLayout,
      normalOpacity = win.getOpacity();
    config.pointerFadeReversed = true;
    saveConfig({ islandLayout: config });
    island.syncCustomLayout();
    await pause(120);
    const reversed = Math.abs(win.getOpacity() - normalOpacity * 0.05) < 0.01;
    config.pointerFadeEnabled = false;
    saveConfig({ islandLayout: config });
    island.syncCustomLayout();
    await pause(120);
    const disabled = Math.abs(win.getOpacity() - normalOpacity) < 0.01;
    config.pointerFadeReversed = false;
    config.pointerFadeEnabled = true;
    saveConfig({ islandLayout: config });
    island.syncCustomLayout();
    return reversed && disabled;
  });
  await check('点击常驻内容展开无通知布局', async () => {
    await win.webContents.executeJavaScript(`document.querySelector('.custom-card .clock')?.click()`);
    await pause();
    return (
      island.getState().mode === 'expanded' &&
      !island.getState().active &&
      (await win.webContents.executeJavaScript(
        `(() => {const page=document.querySelector('.resident-detail-page.page-active');return Boolean(page?.querySelector('.resident-panel-heading')&&page.textContent.includes('今日安排')&&document.querySelector('.resident-compact-page[inert]'));})()`,
      ))
    );
  });
  await shot('resident-empty-expanded');
  await check('无通知展开页可以收回常驻岛且尺寸恢复', async () => {
    await win.webContents.executeJavaScript(`document.querySelector('[aria-label="收起常驻岛"]')?.click()`);
    await pause(800);
    return (
      island.getState().mode === 'hidden' &&
      (await win.webContents.executeJavaScript(
        `Math.abs(document.querySelector('.custom-card').getBoundingClientRect().width-${compactWidth})<=2`,
      ))
    );
  });
  const message = (id: string, title: string, priority: 'NORMAL' | 'URGENT') => ({
    id,
    title,
    content: '本地隔离消息内容',
    priority,
    createdAt: new Date().toISOString(),
    teacherName: '本地验证',
    courseName: null,
  });
  await check('上课收到普通消息只亮铃铛，常驻内容不横移', async () => {
    island.setClassState({ inClass: true, currentPeriodEnd: null, week: 1 });
    island.pushNotification(message('resident-normal', '常驻通知一', 'NORMAL'));
    await pause();
    return (
      island.getState().mode === 'pill' &&
      (await win.webContents.executeJavaScript(`(() => {
      const card=document.querySelector('.custom-card'),bell=card?.querySelector('.resident-bell');
      return Boolean(bell&&!bell.classList.contains('bell-empty')&&bell.textContent.trim()==='1'&&Math.abs(card.getBoundingClientRect().width-${compactWidth})<=2&&!card.classList.contains('has-alert'));
    })()`))
    );
  });
  await shot('resident-bell');
  await check('紧急消息也先提示铃铛，重复消息不增加数量', async () => {
    island.pushNotification(message('resident-urgent', '常驻通知二', 'URGENT'));
    island.pushNotification(message('resident-urgent', '常驻通知二', 'URGENT'));
    await pause();
    return (
      island.getState().mode === 'pill' &&
      (await win.webContents.executeJavaScript(
        `document.querySelector('.resident-bell')?.textContent.trim()==='2'`,
      ))
    );
  });
  await check('点击铃铛展开通知列表，上课时也可主动查看', async () => {
    await win.webContents.executeJavaScript(`document.querySelector('.resident-bell')?.click()`);
    await pause(1800);
    return (
      island.getState().mode === 'expanded' &&
      (await win.webContents.executeJavaScript(
        `(() => {const host=document.querySelector('#custom-alert-host');return Boolean(host&&host.getBoundingClientRect().height>0&&host.querySelectorAll('.list-row').length===2&&host.textContent.includes('常驻通知一')&&host.textContent.includes('常驻通知二')&&!host.querySelector('.island-root'));})()`,
      ))
    );
  });
  await shot('resident-notifications');
  await check('收起通知保留铃铛，键盘可重新展开', async () => {
    await win.webContents.executeJavaScript(
      `document.querySelector('.resident-panel-heading .icon-btn')?.click()`,
    );
    await pause(800);
    const collapsed = island.getState().mode === 'pill';
    await win.webContents.executeJavaScript(
      `document.querySelector('.custom-card')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    );
    await pause();
    return collapsed && island.getState().mode === 'expanded';
  });
  await check('处理完通知清除铃铛，恢复40px常驻内容且命中不占整窗', async () => {
    await win.webContents.executeJavaScript(
      `document.querySelector('#custom-alert-host .solid-btn')?.click()`,
    );
    await pause(800);
    const box = win.getBounds();
    const dimensions = await win.webContents.executeJavaScript(
      `(() => {const card=document.querySelector('.custom-card'), r=card.getBoundingClientRect();return {width:r.width,height:r.height,empty:card.querySelector('.resident-bell')?.classList.contains('bell-empty'),content:card.textContent.includes('常驻概览')};})()`,
    );
    return (
      !island.getState().active &&
      island.getState().queued.length === 0 &&
      dimensions.empty === true &&
      dimensions.content &&
      dimensions.width + 2 * ISLAND_SHADOW_PAD <= box.width &&
      Math.abs(dimensions.height - 40) <= 1 &&
      Math.abs((island.getHitRect()?.height ?? 0) - dimensions.height) <= 2
    );
  });
  await check('空闲展开时收到消息返回铃铛提示', async () => {
    island.handleAction({ action: 'expand' });
    await pause();
    island.pushNotification(message('resident-after-open', '展开后新消息', 'NORMAL'));
    await pause(800);
    const collapsed = island.getState().mode === 'pill';
    island.handleAction({ action: 'dismiss-all' });
    await pause();
    return collapsed;
  });
  await check('常驻岛开合复用固定画布，动画中没有滚动容器或旧胶囊形变', async () => {
    const bounds = new Set<string>();
    const timer = setInterval(() => bounds.add(JSON.stringify(win.getBounds())), 20);
    let result;
    try {
      result = await win.webContents.executeJavaScript(`new Promise(resolve => {
        const frames=[], gaps=[]; let last=performance.now(), count=0;
        const sample=()=>{
          const card=document.querySelector('.resident-card'), r=card?.getBoundingClientRect();
          if(!r){frames.push(false);return;}
          const nodes=[card,...card.querySelectorAll('*')];
          frames.push(r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&nodes.every(n=>!['auto','scroll'].includes(getComputedStyle(n).overflowY)&&!['auto','scroll'].includes(getComputedStyle(n).overflowX)));
        };
        const animate=time=>{gaps.push(time-last);last=time;count++;sample();if(time-start<1800)requestAnimationFrame(animate);};
        const start=performance.now();requestAnimationFrame(animate);
        window.island.sendAction('expand');setTimeout(()=>window.island.sendAction('collapse'),700);
        setTimeout(()=>{sample(); const card=document.querySelector('.resident-card');resolve({valid:frames.every(Boolean),count,gaps:gaps.filter(g=>g>0).sort((a,b)=>a-b),height:card.getBoundingClientRect().height,legacy:document.querySelector('.island-root')?.getBoundingClientRect().height===0});},1900);
      })`);
    } finally {
      clearInterval(timer);
    }
    if (process.env.ISLAND_SHOTS_DIR)
      fs.writeFileSync(
        path.join(
          process.env.ISLAND_SHOTS_DIR,
          `resident-animation-metrics-${process.env.ELECTRON_SMOKE_MODE}.json`,
        ),
        JSON.stringify({ ...result, windowRects: bounds.size }, null, 2),
      );
    const visual = process.env.ELECTRON_SMOKE_MODE === 'visual';
    return Boolean(
      result?.valid &&
      result.legacy &&
      Math.abs(result.height - 40) <= 1 &&
      bounds.size === 1 &&
      (!visual || (result.count >= 20 && result.gaps[Math.floor(result.gaps.length * 0.95)] < 100)),
    );
  });
  await check('常驻岛连续快速开合后恢复40px且没有遗留过渡', async () => {
    const box = win.getBounds();
    const stable = await win.webContents.executeJavaScript(`new Promise(resolve=>{
      for(let i=0;i<8;i++)setTimeout(()=>window.island.sendAction(i%2?'collapse':'expand'),i*70);
      setTimeout(()=>{const r=document.querySelector('.resident-card').getBoundingClientRect();resolve({width:r.width,height:r.height,active:document.querySelector('.resident-compact-page').classList.contains('page-active')});},1300);
    })`);
    return Boolean(
      stable.active &&
      Math.abs(stable.height - 40) <= 1 &&
      Math.abs(stable.width - compactWidth) <= 2 &&
      JSON.stringify(box) === JSON.stringify(win.getBounds()),
    );
  });
  await check('收起时鼠标留在旧展开区域不会错误触发5%淡化闪烁', async () => {
    island.handleAction({ action: 'expand' });
    await pause(800);
    const hit = island.getHitRect()!,
      box = win.getBounds(),
      opacity = win.getOpacity();
    island.setHitTestCursor({ x: box.x + hit.x + hit.width / 2, y: box.y + hit.y + hit.height - 12 });
    island.handleAction({ action: 'collapse' });
    const immediate = win.getOpacity();
    await pause(120);
    const after = win.getOpacity();
    island.setHitTestCursor({ x: 0, y: 0 });
    await pause(700);
    return Math.abs(immediate - opacity) < 0.01 && Math.abs(after - opacity) < 0.01;
  });
  await check('长文本多行与2.5倍字号自动适配，变窄窗口和底部右侧停靠均不溢出', async () => {
    const appearance = island.getAppearance();
    const dense = JSON.parse(JSON.stringify(fixture));
    dense.schemes[0].scale = 2.5;
    dense.schemes[0].separated = true;
    dense.schemes[0].rows[0].nodes[2].settings.text = '自适应常驻内容'.repeat(18);
    dense.schemes[0].rows.push({ ...dense.schemes[0].rows[0], id: 'resident-dense-row' });
    saveConfig({ islandLayout: dense });
    island.syncCustomLayout();
    island.setAppearance({ position: 'bottom-right' });
    await pause(800);
    // 模拟更小的工作区画布，检查响应的是 resize，而不是上一次固定像素尺寸。
    const box = win.getBounds();
    win.setBounds({ ...box, width: 360, height: 260 });
    await pause(800);
    const geometry = await win.webContents.executeJavaScript(`(() => {
      const card=document.querySelector('.resident-card'), page=card.querySelector('.page-active'), source=page.querySelector('.resident-source');
      const r=card.getBoundingClientRect(), c=source.getBoundingClientRect();
      return {r:r.toJSON(), c:c.toJSON(), width:innerWidth,height:innerHeight, fits:r.width<=340&&r.height<=240&&r.right<=innerWidth&&r.bottom<=innerHeight&&c.left>=r.left-1&&c.right<=r.right+1&&c.bottom<=r.bottom+1&&getComputedStyle(card).overflowY!=='auto'&&card.classList.contains('resident-separated')};
    })()`);
    const hit = island.getHitRect();
    const hitMatches = hit && Math.abs(hit.x - geometry.r.x) <= 2 && Math.abs(hit.y - geometry.r.y) <= 2;
    await shot('resident-adaptive-narrow');
    saveConfig({ islandLayout: fixture });
    island.syncCustomLayout();
    island.setAppearance(appearance);
    await pause(800);
    if (!geometry.fits || !hitMatches) throw new Error(JSON.stringify({ ...geometry, hit }));
    return true;
  });
  await check('常驻消息较多及超长正文不产生滚动条，底部操作始终可见', async () => {
    for (let i = 0; i < 8; i++)
      island.pushNotification({
        ...message('resident-overflow-' + i, '较多通知 ' + i, 'NORMAL'),
        content: '超长正文'.repeat(200),
      });
    island.handleAction({ action: 'expand' });
    await pause(800);
    island.handleAction({ action: 'expand-list' });
    await pause(800);
    const geometry = await win.webContents.executeJavaScript(`(() => {
      const card=document.querySelector('.resident-card'), footer=card.querySelector('.resident-actions'), r=card.getBoundingClientRect(), f=footer?.getBoundingClientRect();
      return {r:r.toJSON(),f:f?.toJSON(), fits:Boolean(f&&f.bottom<=r.bottom+1&&f.left>=r.left&&f.right<=r.right+1&&card.querySelector('.resident-more')&&[card,...card.querySelectorAll('*')].every(n=>!['auto','scroll'].includes(getComputedStyle(n).overflowY)))};
    })()`);
    await shot('resident-many-notifications');
    island.handleAction({ action: 'dismiss-all' });
    await pause(800);
    if (!geometry.fits) throw new Error(JSON.stringify(geometry));
    return true;
  });
  await check('触摸常驻岛停稳后只保留岛体输入区域，开合不缩放原生窗口', async () => {
    if (process.platform !== 'win32') return true;
    const original = win.setShape.bind(win);
    let shape: Electron.Rectangle[] = [];
    win.setShape = (rects) => {
      shape = rects;
      original(rects);
    };
    try {
      island.setTouchMode(true);
      const box = win.getBounds();
      island.handleAction({ action: 'expand' });
      await pause(1000);
      island.handleAction({ action: 'collapse' });
      await pause(1000);
      const hit = island.getHitRect();
      return Boolean(
        hit &&
        shape.length === 1 &&
        shape[0]!.width <= hit.width + 18 &&
        shape[0]!.height <= hit.height + 18 &&
        JSON.stringify(box) === JSON.stringify(win.getBounds()),
      );
    } finally {
      win.setShape = original;
      island.setTouchMode(false);
    }
  });
  await check('常驻和无通知展开内容可独立编辑并持久化', async () => {
    island.editLayout();
    await pause();
    await win.webContents.executeJavaScript(
      `(() => {const button=[...document.querySelectorAll('.surface-tabs button')].find(b=>b.textContent.includes('无通知'));button?.click();})()`,
    );
    await pause(200);
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-node="resident-expanded-text"]')?.click()`,
    );
    await pause(200);
    await win.webContents.executeJavaScript(
      `(() => {const input=document.querySelector('.settings textarea');if(!input)throw Error('未找到展开文本设置');input.value='放学前检查';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await pause();
    const saved = getConfig().islandLayout.schemes[0]!;
    const independent =
      saved.rows[0]!.nodes.find((n) => n.id === 'resident-compact-text')?.settings.text === '常驻概览' &&
      saved.expandedRows[0]!.nodes.find((n) => n.id === 'resident-expanded-text')?.settings.text ===
        '放学前检查';
    await shot('resident-editor');
    island.editLayout(false);
    await pause();
    const roundtrip = normalizeIslandLayouts(JSON.parse(JSON.stringify(getConfig().islandLayout)));
    return (
      independent &&
      roundtrip.residentEnabled &&
      roundtrip.schemes[0]!.expandedRows[0]!.nodes.some((n) => n.settings.text === '放学前检查')
    );
  });
  await check('关闭常驻并选择经典岛后恢复原有隐藏方式', async () => {
    island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
    saveConfig({ islandLayout: defaultIslandLayouts() });
    island.syncCustomLayout();
    await pause();
    return (
      !win.isVisible() &&
      !getConfig().islandLayout.residentEnabled &&
      (await win.webContents.executeJavaScript(`!document.querySelector('.custom-card')`))
    );
  });
  island.setHitTestCursor(null);
  island.setTouchMode(originalTouchMode);
  island.setAppearance(originalAppearance);
}
