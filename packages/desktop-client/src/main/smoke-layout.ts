import fs from 'node:fs';
import { BrowserWindow } from 'electron';
import path from 'node:path';
import { island } from './island.js';
import { getConfig, saveConfig } from './config.js';
import { defaultIslandLayouts, ISLAND_SHADOW_PAD } from '@classhelper/shared';
import { verifyResidentSmoke } from './smoke-resident.js';
export async function verifyLayoutSmoke(
  check: (name: string, action: () => Promise<boolean | string> | boolean) => Promise<void>,
) {
  const original = getConfig().islandLayout;
  await island.init(null);
  island.setTestInputPassthrough(true);
  const win = island.getWindow()!;
  const editor = BrowserWindow.getAllWindows().find(
    (w) => w !== win && !w.isDestroyed() && /\/index\.html(?:#|$)/.test(w.webContents.getURL()),
  )!;
  let editingBounds = win.getBounds();
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
      saveConfig({ islandLayout: { ...defaultIslandLayouts(), layout: 'custom' } });
      island.syncCustomLayout();
      await pause();
      editingBounds = win.getBounds();
      await editor.webContents.executeJavaScript('window.__classhelperSmoke__.islandEditorSmoke(true)');
      await pause();
      return (
        (await editor.webContents.executeJavaScript(
          'location.hash.includes("/settings/island/editor") && Boolean(document.querySelector(".aside"))',
        )) &&
        editor.webContents.executeJavaScript(
          `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='新增行');b?.click();return Boolean(document.querySelector('.island-editor-page .el-card')) && !document.querySelector('.layout-editor, iframe'); })()`,
        )
      );
    });
    await check('触摸拖动可跨行并持久化', async () => {
      await pause();
      const dragGeometry = await editor.webContents.executeJavaScript(`(() => {
        const handle=document.querySelector('.node-handle[data-kind=clock]');
        const row=document.querySelectorAll('[data-row]')[1]; if(!handle||!row)throw Error('缺少拖动目标');
        document.querySelector('.preview-canvas')?.scrollIntoView({block:'center'});
        const r=row.getBoundingClientRect(); const x=r.left+Math.min(20,r.width/2),y=r.top+r.height/2;
        handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:19,pointerType:'touch',clientX:10,clientY:10}));
        handle.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:19,pointerType:'touch',clientX:x,clientY:y}));
        handle.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:19,pointerType:'touch',clientX:x,clientY:y}));
        return {row:r.toJSON(), point:{x,y}, hit:document.elementFromPoint(x,y)?.outerHTML.slice(0,600), canvas:document.querySelector('.preview-canvas')?.getBoundingClientRect().toJSON()};
      })()`);
      await pause();
      const moved =
        getConfig().islandLayout.schemes[0]?.rows[1]?.nodes.some((n) => n.kind === 'clock') === true;
      if (!moved) throw new Error(JSON.stringify(dragGeometry));
      return true;
    });
    await check('组件可以包裹进容器且设置独立保存', async () => {
      await editor.webContents.executeJavaScript(
        `document.querySelector('[data-action=wrap] .el-select__wrapper')?.click()`,
      );
      await pause();
      await editor.webContents.executeJavaScript(
        `(() => { const option=[...document.querySelectorAll('.el-select-dropdown__item')].find(e=>e.textContent.trim()==='分组'); if(!option)throw Error('容器菜单未出现');option.click(); })()`,
      );
      await pause();
      return (
        getConfig().islandLayout.schemes[0]?.rows.some((r) =>
          r.nodes.some((n) => n.kind === 'group' && n.children.some((c) => c.kind === 'clock')),
        ) === true
      );
    });
    await check('组件设置按内容外观高级切换，整体外观单独显示', async () => {
      const initial = await editor.webContents.executeJavaScript(`(() => {
        const panel=[...document.querySelectorAll('.component-settings .el-tab-pane')].find(e=>getComputedStyle(e).display!=='none');
        return panel?.textContent.includes('排列方向') && !panel.textContent.includes('背景颜色');
      })()`);
      await editor.webContents.executeJavaScript(
        `document.querySelectorAll('.component-settings .el-tabs__item')[1].click()`,
      );
      await pause();
      const appearance = await editor.webContents.executeJavaScript(`(() => {
        const panel=[...document.querySelectorAll('.component-settings .el-tab-pane')].find(e=>getComputedStyle(e).display!=='none');
        return panel?.textContent.includes('正文字号') && !panel.textContent.includes('排列方向');
      })()`);
      await editor.webContents.executeJavaScript(
        `document.querySelectorAll('.component-settings .el-tabs__item')[2].click()`,
      );
      await pause();
      const advanced = await editor.webContents.executeJavaScript(`(() => {
        const panel=[...document.querySelectorAll('.component-settings .el-tab-pane')].find(e=>getComputedStyle(e).display!=='none');
        return panel?.textContent.includes('隐藏条件') && !panel.textContent.includes('背景颜色');
      })()`);
      await editor.webContents.executeJavaScript(
        `document.querySelectorAll('.component-settings .el-tabs__item')[0].click()`,
      );
      await pause();
      return initial && appearance && advanced;
    });
    await check('主窗口编辑器的预览完整适配画布且不遮挡缩放控件', async () => {
      return editor.webContents.executeJavaScript(`(() => {
        const canvas=document.querySelector('.preview-canvas')?.getBoundingClientRect();
        const footer=document.querySelector('.preview-toolbar')?.getBoundingClientRect();
        return Boolean(canvas&&footer&&canvas.bottom<=footer.top+1&&document.documentElement.scrollWidth<=innerWidth);
      })()`);
    });
    await check('原生编辑页使用客户端主题并兼容深色', async () => {
      return editor.webContents.executeJavaScript(`(() => {
        const root=document.documentElement, wasDark=root.classList.contains('dark');
        root.classList.add('dark');
        const card=document.querySelector('.scheme-card'), style=getComputedStyle(card);
        const ok=style.getPropertyValue('--ch-text').trim() && !document.querySelector('.layout-editor, iframe') && document.querySelectorAll('.island-editor-page .el-card').length>=4;
        root.classList.toggle('dark',wasDark);return Boolean(ok);
      })()`);
    });
    if (process.env.ISLAND_SHOTS_DIR) {
      await editor.webContents.executeJavaScript(`document.querySelector('.main').scrollTop=0`);
      fs.mkdirSync(process.env.ISLAND_SHOTS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.ISLAND_SHOTS_DIR, 'custom-editor.png'),
        (await editor.webContents.capturePage()).toPNG(),
      );
    }
    await check('退出编辑后配置可从 getConfig 读回', async () => {
      await editor.webContents.executeJavaScript(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='应用并返回')?.click()`,
      );
      await pause();
      return (
        !island.getEditingLayout() &&
        getConfig().islandLayout.schemes[0]!.rows.length === 2 &&
        !editor.webContents.getURL().includes('/editor') &&
        win.getBounds().width === editingBounds.width
      );
    });
    await editor.webContents.executeJavaScript('window.__classhelperSmoke__.islandEditorSmoke(false)');
    await check('自定义岛统一使用固定画布且常态组件居中适配', async () => {
      await pause();
      return win.webContents.executeJavaScript(`(() => {
        const card=document.querySelector('.resident-card'), source=card?.querySelector('.resident-compact');
        if(!card||!source)return false;
        const r=card.getBoundingClientRect(),s=source.getBoundingClientRect();
        return r.width<=innerWidth-${2 * ISLAND_SHADOW_PAD}&&r.height<=innerHeight-${2 * ISLAND_SHADOW_PAD}&&Math.abs(r.left+r.width/2-s.left-s.width/2)<=2;
      })()`);
    });
    await check('自定义岛紧急通知立即弹出并复用经典通知内容', async () => {
      island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1 });
      island.pushNotification({
        id: 'custom-smoke-alert',
        title: '组件化提醒验收',
        content: '通知、作业与叫人共用经典卡片',
        priority: 'URGENT',
        createdAt: new Date().toISOString(),
        teacherName: '临时教师',
        courseName: null,
      });
      await pause();
      await pause();
      const result = await win.webContents.executeJavaScript(`(() => {
        const card=document.querySelector('.resident-card'), content=card?.querySelector('.classic-notifications'),r=card?.getBoundingClientRect(),c=content?.getBoundingClientRect();
        const valid=Boolean(content&&content.textContent.includes('组件化提醒验收')&&card.querySelectorAll('.shape').length===1&&c.left>=r.left-1&&c.right<=r.right+1&&c.bottom<=r.bottom+1);
        return {valid,card:r?.toJSON(),content:c?.toJSON(),shape:card?.querySelectorAll('.shape').length};
      })()`);
      if (!result.valid) throw Error(JSON.stringify(result));
      return island.getState().mode === 'expanded';
    });
    if (process.env.ISLAND_SHOTS_DIR)
      fs.writeFileSync(
        path.join(process.env.ISLAND_SHOTS_DIR, 'custom-alert.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
    await win.webContents.executeJavaScript(
      `document.querySelector('#custom-alert-host .solid-btn')?.click()`,
    );
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
    await check('没有提醒时消息组件不占位', async () => {
      return win.webContents.executeJavaScript(
        `document.querySelectorAll('.custom-card .component-node.notification, .custom-card .component-node.homework, .custom-card .component-node.call').length === 0`,
      );
    });
    await verifyResidentSmoke(check);
  } finally {
    if (editor && !editor.isDestroyed())
      await editor.webContents.executeJavaScript('window.__classhelperSmoke__.islandEditorSmoke(false)');
    saveConfig({ islandLayout: original });
    island.syncCustomLayout();
    win.hide();
  }
}
