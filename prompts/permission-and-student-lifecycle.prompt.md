# ClassHelper 权限组治理与学生年度生命周期重构提示词

> 用法：在仓库根目录（含 `AGENTS.md`）把本文件整体交给编码代理。
> 这不是“加几个按钮”的任务，而是把**权限键、数据范围、写入口、年度升级**收敛成单一路径。
> 如果当前会话支持计划确认，先输出差距清单与分阶段计划；确认后逐阶段实现。若为自动执行模式，按阶段直接实现，但每阶段结束必须停下来汇报实际验证输出。

## 0. 你的角色与工作方式

你是本仓库的高级全栈工程师，熟悉 TypeScript、Express、Prisma、Vue 3、Element Plus 与 pnpm monorepo。

开始前必须按顺序阅读：

1. `AGENTS.md`（最高优先级工程约束）
2. `docs/dev/permissions.md`、`docs/app/classes.md`、`docs/dev/api.md`、`docs/dev/implementation.md`、`docs/dev/data-model.md`、`docs/dev/testing.md`
3. 本提示词第 2 节列出的源码文件与符号

工作规则：

- 先只读调研，不要先改代码；先给出“已核实差距 + 实施方案 + 风险 + 测试计划”。
- 分阶段提交；每阶段结束运行对应验证命令，汇报**本次实际输出**，不要引用历史报告数字。
- 不要留下 `TODO`、空实现、只改前端不改服务端、只改服务端不改 UI 的半截功能。
- 发现本文与代码冲突时，以代码和 `AGENTS.md` 为准，并在汇报中列出冲突点与你的处理方式。
- 代码注释、文档、界面文案、提交描述一律中文；提交使用中文 Conventional Commits。
- 只格式化本次改动文件，不要全仓库跑 Prettier；换行用 LF。

## 1. 硬约束（不可违反）

- 单一 `packages/server/prisma/schema.prisma`；保持 SQLite/MySQL 通用，不加 Prisma `enum`、不加 `@db.*`。
- 模型变动必须同步迁移、`lib/snapshot.ts` 的 `SNAPSHOT_TABLES` 与旧库兼容逻辑；不能修改已应用的历史迁移。
- 权限每次请求实时计算，改动立即生效；前端隐藏不是鉴权，服务端必须独立校验。
- 班级端会话（`CLASS_DEVICE`）权限集合为空，但既有能力必须保留：本班名单/课表/通知/叫人可读，作业可代录，成绩不可写，个人成绩查询受班级开关控制。
- 不破坏离线客户端、preload 白名单、CSP、设备心跳与现有 API 兼容；改路由守卫后必须检查桌面客户端调用链。
- 不修改版本号、不发布、不动 `releases/`、不对真实业务库执行 `db:seed`/`db:reset`、不向真实班级发测试消息。
- 验收使用隔离临时库；测试失败先定位，不要为了通过而放宽断言。

## 2. 已核实现状（按这些事实设计，不要重新猜测）

### 2.1 权限组

- **P1 权限键有目录、无入口。** `class:read`、`schedule:read`、`homework:read`、`notification:read` 在 `shared/src/permissions.ts` 中定义，但服务端没有任何路由使用它们；`GET /classes`、`GET /schedules`、`GET /homeworks`、`GET /notifications` 只做登录与班级范围断言。结果是：从权限组取消这些键，用户仍然能读。
- **P2 写入口也有缺口。** `POST /homeworks` 没有 `homework:write` 守卫；`GET /classes/:id`、`GET /classes/:id/students` 没有功能键守卫；`POST /notifications` 使用 `requirePermission` 而不是 `requireStaffPermission`，班级端会被空权限集合挡住，与 `canPublishNotification` 允许 `CLASS_DEVICE` 的规则不一致。
- **P3 键与业务断言错位。** `POST /students/transfer`、`POST /students/transfer-out` 路由要求 `class:manage`，服务层又硬编码 `isAdmin`；持有 `roster:manage` 的班主任不能调班，持有 `class:manage` 的教师仍被 `assertCanManageClasses` 拒绝。`POST /classes/promote` 同样只认 `class:manage` + ADMIN。归档模块更明显：路由要求 `archive:manage`，但 `archives.service` 与 `transferred.service` 的每个入口都调用 `assertCanManageClasses`（只认 ADMIN），非管理员即使被授予 `archive:manage` 也无法使用。
- **P4 升级权限过宽。** `/term/promotion` 的读取、配置、执行全部要求 `system:manage`。要授权教务主任执行升级，只能把系统设置权限一并给出。
- **P5 页面仍按角色门控。** `web-admin/src/router/index.ts` 中 `students`、`classes`、`archives`、`term-weeks` 的 `meta.roles` 固定为 `['ADMIN']`；权限组即使授予 `roster:manage`/`class:read`/`archive:manage`/`term:read`，页面也进不去。
- **P6 分配可越权。** `assignUserGroups` 只校验组存在，不校验 `defaultRole` 与目标账号角色；把 ADMIN 默认组分配给 TEACHER 会让其获得全部键。拥有 `permission:manage` 的教师也可以新建含 `system:manage`/`database:manage` 的组并分配给自己。
- **P7 范围是自由文本。** `scopeValue` 直接按逗号拆分；`GRADE` 与 `DIVISION` 实现完全相同；空值、未知年级、全角逗号都没有统一校验；`SELF_CLASS` 的 `HEAD` 语义只存在于代码分支，UI 没有解释。
- **P8 导入键不生效。** `import:students` 挂在路由上，但 `imports.module.ts` 的 `assertImportKindAllowed` 仍用 `role !== 'ADMIN'` 拒绝教师。
- **P9 成员列表 N+1 且字段失效。** `listMembers` 对每个账号调用一次 `loadEffectivePermissions`；`PermissionMemberDto.fixed` 永远为 false，前端“管理员固定”提示不会出现。
- **P10 无审计、无差异预览。** 权限组变更只写 `logger.info`，没有操作人、前后差异或受影响成员；编辑组/分配组时看不到生效权限变化。
- **P11 默认组语义与文案相反。** 页面说“给老师额外开通某项能力”，但一旦分配任何组，就不再使用角色默认组（并集只含所分配组），可能反而收掉教师默认权限。必须显式提示并预览，不能靠用户猜。

### 2.2 学生年度流程

- **S1 PATCH 绕过生命周期。** `PATCH /students/:id` 接受 `classId` 和 `status`；可直接把学生改成 `transferred`/`graduated`，不写 `transferredAt`、不写历史、不挂归档；换班也不会广播班级更新。
- **S2 调班不是原子操作。** `transferStudents` 先事务改 `Student.classId`，事务外再写 `StudentClassTransfer`；历史写入失败会留下“人已调走、无记录”。`recordTransfer` 按 `createdAt desc` 取最近 N 条，没有批次标识，存在取错/漏取风险。
- **S3 转出接受毕业生。** `transferOutStudents` 只排除已是 `transferred` 的记录；`graduated`/已归档学生也会被改成 `transferred`，覆盖毕业事实。没有结构化的转入学校/去向字段。
- **S4 转出历史查不到。** `listTransfers` 的 where 带 `student: activeStudentWhere()`，而 `activeStudentWhere` 排除 `transferred`；因此转出记录在班级/学生历史里不可见，`GET /students/:id/transfers` 对转出学生返回空。
- **S5 状态筛选是坏的。** `listStudents` 始终 AND `activeStudentWhere()`；`status=transferred` 永远返回空，但 UI 提供了“已转出/已毕业”筛选项。
- **S6 可复活毕业生。** `isActiveStudent` 只排除 `transferred/inactive`，不排除 `graduated`；`addStudent` 对已毕业学生会走“已存在”分支，把 `status` 改回 `active`，但保留 `archivedYearId`，造成隐藏的不一致记录。该分支也不是事务。
- **S7 删除是硬删。** `deleteStudent` 级联删除成绩、作业状态、已读和调班历史；对毕业/转出学生没有保护。
- **S8 升级归档漏人。** `runPromotion` 只对 `status: active` 的学生写 `archivedYearId`；转出/停用学生不挂届别，归档详情的“转出学生”为空，`ArchivedYear.transferredCount` 也不会写。
- **S9 升级清空周次。** `runPromotion` 直接 `termWeek.deleteMany()`，并把 `term.startDate` 固定写成 `${year}-09-01`；忽略配置日期，清掉班级自定义周次。
- **S10 年级硬编码。** 升级只认 `高一/高二/高三`；`PATCH /classes/:id` 可把年级改成任意字符串，`POST /classes/promote` 也接受任意目标年级，能绕过“只升一级”。
- **S11 新班码冲突后置。** 新高一按 `enrollmentYear+classIndex` 判重，但 `Class.code` 全局唯一；冲突要到事务里才失败，没有预检。
- **S12 升级不可预览。** `dryRun` 只返回班级数/学生数；没有逐班、逐状态明细、阻断项、计划哈希。`PromotionRun` 没有操作人、明细、快照摘要。
- **S13 升级年份任意。** `POST /term/promotion/run` 接受 2000–2100 的任意 `year`，可手动升级未来学年并生成假档案；没有“只能补跑应执行学年”的限制。
- **S14 死代码。** `archives.service.createArchive` 仍存在，但没有路由；文档明确“不提供创建归档代替年度升级的入口”。保留会让人误以为有第二条毕业路径。
- **S15 撤回转出限制过死。** `restoreTransferred` 只允许原班仍在读；原班已归档时无法把学生恢复到其他班，也没有审计记录。

## 3. 目标与非目标

### 3.1 目标

权限组：

1. 每个权限键至少有一个真实服务端入口；每个受控入口至少有一个权限键。
2. 数据范围可配置、可校验、可展示；不再用自由文本猜年级。
3. 防止权限管理员自我提权、跨角色分配默认组、越范围授权。
4. 权限变更可审计、可预览影响；成员列表不再 N+1。
5. Web 菜单/页面/按钮按生效权限门控，而不是继续写死 ADMIN。

学生年度流程：

1. 学生状态、班级变更、转出、转入、毕业、升级只有一条受控路径。
2. 所有写操作在事务内完成，并写可追溯的历史（操作人、批次、学年、原/新班级与年级）。
3. 在读/归档/转出查询语义一致；转出历史必须查得到。
4. 年度升级支持可配置学段、逐班预览、阻断项、幂等执行、快照与执行记录。
5. 升级不丢学生、不清空未确认的数据；毕业归档包含转出/停用学生。

### 3.2 非目标

- 不引入学生个人账号、SSO、多租户、多学校隔离。
- 不重做成绩/作业/课表业务，只改权限入口与学年流程的边界。
- 不做“一键回滚整个学年升级”；回滚依赖执行前快照与手工恢复，UI 必须写清楚。
- 不升版本、不发版、不改 `releases/`。
- 不为了兼容旧前端而保留两套权限事实源；DTO 兼容字段可以由新字段派生。

## 4. 必须实现的设计

### 4.1 权限键矩阵（单一事实源）

以 `shared/src/permissions.ts` 为准扩展现有目录；不要新建第二份键表。

| 能力/入口                                      | 权限键                                                                | 守卫方式                                                     | 范围与备注                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 班级列表/详情读取                              | `class:read`                                                          | `requireStaffPermission`                                     | 班级端仍看自己绑定的班；教师按 scope                                     |
| 班级创建/修改/删除、班级账号、班主任/任课分配  | `class:manage`                                                        | `requirePermission` + 服务层 `assertPermission` + 目标班范围 | 创建/删除建议要求 scope=ALL；修改要求目标班在 scope 内                   |
| 学生名单读取、班级名单读取                     | `roster:read`                                                         | `requireStaffPermission`                                     | 班级端本班；教师按 scope                                                 |
| 学生新建/资料修改/导入/调班/转出/转入/撤回转出 | `roster:manage`                                                       | `requirePermission` + 服务层断言                             | 跨班操作要求 scope=ALL 或同时覆盖源班与目标班；ADMIN 不受范围限制        |
| 教师读取/维护                                  | `teacher:read` / `teacher:manage`                                     | 现有守卫                                                     | 导入教师仍要求 `teacher:manage` + `import:teachers`                      |
| 课表读取/编辑                                  | `schedule:read` / `schedule:write`                                    | `requireStaffPermission` / `requirePermission`               | 班级端读本班；写仍要求班主任/管理员                                      |
| 全校时间表                                     | `timetable:manage`                                                    | 现有守卫                                                     | 不变                                                                     |
| 作业读取/写入                                  | `homework:read` / `homework:write`                                    | `requireStaffPermission`                                     | 班级端可代录作业；写仍按科目收口                                         |
| 通知读取/发布/删除                             | `notification:read` / `notification:publish` / `notification:delete`  | `requireStaffPermission` / `requirePermission`               | 班级端可发布；删除仍只给有键者                                           |
| 成绩读取/写入/导入/个人明细                    | `grade:read` / `grade:write` / `grade:import` / `student:grade-query` | 现有守卫                                                     | 班级端只读聚合；明细受班级开关                                           |
| 学期周次读取/修改                              | `term:read` / `term:write`                                            | 现有守卫                                                     | 修改仅授权者                                                             |
| 学年升级读取/配置/预览/执行/手动升级           | **新增 `promotion:manage`**                                           | `requirePermission('promotion:manage')`                      | 默认仅 ADMIN；替代 `system:manage`；范围按 `archive:manage` 同等敏感处理 |
| 毕业归档读取/撤销                              | `archive:manage`                                                      | `requirePermission` + 服务层 `assertPermission`              | 不做手动创建归档；撤回转出改由 `roster:manage` 控制                      |
| 学生/教师/课表/任课导入                        | `import:*`                                                            | 路由 + 服务层                                                | 必须真正按键判断，不能再用 `role !== 'ADMIN'` 代替                       |
| 客户端/远控/更新                               | `client:*` / `remote:control`                                         | 现有守卫                                                     | 不变                                                                     |
| 系统/数据库/权限                               | `system:manage` / `database:manage` / `permission:manage`             | 现有守卫                                                     | 不变                                                                     |

强制规则：

1. **新增键必须同步**：`PERMISSION_KEYS`、`PERMISSION_LABELS`、`PERMISSION_CATEGORIES`、`PERMISSION_DEFAULT_ROLES`、`ROLE_DEFAULT_PERMISSIONS`（派生即可）、必要的 `PERMISSION_MATRIX`。
2. **旧库迁移**：`ensureDefaultGroups()` 的 `update: {}` 不会给旧库默认组补新键；`promotion:manage` 必须通过迁移插入已有的 ADMIN 默认组（用 `INSERT ... SELECT ... WHERE defaultRole='ADMIN'`，旧库尚未创建默认组时允许 0 行）。新库由 `ROLE_DEFAULT_PERMISSIONS.ADMIN` 自然包含；随后 `ensureDefaultGroups()` 新建的 ADMIN 默认组也会包含该键。
3. **删除装饰键**：如果某个键最终找不到任何真实入口，就删除它并更新迁移/文档，不要保留“看起来能用”的键。
4. **班级端兼容**：凡是班级端会调的读/写路由，用 `requireStaffPermission` 或显式 `isClassDevice` 分支；不要因为加了 `requirePermission` 把班级端挡死。改完必须跑桌面客户端相关验收。
5. **页面门控**：`students` 用 `permission: 'roster:read'`，`classes` 用 `class:read`，`archives` 用 `archive:manage`，`term-weeks` 用 `term:read`；写按钮再用 `auth.can('...:manage')` 隐藏。路由守卫与服务端都要检查，前端隐藏不能代替鉴权。

### 4.2 服务端断言分层

统一为三层，顺序不能反：

1. **路由层**：`requirePermission`（员工必须持有键，班级端必被挡）、`requireStaffPermission`（班级端放行，员工查键）、`requireAnyPermission`（读或写任一即可）。
2. **服务层权限断言**：`assertPermission(user, key)` / `assertAnyPermission(user, keys)`；不要在 service 里继续写 `user.role === 'ADMIN'` 来代替已有键。
3. **业务关系断言**：`assertClassAccess`、`assertCanManageRoster`、`assertCanManageSubjectContent`、班主任/任课关系、班级端开关；这些不能被权限组替代。

建议新增/整理：

- `lib/permissions.ts`：`assertPermission`、`assertAnyPermission`、`hasEffectivePermission`。
- `lib/access.ts`：`assertClassInScope(user, classId, key)`、`assertClassesInScope`；把 `assertCanManageClasses`、`assertCanManageRoster` 改为“键 + 关系 + 范围”，而不是只认 ADMIN。
- 避免重复查询：路由中间件已经算过 `req.auth.permissions`；能传上下文就传，不能传时至少不要在同一请求里重复查两次权限组。
- **班级端例外**：`assertPermission` 只适用于员工；班级端可用的路径用 `assertStaffPermission` 或显式 `isClassDevice` 分支，不能把班级端的空权限集合当成“没有权限”而误伤作业代录、通知/叫人等既有能力。

### 4.3 数据范围模型

在 shared 中保留 `PermissionScope = 'SELF_CLASS' | 'GRADE' | 'DIVISION' | 'ALL'`，增加统一解析与展示：

- `SELF_CLASS`：`scopeValue` 只允许 `''`（班主任或任课班）或 `'HEAD'`（仅班主任班）；其他值拒绝。
- `GRADE`：只允许一个年级；`DIVISION`：允许逗号分隔的年级集合；统一全角逗号/顿号/空白，去重排序。
- `ALL`：忽略 `scopeValue`，服务端强制存空串。
- `GRADE`/`DIVISION` 的空值、未知年级一律 400；未知年级的判定基准是数据库中 `Class.grade` 的 distinct 值加上升级计划里的年级。
- 新增 `GET /permissions/scopes`：返回可选年级、部范围建议、当前计划年级；权限页用选择器，不再让用户手填。
- `teacherScopeWhere` 必须走同一个解析器；不要在各处 `split(',')`。
- DTO 增加 `scopeLabel`（中文展示），避免前端各自拼。

### 4.4 防提权与审计

必须实现：

1. **默认组只能给同角色**：`PermissionGroup.defaultRole` 非空的组，只能分配给相同 `User.role` 的账号；ADMIN 默认组不能分配给 TEACHER。显式分配教师默认组给教师是允许的（用于“保留默认 + 追加权限”）。
2. **不能授予自己没有的键**：非 ADMIN 的 `permission:manage` 账号，创建/修改组时提交的键集合必须是其生效权限的子集；修改已有组时，组内现有键也必须是其子集；否则 403。
3. **不能分配超出自己的组**：非 ADMIN 只能把“组内所有键都在自己权限内”的组分配给别人；不能给自己分配会新增权限的组。
4. **范围提权**：非 ADMIN 不得创建/修改/分配 `scope=ALL`；`GRADE`/`DIVISION` 组只允许 ADMIN，或范围覆盖目标年级的账号（最简实现：仅 ADMIN 可管理非 `SELF_CLASS` 组）。
5. **默认组编辑**：ADMIN 默认组、TEACHER 默认组影响所有未分组账号，只有 ADMIN 可改；非 ADMIN 的权限管理员只能改自定义组。
6. **内置组**：仍不可删除；改名/改键按上述规则。
7. **审计**：新增 `PermissionAudit` 表（`id`、`actorId`、`actorName`、`action`、`targetType`、`targetId`、`beforeJson`、`afterJson`、`createdAt`），记录组的增删改、成员分配、默认组修改。同步 migration 与 `SNAPSHOT_TABLES`。提供分页读取接口（`permission:manage`）和权限页“变更记录”Tab。
8. **成员列表**：`listMembers` 一次预取所有组 + 默认组，内存计算每个账号的生效键；`PermissionMemberDto` 增加 `permissions: PermissionKey[]` 与 `scopeLabels`，`fixed` 要么删除，要么只对真正不可分配的账号为 true；不要保留永远 false 的字段。
9. **组详情**：新增 `GET /permissions/groups/:id/members` 或在组列表 DTO 带成员摘要；权限页可展开查看成员，不再只有数量。
10. **保存前预览**：前端在编辑组/分配组时展示“将影响 N 名成员、新增/移除哪些键”；默认组分配时提示“已选组会替代角色默认模板，如需保留请同时选择教师默认组”。

### 4.5 学生状态机

只允许以下状态与迁移；`archivedYearId` 是与状态正交的归档标记，不是第五种状态。

| 当前状态      | 允许动作                              | 结果                                                                           |
| ------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `active`      | 调班、转出、停用、随年度升级毕业/归档 | 调班改 `classId`；转出→`transferred`；停用→`inactive`；毕业→`graduated` + 归档 |
| `inactive`    | 复学、转出、随年度升级归档            | 复学→`active`；转出→`transferred`；归档保持 `inactive`                         |
| `transferred` | 撤回转出（原班或指定在读班）          | 回到 `active`；保留原转出历史                                                  |
| `graduated`   | 仅撤销归档（ADMIN）                   | 回到 `active`；不通过名单编辑直接改                                            |

禁止：

- `PATCH /students/:id` 直接改 `status` 为 `transferred`/`graduated`。
- 把 `graduated`/已归档学生加入班级或“复活”。
- 对 `transferred`/`graduated` 再次办理转出。
- 删除仍有成绩、作业、已读或历史的学生。

### 4.6 写入口与 API

| 接口                                                                       | 权限                        | 行为                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /students`                                                           | `roster:manage`             | 只允许创建 `active`/`inactive`；学号重复 409，不复活历史学生                                                                                   |
| `PATCH /students/:id`                                                      | `roster:manage`             | 只改姓名、性别、家长手机号、学号（学号变更需唯一）；**移除 `classId`/`status`**，收到就 400 并提示使用专用接口                                 |
| `POST /students/transfer`                                                  | `roster:manage`             | 批量调班；事务内改班 + 写历史；目标班必须未归档；默认只允许同年级，跨年级需 ADMIN + `allowGradeChange` + 备注                                  |
| `POST /students/transfer-out`                                              | `roster:manage`             | 只允许 `active`/`inactive`；写 `transferredAt`、`transferNote`、可选取向学校；保留 `classId` 作历史；写 `kind=transfer-out`                    |
| `POST /students/transfer-in`                                               | `roster:manage`             | 新建或把 `transferred` 学生重新入校；必须指定在读班；记录来源学校；写 `kind=transfer-in`                                                       |
| `POST /students/:id/restore`（或保留 `/archives/transferred/:id/restore`） | `roster:manage`             | 撤回转出；可指定目标在读班；原班已归档时允许转到其他班；写 `kind=restore`；保留旧路径时同步改键，归档页按钮按 `auth.can('roster:manage')` 显示 |
| `DELETE /students/:id`                                                     | `roster:manage`             | 默认软停用；仅当无成绩/作业/已读/历史且状态允许时才硬删；硬删需 ADMIN 二次确认                                                                 |
| `GET /students/transfers`                                                  | `roster:read`               | 不再按学生状态过滤；按批次/学生/班级/学年分页；转出记录必须可见                                                                                |
| `GET /students/:id/transfers`                                              | `roster:read` + 班级范围    | 只读权限也能查历史；不再要求 `roster:manage`                                                                                                   |
| `POST /classes/:id/students`                                               | `roster:manage`             | 已存在的在读学生走调班生命周期；`transferred` 需显式转入；`graduated`/归档一律 409                                                             |
| `DELETE /classes/:id/students/:studentId`                                  | `roster:manage`             | 走“移出班级”生命周期，写历史 + 广播，不直接清空                                                                                                |
| `GET /classes/:id/students`                                                | `roster:read`（班级端放行） | 只返回在读；归档/转出走归档页                                                                                                                  |

实现要求：

- 所有“学生 + 历史”写入在**同一个事务**内；失败一起回滚。
- 每次批量操作生成 `batchId`（UUID），同批次记录可一起查询/撤销说明。
- 写操作提交后再广播 `classUpdated`，旧班与新班都通知。
- 调班/转出/转入/复学/移出统一收进 `lib/student-lifecycle.ts`，`students.service` 与 `classes.service` 不再各写一套。
- 错误文案必须可操作，例如“该生已毕业，请先在归档页撤销归档”“目标班级已归档，不能调入”。

### 4.7 历史模型

把 `StudentClassTransfer` 从“调班历史”升级为“学生生命周期历史”：

- 新增 `kind String @default("class-change")`：`class-change` / `transfer-in` / `transfer-out` / `restore` / `unassign`。
- 新增 `batchId String @default("")`，加索引。
- 新增 `academicYear Int?`：写入时按升级计划/当前学年计算，历史配置变化不影响旧记录。
- 新增 `fromGrade String @default("")`、`toGrade String @default("")`、`fromSchool String @default("")`、`toSchool String @default("")`。
- 旧 `mode` 字段迁移为 `kind`（`single`/`batch` → `class-change`，`transfer-out` → `transfer-out`，`restore-transfer` → `restore`），不要长期双写两个事实源；DTO 保留 `mode` 兼容字段时由 `kind` 派生，并标注 deprecated。
- `ArchivedYear` 增加 `inactiveCount Int @default(0)`；`PromotionRun` 增加 `operatorId`、`operatorName`、`detailsJson`、`snapshotSha256`、`error`（`message` 保留）。
- 新表/新字段同步 `SNAPSHOT_TABLES`；迁移为旧行补默认值，不重写历史语义。

### 4.8 年度升级计划

不要把 `高一/高二/高三` 写死在服务里。使用“轨道 + 有序学段”：

```json
{
  "tracks": [
    {
      "id": "high",
      "name": "高中",
      "entryClassCount": 6,
      "stages": [{ "grade": "高一" }, { "grade": "高二" }, { "grade": "高三", "terminal": true }]
    }
  ],
  "termStartDate": null,
  "resetTermWeeks": true
}
```

- 默认只配置高中一条轨道，保持现有行为；结构支持初中/小学/完全中学多条轨道。
- 每个年级只能出现在一条轨道；同一轨道内顺序即升级顺序；最后一个学段必须 `terminal: true`。
- `entryClassCount` 是每条轨道起始年级每年新建班数；0 表示不新建。
- 计划存 `AppSetting` 的 `term.promotionPlan`（JSON 文本），执行时间仍用 `term.promotionAt`；`promotionStatus` 兼容旧 `{month,day,hour,classCount}` 并归一化为新计划。
- 旧配置没有计划时，默认生成高中轨道，`entryClassCount` 取旧 `classCount`。

升级接口：

| 接口                           | 行为                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `GET /term/promotion`          | 返回计划、执行时间、应执行学年、是否待执行、最近执行记录、旧字段兼容                                      |
| `PUT /term/promotion`          | 保存执行时间与计划；校验轨道/年级/班数/日期；旧扁平格式继续接受                                           |
| `POST /term/promotion/preview` | 只读预览：逐轨道、逐班、逐状态计数；阻断项；将新建班级；将删除的 `TermWeek` 行数；计划哈希                |
| `POST /term/promotion/run`     | 必须带 `year`、`planHash`、`confirm: true`；只允许当前应执行学年或 ADMIN 明确补跑过去学年；不允许未来学年 |
| `POST /classes/promote`        | 目标年级由计划推导，不再接受自由文本；terminal 班拒绝并提示走年度升级                                     |

预览必须包含：

- 每条轨道：将升级的班、将归档的班、将新建的班（含生成班级码）、学生 `active/inactive/transferred` 计数。
- 阻断项（有任意一项就拒绝执行，返回 409 + 结构化 `details`）：
  - 在读班级的 `grade` 不在计划内；
  - `enrollmentYear` 缺失或同一届已存在 `ArchivedYear`；
  - 新班班级码冲突且无法生成唯一码；
  - 同一轨道同一届出现重复 `classIndex`；
  - 计划哈希不匹配或配置在校验后被修改。
- 警告项：无班主任/无任课的新班、`TermWeek` 将被清空、`resetTermWeeks=false` 时旧周次会继续覆盖新学年。

执行顺序（单事务，快照成功后才开始）：

1. 计算并校验计划与预览；写入/更新 `PromotionRun(status='running')`。
2. terminal 学段：按 `enrollmentYear` 分组创建/校验 `ArchivedYear`；班级写 `archivedYearId/archivedAt`；**所有学生**按状态处理并写 `archivedYearId/archivedAt`：`active → graduated`，`transferred` 保持，`inactive` 保持。统计 `studentCount/transferredCount/inactiveCount/classCount/homeworkCount/notificationCount`。
3. 非 terminal 学段：只改 `grade` 为下一学段；清空 `Class.termStartDate`；保留班级/学生/作业/成绩。
4. 每条轨道起始年级：按 `entryClassCount` 新建骨架班；`enrollmentYear=year`、`classIndex=1..N`、`grade=起始年级`、`teacherId=null`、无课程；班级码必须唯一；`termWeeks` 取默认值并受全校上限约束。
5. 学期：`term.startDate` 设为计划日期（默认 `${year}-09-01`）或计划中的 `termStartDate`；`resetTermWeeks=true` 时删除 `TermWeek`（预览已明确行数），否则保留并警告；新班 `termStartDate=null`。
6. `PromotionRun(status='done')` 写操作人、明细 JSON、快照 SHA256；提交后广播课表/班级更新。

幂等与并发：

- `PromotionRun.year` 唯一；已 `done` 直接返回既有记录并标记 `alreadyDone`。
- 并发执行只允许一个事务提交；另一个返回既有结果或 409。
- 失败保留 `failed` 记录、快照路径与错误；允许修复后重试，重试前删除同年的 `failed/running` 记录。
- 快照路径与 SHA256 必须在执行记录和 UI 中可见；不要自动删除升级快照。

毕业/归档：

- 毕业只由年度升级产生，不恢复手动 `POST /archives` 入口；删除 `createArchive` 死代码及其 schema。
- 撤销归档（`DELETE /archives/:id`）只撤销归档标记：`graduated → active`，`transferred/inactive` 保持状态并清 `archivedYearId`；不回滚年级、不删除新建班、不恢复已清空的 `TermWeek`。UI 必须写明这一点。
- 归档详情增加 `inactive` 列表；`getArchivedClassContent` 不变。

手动升级：

- `promoteClasses` 从计划推导下一学段；terminal 拒绝；只允许 `promotion:manage`；单事务；广播；记录操作日志。
- `PATCH /classes/:id` 移除 `grade` 字段（或仅 ADMIN 且走升级逻辑），否则用户可绕过计划任意改年级。

### 4.9 Web 管理端

- `router/index.ts`：按 4.1 改为 `meta.permission`；保留 `database` 等真正仅 ADMIN 的页面的角色门槛；守卫同时检查 `roles` 与 `permission`。
- `PermissionsView.vue`：
  - 组表增加“范围”列（`scopeLabel`）、成员数、更新时间；支持查看成员、复制组。
  - 编辑弹窗：范围选择器（年级多选/部多选/全校/关联班级），不再手填 `scopeValue`；显示每个键的默认角色与高权限标记；保存前展示影响预览。
  - 成员页：搜索/筛选；分配弹窗展示“角色默认模板 vs 所选组”的生效差异；默认勾选同角色默认组；跨角色默认组禁止选择。
  - 新增“变更记录”Tab，读取审计接口。
  - 所有操作按 `permission:manage` 门控；失败提示用服务端文案。
- `StudentsView.vue`：
  - 状态筛选真正可用；默认“在读”；“包含归档”单独开关。
  - 操作按钮按 `auth.can('roster:manage')` 显示；只读账号仍能看历史。
  - 调班弹窗显示源班/目标班/年级变化；跨年级警告；转出弹窗增加“去向学校/原因”；新增“转入”入口。
  - 编辑表单移除班级/状态字段；删除改为“停用/删除”并说明影响。
  - 历史抽屉显示类型、批次、学年、原/新班级与年级、操作人、备注；补齐 `restore` 等标签。
- `ClassesView.vue`：升级区改为显示“下一学段”，不再自由输入；terminal 班引导到年度升级/归档页；批量升级可在年度升级页完成。
- `ArchivesView.vue`：显示转入/转出/停用统计；届别详情增加停用学生；撤销归档确认文案写清“不回滚年级与周次”；不显示“新建归档”。
- `PromotionSettings.vue`：重做为“计划 + 预览 + 执行 + 记录”：
  - 轨道/学段编辑（增删、排序、标记毕业学段）、起始年级班数、执行时间、学期开始日期、是否重置周次。
  - 预览抽屉：逐班表格、状态计数、阻断项/警告、新班班级码、将删除的周次行数。
  - 执行前要求确认学年与计划哈希；执行中禁用重复提交；执行后展示快照路径/SHA256/操作人/明细。
  - 执行记录表：学年、状态、操作人、班级/学生统计、快照、错误。
- 移动端：保持现有响应式；权限页/升级页的宽表格允许横向滚动，不新造断点体系。

## 5. 实施阶段

### Phase 0：基线与测试骨架

- 运行现有 `pnpm lint`、`pnpm typecheck`、`pnpm verify:v14`，记录实际输出。
- 新增隔离验收脚本骨架（建议 `packages/server/scripts/verify-lifecycle.ts` + 根 `scripts/verify-lifecycle.mjs`，复用 `verify-v14` 的临时 SQLite 模式），先放会失败的用例。
- 更新 `scripts/verify-client-migrations.mjs` 中“最后一条迁移名”的硬编码断言，改为读取实际最后一条；新迁移必须能被旧库升级回归覆盖。

**出口**：基线通过；新测试能跑起来并明确失败原因。

### Phase 1：权限键接线与页面门控

- 新增 `promotion:manage` 键与迁移，并把 `/term/promotion*` 从 `system:manage` 切换过来；旧库 ADMIN 默认组补键。
- 按 4.1 逐键接入路由；补 `homework:write`、读键、`class:read`、`schedule:read`、`homework:read`、`notification:read`；把归档/升级服务里的 `assertCanManageClasses` 换成对应功能键断言。
- 班级端路由改 `requireStaffPermission`，确认桌面客户端调用链。
- Web 路由/按钮按权限门控；移除 `students/classes/archives/term-weeks` 的 ADMIN 硬门槛。
- 修 `import:students` 的角色替代逻辑。

**出口**：权限矩阵中每个键至少有一个入口；取消键后接口 403；班级端既有能力不回归。

### Phase 2：范围、防提权与审计

- 核对 `promotion:manage` 的旧库补键与默认组行为，确保迁移与 `ensureDefaultGroups()` 不会重复/漏键。
- 实现 scope parser、`GET /permissions/scopes`、`teacherScopeWhere` 重写、DTO `scopeLabel`。
- 实现 4.4 的防提权规则；`PermissionAudit` 表/接口/UI。
- 重写 `listMembers` 为一次预取；补组详情/成员接口。

**出口**：跨角色默认组分配 403；无键授权 403；范围非法 400；审计可查；成员列表查询数不随人数线性增长。

### Phase 3：学生状态机与写入口

- 新增 `lib/student-lifecycle.ts`；改造 students/classes 服务。
- 收紧 `PATCH /students`，新增转入/复学；调班/转出/移出全部事务化 + `batchId`。
- 历史表迁移与 DTO 兼容；修 `activeStudentWhere`/状态筛选/转出历史。
- 删除/停用保护；归档学生不可复活。

**出口**：S1–S7 的复现用例全部转为通过；调班失败不会留下半截数据；转出历史可查。

### Phase 4：年度升级计划与归档

- 新增 `PromotionPlan` 类型、schema、默认计划、迁移。
- 实现 preview/run/planHash/年份限制/幂等/快照 SHA256/执行明细。
- 重写周次重置、归档学生范围、新班码预检、手动升级。
- 删除 `createArchive` 死代码；归档详情补 `inactive`。
- 保持 `runPromotion(year, dryRun)` 旧签名可用（供 v14 测试），新增 options 重载；路由层做年份限制。

**出口**：预览不写库；阻断项可复现；转出/停用学生进入归档；同年重复执行幂等；新班码冲突在预览阶段被拦。

### Phase 5：UI 与文档

- 完成 4.9 的页面改造。
- 更新 `docs/dev/permissions.md`、`docs/app/classes.md`、`docs/dev/api.md`、`docs/dev/data-model.md`、`docs/dev/implementation.md`、`docs/dev/testing.md`、`docs/get-started/web-admin.md`；不要手抄键数/测试数。
- 为新增接口补 API 文档表格；为迁移补升级说明。

**出口**：`pnpm docs:check` 通过；UI 构建通过；关键路径有隔离 UI 回归或手工验收记录。

## 6. 验收清单

### 权限组

- [ ] 逐个键验证：有键可用、无键 403；不存在“有键但接口不检查”或“接口检查但键不在目录”。
- [ ] 班级端：本班名单/课表/通知/叫人/作业代录可用；成绩写入 403；个人成绩查询受开关控制。
- [ ] 教师默认组、空自定义组、多个组并集、无组回落默认组四种情况均符合文档。
- [ ] 教师被授予 `permission:manage` 后不能创建/分配超出自身权限的组；不能给自己提权；不能分配 ADMIN 默认组给教师。
- [ ] 非 ADMIN 不能管理 `GRADE`/`DIVISION`/`ALL` 范围组（或按你实现的覆盖规则验证）。
- [ ] 范围空值、未知年级、全角逗号、重复年级均被规范化或 400。
- [ ] 权限变更审计有操作人、目标、前后差异；成员列表不再 N+1。
- [ ] 权限页的“影响预览”与实际生效一致；默认组文案不再误导。

### 学生流程

- [ ] `PATCH /students` 不能改班级/状态；直接构造请求返回 400。
- [ ] 调班：源班/目标班范围校验；跨年级默认拒绝；历史与班级更新同事务；旧班/新班都收到实时事件。
- [ ] 转出：只接受在读/停用；毕业生/已归档 409；写 `transferredAt`、去向、历史；重复转出幂等或 409。
- [ ] 转入/复学：新建与 `transferred` 重入两条路径都正确；学号唯一；归档班不能作为目标。
- [ ] 撤回转出：原班在读可恢复；原班归档时可指定其他在读班；历史保留。
- [ ] 归档学生不可通过 `addStudent` 复活；`isActiveStudent` 不再把 `graduated` 当在读。
- [ ] 状态筛选 `transferred/graduated/inactive` 均能返回正确记录；转出历史在班级/学生维度都可见。
- [ ] 删除保护：有成绩/作业/已读/历史的学生不能硬删；软停用后不在在读名单。
- [ ] 升级预览：逐班、逐状态、阻断项、新班码、周次影响都可见；不写库。
- [ ] 升级执行：毕业班归档；非毕业班只升一级；转出/停用学生挂届别；新班无班主任/无课程；同年重复执行幂等。
- [ ] 计划含初中/多轨道时，各轨道独立升级；未知年级被阻断。
- [ ] `termStartDate` 按计划写入；`resetTermWeeks=false` 时不清空且 UI 有警告；清空时预览行数准确。
- [ ] 未来学年不能执行；过去学年仅 ADMIN 补跑；`planHash` 不匹配 409。
- [ ] 手动升级只接受计划中的下一学段；terminal 班拒绝；`PATCH /classes` 不能绕过。

### 兼容与数据

- [ ] 旧库升级：新列有默认值，旧 `mode` 正确映射 `kind`，旧权限组不丢键，ADMIN 默认组补 `promotion:manage`。
- [ ] `SNAPSHOT_TABLES` 包含所有新表；快照导出/恢复/换库不丢数据。
- [ ] 旧 Web 客户端/PWA 缓存发送旧请求体时，接口给出明确 400 或兼容处理，不静默写错。
- [ ] 桌面客户端离线/在线冒烟通过；未破坏班级端登录、心跳、作业、通知。

## 7. 验证命令

按改动范围至少执行：

```bash
pnpm lint
pnpm typecheck
pnpm verify:v14
pnpm verify:e2e
pnpm verify:lifecycle        # 新增脚本；先加 package.json script
pnpm verify:client-migrations
pnpm --filter @classhelper/web-admin build
pnpm verify:web:isolated
pnpm docs:check              # 改了 docs 时
pnpm verify:desktop          # 改了班级端会调用的路由/契约时
```

注意：

- `verify-client-migrations.mjs` 目前硬编码最后一条迁移名；新增迁移后必须同步改为动态读取，并验证旧库升级。
- 不在真实业务库上跑升级；升级测试用临时 SQLite。
- 单元/接口断言优先直接调用 service + 临时库；UI 回归用隔离服务。
- 数量只记录本次输出，不抄历史数字。

## 8. 交付物与完成定义

每次汇报必须包含：

1. 本阶段改动文件清单与一句话说明。
2. 迁移说明：新表/新列、旧库兼容、`SNAPSHOT_TABLES` 变更、是否需要管理员补权限。
3. 实际执行的验证命令与输出摘要（通过/失败数、失败原因）。
4. 行为变化与兼容性：旧前端、班级端、离线客户端、旧权限组。
5. 风险与未完成项；不允许用“应该可以”代替验证。

完成定义：

- 第 6 节清单全部通过，或明确列出未通过项及原因、影响、后续任务。
- 没有装饰性权限键、没有第二条毕业路径、没有硬编码三个年级、没有绕过生命周期的写入口。
- 所有新增/修改接口在 `docs/dev/api.md` 有边界说明；所有新增权限键在 `docs/dev/permissions.md` 有归属说明。

## 9. 如果只能做最小闭环

按以下顺序交付，仍须保证每步可运行：

1. 修 S1–S7（状态机、事务、历史查询、复活、删除保护）。
2. 接通 P1–P5（权限键、班级端守卫、页面门控、`promotion:manage`）。
3. 升级预览/执行正确性（S8–S13），暂不做多轨道 UI 的完整编辑，只保留默认高中轨道 + 只读计划展示。
4. 最后做 P6–P11（防提权、审计、权限页预览）。

不要为了“最小闭环”保留已知的数据不一致；宁可缩小 UI 范围，也不要保留两条写路径。
