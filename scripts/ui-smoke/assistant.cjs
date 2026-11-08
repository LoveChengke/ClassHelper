const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function runAssistantChecks({ win, target, record, waitFor, realClick }) {
  if (process.env.UI_SMOKE_ISOLATED !== '1') return;
  assert(['127.0.0.1', 'localhost'].includes(new URL(target).hostname));
  const origin = new URL(target).origin,
    previous = win.webContents.getURL();
  const title = `AI界面隔离验收${Date.now()}`;
  let settings, token, uiPreferences;
  const windowSize = win.getContentSize();
  const request = async (url, method = 'GET', body) =>
    win.webContents.executeJavaScript(`(async () => {
    const res = await fetch('/api' + ${JSON.stringify(url)}, {method:${JSON.stringify(method)}, headers:{authorization:'Bearer ' + ${JSON.stringify(token)},'content-type':'application/json'}, ${body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(body)}),`}});
    const data = await res.json(); if (!res.ok) throw new Error(data.message); return data.data;
  })()`);
  const screenshot = async (name) => {
    const file = path.join(__dirname, '../../docs/screenshots', name + '.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        return;
      } catch (error) {
        if (!String(error).includes('UnknownVizError') || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  };
  const chooseClass = async (name) => {
    await win.webContents.executeJavaScript(
      `document.querySelector('.page-header .el-select, .toolbar .el-select')?.click()`,
    );
    assert(
      await waitFor(
        win,
        `Array.from(document.querySelectorAll('.el-select-dropdown__item')).some(n => n.textContent.trim() === ${JSON.stringify(name)})`,
      ),
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.el-select-dropdown__item')).find(n => n.textContent.trim() === ${JSON.stringify(name)})?.click()`,
    );
  };
  try {
    token = await win.webContents.executeJavaScript(`localStorage.getItem('classhelper.token')`);
    settings = await request('/ai/settings');
    await request('/ai/settings', 'PUT', { enabled: true, provider: 'mock' });
    const classes = await request('/classes');
    const cls = classes.find((item) => !item.archivedYearId);
    assert(cls, '隔离库缺少可用班级');
    await win.loadURL(origin + '/assistant');
    assert(await waitFor(win, `Boolean(document.querySelector('.assistant-composer textarea'))`));
    await chooseClass(cls.name);
    await win.webContents.executeJavaScript(`(() => {
      const input=document.querySelector('.assistant-composer input[type=file]'); const transfer=new DataTransfer(); transfer.items.add(new File(['界面隔离附件'], 'AI附件.txt', {type:'text/plain'})); input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    assert(
      await waitFor(
        win,
        `document.querySelector('.assistant-attachments')?.textContent.includes('AI附件.txt')`,
      ),
    );
    record('AI 对话框可选择文件并完成浏览器分块哈希', true);
    await win.webContents.executeJavaScript(`(() => {
      const input=document.querySelector('.assistant-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input, ${JSON.stringify(title + ' 布置作业：完成练习')}); input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    assert(
      await waitFor(
        win,
        `Array.from(document.querySelectorAll('.assistant-composer button')).some(n=>n.textContent.trim()==='发送' && !n.disabled)`,
      ),
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.assistant-composer button')).find(n=>n.textContent.trim()==='发送').click()`,
    );
    assert(
      await waitFor(
        win,
        `document.querySelector('.assistant-step .el-tag')?.textContent.includes('待确认')`,
        20000,
      ),
    );
    assert.equal((await request('/homeworks?keyword=' + encodeURIComponent(title))).length, 0);
    await screenshot('assistant-plan');
    record('AI 操作卡片显示预览，确认前无业务写入', true);
    await win.loadURL(origin + '/dashboard');
    await win.loadURL(origin + '/assistant');
    assert(
      await waitFor(win, `document.querySelector('.assistant-step .el-tag')?.textContent.includes('待确认')`),
    );
    assert.equal((await request('/homeworks?keyword=' + encodeURIComponent(title))).length, 0);
    assert(
      await win.webContents.executeJavaScript(
        `Boolean(document.querySelector('.agent-header') && document.querySelector('.agent-activity'))`,
      ),
    );
    record('Agent 对话布局支持离开页面后恢复后台任务和待确认预览', true);
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.assistant-plan-actions button')).find(n=>n.textContent.trim()==='确认执行')?.click()`,
    );
    assert(
      await waitFor(
        win,
        `document.querySelector('.assistant-step .el-tag')?.textContent.includes('已完成')`,
        20000,
      ),
    );
    assert.equal((await request('/homeworks?keyword=' + encodeURIComponent(title))).length, 1);
    record('AI 界面确认后通过原业务端点执行并显示结果', true);
    const cachedBefore = await request('/update/client/releases');
    const cacheVersion = `0.0.0-ai-${Date.now()}`;
    const cacheTask = JSON.stringify({
      operations: [{ action: 'clients.release-fetch', params: { version: cacheVersion } }],
    });
    await win.webContents.executeJavaScript(`(() => {
      const input=document.querySelector('.assistant-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(cacheTask)});input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    assert(
      await waitFor(
        win,
        `Array.from(document.querySelectorAll('.assistant-composer button')).some(n=>n.textContent.trim()==='发送' && !n.disabled)`,
      ),
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.assistant-composer button')).find(n=>n.textContent.trim()==='发送').click()`,
    );
    assert(
      await waitFor(
        win,
        `document.querySelector('.assistant-step')?.textContent.includes(${JSON.stringify(cacheVersion)}) && document.querySelector('.assistant-step')?.textContent.includes('仅缓存，不安装或推送')`,
      ),
    );
    await screenshot('assistant-client-cache');
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.assistant-plan-actions button')).find(n=>n.textContent.trim()==='确认执行').click()`,
    );
    assert(
      await waitFor(
        win,
        `Array.from(document.querySelectorAll('.el-message-box')).some(n=>n.getBoundingClientRect().width>0 && n.textContent.includes(${JSON.stringify(cacheVersion)}))`,
      ),
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.el-message-box__btns button')).filter(n=>n.getBoundingClientRect().width>0 && n.textContent.trim()==='取消').at(-1).click()`,
    );
    assert(
      await waitFor(
        win,
        `Array.from(document.querySelectorAll('.assistant-plan-actions button')).some(n=>n.textContent.trim()==='确认执行' && !n.disabled && !n.classList.contains('is-loading'))`,
      ),
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.assistant-plan-actions button')).find(n=>n.textContent.trim()==='取消计划').click()`,
    );
    assert(
      await waitFor(win, `document.querySelector('.assistant-plan-actions .el-button--primary')?.disabled`),
    );
    assert.deepEqual(await request('/update/client/releases'), cachedBefore);
    assert.equal(
      await win.webContents.executeJavaScript(
        `performance.getEntriesByType('resource').filter(n=>new URL(n.name).pathname==='/api/update/client/fetch').length`,
      ),
      0,
    );
    record('管理员客户端缓存计划显示版本文件及专门确认，取消后没有下载请求或登记变化', true);
    const agentPreferences = await win.webContents.executeJavaScript(`(() => {
      const keys=['classhelper.admin.theme','classhelper.admin.careMode','classhelper.admin.careScale'];
      const previous=keys.map(key=>[key,localStorage.getItem(key)]);
      localStorage.setItem(keys[0],'dark');localStorage.setItem(keys[1],'1');localStorage.setItem(keys[2],'1.5');return previous;
    })()`);
    await win.loadURL(origin + '/assistant');
    assert(
      await waitFor(
        win,
        `document.documentElement.matches('.dark.care-mode') && Boolean(document.querySelector('.agent-header'))`,
      ),
    );
    win.setContentSize(390, 844);
    assert(
      await waitFor(
        win,
        `innerWidth===390 && document.documentElement.scrollWidth<=innerWidth && document.querySelector('.assistant-composer').getBoundingClientRect().right<=innerWidth && document.querySelector('.assistant-composer').getBoundingClientRect().bottom<=innerHeight+1`,
      ),
    );
    await screenshot('assistant-agent-mobile-dark');
    record('Agent 页面支持390px、暗色与150%关怀模式，输入区及页头无横向溢出', true);
    win.setContentSize(...windowSize);
    await win.webContents.executeJavaScript(
      `for(const [key,value] of ${JSON.stringify(agentPreferences)}){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}`,
    );
    await win.loadURL(origin + '/homeworks');
    assert(await waitFor(win, `Boolean(document.querySelector('.day-picker input'))`));
    await chooseClass(cls.name);
    const dateClick = await realClick(win, '.day-picker .el-input__prefix');
    assert(dateClick?.targetHit, '日历输入框必须可被真实点击：' + JSON.stringify(dateClick));
    const hasCalendarMarks = await waitFor(
      win,
      `Array.from(document.querySelectorAll('.ch-calendar')).some(n=>n.getBoundingClientRect().width>0 && n.querySelector('.ch-calendar-dot'))`,
    );
    if (!hasCalendarMarks) {
      await screenshot('shared-calendar-failure');
      const diagnostic = await win.webContents.executeJavaScript(`(async () => {
        const dates=performance.getEntriesByType('resource').map(n=>n.name).filter(n=>n.includes('/homeworks/days'));
        const latest=dates.at(-1); const response=latest?await fetch(latest,{headers:{authorization:'Bearer '+localStorage.getItem('classhelper.token')}}).then(r=>r.json()):null;
        return {dates,response,panels:Array.from(document.querySelectorAll('.ch-calendar')).map(n=>({visible:n.getBoundingClientRect().width,cells:n.querySelectorAll('.ch-calendar-day').length,html:n.innerHTML.slice(-2500)})),selected:Array.from(document.querySelectorAll('.el-select__selected-item')).map(n=>n.textContent)};
      })()`);
      throw new Error('日历圆点未出现：' + JSON.stringify(diagnostic));
    }
    const calendar = await win.webContents.executeJavaScript(
      `(() => { const panel=Array.from(document.querySelectorAll('.ch-calendar')).find(n=>n.getBoundingClientRect().width>0); const dot=panel.querySelector('.ch-calendar-dot'); const urls=performance.getEntriesByType('resource').map(n=>n.name).filter(n=>n.includes('/homeworks/days')); return {dots:panel.querySelectorAll('.ch-calendar-dot').length,label:dot.parentElement.getAttribute('aria-label'),from:new URL(urls.at(-1)).searchParams.get('from'),requests:urls.length}; })()`,
    );
    assert(calendar.dots > 0 && calendar.label.includes('条记录'));
    await screenshot('shared-calendar');
    await win.webContents.executeJavaScript(
      `(() => {const panel=Array.from(document.querySelectorAll('.ch-calendar')).find(n=>n.getBoundingClientRect().width>0); panel.querySelectorAll('.el-date-picker__header button')[1].click();})()`,
    );
    assert(
      await waitFor(
        win,
        `performance.getEntriesByType('resource').filter(n=>n.name.includes('/homeworks/days')).length > ${calendar.requests}`,
      ),
    );
    const nextFrom = await win.webContents.executeJavaScript(
      `new URL(performance.getEntriesByType('resource').filter(n=>n.name.includes('/homeworks/days')).at(-1).name).searchParams.get('from')`,
    );
    assert.notEqual(nextFrom, calendar.from);
    const selectedDate = await win.webContents.executeJavaScript(`(() => {
      const panel=Array.from(document.querySelectorAll('.ch-calendar')).find(n=>n.getBoundingClientRect().width>0);
      const cell=panel.querySelector('td.available:not(.prev-month):not(.next-month) .ch-calendar-day');
      const date=cell.getAttribute('aria-label').slice(0,10); cell.click(); return date;
    })()`);
    assert(
      await waitFor(
        win,
        `document.querySelector('.day-picker input').value === ${JSON.stringify(selectedDate)}`,
      ),
    );
    record('共享日历显示可访问圆点，翻月按可见区间重新统计', true);
    await win.webContents.executeJavaScript(
      `document.querySelector('.page-title').click(); document.querySelector('.user-chip').click()`,
    );
    assert(
      await waitFor(
        win,
        `Array.from(document.querySelectorAll('.el-dropdown-menu__item')).some(n=>n.textContent.includes('使用引导'))`,
      ),
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.el-dropdown-menu__item')).find(n=>n.textContent.includes('使用引导')).click()`,
    );
    assert(await waitFor(win, `Boolean(document.querySelector('.ch-guide'))`));
    await win.webContents.executeJavaScript(`window.dispatchEvent(new Event('focus'))`);
    const fullscreen = await waitFor(
      win,
      `(() => {const n=document.querySelector('.ch-guide'),r=n.getBoundingClientRect();return Math.abs(r.width-innerWidth)<2 && Math.abs(r.height-innerHeight)<2 && n.contains(document.activeElement);})()`,
    );
    assert(fullscreen);
    await win.webContents.executeJavaScript(
      `document.querySelector('.user-chip').focus(); window.dispatchEvent(new Event('focus'))`,
    );
    assert(await waitFor(win, `document.querySelector('.ch-guide').contains(document.activeElement)`));
    await screenshot('fullscreen-guide');
    await win.webContents.executeJavaScript(`document.querySelector('.ch-guide [data-action=next]').click()`);
    assert(
      await waitFor(win, `document.querySelector('.ch-guide-progress')?.textContent.trim().startsWith('2')`),
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.ch-guide').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );
    assert(await waitFor(win, `!document.querySelector('.ch-guide')`));
    assert.equal((await request('/homeworks?keyword=' + encodeURIComponent(title))).length, 1);
    record('全屏引导覆盖视口、管理焦点、逐步前进和键盘跳过，无业务副作用', true);
    uiPreferences = await win.webContents.executeJavaScript(`(() => {
      const keys=['classhelper.admin.theme','classhelper.admin.careMode','classhelper.admin.careScale'];
      const previous=keys.map(key=>[key,localStorage.getItem(key)]);
      localStorage.setItem(keys[0],'dark');localStorage.setItem(keys[1],'1');localStorage.setItem(keys[2],'1.5');
      return previous;
    })()`);
    await win.loadURL(origin + '/homeworks');
    assert(
      await waitFor(
        win,
        `document.documentElement.matches('.dark.care-mode') && Boolean(document.querySelector('.day-picker input'))`,
      ),
    );
    await realClick(win, '.day-picker .el-input__prefix');
    assert(
      await waitFor(
        win,
        `Array.from(document.querySelectorAll('.ch-calendar')).some(n=>n.getBoundingClientRect().width>0 && n.querySelector('.ch-calendar-dot'))`,
      ),
    );
    assert(
      await win.webContents.executeJavaScript(`(() => {
      const panel=Array.from(document.querySelectorAll('.ch-calendar')).find(n=>n.getBoundingClientRect().width>0);
      return getComputedStyle(panel).backgroundColor !== 'rgb(255, 255, 255)' && parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ch-font-scale'))===1.5 && parseFloat(getComputedStyle(panel.querySelector('.el-date-table')).fontSize)>=18 && panel.querySelector('.el-date-table').getBoundingClientRect().width>=panel.getBoundingClientRect().width-80 && document.documentElement.scrollWidth<=innerWidth;
    })()`),
    );
    await screenshot('shared-calendar-dark-care');
    await win.webContents.executeJavaScript(
      `document.querySelector('.page-title').click();document.querySelector('.user-chip').click()`,
    );
    assert(
      await waitFor(
        win,
        `Array.from(document.querySelectorAll('.el-dropdown-menu__item')).some(n=>n.textContent.includes('使用引导'))`,
      ),
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.el-dropdown-menu__item')).find(n=>n.textContent.includes('使用引导')).click()`,
    );
    assert(await waitFor(win, `Boolean(document.querySelector('.ch-guide'))`));
    win.setContentSize(390, 844);
    assert(
      await waitFor(win, `innerWidth===390 && document.querySelector('.ch-guide').scrollWidth<=innerWidth`),
    );
    await screenshot('fullscreen-guide-mobile-care');
    await win.webContents.executeJavaScript(`document.querySelector('.ch-guide [data-action=skip]').click()`);
    assert(await waitFor(win, `!document.querySelector('.ch-guide')`));
    record('共享日历支持深色与150%关怀模式，全屏引导在390px小屏无横向溢出', true);
    for (const [width, height] of [
      [360, 800],
      [768, 1024],
      [1366, 768],
      [1920, 1080],
    ]) {
      win.setContentSize(width, height);
      for (const route of [
        'assistant',
        'courseware',
        'term-weeks',
        'plan-editor',
        'dashboard',
        'classes',
        'students',
        'teachers',
        'promotion',
        'archives',
        'homeworks',
        'notifications',
        'grades',
        'ai-settings',
        'database',
        'permissions',
        'clients',
        'system-settings',
      ]) {
        await win.loadURL(origin + '/' + route);
        assert(
          await waitFor(
            win,
            `location.pathname === ${JSON.stringify('/' + route)} && Boolean(document.querySelector('.page, .page-container'))`,
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert(
          await waitFor(win, `document.documentElement.scrollWidth<=innerWidth+1`),
          route + ' 页面溢出 ' + width,
        );
      }
      await screenshot('responsive-' + width);
    }
    record('全部Web业务页面在360/768/1366/1920宽度无页面横向溢出', true);
  } catch (error) {
    record('AI 与共享控件隔离界面验收', false, error.stack || error.message);
  } finally {
    win.setContentSize(...windowSize);
    if (uiPreferences)
      await win.webContents.executeJavaScript(
        `for(const [key,value] of ${JSON.stringify(uiPreferences)}){if(value===null)localStorage.removeItem(key);else localStorage.setItem(key,value);}`,
      );
    if (token) {
      const rows = await request('/homeworks?keyword=' + encodeURIComponent(title)).catch(() => []);
      for (const row of rows)
        await request('/homeworks/' + encodeURIComponent(row.id), 'DELETE').catch(() => undefined);
      if (settings)
        await request('/ai/settings', 'PUT', {
          enabled: settings.enabled,
          provider: settings.provider,
        }).catch(() => undefined);
    }
    await win.loadURL(previous);
    await waitFor(win, `Boolean(document.querySelector('.management-breadcrumb'))`);
  }
};
