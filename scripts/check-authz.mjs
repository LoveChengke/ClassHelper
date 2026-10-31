import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const forbidden = new Set([
  'assertStaffPermission',
  'hasAllScope',
  'teacherScopeWhere',
  'currentRequestPermission',
  'bindRequestPermission',
  'bindRequestPermissions',
]);
const failures = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'generated') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(file);
      continue;
    }
    if (!file.endsWith('.ts')) continue;
    const src = fs.readFileSync(file, 'utf8'),
      ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    function fail(node, message) {
      failures.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1} ${message}`);
    }
    function visit(node) {
      if (ts.isIdentifier(node) && forbidden.has(node.text)) fail(node, `禁止旧授权符号 ${node.text}`);
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast);
        const position = ['resolveClassScope', 'assertClassAccess', 'canAccessClass'].includes(name)
          ? 2
          : ['classIdsFor', 'classWhere', 'getAccessibleClassIds'].includes(name)
            ? 1
            : -1;
        if (
          position >= 0 &&
          (!node.arguments[position] || node.arguments[position].getText(ast) === 'undefined')
        )
          fail(node, `${name} 必须显式传权限键`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
scan('packages/server/src');
// 菜单页必须声明能力键，防止移除旧 roles 后出现无门控入口。
const routerFile = 'packages/web-admin/src/router/index.ts';
const routerAst = ts.createSourceFile(
  routerFile,
  fs.readFileSync(routerFile, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function property(object, name) {
  return object.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(routerAst) === name)
    ?.initializer;
}
function checkRoutes(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const name = property(node, 'name'),
      component = property(node, 'component'),
      meta = property(node, 'meta');
    if (meta && ts.isObjectLiteralExpression(meta) && property(meta, 'roles'))
      failures.push(`${routerFile} 禁止 meta.roles，统一使用能力键`);
    if (
      name &&
      component &&
      name.getText(routerAst) !== "'no-access'" &&
      (!meta ||
        !ts.isObjectLiteralExpression(meta) ||
        (!property(meta, 'public') && !property(meta, 'permission')))
    )
      failures.push(`${routerFile} 页面 ${name.getText(routerAst)} 缺少 meta.permission`);
  }
  ts.forEachChild(node, checkRoutes);
}
checkRoutes(routerAst);
if (fs.existsSync('packages/server/src/lib/permission-scope.ts'))
  failures.push('旧 permission-scope.ts 必须删除');
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log('授权静态门禁通过：无旧入口、无省略权限键的范围查询');
