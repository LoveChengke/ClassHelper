-- ClassHelper 班级端成绩查询开关（按班级存，默认开启）
--
-- 需求：「ClassHelper 班级端可按学号查询本班学生成绩明细；是否允许学生通过班级端查看本人明细，
-- 由教师或管理员开关控制」。
--
-- 默认 true 是刻意的：教室机器装好就能查（开箱可用），要收紧的班级由班主任/管理员关掉即可。
-- 关闭后班级端调 `GET /api/grades/student/:studentNo` 一律 403，教师端不受影响。
ALTER TABLE "Class" ADD COLUMN "studentGradeQueryEnabled" BOOLEAN NOT NULL DEFAULT true;
