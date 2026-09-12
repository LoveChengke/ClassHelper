/**
 * 种子数据：pnpm db:seed
 *
 * 会清空业务表后重建一套完整演示数据：
 *   1 管理员 / 2 教师 / 3 个班级 / 15 名学生 / 课程 / 课表 / 作业 / 通知 / 成绩
 *
 * 演示账号（密码见文件末尾打印结果）：
 *   admin / admin123        - 系统管理员
 *   teacher1 / teacher123   - 张老师（高一(1)班、高二(3)班班主任）
 *   teacher2 / teacher123   - 李老师（高一(2)班班主任，高二(3)班协作教师）
 *   student01..student15 / student123
 */
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

const COURSE_NAMES = ['语文', '数学', '英语', '物理', '化学'];

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
  await prisma.enrollment.deleteMany();
  await prisma.classTeacher.deleteMany();
  await prisma.user.updateMany({ data: { classId: null } });
  await prisma.user.deleteMany();
  await prisma.class.deleteMany();
}

async function main(): Promise<void> {
  logger.info('开始写入种子数据...');

  if (process.env.NODE_ENV === 'production') {
    throw new Error('拒绝在生产环境执行 seed（NODE_ENV=production）');
  }

  await resetDatabase();

  const random = createRandom(20260901);

  // 同一角色共用密码，只需各哈希一次
  const [adminHash, teacherHash, studentHash, classPasswordHash] = await Promise.all([
    hashPassword('admin123'),
    hashPassword('teacher123'),
    hashPassword('student123'),
    // 班级账号默认密码（学生端「班级登录」）
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

  // 班级账号：班级码（学生端「班级登录」的账号）+ 班级密码（默认 123456，可在班级管理里重置）
  const classSeeds = [
    { name: '高一(1)班', grade: '高一', teacherId: teacher1.id, code: 'G101' },
    { name: '高一(2)班', grade: '高一', teacherId: teacher2.id, code: 'G102' },
    { name: '高二(3)班', grade: '高二', teacherId: teacher1.id, code: 'G203' },
  ];

  const classes = [];
  for (const [index, seed] of classSeeds.entries()) {
    const created = await prisma.class.create({
      data: {
        name: seed.name,
        grade: seed.grade,
        teacherId: seed.teacherId,
        code: seed.code,
        passwordHash: classPasswordHash,
      },
    });
    classes.push({ ...created, room: CLASS_ROOMS[index] ?? '教学楼 A101' });
  }

  // 高二(3)班：李老师作为协作教师
  await prisma.classTeacher.create({
    data: { classId: classes[2]!.id, teacherId: teacher2.id },
  });

  // ---------------------------------------------------------------- 学生
  const students = [];
  for (let index = 0; index < STUDENT_NAMES.length; index += 1) {
    const classIndex = Math.floor(index / 5);
    const targetClass = classes[classIndex] ?? classes[0]!;
    const student = await prisma.user.create({
      data: {
        username: `student${String(index + 1).padStart(2, '0')}`,
        name: STUDENT_NAMES[index] ?? `学生${index + 1}`,
        role: 'STUDENT',
        classId: targetClass.id,
        passwordHash: studentHash,
      },
    });
    students.push(student);
    await prisma.enrollment.create({ data: { userId: student.id, classId: targetClass.id } });
  }

  // ---------------------------------------------------------------- 课程
  const coursesByClass = new Map<string, { id: string; name: string }[]>();
  for (const targetClass of classes) {
    const created = [];
    for (const courseName of COURSE_NAMES) {
      const course = await prisma.course.create({
        data: { name: courseName, classId: targetClass.id, teacherId: targetClass.teacherId },
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
          },
        });
      }
    }
  }

  // ---------------------------------------------------------------- 作业
  const now = Date.now();
  const day = 86_400_000;
  const homeworkSeeds = [
    {
      title: '《劝学》全文背诵',
      content: '背诵《劝学》并录制音频上传到班级群，注意断句。',
      dueInDays: 3,
      courseIndex: 0,
    },
    {
      title: '数学必修一 3.2 习题',
      content: '完成课本 P78 习题 3.2 全部题目，第 12 题选做。',
      dueInDays: 1,
      courseIndex: 1,
    },
    {
      title: '英语周记一篇',
      content: '以"My School Life"为题写一篇 150 词左右的英语周记。',
      dueInDays: 5,
      courseIndex: 2,
    },
    {
      title: '物理实验报告',
      content: '整理"探究匀变速直线运动"实验数据，撰写实验报告。',
      dueInDays: -2,
      courseIndex: 3,
    },
    {
      title: '化学方程式默写',
      content: '默写第一至第三章全部化学方程式，家长签字。',
      dueInDays: -1,
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
          attachmentUrl:
            seed.courseIndex % 2 === 0 ? 'https://example.com/classhelper/homework-sample.pdf' : null,
          dueAt: new Date(now + seed.dueInDays * day),
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
        data: { homeworkId: homework.id, userId: student.id, completed },
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
            data: { notificationId: notification.id, userId: student.id },
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- 成绩
  const examNames = ['第一次月考', '期中考试'];
  for (const targetClass of classes) {
    const classCourses = coursesByClass.get(targetClass.id) ?? [];
    const classmates = studentsByClass.get(targetClass.id) ?? [];
    for (const [examIndex, examName] of examNames.entries()) {
      for (const course of classCourses.slice(0, 3)) {
        for (const student of classmates) {
          const base = 60 + random() * 38;
          const score = Math.round(Math.min(100, Math.max(35, base - examIndex * 2)));
          await prisma.grade.create({
            data: {
              classId: targetClass.id,
              courseId: course.id,
              userId: student.id,
              examName,
              score,
              totalScore: 100,
              publishedAt: new Date(now - (examIndex + 1) * 6 * day),
            },
          });
        }
      }
    }
  }

  const counts = {
    用户: await prisma.user.count(),
    班级: await prisma.class.count(),
    课程: await prisma.course.count(),
    课表: await prisma.schedule.count(),
    作业: await prisma.homework.count(),
    通知: await prisma.notification.count(),
    成绩: await prisma.grade.count(),
  };

  logger.info('种子数据写入完成', counts);

  console.log('\n================ 演示账号 ================');
  console.log(`管理员    admin       / admin123      (${admin.name})`);
  console.log(`教师      teacher1    / teacher123    (${teacher1.name} · 高一(1)班、高二(3)班)`);
  console.log(`教师      teacher2    / teacher123    (${teacher2.name} · 高一(2)班、高二(3)班协作)`);
  console.log('学生      student01   / student123    (高一(1)班)');
  console.log('学生      student06   / student123    (高一(2)班)');
  console.log('学生      student11   / student123    (高二(3)班)');
  console.log('学生      student15   / student123    (高二(3)班)');
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
