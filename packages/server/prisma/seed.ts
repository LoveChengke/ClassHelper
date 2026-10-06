/**
 * 种子数据：pnpm db:seed
 *
 * 会清空业务表后重建一套完整演示数据：
 *   1 管理员 / 2 教师 / 3 个在读班级 / 1 个已毕业届别 / 15 名学生 /
 *   课程（含各科任课老师）/ 课表 / 作业 / 通知 / 成绩 / 调班与转出历史
 *
 * 班级称呼一律是「XXXX级X班」（入学年份 + 班号）—— 见 shared 的 `formatClassName()`。
 *
 * 演示账号（密码见文件末尾打印结果）：
 *   admin / admin123        - 系统管理员
 *   teacher1 / teacher123   - 张老师（2026级1班 班主任，兼 2026级1班 数学）
 *   teacher2 / teacher123   - 李老师（2026级2班 班主任，兼 2026级1班 语文）
 *   （学生只有名单、没有账号：ClassHelper 班级端统一用班级码 + 班级密码登录）
 */
import {
  SUBJECT_CATALOG,
  dayKeyLocal,
  formatClassName,
  formatYearLabel,
  gradeLevel,
  gradePercent,
} from '@classhelper/shared';
import { disconnectPrisma, prisma } from '../src/lib/db.js';
import { logger } from '../src/lib/logger.js';
import { hashPassword } from '../src/lib/password.js';
import { MAX_TERM_WEEK } from '../src/lib/term.js';

const STUDENT_NAMES = [
  '王小明',
  '李思远',
  '张欣怡',
  '刘子涵',
  '陈嘉豪',
  '杨雨欣',
  '赵依然',
  '黄浩然',
  '周思彤',
  '吴俊杰',
  '徐若曦',
  '孙晨曦',
  '马文博',
  '朱佳琪',
  '胡一鸣',
];

// 课程目录：与 shared 的 SUBJECT_CATALOG 保持一致（演示数据覆盖全部常见科目）
const COURSE_NAMES = [...SUBJECT_CATALOG];

/** 每天的上课节次模板（dayOfWeek 1-5） */
const PERIOD_TEMPLATE = [
  { startTime: '08:00', endTime: '08:45' },
  { startTime: '08:55', endTime: '09:40' },
  { startTime: '10:00', endTime: '10:45' },
  { startTime: '10:55', endTime: '11:40' },
  { startTime: '14:00', endTime: '14:45' },
  { startTime: '14:55', endTime: '15:40' },
];

const CLASS_ROOMS = ['教学楼 A301', '教学楼 A302', '实验楼 B205'];

/** 固定种子的伪随机数，保证每次 seed 结果一致 */
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

async function resetDatabase(): Promise<void> {
  // 顺序敏感：先删子表，再删主表
  await prisma.grade.deleteMany();
  await prisma.homeworkStatus.deleteMany();
  await prisma.homework.deleteMany();
  await prisma.notificationRead.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.schedule.deleteMany();
  await prisma.course.deleteMany();
  await prisma.studentClassTransfer.deleteMany();
  // 学生要排在调班历史之后、班级之前（Student.classId 是 SetNull，但历史是 Cascade）
  await prisma.student.deleteMany();
  await prisma.user.deleteMany();
  // 班级归到届别上，所以先删班级再删届别
  await prisma.class.deleteMany();
  await prisma.archivedYear.deleteMany();
}

async function main(): Promise<void> {
  logger.info('开始写入种子数据...');

  if (process.env.NODE_ENV === 'production') {
    throw new Error('拒绝在生产环境执行 seed（NODE_ENV=production）');
  }

  await resetDatabase();

  const random = createRandom(20260901);

  // 同一角色共用密码，只需各哈希一次
  // 学生没有密码：个人学生账号已清理（2026-10-01），ClassHelper 班级端统一用班级码 + 班级密码登录
  const [adminHash, teacherHash, classPasswordHash] = await Promise.all([
    hashPassword('admin123'),
    hashPassword('teacher123'),
    // 班级账号默认密码（ClassHelper 班级端「班级登录」）
    hashPassword('123456'),
  ]);

  const admin = await prisma.user.create({
    data: { username: 'admin', name: '系统管理员', role: 'ADMIN', passwordHash: adminHash },
  });

  const teacher1 = await prisma.user.create({
    data: { username: 'teacher1', name: '张老师', role: 'TEACHER', passwordHash: teacherHash },
  });
  const teacher2 = await prisma.user.create({
    data: { username: 'teacher2', name: '李老师', role: 'TEACHER', passwordHash: teacherHash },
  });

  // 班级账号：班级码（ClassHelper 班级端「班级登录」的账号）+ 班级密码（默认 123456，可在班级管理里重置）
  //
  // 称呼按「入学年份 + 班号」生成：2026 级是高一（当前学年 2026-2027），2025 级是高二。
  // 毕业年份 = 入学年份 + 3，所以这一届 2026 级将在 2029 年归档。
  const classSeeds = [
    { enrollmentYear: 2026, classIndex: 1, grade: '高一', teacherId: teacher1.id, code: 'G101' },
    { enrollmentYear: 2026, classIndex: 2, grade: '高一', teacherId: teacher2.id, code: 'G102' },
    { enrollmentYear: 2025, classIndex: 3, grade: '高二', teacherId: teacher1.id, code: 'G203' },
  ];

  const classes = [];
  for (const [index, seed] of classSeeds.entries()) {
    const created = await prisma.class.create({
      data: {
        name: formatClassName(seed.enrollmentYear, seed.classIndex),
        grade: seed.grade,
        enrollmentYear: seed.enrollmentYear,
        classIndex: seed.classIndex,
        teacherId: seed.teacherId,
        code: seed.code,
        passwordHash: classPasswordHash,
      },
    });
    classes.push({ ...created, room: CLASS_ROOMS[index] ?? '教学楼 A101' });
  }

  // ---------------------------------------------------------------- 学生（只是名单，不是账号）
  const students = [];
  for (let index = 0; index < STUDENT_NAMES.length; index += 1) {
    const classSlot = Math.floor(index / 5);
    const targetClass = classes[classSlot] ?? classes[0]!;
    // 学号：入学年份 + 两位序号（与班级称呼同一套「届别」口径）
    const student = await prisma.student.create({
      data: {
        studentNo: `${targetClass.enrollmentYear}${String(index + 1).padStart(2, '0')}`,
        name: STUDENT_NAMES[index] ?? `学生${index + 1}`,
        classId: targetClass.id,
        gender: index % 2 === 0 ? 'MALE' : 'FEMALE',
        guardianPhone: `138${String(10000000 + index * 137).slice(0, 8)}`,
      },
    });
    students.push(student);
  }

  // ---------------------------------------------------------------- 课程（= 班级 + 科目 + 教师的任课关系）
  //
  // 每门课都要挂一位**任课老师**：作业与成绩能不能被某位老师改动，查的就是 `Course.teacherId`。
  // 演示数据刻意让「语文」由另一位老师任教 —— 这样班主任在语文上就没有编辑权，
  // 正好覆盖需求「班主任不自动拥有所有科目作业成绩编辑权」这条规则。
  const OTHER_TEACHER_SUBJECT = '语文';
  const coursesByClass = new Map<string, { id: string; name: string }[]>();
  for (const targetClass of classes) {
    const otherTeacher = targetClass.teacherId === teacher1.id ? teacher2.id : teacher1.id;
    const created = [];
    for (const courseName of COURSE_NAMES) {
      const course = await prisma.course.create({
        data: {
          name: courseName,
          classId: targetClass.id,
          teacherId: courseName === OTHER_TEACHER_SUBJECT ? otherTeacher : targetClass.teacherId,
        },
      });
      created.push({ id: course.id, name: course.name });
    }
    coursesByClass.set(targetClass.id, created);
  }

  // ---------------------------------------------------------------- 课表
  for (const targetClass of classes) {
    const classCourses = coursesByClass.get(targetClass.id) ?? [];
    for (let dayOfWeek = 1; dayOfWeek <= 5; dayOfWeek += 1) {
      for (const [periodIndex, period] of PERIOD_TEMPLATE.entries()) {
        const course = classCourses[(dayOfWeek + periodIndex) % classCourses.length];
        if (!course) continue;
        // 前 2 节限制在第 1 周（演示按周筛选）
        const onlyFirstWeek = dayOfWeek === 1 && periodIndex === 0;
        // 周二第 3 节演示"单双周"：单周上次课表里的科目、双周上一门别的科目
        const paritySlot = dayOfWeek === 2 && periodIndex === 2;
        await prisma.schedule.create({
          data: {
            classId: targetClass.id,
            courseId: course.id,
            dayOfWeek,
            startTime: period.startTime,
            endTime: period.endTime,
            location: targetClass.room,
            weekStart: 1,
            weekEnd: onlyFirstWeek ? 1 : MAX_TERM_WEEK,
            weekParity: paritySlot ? 'ODD' : 'ALL',
          },
        });
        if (paritySlot) {
          // 双周同一节换另一门课，用于演示"单双周课表"（第 1 周单周、第 2 周双周）
          const evenCourse = classCourses[(dayOfWeek + periodIndex + 2) % classCourses.length];
          if (evenCourse) {
            await prisma.schedule.create({
              data: {
                classId: targetClass.id,
                courseId: evenCourse.id,
                dayOfWeek,
                startTime: period.startTime,
                endTime: period.endTime,
                location: targetClass.room,
                weekStart: 1,
                weekEnd: MAX_TERM_WEEK,
                weekParity: 'EVEN',
              },
            });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- 作业
  // 注：作业"截止时间"功能已下线，种子数据不再写入 dueAt（库字段保留以兼容已装库）
  const now = Date.now();
  const day = 86_400_000;
  const homeworkSeeds = [
    {
      title: '《劝学》全文背诵',
      content: '背诵《劝学》并录制音频上传到班级群，注意断句。',
      courseIndex: 0,
    },
    {
      title: '数学必修一 3.2 习题',
      content: '完成课本 P78 习题 3.2 全部题目，第 12 题选做。',
      courseIndex: 1,
    },
    {
      title: '英语周记一篇',
      content: '以"My School Life"为题写一篇 150 词左右的英语周记。',
      courseIndex: 2,
    },
    {
      title: '物理实验报告',
      content: '整理"探究匀变速直线运动"实验数据，撰写实验报告。',
      courseIndex: 3,
    },
    {
      title: '化学方程式默写',
      content: '默写第一至第三章全部化学方程式，家长签字。',
      courseIndex: 4,
    },
  ];

  const homeworks = [];
  for (const targetClass of classes) {
    const classCourses = coursesByClass.get(targetClass.id) ?? [];
    for (const seed of homeworkSeeds) {
      const course = classCourses[seed.courseIndex % classCourses.length];
      const homework = await prisma.homework.create({
        data: {
          classId: targetClass.id,
          courseId: course?.id ?? null,
          title: `${seed.title}`,
          content: seed.content,
          // 种子直接走 prisma.create，绕过了 service 里 `assignDate ?? 今天` 的兜底，
          // 不显式写就会落成 schema 默认值空串 —— 于是「按天查看 / 日期高亮」全是空的。
          assignDate: dayKeyLocal(new Date()),
          attachmentUrl:
            seed.courseIndex % 2 === 0 ? 'https://example.com/classhelper/homework-sample.pdf' : null,
          createdBy: targetClass.teacherId,
        },
      });
      homeworks.push(homework);
    }
  }

  // 部分学生已完成部分作业
  const studentsByClass = new Map<string, typeof students>();
  for (const student of students) {
    if (!student.classId) continue;
    const bucket = studentsByClass.get(student.classId) ?? [];
    bucket.push(student);
    studentsByClass.set(student.classId, bucket);
  }

  for (const homework of homeworks) {
    const classmates = studentsByClass.get(homework.classId) ?? [];
    for (const [index, student] of classmates.entries()) {
      const completed = (index + homework.title.length) % 3 !== 0;
      if (!completed && index % 2 === 1) continue;
      await prisma.homeworkStatus.create({
        data: { homeworkId: homework.id, studentId: student.id, completed },
      });
    }
  }

  // ---------------------------------------------------------------- 通知
  const notificationSeeds = [
    {
      title: '关于期中考试安排的通知',
      content: '期中考试定于下月 8 日至 10 日进行，请同学们提前复习，考试安排详见班级公告栏。',
      priority: 'HIGH',
      daysAgo: 0.2,
    },
    {
      title: '明天下午临时调课',
      content: '因教师外出教研，明天下午第 5、6 节课与周五下午对调，请相互转告。',
      priority: 'URGENT',
      daysAgo: 0.6,
    },
    {
      title: '校运动会报名开始',
      content: '本届校运动会开始报名，每人限报 2 个项目，请到体育委员处登记。',
      priority: 'NORMAL',
      daysAgo: 2,
    },
    {
      title: '教室卫生值日表更新',
      content: '新的值日表已张贴在教室后墙，请各小组按时完成值日。',
      priority: 'LOW',
      daysAgo: 4,
    },
  ];

  for (const targetClass of classes) {
    for (const seed of notificationSeeds) {
      const notification = await prisma.notification.create({
        data: {
          classId: targetClass.id,
          title: seed.title,
          content: seed.content,
          priority: seed.priority,
          createdBy: targetClass.teacherId,
          createdAt: new Date(now - seed.daysAgo * day),
        },
      });

      // 第一条通知：部分学生已读，用于演示未读红点
      if (seed.priority === 'LOW') {
        const classmates = (studentsByClass.get(targetClass.id) ?? []).slice(0, 3);
        for (const student of classmates) {
          await prisma.notificationRead.create({
            data: { notificationId: notification.id, studentId: student.id },
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- 成绩
  //
  // 三种等级口径各演示一门，方便在界面上看出差别：
  //   数学（percent）—— 按得分率自动换算 A~E
  //   语文（custom） —— 自定义等级文本
  //   英语（letter） —— A / B / C / D
  const examNames = ['第一次月考', '期中考试'];
  const customLevels = ['优', '良', '合格'] as const;
  const letterLevels = ['A', 'B', 'C', 'D'] as const;
  const levelPlan = [
    { type: 'percent' as const },
    { type: 'custom' as const },
    { type: 'letter' as const },
  ];

  for (const targetClass of classes) {
    const classCourses = coursesByClass.get(targetClass.id) ?? [];
    const classmates = studentsByClass.get(targetClass.id) ?? [];
    for (const [examIndex, examName] of examNames.entries()) {
      for (const [courseIndex, course] of classCourses.slice(0, 3).entries()) {
        const plan = levelPlan[courseIndex % levelPlan.length]!;
        for (const student of classmates) {
          const base = 60 + random() * 38;
          const score = Math.round(Math.min(100, Math.max(35, base - examIndex * 2)));
          const percent = gradePercent(score, 100);
          const level =
            plan.type === 'percent'
              ? gradeLevel(percent)
              : plan.type === 'letter'
                ? (letterLevels[Math.min(letterLevels.length - 1, Math.floor((100 - percent) / 12))] ?? 'D')
                : (customLevels[Math.min(customLevels.length - 1, Math.floor((100 - percent) / 15))] ?? '合格');
          await prisma.grade.create({
            data: {
              classId: targetClass.id,
              courseId: course.id,
              studentId: student.id,
              examName,
              score,
              totalScore: 100,
              levelType: plan.type,
              level,
              publishedAt: new Date(now - (examIndex + 1) * 6 * day),
            },
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- 调班 / 转出历史
  //
  // 调班只改 `Student.classId`（学号不变，历史作业与成绩留在原班级），并留一条可查的痕迹。
  const movedStudent = students[7]!; // 赵依然：2026级2班 → 2026级1班（曾经）
  await prisma.student.update({
    where: { id: movedStudent.id },
    data: { classId: classes[0]!.id },
  });
  await prisma.studentClassTransfer.create({
    data: {
      studentId: movedStudent.id,
      studentNo: movedStudent.studentNo,
      studentName: movedStudent.name,
      fromClassId: classes[0]!.id,
      fromClassName: classes[0]!.name,
      toClassId: classes[1]!.id,
      toClassName: classes[1]!.name,
      operatorId: admin.id,
      operatorName: admin.name,
      mode: 'batch',
      note: '军训后按分班考试成绩重新均衡',
      createdAt: new Date(now - 30 * day),
    },
  });

  // 转出：学籍离开本校（不是调班），班级归属保留作历史
  const transferredStudent = students[13]!; // 朱佳琪
  await prisma.student.update({
    where: { id: transferredStudent.id },
    data: {
      status: 'transferred',
      transferredAt: new Date(now - 12 * day),
      transferNote: '随家长工作调动转学至外地',
    },
  });
  await prisma.studentClassTransfer.create({
    data: {
      studentId: transferredStudent.id,
      studentNo: transferredStudent.studentNo,
      studentName: transferredStudent.name,
      fromClassId: transferredStudent.classId,
      fromClassName: classes[2]!.name,
      toClassId: null,
      toClassName: '转出本校',
      operatorId: admin.id,
      operatorName: admin.name,
      mode: 'transfer-out',
      note: '随家长工作调动转学至外地',
      createdAt: new Date(now - 12 * day),
    },
  });

  // ---------------------------------------------------------------- 已毕业届别（归档页的演示数据）
  //
  // 归档 = 打标记 + 只读：班级与它的作业/通知原样留在库里，只是从常规列表里隐去。
  const graduatedClass = await prisma.class.create({
    data: {
      name: formatClassName(2023, 1),
      grade: '高三',
      enrollmentYear: 2023,
      classIndex: 1,
      teacherId: teacher1.id,
      code: 'G231',
      passwordHash: classPasswordHash,
    },
  });
  const archivedYear = await prisma.archivedYear.create({
    data: {
      enrollmentYear: 2023,
      graduationYear: 2023 + 3,
      name: formatYearLabel(2023),
      note: '演示用：2023 级已于 2026 年 6 月毕业',
      operatorId: admin.id,
      operatorName: admin.name,
      archivedAt: new Date(now - 100 * day),
    },
  });
  await prisma.class.update({
    where: { id: graduatedClass.id },
    data: { archivedYearId: archivedYear.id, archivedAt: new Date(now - 100 * day) },
  });

  const graduateNames = ['毕业演示甲', '毕业演示乙', '毕业演示丙'];
  for (const [index, name] of graduateNames.entries()) {
    await prisma.student.create({
      data: {
        studentNo: `2023${String(index + 1).padStart(2, '0')}`,
        name,
        classId: graduatedClass.id,
        gender: index % 2 === 0 ? 'MALE' : 'FEMALE',
        status: 'graduated',
        archivedYearId: archivedYear.id,
        archivedAt: new Date(now - 100 * day),
      },
    });
  }
  // 这一届也要有作业与通知，「记录每个年度毕业班级的消息和作业」才有东西可看
  await prisma.homework.create({
    data: {
      classId: graduatedClass.id,
      title: '高考前最后一轮复习',
      content: '按考点清单过一遍错题本，重点看函数与数列。',
      assignDate: dayKeyLocal(new Date(now - 120 * day)),
      createdBy: teacher1.id,
    },
  });
  await prisma.notification.create({
    data: {
      classId: graduatedClass.id,
      title: '毕业典礼安排',
      content: '6 月 20 日上午 9 点在礼堂举行毕业典礼，请全体同学准时参加。',
      priority: 'HIGH',
      createdBy: teacher1.id,
      createdAt: new Date(now - 110 * day),
    },
  });

  const counts = {
    账号: await prisma.user.count(),
    在读班级: await prisma.class.count({ where: { archivedYearId: null } }),
    学生: await prisma.student.count({ where: { status: 'active' } }),
    课程: await prisma.course.count(),
    课表: await prisma.schedule.count(),
    作业: await prisma.homework.count(),
    通知: await prisma.notification.count(),
    成绩: await prisma.grade.count(),
    调班历史: await prisma.studentClassTransfer.count(),
    归档届别: await prisma.archivedYear.count(),
  };

  logger.info('种子数据写入完成', counts);

  console.log('\n================ 演示账号 ================');
  console.log(`管理员    admin       / admin123      (${admin.name} · 可执行毕业归档与调班)`);
  console.log(`教师      teacher1    / teacher123    (${teacher1.name} · ${classes[0]!.name} 班主任，教数学)`);
  console.log(`教师      teacher2    / teacher123    (${teacher2.name} · ${classes[1]!.name} 班主任，教 ${classes[0]!.name} 语文)`);
  console.log('ClassHelper 班级端（班级码）：G101 / G102 / G203，密码 123456');
  console.log('（学生只有名单、没有账号：成绩/未交/叫人按学号记录）');
  console.log(`已在读班级：${classes.map((item) => item.name).join(' / ')}`);
  console.log(`已归档届别：${formatYearLabel(2023)}（${graduatedClass.name}，${graduateNames.length} 名毕业生）`);
  console.log('==========================================\n');
}

main()
  .catch((error) => {
    logger.error('种子数据写入失败', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
