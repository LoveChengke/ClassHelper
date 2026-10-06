/**
 * ClassHelper · 下载页（download.html）
 *
 * 这一页只做一件事：**挑一个版本，挑一份文件，点下去就下**。
 * 版本与文件清单有两种来路，按可靠性兜底：
 *
 *   ① 当场读 GitHub Releases 接口 —— 拿到的就是发布页上真实存在的资源，
 *      文件名与体积照抄，不靠命名约定去猜（这是正常路径）；
 *   ② 读不到时（离线、被限流、被墙）退回 HTML 里那份 `<meta name="ch-version">`，
 *      按**发布的命名约定**拼直链，并在页面上明说"这是拼出来的"。
 *
 * 为什么不把清单预生成成 JSON 放进站点：那样只在部署那一刻是新的，
 * 发了新版本得等下一次推 master 才更新。而这一页几乎每一步都指回 github.com，
 * 真离线时它本来也用不了 —— 所以真正要兜的只有"接口被限流"，
 * 那由 ② 兜住就够了。匿名接口每小时 60 次、按出口 IP 算，机房出口很容易撞到。
 *
 * 动效沿用 assets/motion.js 那套 beUI token（版本分段控件的指示器与首页实机截图那组同源）。
 * 建完卡片会派发一次 `ch:content`，让 main.js 把按压反馈补挂上去
 * —— 这些元素是拉到清单之后才出现的，main.js 启动时还看不到它们。
 */

(() => {
  'use strict';

  const REPO = 'LoveChengke/ClassHelper';
  const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

  /** 版本选择器最多列几版；更早的去 Releases 页看 */
  const MAX_VERSIONS = 12;

  const motion = window.CHMotion ?? null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  /** 页面上那份兜底版本号，由 `pnpm version:bump` 与根 package.json 一起维护 */
  const FALLBACK_VERSION = ($('meta[name="ch-version"]')?.content ?? '').trim();

  /**
   * 四个交付物 = 四张卡；卡里每一行 = Release 上的一个文件。
   *
   * `match` 用来在真实资源里认领这个文件，`expect` 在没有接口时按命名约定拼直链的名字。
   * **两个都要跟着发布流程一起改** —— 名字口径与 README「开始使用」那张表、
   * `.cache/release-notes-*.md` 里那份清单是同一套。
   */
  const CARDS = [
    {
      key: 'client',
      who: '教室机器 / 学生电脑',
      name: 'ClassHelper 班级端',
      desc: '第一次打开时填服务器地址和班级码，之后开机就能看课表、作业、通知与成绩；断网时读本地缓存，恢复后自己刷新。',
      files: [
        {
          role: '安装版',
          note: 'NSIS 安装程序，装完在开始菜单里',
          match: /-client-setup\.exe$/i,
          expect: (version) => `ClassHelper-${version}-x64-client-setup.exe`,
        },
        {
          role: '单文件版',
          note: '不用安装，放 U 盘里就能分发',
          match: /-client-portable\.exe$/i,
          expect: (version) => `ClassHelper-${version}-x64-client-portable.exe`,
        },
      ],
    },
    {
      key: 'server',
      who: '教师电脑 / 学校服务器 · Windows',
      name: 'ClassHelper 服务端',
      desc: '内含 Web 管理端与 Node 运行时，装上就算跑起来：建库、建号、开机自启都由它自己办。',
      files: [
        {
          role: '安装程序',
          note: '装完浏览器打开 http://<服务器地址>:4000',
          match: /-server-setup\.exe$/i,
          expect: (version) => `ClassHelper-${version}-x64-server-setup.exe`,
        },
      ],
    },
    {
      key: 'linux',
      who: 'Linux 服务器',
      name: '服务端 · systemd',
      desc: '一行命令装完，附带 classhelper 运维命令（status / upgrade / backup / doctor / password）；也可以下压缩包自己解。',
      files: [
        {
          role: '安装包',
          note: '解压即用，含内置 Node 运行时',
          match: /^classhelper-server-linux-x64-.*\.tar\.gz$/i,
          expect: (version) => `classhelper-server-linux-x64-${version}.tar.gz`,
        },
        {
          role: '校验值',
          note: '安装脚本会自动取它核对',
          match: /^classhelper-server-linux-x64-.*\.tar\.gz\.sha256$/i,
          expect: (version) => `classhelper-server-linux-x64-${version}.tar.gz.sha256`,
        },
      ],
    },
    {
      key: 'plugin',
      who: '教室大屏 · 装在 ClassIsland 上',
      name: 'ClassIsland 联动插件',
      desc: '把课表上报给服务端，把老师发的提醒弹到 ClassIsland 的全屏提醒上。上课时段的普通通知先收着，打下课铃补弹。',
      files: [
        {
          role: '插件包',
          note: '在 ClassIsland 的插件页里选它安装',
          match: /classislandplugin\.cipx$/i,
          expect: () => 'ClassHelper.ClassIslandPlugin.cipx',
        },
      ],
    },
  ];

  const tabs = $('#ver-tabs');
  const indicator = $('#ver-indicator');
  const note = $('#ver-note');
  const grid = $('#dl-grid');
  const gridNote = $('#dl-note');
  const primary = $('#ver-primary');
  const command = $('#cmd-linux code');

  if (!tabs || !indicator || !note || !grid || !gridNote || !primary || !command) return;

  /** 当前选中的版本清单来自哪儿：live（读到的） / fallback（拼出来的） */
  let source = 'live';
  let releases = [];
  let current = null;

  /* ══════════════════════════════════════════════════════════════════════
     小工具
     ══════════════════════════════════════════════════════════════════════ */

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 体积口径与 GitHub 发布页一致（1024 进制，标签写 MB） */
  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    const mb = bytes / 1024 / 1024;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  /* ══════════════════════════════════════════════════════════════════════
     取清单
     ══════════════════════════════════════════════════════════════════════ */

  async function fetchReleases() {
    const response = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error('返回的不是发布列表');

    return list
      .filter((item) => item && item.tag_name && !item.draft)
      .map((item) => ({
        tag: String(item.tag_name),
        version: String(item.tag_name).replace(/^v/i, ''),
        prerelease: Boolean(item.prerelease),
        publishedAt: String(item.published_at ?? '').slice(0, 10),
        notesUrl: item.html_url ?? `${RELEASES_PAGE}/tag/${item.tag_name}`,
        assets: (item.assets ?? []).map((asset) => ({
          name: String(asset.name ?? ''),
          url: String(asset.browser_download_url ?? ''),
          size: Number(asset.size) || 0,
        })),
      }))
      .slice(0, MAX_VERSIONS);
  }

  /** 最新的一版 = 第一个正式版（预发布不占这个位置） */
  function markLatest(list) {
    const index = list.findIndex((item) => !item.prerelease);
    if (index >= 0) list[index].latest = true;
    return list;
  }

  /** 接口读不到时的替身：版本号取自页面上的 meta，文件名按发布命名约定拼 */
  function fallbackRelease() {
    const version = FALLBACK_VERSION || '0.0.0';
    const tag = `v${version}`;
    const assets = [];
    for (const card of CARDS) {
      for (const file of card.files) {
        const name = file.expect(version);
        assets.push({ name, url: `${RELEASES_PAGE}/download/${tag}/${name}`, size: 0 });
      }
    }
    return {
      tag,
      version,
      latest: true,
      prerelease: false,
      publishedAt: '',
      notesUrl: `${RELEASES_PAGE}/tag/${tag}`,
      assets,
    };
  }

  /* ══════════════════════════════════════════════════════════════════════
     版本分段控件 —— beUI Tabs：一个指示器在选项之间滑移
     ══════════════════════════════════════════════════════════════════════ */

  let setIndicator = null;
  if (motion) {
    const x = new motion.Spring(0, motion.SPRING_LAYOUT, (value) => {
      indicator.style.transform = `translateX(${motion.round2(value)}px)`;
    });
    const width = new motion.Spring(0, motion.SPRING_LAYOUT, (value) => {
      indicator.style.width = `${motion.round2(value)}px`;
    });
    setIndicator = (left, size, animate) => {
      if (!animate || motion.reduceMotion()) {
        x.jump(left);
        width.jump(size);
        return;
      }
      // 首次落位时宽度弹簧还在 0，直接跳过去，免得从 0 撑开
      if (width.value === 0) width.jump(size);
      x.set(left);
      width.set(size);
    };
  } else {
    // 动效层没加载出来也要能用：直接落位
    setIndicator = (left, size) => {
      indicator.style.transform = `translateX(${left}px)`;
      indicator.style.width = `${size}px`;
    };
  }

  /**
   * 位置用 offsetLeft / offsetWidth 量：指示器是绝对定位在 `.dl-tabs`（position: relative）里的，
   * 两者的参照边都是容器的内边距边 —— 而且这样**与容器的横向滚动无关**
   * （版本多了以后这排是可以横滚的，用 getBoundingClientRect 会在滚动后对不上）。
   */
  function moveIndicator(tag, animate) {
    const button = $$('.dl-tab', tabs).find((node) => node.dataset.tag === tag);
    if (!button) return;
    setIndicator(button.offsetLeft, button.offsetWidth, animate);
  }

  function renderTabs() {
    $$('.dl-tab', tabs).forEach((node) => node.remove());

    for (const release of releases) {
      const button = element('button', 'dl-tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.dataset.tag = release.tag;
      button.dataset.press = '0.96';
      button.setAttribute('aria-selected', 'false');
      button.append(element('span', null, release.tag));

      if (release.latest) button.append(element('span', 'dl-tab-flag', '最新'));
      else if (release.prerelease) button.append(element('span', 'dl-tab-flag dl-tab-flag-quiet', '预发布'));

      button.addEventListener('click', () => select(release.tag));
      tabs.append(button);
    }

    // 首帧之后重量一次：楷体是 CDN 来的，字体落定前量出来的宽度是错的
    moveIndicator(current?.tag ?? releases[0]?.tag, false);
    if (motion) {
      motion.nextFrame(() => moveIndicator(current?.tag ?? releases[0]?.tag, false));
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     卡片
     ══════════════════════════════════════════════════════════════════════ */

  function buildFileRow(file, asset) {
    const link = element('a', 'dl-file');
    link.href = asset.url;
    link.dataset.press = '0.98';

    const top = element('span', 'dl-file-top');
    top.append(element('span', 'dl-file-role', file.role));
    const size = formatSize(asset.size);
    if (size) top.append(element('span', 'dl-file-size', size));

    link.append(top, element('span', 'dl-file-name', asset.name), element('span', 'dl-file-note', file.note));

    const row = element('li');
    row.append(link);
    return row;
  }

  function buildCard(card, release) {
    const node = element('div', 'dl-card');
    node.append(
      element('p', 'dl-card-who', card.who),
      element('p', 'dl-card-name', card.name),
      element('p', 'dl-card-desc', card.desc),
    );

    const rows = card.files
      .map((file) => ({ file, asset: release.assets.find((item) => file.match.test(item.name)) }))
      .filter((row) => row.asset);

    if (rows.length) {
      const list = element('ul', 'dl-files');
      for (const row of rows) list.append(buildFileRow(row.file, row.asset));
      node.append(list);
    } else {
      node.append(element('p', 'dl-missing', `这一版没有发布「${card.name}」。`));
    }

    return node;
  }

  /** 卡片下方那段「这一版还有什么」，顺便说明清单是从哪儿来的 */
  function renderNote(release) {
    gridNote.textContent = '';
    const say = (text) => gridNote.append(document.createTextNode(text));
    const link = (text, href) => {
      const anchor = element('a', null, text);
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      gridNote.append(anchor);
    };

    if (source !== 'live') {
      say(
        '现在读不到版本列表 —— 多半是离线，或者 GitHub 那个匿名接口被限流了（每小时 60 次，按出口 IP 算）。',
      );
      say(`下面只列了当前版本 ${release.tag}，文件名是按发布命名约定拼出来的直链；打不开就去 `);
      link('Releases 页', RELEASES_PAGE);
      say(' 自己挑一份。');
      return;
    }

    const sums = release.assets.find((asset) => /^SHA256SUMS-.*\.txt$/i.test(asset.name));
    say(
      `这一版${release.publishedAt ? `（${release.publishedAt} 发布）` : ''}在发布页上有 ${release.assets.length} 个文件。`,
    );
    if (sums) {
      say('全部文件的哈希在 ');
      link(sums.name, sums.url);
      say(' 里，装之前可以先核对；');
    }
    say('发布说明与更早的版本见 ');
    link('Releases', release.notesUrl);
    say('。这份清单每打开一次就重新读一次，站点里不留副本。');
  }

  /* ══════════════════════════════════════════════════════════════════════
     选中某一版
     ══════════════════════════════════════════════════════════════════════ */

  /** 版本选择器下面那行状态 —— 它要说清"现在选中的是哪一版" */
  function renderStatus(release) {
    if (source !== 'live') {
      note.textContent =
        '版本列表暂时取不到（离线，或 GitHub 的匿名接口被限流），下面是按发布命名约定拼出来的直链。';
      return;
    }
    const marks = [];
    if (release.latest) marks.push('最新版');
    else if (release.prerelease) marks.push('预发布');
    if (release.publishedAt) marks.push(`${release.publishedAt} 发布`);
    marks.push(`${release.assets.length} 个文件`);
    note.textContent = `已选 ${release.tag}（${marks.join(' · ')}）· 列表读自本仓库的 GitHub Releases`;
  }

  function select(tag, animate = true) {
    const release = releases.find((item) => item.tag === tag);
    if (!release) return;
    current = release;

    for (const button of $$('.dl-tab', tabs)) {
      button.setAttribute('aria-selected', String(button.dataset.tag === tag));
    }
    moveIndicator(tag, animate);

    grid.textContent = '';
    for (const card of CARDS) grid.append(buildCard(card, release));
    renderStatus(release);
    renderNote(release);

    // 首屏那颗按钮：直接下这一版的服务端（其余三个包在下面自己挑）
    const serverCard = CARDS.find((card) => card.key === 'server');
    const server = release.assets.find((asset) => serverCard.files[0].match.test(asset.name));
    if (server) {
      primary.href = server.url;
      primary.textContent = `下 ${release.tag} 服务端`;
    } else {
      primary.href = release.notesUrl;
      primary.textContent = '去 Releases 挑一份';
    }

    // Linux 那一行：钉到当前选中的版本（老版本 tag 不是 x.y.z 形式时不带 --version）
    const pinned = /^\d+\.\d+\.\d+$/.test(release.version) ? ` --version ${release.version}` : '';
    command.textContent = `${command.dataset.base}${pinned}`;

    // 卡片与文件行是刚建出来的，让 main.js 把按压反馈补挂上
    document.dispatchEvent(new CustomEvent('ch:content'));
  }

  /* ══════════════════════════════════════════════════════════════════════
     启动
     ══════════════════════════════════════════════════════════════════════ */

  async function boot() {
    // 命令原文先记下来：后面每次都从它拼（版本选择会改写这段文本）
    command.dataset.base = command.textContent.trim();

    try {
      releases = markLatest(await fetchReleases());
      if (!releases.length) throw new Error('发布列表是空的');
    } catch (error) {
      console.warn('[download] 取版本列表失败，改用按命名约定拼出来的直链：', error.message);
      source = 'fallback';
      releases = [fallbackRelease()];
    }

    renderTabs();
    select(releases[0].tag, false);

    window.addEventListener('resize', () => moveIndicator(current?.tag, false), { passive: true });
  }

  boot();
})();
