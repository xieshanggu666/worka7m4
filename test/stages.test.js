/**
 * 分阶段产线施工测试：node test/stages.test.js
 * 阶段前置门控（建成放行 / 试产达标放行）→ 阶段记录（完工/取消档案）→
 * 前置取消 / 缺料 / 建筑被拆时联动挂起并释放预留 → 重建后自动放行 →
 * 升级计划作为前置 → 阶段进度随存档恢复（兼容旧存档）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
global.window = global;
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] !== undefined ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const files = [
  'js/core/config.js', 'js/core/utils.js',
  'js/data/items.js', 'js/data/recipes.js', 'js/data/buildings.js',
  'js/data/research.js', 'js/data/maps.js',
  'js/game/map.js', 'js/game/scheduler.js', 'js/game/railway.js', 'js/game/sim.js', 'js/game/researchmgr.js',
  'js/game/stats.js', 'js/game/save.js', 'js/game/blueprint.js', 'js/game/game.js',
];
for (const f of files) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
}

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
function ticks(g, n) { for (let i = 0; i < n; i++) g.tickOnce(); }

function mkGen() {
  const w = 60, h = 40;
  return {
    presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'medium',
    terrain: Array.from({ length: h }, () => Array(w).fill('grass')),
    ores: Array.from({ length: h }, () => Array(w).fill(null)),
    water: new Set(), oil: new Set(),
  };
}
function mkGame(name) {
  const g = new FG.Game();
  g.startWithMap(mkGen(), null, name);
  return g;
}
function P(g, t, x, y, d) { const b = FG.Map.create(t, x, y, d || 0); g.map.register(b); g.sim.register(b); return b; }
function chestOf(g, x, y, items) {
  const c = P(g, 'chest', x, y);
  for (const k of Object.keys(items)) g.sim.chestAdd(c, k, items[k]);
  return c;
}
function chestCount(b, type) { const s = b.chest.find(x => x.type === type); return s ? s.count : 0; }
function bpEntry(type, dx, dy, dir, extra) {
  return Object.assign({
    type, dx, dy, dir: dir || 0, recipe: null, filter: null, demandMode: false, priority: 'normal',
  }, extra || {});
}
function submit(g, entry, x, y) {
  g.blueprint = { w: 1, h: 1, entries: [entry] };
  return g.submitBlueprintPlan(x, y);
}

console.log('\n[1] 建成放行：前置完工留下阶段记录，后继放行建成，记录用后回收');
{
  const g = mkGame('st1');
  const chest = chestOf(g, 5, 5, { ironPlate: 10 });
  submit(g, bpEntry('belt', 0, 0, 1), 10, 10);
  const a = g.construction.plans[0];
  submit(g, bpEntry('chest', 0, 0, 0), 12, 10);
  const b = g.construction.plans[1];
  ok(g.construction.addDep(b.id, a.id, 'build'), '设置 B 前置 A（建成放行）');
  ok(b.deps[0].mode === 'build', '默认门控为建成放行');
  ticks(g, 1);
  ok(!!g.map.buildingAt(10, 10), '前置 A 传送带建成');
  ticks(g, 1);
  ok(g.construction.stageRecords.length === 1, 'A 完工留下阶段记录（被 B 的前置引用）');
  const rec = g.construction.stageRecords[0];
  ok(rec.buildings.length === 1 && rec.buildings[0].type === 'belt' && !rec.cancelled,
    '阶段记录包含建成建筑观察点');
  ok(!!g.map.buildingAt(12, 10), '门控放行，B 箱子建成');
  ticks(g, 2);
  ok(g.construction.plans.length === 0 && g.construction.stageRecords.length === 0,
    '全部完工出列，阶段记录无人引用自动回收');
  ok(chestCount(chest, 'ironPlate') === 7, '建材消耗正确（10-1带-2箱=7）');
}

console.log('\n[2] 试产达标放行：前置完工后累计产出达标才放行后继');
{
  const g = mkGame('st2');
  g.map.ores[10][20] = { type: 'ironOre', amount: 1000 };
  chestOf(g, 5, 5, { ironPlate: 10, gear: 5 });
  submit(g, bpEntry('miner', 0, 0, 0), 20, 10);
  const a = g.construction.plans[0];
  submit(g, bpEntry('chest', 0, 0, 0), 22, 10);
  const b = g.construction.plans[1];
  ok(g.construction.addDep(b.id, a.id, 'produce', 5), '设置 B 前置 A（试产达标 5 件）');
  ok(b.deps[0].mode === 'produce' && b.deps[0].count === 5, '门控模式与达标数登记');
  ticks(g, 2);
  ok(!!g.map.buildingAt(20, 10) && !g.map.buildingAt(22, 10), '矿机建成，B 挂起未建');
  const rec = g.construction.stageRecords[0];
  ok(rec && rec.producers.length === 1 && rec.producers[0].type === 'miner',
    '阶段记录跟踪生产建筑（矿机）');
  ticks(g, 43);   // 矿机 20 tick/件：第 21、41 tick 产出 2 件
  ok(rec.produced === 2, '试产累计 2 件（实际 ' + rec.produced + '）');
  const gs = g.construction.gateState(b.deps[0]);
  ok(!gs.satisfied && gs.reason === 'producing' && gs.produced === 2 && gs.count === 5,
    '门控状态：试产中 2/5');
  ok(b.blocked && !g.map.buildingAt(22, 10), '未达标，B 保持挂起');
  ticks(g, 65);   // 第 61/81/101 tick 产出第 3~5 件
  ok(rec.produced >= 5, '试产达标（累计 ' + rec.produced + ' 件）');
  ok(!!g.map.buildingAt(22, 10), '达标后放行，B 箱子建成');
  ok(g.log.some(l => l.text.indexOf('解除挂起') >= 0), '放行写入事件日志');
}

console.log('\n[3] 前置取消：试产门控联动挂起，建成门控视为满足（兼容旧行为）');
{
  const g = mkGame('st3');
  const chest = chestOf(g, 5, 5, { ironPlate: 10 });   // 无电路板 → 实验室计划缺料
  submit(g, bpEntry('lab', 0, 0, 0), 30, 10);
  const a = g.construction.plans[0];
  submit(g, bpEntry('chest', 0, 0, 0), 32, 10);
  const b = g.construction.plans[1];
  submit(g, bpEntry('chest', 0, 0, 0), 34, 10);
  const c = g.construction.plans[2];
  g.construction.addDep(b.id, a.id, 'produce', 3);
  g.construction.addDep(c.id, a.id, 'build');
  ticks(g, 5);
  ok(a.waiting && b.blocked && c.blocked, '前置缺料停工，两个后继均挂起');
  g.construction.cancel(a.id);
  const rec = g.construction.stageRecords[0];
  ok(rec && rec.cancelled, '取消的前置留下「已取消」阶段记录');
  ticks(g, 3);
  ok(!!g.map.buildingAt(34, 10), '建成放行的 C：前置取消视为满足，自动建成');
  ok(!g.map.buildingAt(32, 10) && b.blocked, '试产达标的 B：前置取消条件失效，联动挂起');
  const gs = g.construction.gateState(b.deps[0]);
  ok(!gs.satisfied && gs.reason === 'cancelled', 'B 门控状态：前置已取消');
  ok(chestCount(chest, 'ironPlate') === 8, '取消返还 4 + C 消耗 2（10→8），B 不占料');
  ok(g.construction.stageRecords.length === 1, '取消记录保留（仍被 B 引用）');
  g.construction.removeDep(b.id, a.id);
  ticks(g, 3);
  ok(!!g.map.buildingAt(32, 10), '移除失效前置后 B 放行建成');
  ticks(g, 2);
  ok(g.construction.stageRecords.length === 0, '无人引用后取消记录回收');
}

console.log('\n[4] 建筑被拆：联动挂起并释放预留，原地重建后自动放行');
{
  const g = mkGame('st4');
  const chest = chestOf(g, 5, 5, { ironPlate: 5 });   // 带 1 + 实验室 4，无电路板
  submit(g, bpEntry('belt', 0, 0, 1), 40, 10);
  const a = g.construction.plans[0];
  submit(g, bpEntry('lab', 0, 0, 0), 42, 10);
  const b = g.construction.plans[1];
  g.construction.addDep(b.id, a.id, 'build');
  ticks(g, 3);
  ok(b.waiting && (b.entries[0].stock.ironPlate || 0) === 4, '前置建成放行，B 预留 4 铁板待电路板');
  ok(chestCount(chest, 'ironPlate') === 0, '预留已从箱子扣除');
  g.removeBuilding(g.map.buildingAt(40, 10));   // 拆除前置已建成的传送带
  ticks(g, 1);
  const gs = g.construction.gateState(b.deps[0]);
  ok(!gs.satisfied && gs.reason === 'demolished' && gs.missing === 1, '门控状态：建筑被拆');
  ok(b.blocked, 'B 联动挂起');
  ok(!Object.keys(b.entries[0].stock).length, 'B 的条目预留全部释放');
  ok(chestCount(chest, 'ironPlate') === 4, '释放的预留返还物流（箱子 0→4）');
  ok(g.log.some(l => l.text.indexOf('联动挂起') >= 0), '联动挂起写入事件日志');
  P(g, 'belt', 40, 10, 1);   // 原地重建
  ticks(g, 1);
  ok(!b.blocked && (b.entries[0].stock.ironPlate || 0) === 4, '重建后门控重开，B 重新备料');
  ok(g.log.some(l => l.text.indexOf('解除挂起') >= 0), '解除挂起写入事件日志');
}

console.log('\n[5] 前置缺料：试产停涨保持挂起，供料后达标放行');
{
  const g = mkGame('st5');
  const chest = chestOf(g, 5, 5, { stone: 10, ironPlate: 4 });
  submit(g, bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }), 10, 20);
  const a = g.construction.plans[0];
  submit(g, bpEntry('chest', 0, 0, 0), 12, 20);
  const b = g.construction.plans[1];
  g.construction.addDep(b.id, a.id, 'produce', 3);
  ticks(g, 3);
  const f = g.map.buildingAt(10, 20);
  ok(f && f.recipe === 'smelt:iron', '前置熔炉建成并还原配方');
  const rec = g.construction.stageRecords[0];
  ticks(g, 30);
  ok(rec.produced === 0, '熔炉缺料，试产停涨（0 件）');
  const gs = g.construction.gateState(b.deps[0]);
  ok(!gs.satisfied && gs.reason === 'producing' && gs.starving, '门控状态：试产中·缺料');
  ok(b.blocked && !Object.keys(b.entries[0].stock).length, '缺料期间 B 挂起且不预留建材');
  f.slots.inputs.ironOre.count = 10;
  ticks(g, 70);   // 冶炼 20 tick/次 ×3
  ok(rec.produced >= 3, '供料后试产达标（' + rec.produced + ' 件）');
  ok(!!g.map.buildingAt(12, 20), '达标放行，B 箱子建成');
}

console.log('\n[6] 阶段进度随存档恢复；旧存档（字符串依赖/无阶段记录）兼容');
{
  const g = mkGame('st6');
  chestOf(g, 5, 5, { stone: 10, ironPlate: 4 });
  submit(g, bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }), 10, 20);
  const a = g.construction.plans[0];
  submit(g, bpEntry('chest', 0, 0, 0), 12, 20);
  const b = g.construction.plans[1];
  g.construction.addDep(b.id, a.id, 'produce', 3);
  ticks(g, 2);
  g.map.buildingAt(10, 20).slots.inputs.ironOre.count = 2;
  ticks(g, 50);   // 恰好试产 2 件后矿石耗尽
  const rec = g.construction.stageRecords[0];
  ok(rec.produced === 2, '存档前试产累计 2 件');
  const data = JSON.parse(JSON.stringify(g.serialize()));
  ok(data.construction.stageRecords.length === 1
    && data.construction.stageRecords[0].produced === 2
    && data.construction.stageRecords[0].producers.length === 1,
    '存档包含阶段记录（试产进度/生产建筑观察点）');
  ok(data.construction.plans[0].deps[0].mode === 'produce'
    && data.construction.plans[0].deps[0].count === 3, '存档包含门控模式与达标数');

  const g2 = new FG.Game();
  g2.deserialize(data);
  const rec2 = g2.construction.stageRecords[0];
  ok(rec2 && rec2.produced === 2 && rec2.producers[0].type === 'furnace', '读档后试产进度恢复');
  const b2 = g2.construction.plans[0];
  ok(b2 && b2.deps.length === 1 && b2.deps[0].mode === 'produce' && b2.deps[0].count === 3,
    '读档后门控模式恢复（依赖指向阶段记录，未被误判悬空）');
  ok(!g2.construction.depsSatisfied(b2), '读档后门控仍未达标（2/3）');
  ticks(g2, 1);
  ok(b2.blocked, '读档后首轮调度恢复挂起状态');
  g2.map.buildingAt(10, 20).slots.inputs.ironOre.count = 2;
  ticks(g2, 50);
  ok(rec2.produced >= 3 && !!g2.map.buildingAt(12, 20), '读档后续试产达标，B 放行建成');

  // 旧存档：deps 为字符串数组、无 stageRecords 字段
  const cons = new FG.Construction(g);
  let err = null;
  try {
    cons.deserialize({
      seq: 3,
      plans: [
        { id: 'P1', name: '旧A', entries: [{ type: 'belt', x: 1, y: 1, dir: 0, state: 'wait' }] },
        { id: 'P2', name: '旧B', entries: [{ type: 'chest', x: 2, y: 1, dir: 0, state: 'wait' }], deps: ['P1'] },
      ],
    });
  } catch (e) { err = e; }
  ok(!err, '旧存档读取不报错' + (err ? '：' + err.stack : ''));
  const p2 = cons.plans[1];
  ok(p2.deps.length === 1 && p2.deps[0].id === 'P1' && p2.deps[0].mode === 'build',
    '旧字符串依赖迁移为建成放行门控');
  ok(cons.stageRecords.length === 0, '旧档无阶段记录字段 → 回退空表');
  cons.deserialize(JSON.parse(JSON.stringify(cons.serialize())));
  ok(cons.plans[1].deps[0].mode === 'build', '迁移后门控序列化往返一致');
  // 旧档悬空依赖（前置已完工且无记录）照常剔除
  cons.deserialize({ seq: 1, plans: [{ id: 'P9', name: '旧C', entries: [], deps: ['PX'] }] });
  ok(cons.plans[0].deps.length === 0, '旧档悬空依赖自动剔除（视为已满足）');
}

console.log('\n[7] 升级计划作为前置；前置建筑原地升级为高级型号不触发联动挂起');
{
  // 升级计划完工 → 阶段记录 → 后继放行
  const g = mkGame('st7');
  g.research.completed.add('logistics2');
  P(g, 'belt', 50, 10, 1);
  chestOf(g, 5, 5, { ironPlate: 10, gear: 5 });
  ok(g.previewUpgrade(50, 10, 50, 10) === 1 && g.confirmUpgrade(), '提交升级计划（传送带→快速）');
  const u = g.construction.plans[0];
  submit(g, bpEntry('chest', 0, 0, 0), 52, 10);
  const b = g.construction.plans[1];
  g.construction.addDep(b.id, u.id, 'build');
  ticks(g, 4);
  ok(g.map.buildingAt(50, 10).type === 'fastBelt', '前置升级计划完工（快速传送带）');
  ok(!!g.map.buildingAt(52, 10), '升级阶段记录放行后继建成');

  // 试产门控达标后，前置熔炉原地升级钢炉 → 门控保持放行
  const g2 = mkGame('st7b');
  g2.research.completed.add('steelSmelting');
  const chest2 = chestOf(g2, 5, 5, { stone: 5, ironPlate: 4 });
  submit(g2, bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }), 10, 30);
  const a2 = g2.construction.plans[0];
  submit(g2, bpEntry('lab', 0, 0, 0), 12, 30);
  const b2 = g2.construction.plans[1];
  g2.construction.addDep(b2.id, a2.id, 'produce', 2);
  ticks(g2, 2);
  g2.map.buildingAt(10, 30).slots.inputs.ironOre.count = 5;
  ticks(g2, 45);
  const rec2 = g2.construction.stageRecords[0];
  ok(rec2.produced >= 2 && !b2.blocked && (b2.entries[0].stock.ironPlate || 0) === 4,
    '试产达标放行，B 预留 4 铁板待电路板');
  // 原地升级为钢炉（迁移配方与产量计数）
  const old = g2.map.buildingAt(10, 30);
  const nb = FG.Map.create('steelFurnace', 10, 30, old.dir);
  nb.recipe = old.recipe;
  nb.totalCrafted = old.totalCrafted;
  FG.Map.syncRecipeSlots(nb);
  g2.sim.unregister(old); g2.map.unregister(old);
  g2.map.register(nb); g2.sim.register(nb);
  ticks(g2, 2);
  ok(!b2.blocked && (b2.entries[0].stock.ironPlate || 0) === 4,
    '前置原地升级为高级型号：门控保持放行，预留不释放');
  ok(rec2.produced >= 2, '试产累计不重置（' + rec2.produced + ' 件）');
  // 拆除（而非升级）→ 联动挂起并释放预留
  g2.removeBuilding(nb);
  ticks(g2, 1);
  ok(b2.blocked && !Object.keys(b2.entries[0].stock).length && chestCount(chest2, 'ironPlate') === 4,
    '拆除前置建筑：联动挂起并释放预留回物流');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
