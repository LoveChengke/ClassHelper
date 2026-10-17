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
  island.setTouchMode(false);
  island.setHitTestCursor({ x: 0, y: 0 });
  const pause = (ms = 600) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function shot(name: string) {
    if (!process.env.ISLAND_SHOTS_DIR) return;
    fs.mkdirSync(process.env.ISLAND_SHOTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.ISLAND_SHOTS_DIR, `${name}.png`),
      (await win.webContents.capturePage()).toPNG(),
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
        `(() => {const card=document.querySelector('.custom-card');return Boolean(card?.querySelector('.resident-panel-heading')&&card.textContent.includes('今日安排')&&!card.textContent.includes('常驻概览'));})()`,
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
  await check('点击铃铛展开原通知列表，上课时也可主动查看', async () => {
    await win.webContents.executeJavaScript(`document.querySelector('.resident-bell')?.click()`);
    await pause(1800);
    return (
      island.getState().mode === 'expanded' &&
      (await win.webContents.executeJavaScript(
        `(() => {const host=document.querySelector('#custom-alert-host');return Boolean(host&&host.getBoundingClientRect().height>0&&host.querySelectorAll('.list-row').length===2&&host.textContent.includes('常驻通知一')&&host.textContent.includes('常驻通知二')&&!document.querySelector('.resident-panel-heading'));})()`,
      ))
    );
  });
  await shot('resident-notifications');
  await check('收起通知保留铃铛，键盘可重新展开', async () => {
    await win.webContents.executeJavaScript(
      `document.querySelector('#custom-alert-host .icon-btn')?.click()`,
    );
    await pause(800);
    const collapsed = island.getState().mode === 'pill';
    await win.webContents.executeJavaScript(
      `document.querySelector('.custom-card')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`,
    );
    await pause();
    return collapsed && island.getState().mode === 'expanded';
  });
  await check('处理完通知清除铃铛，恢复常驻内容与窗口留白', async () => {
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
      Math.abs(box.width - dimensions.width - 2 * ISLAND_SHADOW_PAD) <= 2 &&
      Math.abs(box.height - dimensions.height - 2 * ISLAND_SHADOW_PAD) <= 2
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
}
