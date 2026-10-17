-- 将历史离线导入的 JSON 时间点补为关系记录；items 仅保留原始审计来源。
INSERT INTO TimeLayoutItem (id,timeLayoutId,position,name,startTime,endTime,timeType,isHideDefault,breakName)
SELECT 'import-point-'||t.id||'-'||j.key,t.id,CAST(j.key AS INTEGER),COALESCE(json_extract(j.value,'$.name'),''),json_extract(j.value,'$.startTime'),json_extract(j.value,'$.endTime'),
CASE json_extract(j.value,'$.type') WHEN 'break' THEN 'BREAK' WHEN 'divider' THEN 'DIVIDER' WHEN 'action' THEN 'ACTION' ELSE 'LESSON' END,
COALESCE(json_extract(j.value,'$.skipped'),false),CASE json_extract(j.value,'$.type') WHEN 'break' THEN COALESCE(json_extract(j.value,'$.name'),'') ELSE '' END
FROM TimeLayout t,json_each(CASE WHEN json_valid(t.items) THEN t.items ELSE '[]' END) j
WHERE NOT EXISTS(SELECT 1 FROM TimeLayoutItem p WHERE p.timeLayoutId=t.id)
AND json_extract(j.value,'$.startTime') IS NOT NULL AND json_extract(j.value,'$.endTime') IS NOT NULL;
