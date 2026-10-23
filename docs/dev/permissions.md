---
title: 角色与权限
description: 功能权限、岗位范围与班级科目边界。
---

# 角色与权限

授权分为功能权限、数据范围和业务关系三层，任何一层拒绝都不能操作。
shared 的 `permissions.ts` 定义键、标签、默认模板与班级关系规则；服务端 `lib/permissions.ts`、
`lib/permission-scope.ts`、`lib/access.ts` 分别计算生效键、查询范围和具体业务断言。

## 身份与权限组

账号角色为 ADMIN、TEACHER；班级登录形成 CLASS_DEVICE 会话。学生是 Student 名单，不是账号。
HEAD/SUBJECT 是班级关系，级长/部长是岗位组，均不新增 User.role。

| 情况         | 有效功能权限                                          |
| ------------ | ----------------------------------------------------- |
| 已分配权限组 | 所有分组键的并集，可以比角色默认更少                  |
| 没有分组     | 数据库对应角色的可编辑默认组                          |
| ADMIN        | 同上，始终额外保留 permission:manage 与 system:manage |
| CLASS_DEVICE | 空集；通过明确允许班级会话的接口与业务断言操作        |

每请求读取生效权限，编辑后无需等待令牌过期。内置组可改不可删，默认组不是写死的全权限快捷方式。
路由使用 requirePermission（AND）、requireAnyPermission（OR），员工与班级端共享读取入口按 requireStaffPermission 等规则检查。
具体 API 的额外角色限制以模块路由和服务断言为准，不能把“默认只分配给管理员”写成所有接口硬编码 ADMIN。

## 数据范围与科目

| 岗位/身份   | 范围                                          |
| ----------- | --------------------------------------------- |
| 管理员      | 全部班级；仍须功能键                          |
| 班主任/教师 | 自己担任班主任或任课的班级，按分组 scope 收敛 |
| 级长        | 配置年级                                      |
| 部长        | 配置的一组年级，scopeValue 用逗号分隔         |
| 班级端      | 登录绑定班级                                  |

空年级/部配置不放行。范围按当前功能键独立合并，不能借其他只读组扩大名单、班级或设备写权限。
科目编辑再由 `assertCanManageSubjectContent` 检查：管理员可管理，教师仅自己任课科目，无科目内容归班主任。
班主任不任教某科就不能改该科的作业或成绩；班级端只允许作业写入，不能写成绩。

| 业务             | 主要功能键与额外边界                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| 名单读取/管理    | roster:read / roster:manage；管理需名单键与目标班范围；关联班级仍须班主任关系，全校名单范围可跨班维护 |
| 教师列表/维护    | teacher:read / teacher:manage；导入教师另检查 import:teachers 与 teacher:manage                       |
| 日课表写入       | schedule:write + 管理员/本班班主任                                                                    |
| 全校时间表写入   | timetable:manage；默认给 ADMIN                                                                        |
| 作业/成绩        | homework:write / grade:write 或 grade:import，再按班级科目收口                                        |
| 通知/叫人        | notification:publish / call:create，再检查班级范围                                                    |
| 课件             | courseware:read / courseware:write，上传和推送自己的文件还受本人授课班级约束                          |
| 客户端维护/远控  | client:read、client:manage、remote:control，写操作按对应键范围                                        |
| 版本与安装包写入 | client:update；旧 client:update-push 不再作为写入口要求                                               |
| 学年升级         | promotion:manage；计划、预览与执行独立授权，全校范围，默认给 ADMIN                                    |
| 数据库/系统/权限 | database:manage / system:manage / permission:manage                                                   |

完整键目录读取 `PERMISSION_KEYS`，不在文档维护固定键数。

## 前端门控与成绩隐私

Web 菜单属性来自路由，`meta.roles` 粗筛、`meta.permission` 细筛；先 ensurePermissions 再按生效集合判断。
服务端仍检查功能、范围与业务关系，直接构造请求不能绕过。
岗位范围可以扩大读范围，不能自动扩大科目写权限，也不能替代课件的本人任课关系。
班级成绩查询开关仅员工按业务权限修改；关闭后班级端仍看集体聚合，个人明细、原始全班成绩和排名返回拒绝。
稀疏分段与补集抑制，服务端不向客户端下发个人原始成绩再聚合。

## 设备维护

`/api/clients/heartbeat` 和命令回执供已登录设备使用，不依赖班级端的空权限集合；服务端校验 deviceKey 与班级归属。
远控从管理端确认下发，客户端执行后回传真实结果。更新文件由服务端缓存，教室机验 SHA256，
按立即、放学后、空闲策略安装；关闭自动更新不会强制安装。详见[更新与升级](../management/upgrade.md)。

## 范围配置与权限治理

范围由 shared 的 `parsePermissionScope` 统一解析。关联班级只接受空值（班主任与任课班）或 HEAD（仅班主任班）；
GRADE 必选一个年级，DIVISION 必选多个年级组成的集合；全角逗号、顿号和空白统一分隔、去重排序。
ALL 存空范围值。年级选项来自数据库已有年级和升级计划，空范围或未知年级返回 400；旧库未配置的岗位组不放行。
`GET /permissions/scopes` 提供选择器选项，组 DTO 的 scopeLabel 供页面展示。

默认组只能分配给同角色；非 ADMIN 的权限管理员只能管理关联班级范围的自定义组，
组原有键和新键均不得超过自己当前权限。角色默认组只有 ADMIN 可改；删除组可能触发默认回落，仅 ADMIN 可执行。
分配空数组恢复数据库角色默认组，分配任何组则仅取所选组并集；需要保留默认时显式同时选择同角色默认组。

权限页保存前展示成员与权限差异，支持复制组、查看生效成员和分页审计。
PermissionAudit 在组或分配事务中保存操作人、目标、前后 JSON；`GET /permissions/audit` 受 permission:manage 控制。
成员权限由一次预取组和账号后计算，不逐账号重复加载。

新增迁移为旧库已有 ADMIN 默认组补 promotion:manage；新库由默认模板创建。
自定义组和已分配其他组的管理员不会自动获得该键，需要在权限页显式授予。
班级端权限仍为空，本班名单、课表、通知、叫人和作业代录走显式员工守卫例外；班级端发布内容归属本班班主任。
