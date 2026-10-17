import fs from 'node:fs';
import path from 'node:path';
import { island } from './island.js';
import { getConfig, saveConfig } from './config.js';
import { defaultIslandLayouts, ISLAND_SHADOW_PAD } from '@classhelper/shared';
export async function verifyLayoutSmoke(
  check: (name: string, action: () => Promise<boolean | string> | boolean) => Promise<void>,
) {
  const original = getConfig().islandLayout;
  await island.init(null);
  island.setTestInputPassthrough(true);
  const win = island.getWindow()!;
  const pause = () => new Promise<void>((r) => setTimeout(r, 400));
  try {
    await pause();
    await check('默认 fixed 布局且尺寸上报不参与', async () => {
      saveConfig({ islandLayout: defaultIslandLayouts() });
      const before = win.getBounds();
      island.reportCustomSize({ width: 900, height: 900 });
      await pause();
      const after = win.getBounds();
      return (
        before.width === after.width &&
        before.height === after.height &&
        getConfig().islandLayout.layout === 'fixed'
      );
    });
    await check('自定义编辑模式可进入并添加组件行', async () => {
      island.editLayout();
      await pause();
      return win.webContents.executeJavaScript(
        `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('在下方新建'));b?.click();return Boolean(document.querySelector('.layout-editor')); })()`,
      );
    });
    await check('触摸拖动可跨行并持久化', async () => {
      await pause();
      await win.webContents.executeJavaScript(`(() => {
        const handle=document.querySelector('.node-handle[data-kind=clock]');
        const row=document.querySelectorAll('[data-row]')[1]; if(!handle||!row)throw Error('缺少拖动目标');
        const r=row.getBoundingClientRect(); const x=r.left+Math.min(20,r.width/2),y=r.top+r.height/2;
        handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:19,pointerType:'touch',clientX:10,clientY:10}));
        handle.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:19,pointerType:'touch',clientX:x,clientY:y}));
        handle.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:19,pointerType:'touch',clientX:x,clientY:y}));
      })()`);
      await pause();
      return getConfig().islandLayout.schemes[0]?.rows[1]?.nodes.some((n) => n.kind === 'clock') === true;
    });
    await check('组件可以包裹进容器且设置独立保存', async () => {
      await win.webContents.executeJavaScript(
        `(() => { const select=document.querySelector('.settings select');if(!select)throw Error('未选中组件');select.value='group';select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
      );
      await pause();
      return (
        getConfig().islandLayout.schemes[0]?.rows.some((r) =>
          r.nodes.some((n) => n.kind === 'group' && n.children.some((c) => c.kind === 'clock')),
        ) === true
      );
    });
    if (process.env.ISLAND_SHOTS_DIR) {
      fs.mkdirSync(process.env.ISLAND_SHOTS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.ISLAND_SHOTS_DIR, 'custom-editor.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    await check('退出编辑后配置可从 getConfig 读回', async () => {
      island.editLayout(false);
      await pause();
      return !island.getEditingLayout() && getConfig().islandLayout.schemes[0]!.rows.length === 2;
    });
    await check('自定义窗口等于卡片加阴影留白且夹紧工作区', async () => {
      await pause();
      const rect = await win.webContents.executeJavaScript(
        `(() => {const r=document.querySelector('.custom-card').getBoundingClientRect();return {width:r.width,height:r.height};})()`,
      );
      const box = win.getBounds();
      return (
        Math.abs(box.width - rect.width - 2 * ISLAND_SHADOW_PAD) <= 2 &&
        Math.abs(box.height - rect.height - 2 * ISLAND_SHADOW_PAD) <= 2
      );
    });
    await check('自定义提醒复用原渲染器且进入主要行', async () => {
      island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
      island.pushNotification({
        id: 'custom-smoke-alert',
        title: '组件化提醒验收',
        content: '通知、作业与叫人共用原卡片行为',
        priority: 'URGENT',
        createdAt: new Date().toISOString(),
        teacherName: '临时教师',
        courseName: null,
      });
      await pause();
      await pause();
      return win.webContents.executeJavaScript(
        `(() => {const host=document.querySelector('#custom-alert-host'),node=host?.querySelector('.island-root.embedded');return Boolean(node&&node.textContent.includes('组件化提醒验收')&&host.closest('[data-row]')===document.querySelector('[data-row]'));})()`,
      );
    });
    await check('主要行禁用提醒后按允许提醒的行回落', async () => {
      const changed = getConfig().islandLayout;
      const rows = changed.schemes[0]!.rows;
      rows[0]!.allowNotifications = false;
      saveConfig({ islandLayout: changed });
      island.syncCustomLayout();
      await pause();
      await pause();
      return win.webContents.executeJavaScript(
        `(() => {const host=document.querySelector('#custom-alert-host');return Boolean(host?.querySelector('.island-root.embedded')&&host.closest('[data-row]')===document.querySelectorAll('[data-row]')[1]);})()`,
      );
    });
    if (process.env.ISLAND_SHOTS_DIR)
      fs.writeFileSync(
        path.join(process.env.ISLAND_SHOTS_DIR, 'custom-alert.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
    island.handleAction({ action: 'dismiss-all' });
    await pause();
    await pause();
    await pause();
    await check('提醒收回后缩回组件栏，保留时钟与可见状态', async () => {
      const content = await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('.custom-card .clock'))`,
      );
      const visible = process.env.ELECTRON_SMOKE_MODE === 'visual' ? win.isVisible() : !win.isVisible();
      return content && visible && island.getState().mode === 'hidden';
    });
  } finally {
    saveConfig({ islandLayout: original });
    island.syncCustomLayout();
    win.hide();
  }
}
