/** 只创建独立临时班级；验证任课教师的只读详情不能显示班主任维护入口。 */
async function checkClassRelations(win, options, record) {
  const base = `${new URL(options.url).origin}/api`;
  async function request(route, token, method = 'GET', body) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    return { status: response.status, data: result.data, message: result.message };
  }
  async function data(route, token, method, body) {
    const result = await request(route, token, method, body);
    if (result.status >= 400) throw new Error(`${route}: ${result.status} ${result.message}`);
    return result.data;
  }
  async function wait(expression) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (await win.webContents.executeJavaScript(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('班级详情未就绪');
  }
  const teacher = await data('/auth/login', null, 'POST', {
    username: options.username,
    password: options.password,
  });
  const admin = await data('/auth/login', null, 'POST', {
    username: options.adminUsername,
    password: options.adminPassword,
  });
  let other, student;
  try {
    other = await data('/classes', admin.token, 'POST', {
      grade: '验证',
      enrollmentYear: 2098,
      classIndex: 1 + Math.floor(Math.random() * 99),
      teacherId: admin.user.id,
      code: `REL${Date.now().toString(36).toUpperCase()}`,
    });
    await data(`/classes/${other.id}/subject-teachers`, admin.token, 'PUT', {
      assignments: [{ subjectName: '数学', teacherId: teacher.user.id }],
    });
    student = await data('/students', admin.token, 'POST', {
      classId: other.id,
      studentNo: `REL${Date.now()}`,
      name: '独立关系验证学生',
    });
    const detail = await data(`/classes/${other.id}`, teacher.token);
    const statuses = await Promise.all([
      request(`/students/${student.id}`, teacher.token, 'PATCH', { name: student.name }),
      request(`/classes/${other.id}/settings`, teacher.token, 'PATCH', { termWeeks: detail.termWeeks }),
      request(`/classes/${other.id}/student-grade-query`, teacher.token, 'PATCH', {
        enabled: detail.studentGradeQueryEnabled,
      }),
      request(`/courses/${detail.courses[0].id}`, teacher.token, 'DELETE'),
    ]);
    record(
      '任课教师跨班修改学生、学期设置、成绩开关及删除课程均返回 403',
      statuses.every((result) => result.status === 403),
      statuses.map((result) => result.status).join('/'),
    );

    await win.loadURL(`${new URL(options.url).origin}/classes`);
    await wait(
      `Array.from(document.querySelectorAll('.el-table__row')).some(row => row.textContent.includes(${JSON.stringify(other.name)}))`,
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.el-table__row')).find(row => row.textContent.includes(${JSON.stringify(other.name)})).querySelector('button').click()`,
    );
    await wait(
      `Boolean(document.querySelector('.el-drawer .el-tabs')) && !document.querySelector('.el-drawer .el-loading-mask')`,
    );
    const peer = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('.el-drawer');
      const pane = name => drawer.querySelector('#pane-' + name);
      const writes = Array.from(pane('students').querySelectorAll('button')).filter(button => ['添加学生', '移出'].includes(button.textContent.trim()));
      return { studentsVisible: pane('students').textContent.includes('独立关系验证学生'), studentWrites: writes.length, courseDeletes: Array.from(pane('courses').querySelectorAll('button')).filter(button => button.textContent.trim() === '删除').length, courseCreate: Boolean(pane('courses').querySelector('input')), gradeQueryDisabled: pane('settings').querySelector('.el-switch')?.classList.contains('is-disabled') };
    })()`);
    record(
      '任课教师可查看别班详情，名单/课程写入口隐藏且成绩开关只读',
      peer.studentsVisible &&
        peer.studentWrites === 0 &&
        peer.courseDeletes === 0 &&
        !peer.courseCreate &&
        peer.gradeQueryDisabled,
      JSON.stringify(peer),
    );

    const classes = await data('/classes', teacher.token);
    const own = classes.find((row) => row.teacher?.id === teacher.user.id);
    if (!own) throw new Error('缺少独立的班主任班级');
    await win.loadURL(`${new URL(options.url).origin}/classes`);
    await wait(
      `Array.from(document.querySelectorAll('.el-table__row')).some(row => row.textContent.includes(${JSON.stringify(own.name)}))`,
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.el-table__row')).find(row => row.textContent.includes(${JSON.stringify(own.name)})).querySelector('button').click()`,
    );
    await wait(
      `Boolean(document.querySelector('.el-drawer .el-tabs')) && !document.querySelector('.el-drawer .el-loading-mask')`,
    );
    const owner = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('.el-drawer');
      return { studentWrite: Array.from(drawer.querySelectorAll('#pane-students button')).some(button => button.textContent.trim() === '添加学生'), courseCreate: Boolean(drawer.querySelector('#pane-courses input')), gradeQueryEnabled: !drawer.querySelector('#pane-settings .el-switch')?.classList.contains('is-disabled') };
    })()`);
    record(
      '班主任本人班级仍可维护名单、课程和成绩查询开关',
      owner.studentWrite && owner.courseCreate && owner.gradeQueryEnabled,
      JSON.stringify(owner),
    );
    const members = await data('/permissions/users', admin.token);
    const previous = members.find((member) => member.id === teacher.user.id).assignments;
    const groups = [];
    try {
      const allClasses = await data('/classes', admin.token);
      const unrelatedGrade = allClasses.find(
        (row) => row.grade !== own.grade && row.teacher?.id !== teacher.user.id,
      )?.grade;
      if (!unrelatedGrade) throw new Error('缺少不担任班主任的隔离年级');
      const reads = await data('/permissions/groups', admin.token, 'POST', {
        name: `菜单只读${Date.now()}`,
        scope: 'ALL',
        keys: [
          'dashboard:read',
          'class:read',
          'roster:read',
          'schedule:read',
          'term:read',
          'homework:read',
          'notification:read',
          'grade:read',
          'courseware:read',
          'client:read',
        ],
      });
      groups.push(reads.id);
      const limited = await data('/permissions/groups', admin.token, 'POST', {
        name: `菜单空关系${Date.now()}`,
        scope: 'GRADE',
        scopeValue: unrelatedGrade,
        keys: ['class:settings'],
      });
      groups.push(limited.id);
      await data(`/permissions/users/${teacher.user.id}/groups`, admin.token, 'PUT', {
        assignments: [
          { groupId: reads.id, scope: 'ALL', scopeValue: '' },
          { groupId: limited.id, scope: 'GRADE', scopeValue: unrelatedGrade },
        ],
      });
      const restricted = await data('/permissions/me', teacher.token);
      await win.loadURL(`${new URL(options.url).origin}/dashboard`);
      await wait(
        `Boolean(document.querySelector('.page-title')) && document.querySelectorAll('.el-menu-item').length > 0`,
      );
      const labels = await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.el-menu-item')).map(node => node.textContent.trim())`,
      );
      const hidden = [
        '班级管理',
        '学生管理',
        '课表档案',
        '学期周次',
        '作业发布',
        '通知发布',
        '成绩录入',
        '课件',
        '客户端',
      ];
      record(
        '只有读权限或写键无可操作班级时隐藏维护页面',
        restricted.permissions.includes('class:settings') &&
          restricted.actionScopes['class:settings'].length === 0 &&
          hidden.every((label) => !labels.includes(label)),
        labels.join(','),
      );
    } finally {
      await data(`/permissions/users/${teacher.user.id}/groups`, admin.token, 'PUT', {
        assignments: previous.map(({ groupId, scope, scopeValue }) => ({ groupId, scope, scopeValue })),
      });
      for (const id of groups) await data(`/permissions/groups/${id}`, admin.token, 'DELETE');
    }
    await win.loadURL(`${new URL(options.url).origin}/term-weeks`);
    await wait(
      `document.querySelector('.page-title')?.textContent.trim() === '学期周次' && document.querySelector('.page').textContent.includes('当前第') && !document.querySelector('.el-loading-mask')`,
    );
    const partial = await win.webContents.executeJavaScript(`(() => ({
      menu: Array.from(document.querySelectorAll('.el-menu-item')).some(node => node.textContent.trim() === '学期周次'),
      own: document.querySelector('.page').textContent.includes(${JSON.stringify(own.name)}),
      editable: Array.from(document.querySelectorAll('.page button')).some(node => node.textContent.trim() === '保存'),
      dateEnabled: !document.querySelector('.page .el-date-editor input')?.disabled,
    }))()`);
    record(
      '部分班级可维护时保留周次入口，进入后默认选中本人可编辑班级',
      partial.menu && partial.own && partial.editable && partial.dateEnabled,
      JSON.stringify(partial),
    );
  } finally {
    if (other && student) await data(`/classes/${other.id}/students/${student.id}`, admin.token, 'DELETE');
    if (other) await data(`/classes/${other.id}`, admin.token, 'DELETE');
  }
}
module.exports = { checkClassRelations };
