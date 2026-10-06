/**
 * ClassHelper · 下载页（download.html）
 *
 * 这一页只做一件事：**挑一个版本、挑一个组件、挑一份文件，点下去就下**。
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
 * 页面结构（照 ClassIsland 官网那页）：
 *
 *   版本分段控件 → 一行状态 → 「装什么」分段控件 → 卡片（图标 / 名称 / 系统要求 / 主按钮 + 变体下拉）
 *
 * 默认停在**客户端**（进来最先要的多半是它），服务端与插件各是一个可切换的分组。
 * 两个分段控件共用同一套指示器实现；建完卡片会派发一次 `ch:content`，
 * 让 main.js 把按压反馈补挂上 —— 这些元素是拉到清单之后才出现的。
 */

(() => {
  'use strict';

  const REPO = 'LoveChengke/ClassHelper';
  const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

  /** 版本选择器最多列几版；更早的去 Releases 页看 */
  const MAX_VERSIONS = 12;

  /** 进站默认的分组 —— 客户端 */
  const DEFAULT_GROUP = 'client';

  const motion = window.CHMotion ?? null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  /** 页面上那份兜底版本号，由 `pnpm version:bump` 与根 package.json 一起维护 */
  const FALLBACK_VERSION = ($('meta[name="ch-version"]')?.content ?? '').trim();

  const CHEVRON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  /**
   * 卡片顶上那个平台标记。单色描边、跟着文字色走 —— 彩色 logo 落在纸面上像贴纸，
   * 而且深浅两套主题下要各准备一份。图形只取"一眼能认出是哪个平台"的程度。
   */
  const MARKS = {
    windows:
      '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5.5 10.4 4.5V11.3H3ZM11.6 4.4 21 3V11.3H11.6ZM3 12.7H10.4V19.5L3 18.5ZM11.6 12.7H21V21L11.6 19.6Z"/></svg>',
    linux:
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      // 窄头 + 宽肚、脖子处收一下 —— 企鹅的识别点全在这个形状上
      '<path fill="#16231e" d="M12 2.7C9.7 2.7 8 4.7 8 7.1c0 1.5.4 2.3 1 3.3-1.7 1.5-3.4 3.5-3.4 6 0 3 2.6 4.2 6.4 4.2s6.4-1.2 6.4-4.2c0-2.5-1.7-4.5-3.4-6 .6-1 1-1.8 1-3.3 0-2.4-1.7-4.4-4-4.4Z"/>' +
      // 脸的两片白 + 瞳孔 + 嘴：Tux 就是靠这三样认出来的（卡片底色是恒定的纸白，可以用实色）
      '<ellipse cx="10.35" cy="6.7" rx="1.35" ry="1.85" fill="#ffffff"/>' +
      '<ellipse cx="13.65" cy="6.7" rx="1.35" ry="1.85" fill="#ffffff"/>' +
      '<circle cx="10.5" cy="6.6" r=".62" fill="#16231e"/>' +
      '<circle cx="13.5" cy="6.6" r=".62" fill="#16231e"/>' +
      '<path fill="#f0a03c" d="M12 7.6 13.15 9.8h-2.3Z"/>' +
      '<ellipse cx="9.4" cy="21.2" rx="2.3" ry=".95" fill="#f0a03c"/>' +
      '<ellipse cx="14.6" cy="21.2" rx="2.3" ry=".95" fill="#f0a03c"/>' +
      '</svg>',
    plugin:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M9 3.4v4.4M15 3.4v4.4"/>' +
      '<path d="M6.6 7.8H17.4V11.2A5.4 5.4 0 0 1 6.6 11.2Z"/>' +
      '<path d="M12 16.6v4"/></svg>',
  };

  /**
   * 分组 = 「装什么」。一个分组下可以有几张卡（服务端就是 Windows + Linux 两张），
   * 每张卡是一个交付物，卡里的第一个文件是主按钮，其余进变体下拉。
   *
   * `match` 用来在真实资源里认领这个文件，`expect` 是没有接口时按命名约定拼直链的名字。
   * **两个都要跟着发布流程一起改** —— 名字口径与 README「开始使用」那张表、
   * `.cache/release-notes-*.md` 里那份清单是同一套。
   */
  const GROUPS = [
    {
      key: 'client',
      label: '客户端',
      note: {
        text: '教室机器与学生电脑装这个：填一次服务器地址和班级码，之后开机就能用。先得有一台机器跑着服务端，它才连得上。',
        more: { label: '先看服务端', group: 'server' },
      },
      cards: [
        {
          mark: 'windows',
          name: 'ClassHelper 班级端',
          req: 'Windows 10 及更高版本 · 教室机器 / 学生电脑',
          desc: '看课表、作业、通知与成绩，带灵动岛；断网时读本地缓存，网络恢复自己刷新。',
          files: [
            {
              role: '下载安装版',
              note: 'NSIS 安装程序，装完在开始菜单里',
              match: /-client-setup\.exe$/i,
              expect: (version) => `ClassHelper-${version}-x64-client-setup.exe`,
            },
            {
              role: '下载单文件版',
              note: '不用安装，放 U 盘里就能分发',
              match: /-client-portable\.exe$/i,
              expect: (version) => `ClassHelper-${version}-x64-client-portable.exe`,
            },
          ],
        },
      ],
    },
    {
      key: 'server',
      label: '服务端',
      note: {
        text: '整套系统只有一台（或一台云服务器）。装上就算跑起来：建库、建号、开机自启都由它自己办，Web 管理端也由它托管。',
      },
      cards: [
        {
          mark: 'windows',
          name: 'ClassHelper 服务端',
          req: 'Windows 10 及更高版本 · 教师电脑 / 学校服务器',
          desc: '内含 Web 管理端与 Node 运行时。装完浏览器打开 http://<服务器地址>:4000 就能登录。',
          files: [
            {
              role: '下载安装程序',
              note: '双击安装，自动建库建号、开机自启',
              match: /-server-setup\.exe$/i,
              expect: (version) => `ClassHelper-${version}-x64-server-setup.exe`,
            },
            {
              role: '下载 SHA256 清单',
              note: '这一版全部文件的哈希，装之前可以核对',
              match: /^SHA256SUMS-.*\.txt$/i,
              expect: (version) => `SHA256SUMS-${version}.txt`,
            },
          ],
        },
        {
          mark: 'linux',
          name: 'ClassHelper 服务端',
          req: 'Linux x64 · systemd（Debian 10 / Ubuntu 20.04 及更高）',
          desc: '一行命令装成 systemd 服务，带 classhelper 运维命令；也可以下压缩包自己解。',
          files: [
            {
              role: '下载 tar.gz',
              note: '解压即用，含内置 Node 运行时',
              match: /^classhelper-server-linux-x64-.*\.tar\.gz$/i,
              expect: (version) => `classhelper-server-linux-x64-${version}.tar.gz`,
            },
            {
              role: '下载 .sha256',
              note: '安装脚本会自动取它核对压缩包',
              match: /^classhelper-server-linux-x64-.*\.tar\.gz\.sha256$/i,
              expect: (version) => `classhelper-server-linux-x64-${version}.tar.gz.sha256`,
            },
          ],
        },
      ],
    },
    {
      key: 'plugin',
      label: '插件',
      note: {
        text: '给教室那台已经装了 ClassIsland 的机器加装 —— 课表从这里上报，老师发的提醒弹到全屏。',
      },
      cards: [
        {
          mark: 'plugin',
          name: 'ClassIsland 联动插件',
          req: '装在教室已有的 ClassIsland 2.x 上 · 教室大屏',
          desc: '上课时段的普通通知先收着，打下课铃补弹；紧急通知与叫人立刻全屏提醒，可以语音朗读。',
          files: [
            {
              role: '下载 .cipx',
              note: '在 ClassIsland 的插件页里选它安装',
              match: /classislandplugin\.cipx$/i,
              expect: () => 'ClassHelper.ClassIslandPlugin.cipx',
            },
          ],
        },
      ],
    },
  ];

  const versionHost = $('#ver-tabs');
  const versionIndicator = $('#ver-indicator');
  const versionStatus = $('#ver-note');
  const groupHost = $('#group-tabs');
  const groupIndicator = $('#group-indicator');
  const groupStatus = $('#group-note');
  const grid = $('#dl-grid');
  const gridNote = $('#dl-note');
  const primary = $('#ver-primary');
  const command = $('#cmd-linux code');

  if (
    !versionHost ||
    !versionIndicator ||
    !versionStatus ||
    !groupHost ||
    !groupIndicator ||
    !groupStatus ||
    !grid ||
    !gridNote ||
    !primary ||
    !command
  ) {
    return;
  }

  /** 当前状态：选中的版本 + 选中的分组 + 清单来自哪儿 */
  const state = { releases: [], version: null, group: DEFAULT_GROUP, source: 'live' };

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
    for (const group of GROUPS) {
      for (const card of group.cards) {
        for (const file of card.files) {
          const name = file.expect(version);
          assets.push({ name, url: `${RELEASES_PAGE}/download/${tag}/${name}`, size: 0 });
        }
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

  /** 把一张卡的 files 落成"这一版真实存在的资源"；认领不到的行直接丢掉 */
  function resolveFiles(card, release) {
    return card.files
      .map((file) => ({ file, asset: release.assets.find((item) => file.match.test(item.name)) }))
      .filter((row) => row.asset);
  }

  function currentRelease() {
    return state.releases.find((item) => item.tag === state.version) ?? state.releases[0];
  }

  function currentGroup() {
    return GROUPS.find((item) => item.key === state.group) ?? GROUPS[0];
  }

  /* ══════════════════════════════════════════════════════════════════════
     分段控件 —— beUI Tabs：一个指示器在选项之间滑移
     版本与「装什么」共用这一套，所以这里不含任何"版本"的语义。
     ══════════════════════════════════════════════════════════════════════ */

  /** 位置用 offsetLeft / offsetWidth 量：指示器绝对定位在分段控件（position: relative）里，
      两者参照的都是容器的内边距边 —— 而且这样**与容器的横向滚动无关**
      （版本多了以后这一排可以横滚，用 getBoundingClientRect 会在滚动后对不上）。 */
  function createIndicator(indicator) {
    if (!motion) {
      // 动效层没加载出来也要能用：直接落位
      return (left, width) => {
        indicator.style.transform = `translateX(${left}px)`;
        indicator.style.width = `${width}px`;
      };
    }

    const x = new motion.Spring(0, motion.SPRING_LAYOUT, (value) => {
      indicator.style.transform = `translateX(${motion.round2(value)}px)`;
    });
    const width = new motion.Spring(0, motion.SPRING_LAYOUT, (value) => {
      indicator.style.width = `${motion.round2(value)}px`;
    });

    return (left, size, animate) => {
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
  }

  function selectedItem(host, value) {
    return $$('.dl-seg-item', host).find((node) => node.dataset.value === value);
  }

  function markSelected(host, value) {
    for (const item of $$('.dl-seg-item', host)) {
      item.setAttribute('aria-selected', String(item.dataset.value === value));
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     版本分段控件（条目按发布列表建）
     ══════════════════════════════════════════════════════════════════════ */

  const setVersionIndicator = createIndicator(versionIndicator);

  function moveVersionIndicator(animate) {
    const item = selectedItem(versionHost, state.version);
    if (item) setVersionIndicator(item.offsetLeft, item.offsetWidth, animate);
  }

  function renderVersionTabs() {
    $$('.dl-seg-item', versionHost).forEach((node) => node.remove());

    for (const release of state.releases) {
      const button = element('button', 'dl-seg-item');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.dataset.value = release.tag;
      button.dataset.press = '0.96';
      button.setAttribute('aria-selected', 'false');
      button.append(element('span', null, release.tag));

      if (release.latest) button.append(element('span', 'dl-seg-flag', '最新'));
      else if (release.prerelease) {
        button.append(element('span', 'dl-seg-flag dl-seg-flag-quiet', '预发布'));
      }

      button.addEventListener('click', () => selectVersion(release.tag));
      versionHost.append(button);
    }

    markSelected(versionHost, state.version);
    // 首帧之后重量一次：楷体是 CDN 来的，字体落定前量出来的宽度是错的
    moveVersionIndicator(false);
    if (motion) motion.nextFrame(() => moveVersionIndicator(false));
  }

  /* ══════════════════════════════════════════════════════════════════════
     「装什么」分段控件（条目写在 HTML 里）
     ══════════════════════════════════════════════════════════════════════ */

  const setGroupIndicator = createIndicator(groupIndicator);

  function moveGroupIndicator(animate) {
    const item = selectedItem(groupHost, state.group);
    if (item) setGroupIndicator(item.offsetLeft, item.offsetWidth, animate);
  }

  function bindGroupTabs() {
    for (const item of $$('.dl-seg-item', groupHost)) {
      item.dataset.press = '0.96';
      item.addEventListener('click', () => selectGroup(item.dataset.value));
    }
    markSelected(groupHost, state.group);
    moveGroupIndicator(false);
    if (motion) motion.nextFrame(() => moveGroupIndicator(false));
  }

  /* ══════════════════════════════════════════════════════════════════════
     卡片
     ══════════════════════════════════════════════════════════════════════ */

  function buildMenuItem({ file, asset }) {
    const link = element('a');
    link.href = asset.url;

    const top = element('span', 'dl-menu-top');
    top.append(element('span', 'dl-menu-role', file.role));
    const size = formatSize(asset.size);
    if (size) top.append(element('span', 'dl-menu-size', size));

    link.append(top, element('span', 'dl-menu-file', asset.name));
    if (file.note) link.append(element('span', 'dl-menu-note', file.note));

    const item = element('li');
    item.append(link);
    return item;
  }

  /** 主按钮 + 变体下拉：一个整体，右边那条箭头只负责展开剩下的文件 */
  function buildCta(rows) {
    const [first, ...rest] = rows;

    const wrap = element('div', `dl-cta${rest.length ? '' : ' dl-cta-single'}`);
    const main = element('a', 'dl-cta-main', first.file.role);
    main.href = first.asset.url;
    main.dataset.press = '0.97';
    wrap.append(main);

    if (rest.length) {
      const more = element('details', 'dl-more');
      const summary = element('summary');
      summary.setAttribute('aria-label', `还有 ${rest.length} 个文件`);
      summary.innerHTML = CHEVRON; // 静态常量，不含外部文本
      const menu = element('ul', 'dl-menu');
      for (const row of rest) menu.append(buildMenuItem(row));
      more.append(summary, menu);
      wrap.append(more);
    }

    return wrap;
  }

  function buildCard(card, release) {
    const node = element('div', 'dl-card');
    const mark = element('span', 'dl-card-mark');
    mark.innerHTML = MARKS[card.mark] ?? ''; // 静态常量，不含外部文本

    node.append(
      mark,
      element('p', 'dl-card-name', card.name),
      element('p', 'dl-card-req', card.req),
      element('p', 'dl-card-desc', card.desc),
    );

    const rows = resolveFiles(card, release);
    if (!rows.length) {
      node.append(element('p', 'dl-missing', '这一版没有发布这个包。'));
      return node;
    }

    node.append(buildCta(rows));
    const size = formatSize(rows[0].asset.size);
    node.append(element('p', 'dl-card-file', `${rows[0].asset.name}${size ? ` · ${size}` : ''}`));
    return node;
  }

  /* ══════════════════════════════════════════════════════════════════════
     两行状态文字
     ══════════════════════════════════════════════════════════════════════ */

  /** 版本选择器下面那行：现在选中的是哪一版 */
  function renderVersionStatus(release) {
    if (state.source !== 'live') {
      versionStatus.textContent =
        '版本列表暂时取不到（离线，或 GitHub 的匿名接口被限流），下面是按发布命名约定拼出来的直链。';
      return;
    }
    const marks = [];
    if (release.latest) marks.push('最新版');
    else if (release.prerelease) marks.push('预发布');
    if (release.publishedAt) marks.push(`${release.publishedAt} 发布`);
    marks.push(`${release.assets.length} 个文件`);
    versionStatus.textContent = `已选 ${release.tag}（${marks.join(' · ')}）· 列表读自本仓库的 GitHub Releases`;
  }

  /** 「装什么」下面那行：这一组装在哪儿、装之前要不要先有别的东西 */
  function renderGroupStatus(group) {
    groupStatus.textContent = '';
    groupStatus.append(document.createTextNode(group.note.text));
    if (!group.note.more) return;

    groupStatus.append(document.createTextNode(' '));
    const anchor = element('a', null, `${group.note.more.label} →`);
    anchor.href = `#${group.note.more.group}`;
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      selectGroup(group.note.more.group);
      groupHost.scrollIntoView({ block: 'center' });
    });
    groupStatus.append(anchor);
  }

  /** 卡片下方那段「这一版还有什么」，顺便说明清单是从哪儿来的 */
  function renderGridNote(release) {
    gridNote.textContent = '';
    const say = (text) => gridNote.append(document.createTextNode(text));
    const link = (text, href) => {
      const anchor = element('a', null, text);
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      gridNote.append(anchor);
    };

    if (state.source !== 'live') {
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
     渲染 + 选择
     ══════════════════════════════════════════════════════════════════════ */

  function render() {
    const release = currentRelease();
    const group = currentGroup();

    grid.textContent = '';
    for (const card of group.cards) grid.append(buildCard(card, release));

    renderVersionStatus(release);
    renderGroupStatus(group);
    renderGridNote(release);

    // 首屏那颗按钮跟着「版本 + 分组」走：默认就是这一版客户端的安装版
    const first = resolveFiles(group.cards[0], release)[0];
    if (first) {
      primary.href = first.asset.url;
      primary.textContent = `下载${group.label} ${release.tag}`;
    } else {
      primary.href = release.notesUrl;
      primary.textContent = '去 Releases 挑一份';
    }

    // Linux 那一行：钉到当前选中的版本（老版本 tag 不是 x.y.z 形式时不带 --version）
    const pinned = /^\d+\.\d+\.\d+$/.test(release.version) ? ` --version ${release.version}` : '';
    command.textContent = `${command.dataset.base}${pinned}`;

    // 卡片是刚建出来的，让 main.js 把按压反馈补挂上
    document.dispatchEvent(new CustomEvent('ch:content'));
  }

  function selectVersion(tag, animate = true) {
    if (!state.releases.some((item) => item.tag === tag)) return;
    state.version = tag;
    markSelected(versionHost, tag);
    moveVersionIndicator(animate);
    render();
  }

  function selectGroup(key, animate = true) {
    if (!GROUPS.some((item) => item.key === key)) return;
    state.group = key;
    markSelected(groupHost, key);
    moveGroupIndicator(animate);
    render();
  }

  /* ══════════════════════════════════════════════════════════════════════
     变体下拉：点别处或按 Esc 收起来（<details> 自己管键盘与开合）
     ══════════════════════════════════════════════════════════════════════ */

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const inside = target?.closest('.dl-more') ?? null;
    // 点了菜单里的链接也算"用完"，一并收起
    const clickedItem = Boolean(target?.closest('.dl-menu a'));
    for (const node of $$('.dl-more[open]')) {
      if (node !== inside || clickedItem) node.open = false;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const node of $$('.dl-more[open]')) node.open = false;
  });

  /* ══════════════════════════════════════════════════════════════════════
     启动
     ══════════════════════════════════════════════════════════════════════ */

  async function boot() {
    // 命令原文先记下来：后面每次都从它拼（版本选择会改写这段文本）
    command.dataset.base = command.textContent.trim();

    try {
      state.releases = markLatest(await fetchReleases());
      if (!state.releases.length) throw new Error('发布列表是空的');
    } catch (error) {
      console.warn('[download] 取版本列表失败，改用按命名约定拼出来的直链：', error.message);
      state.source = 'fallback';
      state.releases = [fallbackRelease()];
    }

    state.version = state.releases[0].tag;
    renderVersionTabs();
    bindGroupTabs();
    render();

    window.addEventListener(
      'resize',
      () => {
        moveVersionIndicator(false);
        moveGroupIndicator(false);
      },
      { passive: true },
    );
  }

  boot();
})();
