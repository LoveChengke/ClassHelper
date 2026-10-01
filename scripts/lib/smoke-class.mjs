/**
 * 冒烟 / 验收专用的**临时班级**。
 *
 * 为什么必须新开一个班（而不是复用仓库里的第一个班）：
 * 验证会真发通知 —— 实时链路用例必须把通知打到"冒烟客户端所在的班级"，
 * 若这个班就是用户正在用的班，那些探针通知会**弹到用户自己的客户端与灵动岛上**，
 * 用户会以为"屏幕上出现了第二个灵动岛 / 客户端出问题了"（实测被投诉过好几次）。
 *
 * 做法：用管理员账号建一个随机班级码的临时班级 → 设为冒烟客户端的登录账号 →
 * 顺手给它备一份"当天的作业"（新班没有种子数据，作业看板用例要有东西可看）→ 收尾删掉。
 * 拿不到管理员账号（离线 / 没给凭据）时返回 null，调用方自行回退到"复用演示班级"。
 */
export async function provisionSmokeClass(options = {}) {
  const base = options.base ?? process.env.ELECTRON_SMOKE_API ?? 'http://127.0.0.1:4000/api';
  const admin = options.admin ?? process.env.ELECTRON_SMOKE_ADMIN ?? 'admin';
  const adminPassword =
    options.adminPassword ?? process.env.ELECTRON_SMOKE_ADMIN_PASSWORD ?? 'admin123';
  const password = options.password ?? process.env.ELECTRON_SMOKE_CLASS_PASSWORD ?? 'smoke123456';
  const className = options.className ?? '冒烟验证班';
  const code = `SMOKE${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const todayKey = () => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`;
  };

  try {
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: admin, password: adminPassword }),
    }).then((response) => response.json());
    const token = login?.data?.token;
    if (!token) return null;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const created = await fetch(`${base}/classes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: className, grade: '验证', code }),
    }).then((response) => response.json());
    const classId = created?.data?.id;
    if (!classId) return null;

    await fetch(`${base}/classes/${classId}/class-account`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ code, password }),
    });

    // 作业看板用例需要"某天有作业"：临时班没有种子数据，这里补一条当天的
    await fetch(`${base}/homeworks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        classId,
        title: '冒烟看板作业',
        content: '自动化验证用作业（随临时班级一起删除）。',
        assignDate: todayKey(),
      }),
    }).catch(() => undefined);

    return {
      code,
      password,
      classId,
      className,
      /** 收尾：删掉临时班级（连带它的班级账号/作业/通知） */
      async cleanup() {
        try {
          await fetch(`${base}/classes/${classId}`, { method: 'DELETE', headers });
        } catch {
          // 清理失败不影响结论
        }
      },
    };
  } catch {
    return null;
  }
}
