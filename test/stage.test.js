/**
 * 分阶段产线施工测试：node test/stage.test.js
 * 默认单阶段 → 切分阶段（建成闸门：后续挂起不占料、闸门开放后续建）→
 * 试产达标闸门（产物限定/基线）→ 闸门建筑被拆联动挂起并释放预留、重建自动放行 →
 * 升级计划分阶段 → 阶段进度随存档恢复 → 兼容旧存档
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

function mkGame(name) {
  const g = new FG.Game();
  const w = 60, h = 40;
  const terrain = Array.from({ length: h }, () => Array(w).fill('grass'));
  const ores = Array.from({ length: h }, () => Array(w).fill(null));
  g.startWithMap({
    presetId: 'greenfield', biome: 'grass', w, h, seed: 1, sizeId: 'medium',
    terrain, ores, water: new Set(), oil: new Set(),
  }, null, name || 'stage-test');
  return g;
}
function P(g, t, x, y, d) { const b = FG.Map.create(t, x, y, d || 0); g.map.register(b); g.sim.register(b); return b; }
function chestCount(b, type) { const s = b.chest.find(x => x.type === type); return s ? s.count : 0; }
function bpEntry(type, dx, dy, dir, extra) {
  return Object.assign({
    type, dx, dy, dir: dir || 0, recipe: null, filter: null, demandMode: false, priority: 'normal',
  }, extra || {});
}
/** 直接通过 construction.addPlan 提交（绕过蓝图校验），返回计划 */
function submit(g, entries, ox, oy) {
  const bp = { w: Math.max(...entries.map(e => e.dx)) + 1, h: Math.max(...entries.map(e => e.dy)) + 1, entries };
  return g.construction.addPlan(bp, ox, oy);
}

// ============================================================
console.log('\n[1] 默认单阶段：stages 结构与旧行为一致');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'ironPlate', 1);
  const p = submit(game, [bpEntry('belt', 0, 0, 1)], 20, 20);
  ok(p.stages.length === 1 && p.stages[0].cut === 1 && p.stages[0].gate === null, '新计划默认 1 个无闸门阶段');
  ticks(game, 10);
  ok(!!game.map.buildingAt(20, 20) && game.construction.plans.length === 0, '单阶段计划照常完工出列');
}

// ============================================================
console.log('\n[2] 建成闸门：阶段 1 建成前阶段 2 挂起、不占料；放行后自动续建');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  // 阶段1=熔炉(石5)，阶段2=实验室(铁板4+电路板1)
  game.sim.chestAdd(chest, 'stone', 5);
  game.sim.chestAdd(chest, 'ironPlate', 4);
  game.sim.chestAdd(chest, 'circuit', 1);
  const p = submit(game, [
    bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }),
    bpEntry('lab', 1, 0, 0),
  ], 20, 10);
  ok(game.construction.splitStage(p.id, 1), '在条目 1 前切分阶段');
  ok(p.stages.length === 2 && p.stages[0].cut === 1 && p.stages[0].gate.mode === 'built',
    '切分后 2 阶段，阶段1 默认「建成放行」闸门');

  ticks(game, 1);
  const fur = game.map.buildingAt(20, 10);
  ok(!!fur && fur.type === 'furnace', '阶段 1 熔炉率先建成');
  ok(!game.map.buildingAt(21, 10), '闸门未开放前阶段 2 实验室不落成');
  const p2 = game.construction.byId(p.id);
  ok(p2 && p2.activeStage === 0 && p2.stages[0].gate.opened === false,
    '建成当 tick 末闸门尚待下一 tick 对账开放，活跃阶段仍为 0');
  // 关键：阶段 2 建材在闸门开放前不得被预留
  ok(chestCount(chest, 'ironPlate') === 4 && chestCount(chest, 'circuit') === 1,
    '闸门开放前阶段 2 的铁板/电路板保持自由，未被预留');
  game.construction.tick();   // 下一 tick 对账：建成闸门开放
  const p2b = game.construction.byId(p.id);
  ok(p2b.activeStage === 1 && p2b.stages[0].gate.opened === true, '闸门开放，活跃阶段推进到 1');
  ticks(game, 20);
  ok(!!game.map.buildingAt(21, 10), '闸门开放后阶段 2 实验室自动建成');
  ok(game.construction.plans.length === 0, '两阶段全部完工出列');
  ok(chestCount(chest, 'stone') === 0 && chestCount(chest, 'ironPlate') === 0 && chestCount(chest, 'circuit') === 0,
    '两阶段建材全部消耗');
}

// ============================================================
console.log('\n[3] 挂起阶段不占料：阶段 1 缺料时，阶段 2 的建材保持自由（箱子不被预留）');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  // 阶段1=实验室(铁板4+电路板1)，阶段2=熔炉(石5)
  game.sim.chestAdd(chest, 'ironPlate', 4);   // 缺电路板
  game.sim.chestAdd(chest, 'stone', 5);
  const p = submit(game, [
    bpEntry('lab', 0, 0, 0),
    bpEntry('furnace', 1, 0, 0),
  ], 24, 10);
  game.construction.splitStage(p.id, 1);
  ticks(game, 5);
  ok(!game.map.buildingAt(24, 10) && !game.map.buildingAt(25, 10), '两阶段均无建筑落成');
  const p2 = game.construction.byId(p.id);
  ok(p2 && p2.activeStage === 0 && p2.waiting, '活跃阶段 0 缺料等待');
  ok(chestCount(chest, 'ironPlate') === 0, '阶段 1 已预留铁板 4（4→0）');
  ok(chestCount(chest, 'stone') === 5, '阶段 2 的石头未被预留（仍 5 件自由建材）');
  ok(Object.keys(p2.entries[1].stock).length === 0, '阶段 2 条目预留记账为空');
  // 补齐阶段 1
  game.sim.chestAdd(chest, 'circuit', 1);
  ticks(game, 15);
  ok(!!game.map.buildingAt(24, 10), '阶段 1 实验室建成');
  ticks(game, 15);
  ok(!!game.map.buildingAt(25, 10), '闸门开放后阶段 2 熔炉建成');
  ok(chestCount(chest, 'stone') === 0, '阶段 2 开始备料并消耗石头');
}

// ============================================================
console.log('\n[4] 试产达标闸门：阶段建成后还须累计生产 n 次才放行');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'stone', 5);
  game.sim.chestAdd(chest, 'ironPlate', 4);
  game.sim.chestAdd(chest, 'circuit', 1);
  game.sim.chestAdd(chest, 'ironOre', 50);
  const p = submit(game, [
    bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }),
    bpEntry('lab', 1, 0, 0),
  ], 30, 10);
  game.construction.splitStage(p.id, 1);
  ok(game.construction.setStageGate(p.id, 0, { mode: 'trial', item: null, n: 3 }),
    '阶段 1 闸门改为「试产达标 3 次」');

  ticks(game, 20);
  const fur = game.map.buildingAt(30, 10);
  ok(!!fur, '阶段 1 熔炉建成');
  ok(!game.map.buildingAt(31, 10), '试产未达标，阶段 2 不落成');
  const p2 = game.construction.byId(p.id);
  ok(p2 && p2.stageBlocked && /试产中/.test(p2.stageReason), '计划处于「试产等待」状态：' + (p2 && p2.stageReason));
  ok(p2.stages[0].gate.opened === false, '闸门尚未开放');
  ok(chestCount(chest, 'ironPlate') === 4 && chestCount(chest, 'circuit') === 1,
    '试产期间阶段 2 建材不被预留');

  // 投喂铁矿让熔炉生产（直接塞入输入槽，模拟机械臂供料）
  fur.slots.inputs.ironOre.count = 20;
  ticks(game, 25);   // 配方 20 tick/次，钢炉速度1 → 约 1~2 次，未必达 3
  let p3 = game.construction.byId(p.id);
  ok(p3 && !game.map.buildingAt(31, 10), '生产不足 3 次时仍不放行');
  ok(game.construction.trialProgress(p3, 0) < 3, '试产进度小于目标（实际 ' + game.construction.trialProgress(p3, 0) + '）');

  ticks(game, 60);   // 再给足时间完成 3 次
  p3 = game.construction.byId(p.id);
  ok(!!game.map.buildingAt(31, 10), '试产达标后阶段 2 实验室自动建成');
  ok(game.construction.plans.length === 0, '试产达标，计划完工出列');
}

// ============================================================
console.log('\n[5] 试产产物限定：闸门只统计指定产物');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'stone', 5);
  game.sim.chestAdd(chest, 'ironPlate', 4);
  game.sim.chestAdd(chest, 'circuit', 1);
  const p = submit(game, [
    bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }),
    bpEntry('lab', 1, 0, 0),
  ], 34, 10);
  game.construction.splitStage(p.id, 1);
  // 限定产物为铜板（熔炉实际炼铁板）→ 铁板产量不计入
  game.construction.setStageGate(p.id, 0, { mode: 'trial', item: 'copperPlate', n: 3 });
  ticks(game, 10);
  const fur = game.map.buildingAt(34, 10);
  ok(!!fur, '熔炉建成，进入试产等待（基线=建成当下产量）');
  fur.slots.inputs.ironOre.count = 20;
  ticks(game, 80);
  const p2 = game.construction.byId(p.id);
  ok(p2 && p2.stageBlocked && !game.map.buildingAt(35, 10),
    '限定铜板但熔炉产铁板：试产不计入，阶段 2 保持挂起');
  // 限定改回铁板：试产基线不变（一直处于试产期），已产出的铁板计入 → 立即达标
  game.construction.setStageGate(p.id, 0, { mode: 'trial', item: 'ironPlate', n: 3 });
  ticks(game, 12);
  ok(!!game.map.buildingAt(35, 10), '闸门改限铁板后，试产期间已产铁板计入达标，阶段 2 放行建成');
}

// ============================================================
console.log('\n[5b] 先建成、后加试产闸门：基线取设置当下（历史产量不算入试产）');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'stone', 5);   // 只有熔炉料；实验室缺电路板，阶段 2 建不成
  const p = submit(game, [
    bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }),
    bpEntry('lab', 1, 0, 0),
  ], 38, 10);
  game.construction.splitStage(p.id, 1);   // 默认 built 闸门：建成即开放
  ticks(game, 10);
  const fur = game.map.buildingAt(38, 10);
  ok(!!fur, '熔炉已建成、built 闸门已开放');
  fur.slots.inputs.ironOre.count = 30;
  ticks(game, 50);  // 熔炉已经产了若干铁板（阶段 2 缺电路板建不成）
  // 此时才把闸门改成试产 3 次：当前产量作为基线，已产出的铁板不算入
  game.construction.setStageGate(p.id, 0, { mode: 'trial', item: 'ironPlate', n: 3 });
  game.construction.tick();
  const p2 = game.construction.byId(p.id);
  ok(p2 && p2.stageBlocked && game.construction.trialProgress(p2, 0) === 0,
    '后加试产闸门：基线取当下产量，历史产量不计入（试产 0/3，后续阶段重新挂起）');
  fur.slots.inputs.ironOre.count = 80;
  ticks(game, 70);
  ok(game.construction.trialProgress(game.construction.byId(p.id), 0) >= 3,
    '重新生产后试产达标（≥3 次）');
  game.sim.chestAdd(chest, 'ironPlate', 4);
  game.sim.chestAdd(chest, 'circuit', 1);
  ticks(game, 30);
  ok(!!game.map.buildingAt(39, 10), '试产达标且补料后，阶段 2 实验室建成');
}

// ============================================================
console.log('\n[6] 闸门建筑被拆：联动回退条目、关闭闸门、挂起后续并释放预留；重建自动重新放行');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'stone', 5);    // 恰够建一次熔炉，建完即耗尽
  game.sim.chestAdd(chest, 'ironPlate', 4);   // 实验室还缺电路板：阶段 2 停留「已预留铁板、等待」
  const p = submit(game, [
    bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }),
    bpEntry('lab', 1, 0, 0),
  ], 40, 10);
  game.construction.splitStage(p.id, 1);
  ticks(game, 1);
  const fur = game.map.buildingAt(40, 10);
  ok(!!fur, '阶段 1 建成（tick 末），闸门待下一 tick 开放');
  ok(chestCount(chest, 'stone') === 0, '熔炉建造成 5 石头已耗尽');
  ticks(game, 1);   // 下一 tick：闸门开放、冷却清零，阶段 2 立即备料（缺电路板）
  // 让阶段 2 已预留部分建材（实验室铁板 4 已取），再拆闸门建筑
  let p2 = game.construction.byId(p.id);
  ok(p2 && (p2.entries[1].stock.ironPlate || 0) === 4, '阶段 2 已预留铁板 4');
  ok(p2.stages[0].gate.opened === true, '闸门已开放');
  ok(!game.map.buildingAt(41, 10), '缺电路板，阶段 2 未落成');
  game.removeBuilding(fur);   // 拆除已开放闸门的建成建筑（建造石头不退还，无料重建）
  // 先单独对账：验证回退/关闸/释放预留
  p2 = game.construction.byId(p.id);
  game.construction.reconcileStages(p2);
  p2 = game.construction.byId(p.id);
  ok(p2.entries[0].state === 'wait' && p2.activeStage === 0 && p2.stages[0].gate.opened === false,
    '对账：熔炉回退为待建、闸门重新关闭、活跃阶段回到 0');
  ok(chestCount(chest, 'ironPlate') === 4, '后续阶段预留被释放回物流（铁板回到箱子 4 件）');
  ok(Object.keys(p2.entries[1].stock).length === 0, '阶段 2 条目预留记账清空');
  ok(!game.map.buildingAt(41, 10), '阶段 2 实验室未建成（挂起）');
  // 跑若干 tick：无石头，熔炉无法重建，后续阶段持续挂起
  ticks(game, 5);
  p2 = game.construction.byId(p.id);
  ok(p2 && !game.map.buildingAt(40, 10) && p2.activeStage === 0 && !game.map.buildingAt(41, 10),
    '缺石头：熔炉不重建、后续阶段保持挂起');
  // 石头回库 → 阶段 1 重建 → 闸门再开 → 阶段 2 建成
  game.sim.chestAdd(chest, 'stone', 5);
  ticks(game, 12);
  ok(!!game.map.buildingAt(40, 10), '补石头后阶段 1 熔炉重新建成');
  game.sim.chestAdd(chest, 'circuit', 1);   // 补齐阶段 2 缺料
  ticks(game, 20);
  ok(!!game.map.buildingAt(41, 10), '闸门再次开放，阶段 2 实验室建成');
  ok(game.construction.plans.length === 0, '重建后计划整体完工');
}

// ============================================================
console.log('\n[7] 阶段编辑：删除阶段边界即解除挂起（前置取消语义），后续立即放行');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'stone', 5);
  game.sim.chestAdd(chest, 'ironPlate', 4);
  game.sim.chestAdd(chest, 'circuit', 1);
  const p = submit(game, [
    bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }),
    bpEntry('lab', 1, 0, 0),
  ], 46, 10);
  game.construction.splitStage(p.id, 1);
  game.construction.setStageGate(p.id, 0, { mode: 'trial', item: null, n: 99 });  // 永不达标
  ticks(game, 10);
  ok(!!game.map.buildingAt(46, 10) && !game.map.buildingAt(47, 10), '阶段1建成，阶段2被试产闸门挂起');
  // 删除阶段边界（= 取消前置条件）
  ok(game.construction.removeStage(p.id, 0), '删除阶段 0 边界，两阶段合并');
  const p2 = game.construction.byId(p.id);
  ok(p2.stages.length === 1 && p2.stages[0].gate === null, '合并为单个无闸门阶段');
  ticks(game, 20);
  ok(!!game.map.buildingAt(47, 10), '前置取消后后续施工立即放行，实验室建成');
}

// ============================================================
console.log('\n[8] 跳过条目不阻塞建成闸门；末尾阶段无闸门');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'ironPlate', 2);
  // 阶段1：传送带 + 传送带；第二格提前占箱 → 跳过；阶段2：传送带
  const p = submit(game, [
    bpEntry('belt', 0, 0, 1), bpEntry('belt', 1, 0, 1), bpEntry('belt', 2, 0, 1),
  ], 10, 30);
  game.construction.splitStage(p.id, 2);
  P(game, 'chest', 11, 30);   // 抢占第二格 → 该条目 skip
  ticks(game, 20);
  ok(!!game.map.buildingAt(10, 30) && game.map.buildingAt(11, 30).type === 'chest',
    '阶段 1：第一格建成、第二格跳过');
  ok(!!game.map.buildingAt(12, 30), 'skip 不阻塞闸门，阶段 2 传送带照常建成');
  ok(game.construction.plans.length === 0, '计划完工出列');
}

// ============================================================
console.log('\n[9] 切分点校验：越界/重复幂等；末尾阶段不可删除');
{
  const game = mkGame();
  const p = submit(game, [bpEntry('belt', 0, 0), bpEntry('belt', 1, 0), bpEntry('belt', 2, 0)], 10, 20);
  ok(game.construction.splitStage(p.id, 0) === false, 'cut=0 非法');
  ok(game.construction.splitStage(p.id, 3) === false, 'cut=entries.length 非法');
  ok(game.construction.splitStage(p.id, 1), 'cut=1 合法');
  ok(game.construction.splitStage(p.id, 1) === true && p.stages.length === 2, '重复切分幂等');
  ok(game.construction.removeStage(p.id, p.stages.length - 1) === false, '末尾阶段边界不可删除');
  ok(game.construction.setStageGate(p.id, p.stages.length - 1, { mode: 'built' }) === false,
    '末尾阶段不能设置闸门');
}

// ============================================================
console.log('\n[10] 升级计划分阶段：首栋替换并试闸，后续阶段挂起/放行');
{
  const game = mkGame();
  game.research.completed.add('steelSmelting');
  game.research.completed.add('logistics2');
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'stone', 6);
  game.sim.chestAdd(chest, 'steelPlate', 4);
  game.sim.chestAdd(chest, 'ironPlate', 1);
  game.sim.chestAdd(chest, 'gear', 1);
  game.sim.chestAdd(chest, 'circuit', 1);
  P(game, 'furnace', 20, 10);
  P(game, 'belt', 21, 10, 1);
  ok(game.previewUpgrade(20, 10, 21, 10) === 2 && game.confirmUpgrade(), '框选 2 栋提交升级计划');
  const p = game.construction.plans[0];
  // 预览顺序按 y,x：furnace(20,10) 在 belt(21,10) 前
  ok(p.entries[0].from === 'furnace' && p.entries[1].from === 'belt', '升级条目顺序：熔炉→传送带');
  game.construction.splitStage(p.id, 1);
  ticks(game, 1);   // tick 1 末：阶段 1 熔炉替换，闸门待下一 tick 开放
  ok(game.map.buildingAt(20, 10).type === 'steelFurnace', '阶段 1：石炉升级为钢炉');
  ok(game.map.buildingAt(21, 10).type === 'belt', '闸门开放前传送带保持旧型号');
  // tick 2 对账：闸门开放、新阶段冷却清零，传送带建材齐备 → 当 tick 末即替换
  ticks(game, 1);
  ok(game.map.buildingAt(21, 10).type === 'fastBelt', '闸门开放后阶段 2：传送带立即升级为快速带');
  ticks(game, 1);   // 下一 tick 清理完工计划
  ok(game.construction.plans.length === 0, '升级计划完工');
}

// ============================================================
console.log('\n[11] 阶段进度随存档恢复：切分/闸门/试产基线/open 状态往返');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'stone', 5);
  const p = submit(game, [
    bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }),
    bpEntry('lab', 1, 0, 0),
  ], 30, 30);
  game.construction.splitStage(p.id, 1);
  game.construction.setStageGate(p.id, 0, { mode: 'trial', item: 'ironPlate', n: 5 });
  ticks(game, 10);
  const fur = game.map.buildingAt(30, 30);
  ok(!!fur, '阶段 1 熔炉建成（试产挂起中）');
  fur.slots.inputs.ironOre.count = 10;
  ticks(game, 30);   // 完成若干次（<5 次或部分）
  const before = game.construction.byId(p.id);
  const progBefore = game.construction.trialProgress(before, 0);

  const data = JSON.parse(JSON.stringify(game.serialize()));
  ok(data.construction.plans[0].stages.length === 2, '存档包含 2 个阶段');
  const sg = data.construction.plans[0].stages[0].gate;
  ok(sg.mode === 'trial' && sg.item === 'ironPlate' && sg.n === 5, '闸门（试产/铁板/5 次）序列化');
  ok(typeof data.construction.plans[0].entries[0].base === 'number', '试产基线 base 随条目保存');

  const g2 = new FG.Game();
  g2.deserialize(data);
  const q = g2.construction.plans[0];
  ok(q.stages.length === 2 && q.stages[0].gate.mode === 'trial' && q.stages[0].gate.item === 'ironPlate',
    '读档后阶段与闸门恢复');
  ok(g2.construction.trialProgress(q, 0) === progBefore, '试产进度读档后一致（' + progBefore + '）');
  ok(!g2.map.buildingAt(31, 30), '阶段 2 仍挂起');
  const fur2 = g2.map.buildingAt(30, 30);
  fur2.slots.inputs.ironOre.count = 40;
  const c2 = g2.map.buildingAt(5, 5);
  g2.sim.chestAdd(c2, 'ironPlate', 4);
  g2.sim.chestAdd(c2, 'circuit', 1);
  ticks(g2, 120);
  ok(!!g2.map.buildingAt(31, 30), '读档后试产达标，阶段 2 建成续建');
  ok(g2.construction.plans.length === 0, '续建完工出列');
}

// ============================================================
console.log('\n[12] 旧存档兼容：无 stages 字段 → 单阶段无闸门，行为不变');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'ironPlate', 4);
  const p = submit(game, [bpEntry('lab', 0, 0, 0)], 52, 30);
  ticks(game, 3);
  const data = JSON.parse(JSON.stringify(game.serialize()));
  // 手工剥成旧档：删 stages / base / activeStage
  delete data.construction.plans[0].stages;
  delete data.construction.plans[0].activeStage;
  for (const e of data.construction.plans[0].entries) delete e.base;
  const g2 = new FG.Game();
  let err = null;
  try {
    g2.deserialize(data);
    ticks(g2, 5);
  } catch (e) { err = e; }
  ok(!err, '旧档（无阶段字段）读取与仿真不报错' + (err ? '：' + err.stack : ''));
  const q = g2.construction.plans[0];
  ok(q && q.stages.length === 1 && q.stages[0].gate === null && q.activeStage === 0,
    '回退为单阶段无闸门');
  ok((q.entries[0].stock.ironPlate || 0) === 4, '条目预留随档恢复');

  // 更旧：无 construction 字段
  const g3 = new FG.Game();
  const old = JSON.parse(JSON.stringify(data));
  delete old.construction;
  err = null;
  try { g3.deserialize(old); ticks(g3, 5); } catch (e) { err = e; }
  ok(!err && g3.construction.plans.length === 0, '无施工字段旧档回退空计划');
}

// ============================================================
console.log('\n[13] 多阶段：试产达标后第三阶段才放行（端到端三阶段）');
{
  const game = mkGame();
  const chest = P(game, 'chest', 5, 5);
  game.sim.chestAdd(chest, 'stone', 10);
  game.sim.chestAdd(chest, 'ironPlate', 8);
  game.sim.chestAdd(chest, 'circuit', 2);
  game.sim.chestAdd(chest, 'ironOre', 80);
  // 阶段0=熔炉(试产2次)  阶段1=实验室1(建成)  阶段2=实验室2
  const p = submit(game, [
    bpEntry('furnace', 0, 0, 0, { recipe: 'smelt:iron' }),
    bpEntry('lab', 1, 0, 0),
    bpEntry('lab', 2, 0, 0),
  ], 20, 24);
  game.construction.splitStage(p.id, 1);
  game.construction.splitStage(p.id, 2);
  ok(p.stages.length === 3, '切分为 3 阶段');
  game.construction.setStageGate(p.id, 0, { mode: 'trial', n: 2 });
  game.construction.setStageGate(p.id, 1, { mode: 'built' });
  ticks(game, 12);
  const fur = game.map.buildingAt(20, 24);
  ok(!!fur && !game.map.buildingAt(21, 24), '阶段0熔炉建成，阶段1挂起（试产）');
  fur.slots.inputs.ironOre.count = 30;
  // 轮询：一旦阶段 1 实验室建成，立刻确认阶段 2 仍挂起（避免再多 tick 让阶段 2 也建成）
  let lab1BuiltAt = -1;
  for (let i = 0; i < 120; i++) {
    ticks(game, 1);
    if (game.map.buildingAt(21, 24)) { lab1BuiltAt = i + 1; break; }
  }
  ok(lab1BuiltAt > 0, '阶段 0 试产达标后阶段 1 实验室建成（第 ' + lab1BuiltAt + ' tick）');
  ok(!game.map.buildingAt(22, 24), '阶段 1 刚建成、闸门未开放，阶段 2 仍挂起');
  const pl = game.construction.byId(p.id);
  ok(pl && pl.activeStage === 1 && pl.stages[1].gate.opened === false, '活跃阶段停在 1，阶段 1 建成闸门待下 tick 开放');
  ticks(game, 12);
  ok(!!game.map.buildingAt(22, 24), '阶段1建成闸门开放 → 阶段2建成');
  ok(game.construction.plans.length === 0, '三阶段计划完工');
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
