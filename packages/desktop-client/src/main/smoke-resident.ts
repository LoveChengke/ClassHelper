import fs from 'node:fs';
import path from 'node:path';
import {
  defaultIslandLayouts,
  islandNode,
  normalizeIslandLayouts,
  ISLAND_SHADOW_PAD,
  type ScheduleDto,
} from '@classhelper/shared';
import { getConfig, saveConfig } from './config.js';
import { island } from './island.js';
import { LessonReminderTracker } from './lesson-reminder.js';

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
  const dateAt = (h: number, m: number, s = 0) => {
    const date = new Date();
    date.setHours(h, m, s, 0);
    return date;
  };
  const lessonFixtures: ScheduleDto[] = [
    {
      id: 'lesson-math',
      classId: 'local',
      courseId: 'math',
      course: { id: 'math', name: '数学' },
      dayOfWeek: new Date().getDay() || 7,
      startTime: '09:00',
      endTime: '09:45',
      location: null,
      weekStart: 1,
      weekEnd: 40,
      weekParity: 'ALL',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'lesson-chinese',
      classId: 'local',
      courseId: 'chinese',
      course: { id: 'chinese', name: '语文' },
      dayOfWeek: new Date().getDay() || 7,
      startTime: '09:55',
      endTime: '10:40',
      location: null,
      weekStart: 1,
      weekEnd: 40,
      weekParity: 'ALL',
      createdAt: new Date().toISOString(),
    },
  ];
  await check('课前60秒、上课与下课时间边界正确，刷新和改课不重复重置提醒', () => {
    const tracker = new LessonReminderTracker();
    if (tracker.update(lessonFixtures, dateAt(8, 58, 59))) return false;
    const prepare = tracker.update(lessonFixtures, dateAt(8, 59));
    const repeat = tracker.update(lessonFixtures, dateAt(8, 59, 5));
    const renamed = lessonFixtures.map((s) => ({ ...s, course: { ...s.course!, name: '临时换课' } }));
    const changed = tracker.update(renamed, dateAt(8, 59, 6));
    const onClass = tracker.update(lessonFixtures, dateAt(9, 0));
    const noLate = tracker.update(lessonFixtures, dateAt(9, 0, 6));
    const breaking = tracker.update(lessonFixtures, dateAt(9, 45));
    const after = tracker.update(lessonFixtures, dateAt(9, 45, 13));
    const lastBreak = tracker.update(lessonFixtures, dateAt(10, 40));
    const end = tracker.update(lessonFixtures, dateAt(10, 40, 6));
    const removed = tracker.update([], dateAt(8, 59));
    return (
      prepare?.kind === 'prepare' &&
      prepare.maskUntil - prepare.startedAt === 3000 &&
      repeat?.startedAt === prepare.startedAt &&
      changed?.courseName === '临时换课' &&
      changed.maskUntil === prepare.maskUntil &&
      onClass?.kind === 'on-class' &&
      !noLate &&
      breaking?.kind === 'break' &&
      breaking.nextCourseName === '语文' &&
      !after &&
      lastBreak?.kind === 'break' &&
      !end &&
      !removed
    );
  });
  scheme.rows[0]!.nodes = [
    islandNode('clock', 'resident-clock'),
    islandNode('separator', 'resident-separator'),
    compactText,
  ];
  scheme.expandedRows[0]!.nodes = [islandNode('date', 'resident-date'), expandedText];
  island.handleAction({ action: 'dismiss-all' });
  await pause();
  await check('旧自定义配置迁移到统一常驻界面，并补齐空闲展开布局', () => {
    const legacy = JSON.parse(JSON.stringify(fixture));
    delete legacy.residentEnabled;
    delete legacy.schemes[0].expandedRows;
    const value = normalizeIslandLayouts(legacy);
    const oversized = JSON.parse(JSON.stringify(fixture));
    Object.assign(oversized.schemes[0], { scale: 99, radius: 99, opacity: -1, spacing: 999 });
    const bounds = normalizeIslandLayouts(oversized).schemes[0]!;
    return (
      value.residentEnabled &&
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
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="收起自定义灵动岛"]')?.click()`,
    );
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
      island.getState().mode === 'hidden' &&
      (await win.webContents.executeJavaScript(`(() => {
      const card=document.querySelector('.custom-card'),bell=card?.querySelector('.resident-bell');
      return Boolean(bell&&!bell.classList.contains('bell-empty')&&bell.textContent.trim()==='1'&&Math.abs(card.getBoundingClientRect().width-${compactWidth})<=2&&!card.classList.contains('has-alert'));
    })()`))
    );
  });
  await shot('resident-bell');
  await check('紧急消息沿用经典岛立即展开，重复消息不增加数量', async () => {
    island.pushNotification(message('resident-urgent', '常驻通知二', 'URGENT'));
    island.pushNotification(message('resident-urgent', '常驻通知二', 'URGENT'));
    await pause();
    return (
      island.getState().mode === 'expanded' &&
      (await win.webContents.executeJavaScript(
        `document.querySelector('.resident-bell')?.textContent.trim()==='2'`,
      ))
    );
  });
  await check('点击铃铛展开通知列表，上课时也可主动查看', async () => {
    island.handleAction({ action: 'collapse' });
    await pause(800);
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
      `document.querySelector('.classic-notifications .icon-btn')?.click()`,
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
    const collapsed = island.getState().mode === 'hidden';
    island.handleAction({ action: 'dismiss-all' });
    await pause();
    return collapsed;
  });
  await check('课表变更立即传到常态与展开组件，重新加载后仍恢复最新快照', async () => {
    const updated = [
      {
        id: 'island-schedule-live',
        classId: 'local',
        courseId: 'local-course',
        dayOfWeek: new Date().getDay() || 7,
        startTime: '00:00',
        endTime: '23:59',
        location: null,
        weekStart: 1,
        weekEnd: 40,
        weekParity: 'ALL' as const,
        createdAt: new Date().toISOString(),
        course: { id: 'local-course', name: '实时课程' },
      },
    ];
    const settings = JSON.parse(JSON.stringify(fixture));
    settings.schemes[0].rows[0].nodes = [islandNode('schedule', 'live-schedule')];
    saveConfig({ islandLayout: settings });
    island.syncCustomLayout();
    await pause();
    const started = Date.now();
    island.setClassState({ inClass: false, currentPeriodEnd: null, week: 1, schedules: updated });
    const waitForCourse = async () => {
      for (let i = 0; i < 30; i++) {
        if (
          await win.webContents.executeJavaScript(
            `document.querySelector('.resident-compact .schedule')?.textContent.includes('实时课程')`,
          )
        )
          return true;
        await pause(20);
      }
      return false;
    };
    const immediate = (await waitForCourse()) && Date.now() - started < 600;
    const aligned = await win.webContents.executeJavaScript(`(() => {
      const name=document.querySelector('.resident-compact .schedule strong')?.getBoundingClientRect(), time=document.querySelector('.resident-compact .lesson-time')?.getBoundingClientRect();
      return Boolean(name&&time&&time.left>=name.right&&Math.abs(time.top+time.height/2-name.top-name.height/2)<=2);
    })()`);
    await win.webContents.reload();
    await pause(800);
    const restored = await waitForCourse();
    const snapshot = await win.webContents.executeJavaScript('window.island.getSchedules()');
    saveConfig({ islandLayout: fixture });
    island.syncCustomLayout();
    await pause(800);
    island.setClassState({ inClass: true, currentPeriodEnd: null, week: 1, schedules: [] });
    return immediate && aligned && restored && snapshot[0]?.course?.name === '实时课程';
  });
  await check('常驻岛开合复用固定画布，动画中没有滚动容器或旧胶囊形变', async () => {
    const bounds = new Set<string>();
    const timer = setInterval(() => bounds.add(JSON.stringify(win.getBounds())), 20);
    const recorded: Array<{ at: number; image: Electron.NativeImage }> = [];
    const capture = process.env.ISLAND_MOTION_CAPTURE === '1' && process.env.ELECTRON_SMOKE_MODE === 'visual';
    const started = Date.now();
    if (capture)
      win.webContents.beginFrameSubscription(true, (image) => {
        if (Date.now() - (recorded.at(-1)?.at ?? 0) >= 40) recorded.push({ at: Date.now(), image });
      });
    let result;
    try {
      result = await win.webContents.executeJavaScript(`new Promise(resolve => {
        const frames=[], gaps=[], motion=[]; let last=performance.now(), count=0;
        const sample=()=>{
          const card=document.querySelector('.resident-card'), r=card?.getBoundingClientRect();
          if(!r){frames.push(false);return;}
          const nodes=[card,...card.querySelectorAll('*')];
          frames.push(r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&nodes.every(n=>!['auto','scroll'].includes(getComputedStyle(n).overflowY)&&!['auto','scroll'].includes(getComputedStyle(n).overflowX)));
          motion.push({at:performance.now()-start,height:r.height,compact:Number(getComputedStyle(card.querySelector('.resident-compact-page')).opacity),details:Number(getComputedStyle(card.querySelector('.resident-detail-page')).opacity)});
        };
        const animate=time=>{gaps.push(time-last);last=time;count++;sample();if(time-start<1800)requestAnimationFrame(animate);};
        const start=performance.now();requestAnimationFrame(animate);
        window.island.sendAction('expand');setTimeout(()=>window.island.sendAction('collapse'),700);
        setTimeout(()=>{sample(); const card=document.querySelector('.resident-card');resolve({valid:frames.every(Boolean),count,motion,gaps:gaps.filter(g=>g>0).sort((a,b)=>a-b),height:card.getBoundingClientRect().height,legacy:document.querySelector('.island-root')?.getBoundingClientRect().height===0});},1900);
      })`);
    } finally {
      clearInterval(timer);
      if (capture) win.webContents.endFrameSubscription();
    }
    if (capture && process.env.ISLAND_SHOTS_DIR) {
      const dir = path.join(process.env.ISLAND_SHOTS_DIR, 'motion-frames');
      fs.mkdirSync(dir, { recursive: true });
      recorded.forEach((frame, i) => fs.writeFileSync(path.join(dir, `${i}.png`), frame.image.toPNG()));
      fs.writeFileSync(path.join(dir, 'times.json'), JSON.stringify(recorded.map((f) => f.at - started)));
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
      (!visual ||
        (result.count >= 20 &&
          result.gaps[Math.floor(result.gaps.length * 0.95)] < 100 &&
          [
            result.motion.filter((f: { at: number }) => f.at < 700),
            result.motion.filter((f: { at: number }) => f.at >= 700),
          ].every(
            (phase: Array<{ height: number; compact: number; details: number }>) =>
              new Set(phase.map((f) => Math.round(f.height))).size >= 3 &&
              phase.filter((f) => f.details > 0.01 && f.details < 0.95 && f.compact < 0.95).length >= 3,
          ))),
    );
  });
  await check('关闭动画后外壳和内容同时落位，恢复动画无需重启', async () => {
    island.setAppearance({ animations: false });
    try {
      island.handleAction({ action: 'expand' });
      await pause(100);
      const opened = await win.webContents.executeJavaScript(`(() => {
        const card=document.querySelector('.resident-card');
        return card.getBoundingClientRect().height>40&&getComputedStyle(card.querySelector('.resident-detail-page')).opacity==='1'&&getComputedStyle(card.querySelector('.resident-compact-page')).opacity==='0';
      })()`);
      island.handleAction({ action: 'collapse' });
      await pause(100);
      return (
        opened &&
        (await win.webContents.executeJavaScript(`(() => {
        const card=document.querySelector('.resident-card');
        return Math.abs(card.getBoundingClientRect().height-40)<=1&&getComputedStyle(card.querySelector('.resident-compact-page')).opacity==='1'&&getComputedStyle(card.querySelector('.resident-detail-page')).opacity==='0';
      })()`))
      );
    } finally {
      island.setAppearance({ animations: true });
    }
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
  await check('两种布局均弹出ClassIsland课前/上下课提醒，倒计时与右侧时间正确且不写入通知队列', async () => {
    const capture = process.env.ISLAND_MOTION_CAPTURE === '1' && process.env.ELECTRON_SMOKE_MODE === 'visual';
    const recorded: Array<{ at: number; image: Electron.NativeImage }> = [];
    const start = Date.now();
    let recording = false;
    const cueAppearance = island.getAppearance();
    const setTime = async (h: number, m: number, s = 0) => {
      const at = dateAt(h, m, s).getTime();
      await win.webContents.executeJavaScript(`window.__lessonSmokeTime=${at}`);
      island.setLessonReminderTestTime(at);
    };
    try {
      await win.webContents.executeJavaScript(
        `window.__lessonRealNow=Date.now;Date.now=()=>window.__lessonSmokeTime??window.__lessonRealNow();true`,
      );
      for (const layout of ['custom', 'fixed'] as const) {
        saveConfig({ islandLayout: { ...fixture, layout } });
        island.syncCustomLayout();
        await setTime(8, 58, 59);
        island.setClassState({ inClass: false, schedules: lessonFixtures });
        await pause(1100);
        if (layout === 'fixed') {
          island.setAppearance({ idleSliver: true });
          island.setTouchMode(true);
          island.pushNotification(message('lesson-touch-canvas', '触摸画布验证', 'NORMAL'));
          await pause(600);
          island.handleAction({ action: 'dismiss-all' });
          await pause(600);
        }
        if (capture && layout === 'custom') {
          recording = true;
          win.webContents.beginFrameSubscription(true, (image) => {
            if (Date.now() - (recorded.at(-1)?.at ?? 0) >= 40) recorded.push({ at: Date.now(), image });
          });
        }
        await setTime(8, 59);
        await pause(800);
        if (island.getState().lessonReminder?.kind !== 'prepare') return false;
        const mask = await win.webContents.executeJavaScript(
          `(() => {const cue=document.querySelector('${layout === 'custom' ? '.resident-lesson-page' : '.ci-fixed-lesson'} .ci-mask')||document.querySelector('.ci-fixed-lesson .ci-mask');return Boolean(cue&&cue.querySelectorAll('polygon').length===5);})()`,
        );
        if (!mask) return false;
        await shot('lesson-prepare-mask-' + layout);
        await setTime(8, 59, 5);
        await pause(1100);
        const info = await win.webContents.executeJavaScript(`(() => {
          const cue=document.querySelector('${layout === 'custom' ? '.resident-lesson-page .ci-lesson' : '.ci-fixed-lesson'}');
          const name=cue?.querySelector('.ci-lesson-course strong')?.getBoundingClientRect(),time=cue?.querySelector('.ci-lesson-course small')?.getBoundingClientRect();
          const r=cue?.getBoundingClientRect();
          return Boolean(cue&&!cue.classList.contains('ci-mask-active')&&cue.textContent.includes('55')&&cue.textContent.includes('数学')&&cue.textContent.includes('09:00–09:45')&&name&&time&&time.left>=name.right&&r&&Math.abs(r.height-40)<=1&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight);
        })()`);
        if (!info || island.getState().queued.length || island.getState().active) return false;
        await shot('lesson-prepare-info-' + layout);
        await setTime(9, 0);
        island.setClassState({ inClass: true });
        await pause(700);
        if (island.getState().lessonReminder?.kind !== 'on-class') return false;
        await shot('lesson-start-' + layout);
        if (recording) {
          win.webContents.endFrameSubscription();
          recording = false;
        }
        await setTime(9, 0, 6);
        await pause(700);
        if (island.getState().lessonReminder) return false;
        await setTime(9, 45);
        island.setClassState({ inClass: false });
        await pause(700);
        if (island.getState().lessonReminder?.kind !== 'break') return false;
        await setTime(9, 45, 3);
        await pause(1100);
        const next = await win.webContents.executeJavaScript(
          `document.querySelector('${layout === 'custom' ? '.resident-lesson-page' : '.ci-fixed-lesson'}')?.textContent.includes('语文')`,
        );
        if (!next) return false;
        await shot('lesson-break-' + layout);
        await setTime(9, 45, 13);
        if (island.getState().lessonReminder) return false;
      }
      return true;
    } finally {
      if (recording) win.webContents.endFrameSubscription();
      if (capture && process.env.ISLAND_SHOTS_DIR) {
        const dir = path.join(process.env.ISLAND_SHOTS_DIR, 'lesson-motion-frames');
        fs.mkdirSync(dir, { recursive: true });
        recorded.forEach((f, i) => fs.writeFileSync(path.join(dir, `${i}.png`), f.image.toPNG()));
        fs.writeFileSync(path.join(dir, 'times.json'), JSON.stringify(recorded.map((f) => f.at - start)));
      }
      await win.webContents.executeJavaScript(
        `Date.now=window.__lessonRealNow;delete window.__lessonRealNow;delete window.__lessonSmokeTime`,
      );
      island.setLessonReminderTestTime(null);
      island.setClassState({ inClass: false, schedules: [] });
      island.setTouchMode(originalTouchMode);
      island.setAppearance(cueAppearance);
      saveConfig({ islandLayout: fixture });
      island.syncCustomLayout();
      await pause(800);
    }
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
      const card=document.querySelector('.resident-card'), footer=card.querySelector('.classic-notifications .foot'), r=card.getBoundingClientRect(), f=footer?.getBoundingClientRect();
      return {r:r.toJSON(),f:f?.toJSON(), fits:Boolean(f&&f.bottom<=r.bottom+1&&f.left>=r.left&&f.right<=r.right+1&&(card.querySelector('.list-hint')||card.querySelectorAll('.list-row').length===8)&&[card,...card.querySelectorAll('*')].every(n=>!['auto','scroll'].includes(getComputedStyle(n).overflowY)))};
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
