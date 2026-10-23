# 权限组治理与学生年度生命周期交付记录

日期：2026-10-23（Asia/Shanghai）。工作目录：`D:\classhelper`。版本保持 `1.4.1`。

任务源是 `prompts/permission-and-student-lifecycle.prompt.md`；用户消息中的路径缺少 prompts 后的目录分隔符，已按仓库实际文件定位。
工作目录未包含 `.git`，无法分阶段提交或提供 Git diff；没有初始化仓库、发布远端或改动 releases。已有无关工作保留。

## 实施与阶段验证

- Phase 0：先阅读规则、指定文档和实现。基线 lint/typecheck 通过；v14 最初因缺测试密钥退出，隔离注入后 37/37 通过。新增专项先复现“资料 PATCH 接受毕业状态”的失败，再修复。
- Phase 1：读写功能键、班级端守卫、独立升级键、页面门控和教师名单导入接通。取消键返回 403；教师全校授权可管理班级、查看归档和升级配置；班级详情不向无名单键者附带学生。
- Phase 2：统一范围解析，阻止跨角色默认组、越键和越范围授权；角色默认组只由 ADMIN 编辑。审计同事务，成员权限预取计算；增加成员不增加权限查询次数。
- Phase 3：资料不接受状态/班级，调班、转入出、撤回、复学、停用及移出共用事务入口。故障触发器证明历史失败时班级修改回滚；转出历史可读，毕业/归档不可复活，业务及历史阻止硬删除。
- Phase 4：按轨道与有序学段升级；未知年级、缺届别、重复班号、已有档案、新班码冲突阻断。预览不写库，执行复核哈希，保存快照/SHA256，归档包含转出与停用，周次按计划保留或重置，同年幂等。
- Phase 5：完成权限、学生、班级、归档、升级界面及指定文档同步。Web 构建和文档严格构建通过；关键页面完成隔离浏览器人工验收。

## 迁移与兼容

1. `20261023000000_promotion_permission`：为已存在的 ADMIN 默认组补 promotion:manage；无默认组时运行时初始模板自然包含。不会覆盖已有默认组的其他键。
2. `20261023010000_student_lifecycle_audit`：增加 PermissionAudit；历史新增 kind/batchId/academicYear/年级与学校快照；ArchivedYear 新增 inactiveCount；PromotionRun 新增操作人、明细、摘要和错误。
3. 旧 single/batch → class-change，transfer-out 保持，restore-transfer → restore，然后删除 mode 列。DTO 中 mode 仅派生兼容，不再双写。
4. SNAPSHOT_TABLES 已包含 PermissionAudit。旧快照没有此表时恢复为空，旧历史 mode 恢复时转换，缺列使用默认值。快照和执行记录不自动删除。
5. 自定义权限组不会自动得到新升级键；已显式分配其他组的管理员或教务账号需要显式授予。旧客户端资料请求携带 classId/status、班级 PATCH 携带 grade 返回明确 400；旧 dryRun 升级请求提示改用预览和哈希确认接口。
6. CLASS_DEVICE 权限集合仍为空。本班名单、课表、通知、叫人及代录作业保留，成绩写入拒绝，个人成绩查询开关保护保留。离线缓存、preload、CSP、设备心跳实现未改。
7. 迁移、升级、种子与生命周期写入只在本次专用临时 SQLite 运行，未对业务库执行迁移、seed、reset 或升级。修正旧 e2e 固定 dev.db 连接探针；其本次创建的 0 字节空文件已核查后移除。

## 实际验证结果

| 命令                                       | 本次结果                                                             |
| ------------------------------------------ | -------------------------------------------------------------------- |
| pnpm lint                                  | 通过，无错误或警告                                                   |
| pnpm typecheck                             | 通过，shared/server/web/desktop 全部完成                             |
| pnpm verify:lifecycle                      | 32/32 通过，最近一次进程退出码 0                                     |
| pnpm verify:v14                            | 37/37 通过，进程退出码 0                                             |
| pnpm verify:e2e                            | 244/244 通过，进程退出码 0                                           |
| pnpm verify:client-migrations              | 通过：旧默认组补键、旧 mode 映射、旧行默认值、空组保留及重启幂等     |
| pnpm --filter @classhelper/web-admin build | 通过                                                                 |
| pnpm build:desktop                         | 通过，产物凭据检查通过                                               |
| pnpm docs:check                            | 通过，docfx 0 warning / 0 error                                      |
| pnpm verify:web:isolated                   | 未通过：Electron 启动退出 2147483651（0x80000003），尚未进入 UI 用例 |
| pnpm verify:desktop                        | 未通过：同样在 Electron 启动阶段退出 2147483651，尚未进入客户端用例  |

受限终端最初读取 node_modules 遇到 EPERM；上表运行使用自动审批后的正常权限终端。pnpm 为仓库锁定的 11.8.0。
docfx 原先缺失，已安装到 `.cache/docfx`，NuGet/.NET 工具缓存也限制在仓库 `.cache`，没有改构建脚本的全局查找逻辑。
文档重跑时需将 `.cache/docfx` 加入 PATH。

原先 e2e 中“班级端不得通知/叫人”“名单仅管理员”“固定管理员字段”等旧断言与本次明确要求冲突，已改为验证新行为，并保留无键、跨班、成绩写入等拒绝断言。
导入成功夹具改用合法独立学生，结束时停用保留历史，恢复原在读名单，避免影响后续全班已读/完成统计。

## 隔离浏览器人工验收

在 127.0.0.1:54127 的专用临时库使用临时管理员、临时教师执行，没有连接真实班级。浏览器保持后台。

- 管理员能打开独立“学年升级”页面，看到轨道、执行时间、开学日、周次策略与记录。
- 点击预览后显示逐班/逐状态、哈希、周次影响；测试夹具的未知年级显示阻断，执行按钮禁用。未通过浏览器执行升级。
- 权限页显示范围标签、实际成员数、更新时间及审计 Tab；编辑级长组使用年级下拉，显示服务端年级选项和影响预览，未提交权限变更。
- 学生默认在读；编辑弹窗只有学号、姓名、性别、家长电话，缺少班级/状态字段。
- 切到已转出可返回学生；历史抽屉包含转出记录、批次/学年、原新年级和学校字段。
- 教师菜单可见班级、学生及学期周次；班级页面可读且隐藏创建、编辑、账号、删除等无管理键按钮。
- 目视检查升级预览与名单布局。验收结束后检查 54127 无监听；临时浏览器页由会话清理。

## 已知限制与后续

- Electron 自动 UI 与桌面冒烟仍未通过，需要在可正常启动该 Electron 运行时的 Windows 环境补跑；浏览器验收不能证明桌面离线、桥接或原生窗口运行正确。本次没有关闭安全保护来绕过启动问题。
- 一次生命周期专项在全部断言通过后的连接释放阶段出现原生退出 0xC0000005；相同命令重跑 32/32 且正常退出。根因未确认，不把这次异常解释为断言失败，也不宣称已根治依赖层退出问题。
- SQLite 新库与旧库升级、快照恢复已实测；未配置可用的隔离 MySQL 实例，未做 MySQL 真机读写回归。schema 没有加入 Prisma enum 或 @db.*。
- 并发同年升级及幂等已由 v14 回归；没有另行穷举不同数据库进程、所有权限/岗位/接口组合。业务唯一键与事务仍是跨进程保护边界。
- 旧库如果已有毕业标记与归档不一致等异常数据，预览会阻断并提示先核对，迁移不擅自猜测或复活学生。

## 修改文件

- [docs/app/classes.md](D:/classhelper/docs/app/classes.md)：同步现行 API、权限、数据模型或操作/验收说明。
- [docs/dev/api.md](D:/classhelper/docs/dev/api.md)：同步现行 API、权限、数据模型或操作/验收说明。
- [docs/dev/data-model.md](D:/classhelper/docs/dev/data-model.md)：同步现行 API、权限、数据模型或操作/验收说明。
- [docs/dev/implementation.md](D:/classhelper/docs/dev/implementation.md)：同步现行 API、权限、数据模型或操作/验收说明。
- [docs/dev/permissions.md](D:/classhelper/docs/dev/permissions.md)：同步现行 API、权限、数据模型或操作/验收说明。
- [docs/dev/testing.md](D:/classhelper/docs/dev/testing.md)：同步现行 API、权限、数据模型或操作/验收说明。
- [docs/get-started/web-admin.md](D:/classhelper/docs/get-started/web-admin.md)：同步现行 API、权限、数据模型或操作/验收说明。
- [package.json](D:/classhelper/package.json)：登记 verify:lifecycle，不修改版本。
- [packages/server/prisma/migrations/20261023000000_promotion_permission/migration.sql](D:/classhelper/packages/server/prisma/migrations/20261023000000_promotion_permission/migration.sql)：新增迁移；不修改任何历史迁移。
- [packages/server/prisma/migrations/20261023010000_student_lifecycle_audit/migration.sql](D:/classhelper/packages/server/prisma/migrations/20261023010000_student_lifecycle_audit/migration.sql)：新增迁移；不修改任何历史迁移。
- [packages/server/prisma/schema.prisma](D:/classhelper/packages/server/prisma/schema.prisma)：增加审计与生命周期字段，保持字符串状态和单一跨库 schema。
- [packages/server/prisma/seed.ts](D:/classhelper/packages/server/prisma/seed.ts)：演示历史写入新 kind 字段；本次只在隔离库执行。
- [packages/server/scripts/verify-e2e.mjs](D:/classhelper/packages/server/scripts/verify-e2e.mjs)：读取真实快照表注册表，探测当前临时库，并对齐新授权行为及测试数据收尾。
- [packages/server/scripts/verify-lifecycle.ts](D:/classhelper/packages/server/scripts/verify-lifecycle.ts)：覆盖授权、防提权、事务故障、状态机、多轨道、哈希和快照恢复。
- [packages/server/scripts/verify-v14.ts](D:/classhelper/packages/server/scripts/verify-v14.ts)：结束初中范围夹具后再执行默认高中计划，不放宽升级断言。
- [packages/server/src/lib/access.ts](D:/classhelper/packages/server/src/lib/access.ts)：统一功能键、目标范围和业务关系断言；授权员工可管理对应班级。
- [packages/server/src/lib/mappers.ts](D:/classhelper/packages/server/src/lib/mappers.ts)：输出生命周期字段并从 kind 派生旧 mode。
- [packages/server/src/lib/permission-scope.ts](D:/classhelper/packages/server/src/lib/permission-scope.ts)：默认组与显式组均按功能键过滤，再使用共享解析器生成范围。
- [packages/server/src/lib/permissions.ts](D:/classhelper/packages/server/src/lib/permissions.ts)：新增服务断言，保留每请求实时生效和管理员必要入口。
- [packages/server/src/lib/settings.ts](D:/classhelper/packages/server/src/lib/settings.ts)：登记 term.promotionPlan。
- [packages/server/src/lib/snapshot.ts](D:/classhelper/packages/server/src/lib/snapshot.ts)：加入 PermissionAudit，兼容缺审计表的旧快照并转换旧 mode。
- [packages/server/src/lib/student-lifecycle.ts](D:/classhelper/packages/server/src/lib/student-lifecycle.ts)：集中学生状态/班级/历史的事务写入，提交后广播相关班级。
- [packages/server/src/lib/students.ts](D:/classhelper/packages/server/src/lib/students.ts)：在读统一为 active 且未归档，排除毕业、转出和停用。
- [packages/server/src/middleware/auth.ts](D:/classhelper/packages/server/src/middleware/auth.ts)：在当前请求复用权限和功能范围上下文，保留班级端显式例外。
- [packages/server/src/modules/archives/archives.module.ts](D:/classhelper/packages/server/src/modules/archives/archives.module.ts)：移除第二条毕业路径，按功能键读取/撤销归档并复用撤回生命周期。
- [packages/server/src/modules/archives/archives.schemas.ts](D:/classhelper/packages/server/src/modules/archives/archives.schemas.ts)：移除第二条毕业路径，按功能键读取/撤销归档并复用撤回生命周期。
- [packages/server/src/modules/archives/archives.service.ts](D:/classhelper/packages/server/src/modules/archives/archives.service.ts)：移除第二条毕业路径，按功能键读取/撤销归档并复用撤回生命周期。
- [packages/server/src/modules/archives/transferred.service.ts](D:/classhelper/packages/server/src/modules/archives/transferred.service.ts)：移除第二条毕业路径，按功能键读取/撤销归档并复用撤回生命周期。
- [packages/server/src/modules/calls/calls.module.ts](D:/classhelper/packages/server/src/modules/calls/calls.module.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/calls/calls.service.ts](D:/classhelper/packages/server/src/modules/calls/calls.service.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/class-plans/class-plans.module.ts](D:/classhelper/packages/server/src/modules/class-plans/class-plans.module.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/class-plans/profile-import.service.ts](D:/classhelper/packages/server/src/modules/class-plans/profile-import.service.ts)：按具体导入键和写键校验范围，学生导入复用受控生命周期。
- [packages/server/src/modules/classes/classes.module.ts](D:/classhelper/packages/server/src/modules/classes/classes.module.ts)：班级服务接通授权与范围，名单复用生命周期，阻止直接修改年级。
- [packages/server/src/modules/classes/classes.schemas.ts](D:/classhelper/packages/server/src/modules/classes/classes.schemas.ts)：班级服务接通授权与范围，名单复用生命周期，阻止直接修改年级。
- [packages/server/src/modules/classes/classes.service.ts](D:/classhelper/packages/server/src/modules/classes/classes.service.ts)：班级服务接通授权与范围，名单复用生命周期，阻止直接修改年级。
- [packages/server/src/modules/courses/courses.module.ts](D:/classhelper/packages/server/src/modules/courses/courses.module.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/homeworks/homeworks.module.ts](D:/classhelper/packages/server/src/modules/homeworks/homeworks.module.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/homeworks/homeworks.service.ts](D:/classhelper/packages/server/src/modules/homeworks/homeworks.service.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/imports/class-plan.service.ts](D:/classhelper/packages/server/src/modules/imports/class-plan.service.ts)：按具体导入键和写键校验范围，学生导入复用受控生命周期。
- [packages/server/src/modules/imports/imports.module.ts](D:/classhelper/packages/server/src/modules/imports/imports.module.ts)：按具体导入键和写键校验范围，学生导入复用受控生命周期。
- [packages/server/src/modules/imports/table-import.service.ts](D:/classhelper/packages/server/src/modules/imports/table-import.service.ts)：按具体导入键和写键校验范围，学生导入复用受控生命周期。
- [packages/server/src/modules/imports/time-layout.service.ts](D:/classhelper/packages/server/src/modules/imports/time-layout.service.ts)：按具体导入键和写键校验范围，学生导入复用受控生命周期。
- [packages/server/src/modules/notifications/notifications.module.ts](D:/classhelper/packages/server/src/modules/notifications/notifications.module.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/notifications/notifications.service.ts](D:/classhelper/packages/server/src/modules/notifications/notifications.service.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/permissions/permissions.module.ts](D:/classhelper/packages/server/src/modules/permissions/permissions.module.ts)：接入规范范围、防越权授权、批量成员计算与事务审计。
- [packages/server/src/modules/permissions/permissions.service.ts](D:/classhelper/packages/server/src/modules/permissions/permissions.service.ts)：接入规范范围、防越权授权、批量成员计算与事务审计。
- [packages/server/src/modules/schedules/schedules.module.ts](D:/classhelper/packages/server/src/modules/schedules/schedules.module.ts)：补功能守卫与服务断言，保持班级端既有调用及业务关系边界。
- [packages/server/src/modules/students/students.module.ts](D:/classhelper/packages/server/src/modules/students/students.module.ts)：收紧资料入口，接入专用生命周期动作、状态筛选与只读历史。
- [packages/server/src/modules/students/students.schemas.ts](D:/classhelper/packages/server/src/modules/students/students.schemas.ts)：收紧资料入口，接入专用生命周期动作、状态筛选与只读历史。
- [packages/server/src/modules/students/students.service.ts](D:/classhelper/packages/server/src/modules/students/students.service.ts)：收紧资料入口，接入专用生命周期动作、状态筛选与只读历史。
- [packages/server/src/modules/term/promotion.service.ts](D:/classhelper/packages/server/src/modules/term/promotion.service.ts)：实现多轨道计划、预览、阻断、哈希、快照摘要、事务执行、幂等和失败记录。
- [packages/server/src/modules/term/term.module.ts](D:/classhelper/packages/server/src/modules/term/term.module.ts)：独立升级权限、确认与哈希接口，学期写入按授权而非角色判断。
- [packages/server/src/modules/term/term.service.ts](D:/classhelper/packages/server/src/modules/term/term.service.ts)：独立升级权限、确认与哈希接口，学期写入按授权而非角色判断。
- [packages/shared/src/index.ts](D:/classhelper/packages/shared/src/index.ts)：导出范围和升级计划契约。
- [packages/shared/src/lifecycle.ts](D:/classhelper/packages/shared/src/lifecycle.ts)：提供唯一范围解析器及多轨道升级计划契约和默认计划。
- [packages/shared/src/permissions.ts](D:/classhelper/packages/shared/src/permissions.ts)：登记 promotion:manage、默认角色、标签、分类与矩阵。
- [packages/shared/src/types.ts](D:/classhelper/packages/shared/src/types.ts)：扩展权限、学生历史与归档 DTO，收紧资料和班级更新契约。
- [packages/web-admin/src/api/index.ts](D:/classhelper/packages/web-admin/src/api/index.ts)：同步收紧后的写入参数，移除无服务端入口的手工创建归档 API。
- [packages/web-admin/src/components/PromotionSettings.vue](D:/classhelper/packages/web-admin/src/components/PromotionSettings.vue)：提供计划编辑、只读影响预览、学年确认执行和快照明细记录。
- [packages/web-admin/src/components/TransferredStudents.vue](D:/classhelper/packages/web-admin/src/components/TransferredStudents.vue)：按名单管理键撤回转出，允许选择其他在读班。
- [packages/web-admin/src/config/navigation.ts](D:/classhelper/packages/web-admin/src/config/navigation.ts)：将学年升级加入班级与人员菜单，权限仍来自路由。
- [packages/web-admin/src/router/index.ts](D:/classhelper/packages/web-admin/src/router/index.ts)：移除班级、学生、周次和归档的固定 ADMIN 门槛，新增独立升级页面。
- [packages/web-admin/src/views/ArchivesView.vue](D:/classhelper/packages/web-admin/src/views/ArchivesView.vue)：展示转入、转出、停用及停用名单，明确撤销归档的实际边界。
- [packages/web-admin/src/views/ClassesView.vue](D:/classhelper/packages/web-admin/src/views/ClassesView.vue)：按键控制写按钮，年级只读并展示计划推导的下一学段。
- [packages/web-admin/src/views/PermissionsView.vue](D:/classhelper/packages/web-admin/src/views/PermissionsView.vue)：范围选择、真实成员、复制、差异确认、成员搜索和审计分页。
- [packages/web-admin/src/views/StudentsView.vue](D:/classhelper/packages/web-admin/src/views/StudentsView.vue)：状态/归档筛选、专用调转入出、复学、停用/空记录删除与历史明细。
- [packages/web-admin/src/views/TermWeeksView.vue](D:/classhelper/packages/web-admin/src/views/TermWeeksView.vue)：按 term:write 显示写按钮，升级区按独立键显示。
- [scripts/ui-smoke/main.cjs](D:/classhelper/scripts/ui-smoke/main.cjs)：同步教师按权限显示菜单与新版升级页面断言。
- [scripts/verify-client-migrations.mjs](D:/classhelper/scripts/verify-client-migrations.mjs)：动态读取最新迁移，并验证旧默认组补键、旧历史映射与重启幂等。
- [scripts/verify-e2e-isolated.mjs](D:/classhelper/scripts/verify-e2e-isolated.mjs)：明确隔离环境，保持随机端口、临时账号和临时库。
- [scripts/verify-lifecycle.mjs](D:/classhelper/scripts/verify-lifecycle.mjs)：创建专用临时 SQLite 与测试环境，回放迁移后运行专项。
- [scripts/verify-v14.mjs](D:/classhelper/scripts/verify-v14.mjs)：为隔离回归提供独立测试密钥和环境。

本记录的日志位于 `.cache/lifecycle-*.log`，变更清单位于 `.cache/lifecycle-changed-files.json`。
