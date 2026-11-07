/**
 * 课表 YAML 导入格式的公共契约。
 *
 * 这里放「复制给大模型的提示词」与「可导入的示例 YAML」两份文本：
 * - Web 导入弹窗直接展示、复制、下载它们；
 * - 服务端隔离验收也解析同一份示例，保证提示词描述的格式与实际解析器永远一致。
 *
 * 字段语义（与服务端 `class-plan-yaml.service.ts` 对应）：
 * - `version`：固定 1，可省略；
 * - `subjects`：科目列表，`simplified_name` 会成为课程简称，`room` 会写进课次地点；
 * - `schedules`：课表列表，`enable_day` 1=周一 … 7=周日，`weeks` 取 all/odd/even；
 * - 同一天的单周与双周拆成两条 schedules，同一天同一 weeks 只能有一条。
 */

/** 课表 YAML 示例：覆盖每周课表、同一天单周/双周拆分、科目教室。 */
export const CLASS_PLAN_YAML_SAMPLE = `version: 1
subjects:
  - name: 语文
    simplified_name: 语
    teacher: ''
    room: ''
  - name: 数学
    simplified_name: 数
  - name: 英语
    simplified_name: 英
    room: 教学楼 201
schedules:
  - name: 周一
    enable_day: 1
    weeks: all
    classes:
      - subject: 语文
        start_time: '080000'
        end_time: '084500'
      - subject: 数学
        start_time: '08:55:00'
        end_time: '09:40:00'
      - subject: 英语
        start_time: '10:00:00'
        end_time: '10:45:00'
  - name: 周二 单周
    enable_day: 2
    weeks: odd
    classes:
      - subject: 英语
        start_time: '08:00:00'
        end_time: '08:45:00'
      - subject: 数学
        start_time: '08:55:00'
        end_time: '09:40:00'
  - name: 周二 双周
    enable_day: 2
    weeks: even
    classes:
      - subject: 语文
        start_time: '08:00:00'
        end_time: '08:45:00'
      - subject: 数学
        start_time: '08:55:00'
        end_time: '09:40:00'
`;

/** 可直接复制给大模型的提示词（后面追加自己的课表内容一起发送）。 */
export const CLASS_PLAN_YAML_AI_PROMPT = `你是一个课表整理助手。请把我提供的课表整理成 ClassHelper「课表档案」可导入的 YAML。只输出 YAML 本身，不要解释，不要使用 Markdown 代码围栏，不要写注释。

格式要求（必须严格遵守）：
1. 顶层只有 version、subjects、schedules 三个字段，其中 version 固定为 1。
2. subjects 是科目列表，每项字段：
   - name：科目全称，必填，例如 语文；
   - simplified_name：可选，课程简称，建议 1~2 个字；
   - teacher：可选，教师名，仅作备注、不参与课程授权，没有就写空字符串；
   - room：可选，默认教室，会作为每节课的上课地点导入。
3. schedules 是课表列表，每项字段：
   - name：课表名称，例如 周一、周二 单周、周五 双周；
   - enable_day：必填，1=周一、2=周二、3=周三、4=周四、5=周五、6=周六、7=周日；
   - weeks：选填，all=每周（默认）、odd=单周、even=双周；同一天既有单周又有双周时拆成两条；
   - classes：必填，按开始时间从早到晚排列，每项：
     - subject：科目名，要与 subjects 里的 name 对应；空课写空字符串 ''；
     - start_time、end_time：24 小时制六位字符串 HHMMSS，例如 '080000'；也支持 HH:mm / HH:mm:ss。秒必须为 00，结束必须晚于开始。
4. 同一天、同一 weeks 只能有一条 schedules；没有课的星期不要写。
5. 不需要把课间、早读等没有科目的时段都写出来；需要占位时空课写 '' 即可。

示例（仅示意格式，请替换成我的真实课表）：
${CLASS_PLAN_YAML_SAMPLE}`;
