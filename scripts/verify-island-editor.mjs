/** 在隐藏 Chromium 中验证真实 Vue 组件的圆角、课表布局与提醒，不连接业务服务。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const root = path.resolve('.');
const require = createRequire(path.join(root, 'packages/desktop-client/package.json'));
const { build } = require('esbuild');
const { parse, compileScript, compileStyle } = require('vue/compiler-sfc');
const temp = fs.mkdtempSync(path.join(root, '.cache/island-editor-'));
try {
  await build({
    stdin: {
      resolveDir: root,
      contents: `
      import {createApp,h,reactive,nextTick} from './packages/desktop-client/node_modules/vue/index.mjs';
      import {defaultIslandLayouts,DEFAULT_ISLAND_APPEARANCE} from './packages/shared/dist/index.js';
      import Runtime from './packages/desktop-client/src/island/CustomIslandRuntime.vue';
      import Reminder from './packages/desktop-client/src/island/LessonReminderContent.vue';
      import Editor from './packages/desktop-client/src/renderer/views/settings/IslandEditorView.vue';
      import Settings from './packages/desktop-client/src/renderer/views/settings/IslandSettingsView.vue';
      import ElementPlus from './packages/desktop-client/node_modules/element-plus/es/index.mjs';
      import * as icons from './packages/desktop-client/node_modules/@element-plus/icons-vue/dist/index.js';
      import './packages/desktop-client/node_modules/element-plus/dist/index.css';
      import './packages/ui/src/theme.css';
      import './packages/desktop-client/src/island/custom-runtime.css';
      (async()=>{
      const now=new Date(); now.setHours(9,39,59,0);
      const state=reactive({mode:'hidden',active:null,queued:[],inClass:true,currentPeriodEnd:null,reason:null,listExpanded:false,updatedAt:0});
      const settings=reactive(defaultIslandLayouts());settings.layout='custom';
      const scheme=settings.schemes[0];scheme.radius=0;
      scheme.rows[0].nodes=scheme.rows[0].nodes.filter(n=>n.kind==='schedule');
      scheme.rows[0].nodes[0].settings.display='all';scheme.rows[0].nodes[0].settings.count=20;
      const points=[['a','08:00','08:40',''],['b','09:00','09:40','信息技术'],['c','10:00','10:40','历史']].map(([id,startTime,endTime,courseName])=>({id,startTime,endTime,courseName,timeType:'LESSON',name:'',isHideDefault:false}));
      const appearance={...DEFAULT_ISLAND_APPEARANCE,animations:false};
      const originalNow=Date.now;Date.now=()=>now.getTime();
      window.island={setHitRect(){},reportResidentControl(){},reportSize(){},sendAction(){},onViewport(){return ()=>{}}};
      const root=document.createElement('div');document.body.append(root);
      const app=createApp({render:()=>h(Runtime,{settings,state,schedules:[],timePoints:points,appearance,nativeVisible:true})});app.mount(root);
      const results=[];const check=(name,ok,detail='')=>results.push({name,ok,detail});
      const settle=async()=>{await nextTick();await new Promise(r=>setTimeout(r,100));await nextTick()};
      await settle();
      const card=()=>root.querySelector('.resident-card');
      const before=card().style.getPropertyValue('--resident-radius');scheme.radius=14;await settle();
      check('修改圆角无需改变内容尺寸即可生效',card().style.getPropertyValue('--resident-radius')==='14px',before+' → '+card().style.getPropertyValue('--resident-radius'));
      const lines=[...root.querySelectorAll('.resident-compact .lesson-line')];
      const ys=lines.map(n=>{const b=n.getBoundingClientRect();return b.y+b.height/2});
      check('全天课表的课程和占位符垂直居中对齐',ys.length===3&&Math.max(...ys)-Math.min(...ys)<1,JSON.stringify(ys));
      state.lessonReminder={id:'ending',kind:'ending',courseName:'信息技术',startTime:'09:00',endTime:'09:40',startedAt:now.getTime(),maskUntil:now.getTime()+3000,endsAt:now.getTime()+1000,lessonStartsAt:now.getTime()-2399000,lessonEndsAt:now.getTime()+1000};await settle();
      const badge=root.querySelector('.resident-compact .lesson-ending-badge');
      check('自定义岛保留课表，在当前课程右侧显示蓝色负数秒倒计时',badge?.textContent.trim()==='-1'&&Number(card().style.getPropertyValue('--resident-scale'))>0,badge?.textContent??'无徽标');
      check('临近下课保留常驻内容的可见性',Number(root.querySelector('.resident-compact-page').style.opacity)>0.99);
      const reminderRoot=document.createElement('div');document.body.append(reminderRoot);
      const reminderApp=createApp({render:()=>h(Reminder,{reminder:state.lessonReminder,now:now.getTime(),appearance,motion:false})});reminderApp.mount(reminderRoot);await settle();
      check('经典岛临近下课不显示遮罩和整条文字倒计时',!reminderRoot.querySelector('.ci-mask-active')&&reminderRoot.querySelector('.lesson-ending-badge')?.textContent.trim()==='-1');
      reminderApp.unmount();app.unmount();Date.now=originalNow;
      const stored={islandLayout:defaultIslandLayouts(),island:appearance};stored.islandLayout.layout='custom';stored.islandLayout.schemes[0].radius=12;
      window.desktop={getConfig:async()=>structuredClone(stored),saveConfig:async(patch)=>{Object.assign(stored,patch);return structuredClone(stored)},islandGetAppearance:async()=>appearance,islandSetAppearance(){}};
      function mount(Component){const el=document.createElement('div');document.body.append(el);const app=createApp(Component);app.use(ElementPlus);for(const [name,icon]of Object.entries(icons))app.component(name,icon);app.mount(el);return {app,el}};
      const editor=mount(Editor);await settle();
      check('组件库移除消息选项与编辑提示',editor.el.querySelector('.library-item')&&!editor.el.querySelector('.message-options,.editor-tip,[data-library-kind="notification"],[data-library-kind="homework"],[data-library-kind="call"]')&&!editor.el.textContent.includes('班级消息'));
      const palette=[];
      for(const dark of [false,true]){
        document.documentElement.classList.toggle('dark',dark);await settle();
        const page=editor.el.querySelector('.island-editor-page'),button=editor.el.querySelector('.library-item');
        const sample=document.createElement('span');page.append(sample);sample.style.background='var(--ch-bg)';
        const background=getComputedStyle(page).backgroundColor;
        check((dark?'深色':'浅色')+'编辑页与共享主题配色一致',background===getComputedStyle(sample).backgroundColor);
        sample.style.background='var(--ch-surface)';
        check((dark?'深色':'浅色')+'组件按钮复用共享控件背景',getComputedStyle(button).backgroundColor===getComputedStyle(sample).backgroundColor);
        palette.push(background);sample.remove();
      }
      check('深浅模式切换后同步更新编辑器颜色',palette[0]!==palette[1]);
      editor.app.unmount();editor.el.remove();document.documentElement.classList.remove('dark');
      const settingsView=mount(Settings);await settle();
      const radiusItem=[...settingsView.el.querySelectorAll('.el-form-item')].find(el=>el.querySelector('.el-form-item__label')?.textContent.startsWith('圆角'));
      const slider=radiusItem.querySelector('[role="slider"]');slider.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',code:'ArrowRight',bubbles:true}));await settle();
      check('外观页的圆角滑块写入当前自定义方案',stored.islandLayout.schemes[0].radius===13,String(stored.islandLayout.schemes[0].radius));
      settingsView.app.unmount();settingsView.el.remove();window.__results=results;
      })().catch(error=>{window.__results=[{name:'组件运行',ok:false,detail:error.stack}]});
    `,
    },
    outfile: path.join(temp, 'test.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    define: {
      'process.env.NODE_ENV': '"test"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    plugins: [
      {
        name: '真实Vue组件',
        setup(b) {
          b.onResolve({ filter: /^vue-router$/ }, () => ({ path: 'router', namespace: 'island-test' }));
          b.onResolve({ filter: /island\/bridge\.js$/ }, () => ({
            path: 'bridge',
            namespace: 'island-test',
          }));
          b.onLoad({ filter: /.*/, namespace: 'island-test' }, (a) => ({
            contents:
              a.path === 'router'
                ? 'export const useRouter=()=>({push:async()=>{}});export function onBeforeRouteLeave(){}'
                : 'export const getIslandSchedules=()=>[];export const getIslandTimePoints=()=>[];',
            loader: 'js',
          }));
          b.onLoad({ filter: /\.vue$/ }, (args) => {
            const source = fs.readFileSync(args.path, 'utf8');
            const { descriptor } = parse(source, { filename: args.path });
            const id = 'test-' + Buffer.from(path.relative(root, args.path)).toString('hex');
            let code = compileScript(descriptor, {
              id,
              inlineTemplate: true,
              genDefaultAs: '__component',
            }).content;
            if (descriptor.styles.some((s) => s.scoped))
              code += `\n__component.__scopeId=${JSON.stringify('data-v-' + id)};`;
            for (const style of descriptor.styles) {
              const css = style.src
                ? fs.readFileSync(path.resolve(path.dirname(args.path), style.src), 'utf8')
                : style.content;
              const compiled = compileStyle({
                source: css,
                filename: args.path,
                id: 'data-v-' + id,
                scoped: style.scoped,
              }).code;
              code += `\n{const s=document.createElement('style');s.textContent=${JSON.stringify(compiled)};document.head.append(s);}`;
            }
            return {
              contents: code + '\nexport default __component;',
              loader: 'ts',
              resolveDir: path.dirname(args.path),
            };
          });
        },
      },
    ],
    logLevel: 'silent',
  });
  fs.writeFileSync(
    path.join(temp, 'test.html'),
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="test.css"></head><body><script src="test.js"></script></body></html>',
  );
  fs.writeFileSync(
    path.join(temp, 'main.cjs'),
    `
    const {app,BrowserWindow}=require('electron');
    app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{backgroundThrottling:false}});
      w.webContents.on('console-message',(_e,...a)=>console.log(...a));
      try{await w.loadFile(${JSON.stringify(path.join(temp, 'test.html'))});
        let results;for(let i=0;i<100;i++){results=await w.webContents.executeJavaScript('window.__results');if(results)break;await new Promise(r=>setTimeout(r,100))}
        if(!results)throw Error('组件验证未完成');
        for(const r of results)console.log((r.ok?'✓ ':'✗ ')+r.name+' '+r.detail);
        app.exit(results.some(r=>!r.ok)?1:0);
      }catch(e){console.error(e);app.exit(1)}
    });`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const p = spawn(require('electron'), [path.join(temp, 'main.cjs')], {
      env,
      windowsHide: true,
      stdio: 'inherit',
    });
    p.on('error', reject);
    p.on('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  if (path.dirname(temp) !== path.join(root, '.cache')) throw new Error('拒绝清理工作区外路径');
  fs.rmSync(temp, { recursive: true, force: true });
}
