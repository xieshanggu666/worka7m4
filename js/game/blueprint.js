/**
 * FG.Blueprint —— 蓝图：框选捕获、旋转、成本汇总、科技/地形校验
 * FG.Construction —— 施工调度：计划优先级 × 前置依赖 × 全局建材统一分配
 *
 * 调度模型（每 tick 一轮）：
 *  - 先盘点全图「自由建材」（箱子→地面物料堆）构成统一预算池，所有计划共享；
 *  - 计划可设高/中/低优先级与前置依赖：高优先级一层未取料前低优先级不分配，
 *    同级按轮转游标公平起步；前置计划未完成（仍在列表中）时本计划挂起、不占料；
 *  - 每个计划按蓝图顺序找「前沿条目」：尽量从预算池预留其缺口建材（可部分预留，
 *    预留即移出物流）；前沿凑不齐时，向后找一栋「当前能一次凑齐整套成本」的条目
 *    直接建成 —— 即缺料时推进可施工部分；
 *  - 建材凑齐且施工间隔到期 → 消耗预留、落成建筑（map/sim 注册 + 配方/筛选/优先级
 *    还原），自动纳入每 tick 的按需物流调度；
 *  - 暂停计划 / 等待前置 / 取消计划：已预留建材立即返还物流（优先箱子，余下落地），
 *    已建成建筑保留；前置计划被取消视为依赖自动满足；
 *  - 预留按条目记账，计划整体序列化（含优先级/依赖/暂停态/条目预留），读档续建；
 *    旧存档的计划级 stock 迁移到前沿条目，无施工字段的旧档回退空计划。
 *
 * 分阶段施工（阶段前置门控）：
 *  - 前置依赖 dep = {id, mode, count}，每个计划即一个生产阶段，蓝图/升级计划均可设置：
 *      mode='build'   建成放行：前置计划完工（或被取消）即放行——兼容旧行为；
 *      mode='produce' 试产达标放行：前置计划完工后进入试产观察，其生产建筑（含矿机）
 *                     累计产出 ≥ count 才放行，缺料时产量停涨、后继保持挂起；
 *  - 阶段记录 stageRecords：前置计划完工/取消且仍被后继引用时留下观察档案
 *    （建成建筑坐标、生产建筑坐标、累计试产量与产量基线），随存档序列化；
 *  - 联动挂起：前置被取消（试产条件失效）、前置缺料（试产停涨）或前置已建成建筑被拆
 *    时，后继计划自动挂起并释放全部预留；被拆建筑原地重建（含原地升级的高级型号）
 *    后门控自动重开；门控每 tick 连续评估，状态迁移时写事件日志；
 *  - 旧存档兼容：deps 为字符串数组的旧档迁移为 build 模式；无 stageRecords 字段回退
 *    空表，悬空依赖照常剔除。
 *
 * 原地升级（kind='upgrade'）：
 *  - 升级计划条目带 from（原建筑类型）：备料成本为新建筑造价，落成时把该格旧建筑
 *    原地替换为高级型号 —— 配方、槽位库存、流体、传送带在途物品（含预留标签）、
 *    机械臂手持/筛选/按需、供料优先级全部迁移，在途预留因消费者坐标不变而继续有效；
 *  - 计划期间原建筑被拆/变更 → 条目跳过并释放预留；该格已是目标型号 → 直接记完成；
 *  - 暂停/取消与蓝图计划一致：未用预留建材返还物流，已完成的升级保留；
 *  - 旧存档无 kind/from 字段 → 按普通建造计划处理，行为不变。
 */
FG.Blueprint = (() => {

  /** 框选捕获：把矩形区域内的建筑存为相对坐标蓝图（含配方/筛选/按需/优先级） */
  function capture(map, x0, y0, x1, y1) {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const entries = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const b = map.buildingAt(x, y);
        if (!b) continue;
        entries.push({
          type: b.type, dx: x - minX, dy: y - minY, dir: b.dir || 0,
          recipe: b.recipe || null,
          filter: b.filter || null,
          demandMode: !!b.demandMode,
          priority: b.priority || 'normal',
          stationName: b.stationName || null,
        });
      }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1, entries };
  }

  /** 顺时针旋转 90°：条目坐标与朝向同步旋转（require 资源约束一并保留） */
  function rotate(bp) {
    return {
      w: bp.h, h: bp.w,
      fromPreset: bp.fromPreset || null,
      entries: bp.entries.map(e => ({
        type: e.type, dx: bp.h - 1 - e.dy, dy: e.dx, dir: ((e.dir || 0) + 1) % 4,
        recipe: e.recipe || null,
        filter: e.filter || null,
        demandMode: !!e.demandMode,
        priority: e.priority || 'normal',
        stationName: e.stationName || null,
        require: e.require ? Object.assign({}, e.require) : undefined,
      })),
    };
  }

  /** 蓝图建材总成本 {item: n} */
  function costOf(bp) {
    const total = {};
    for (const e of bp.entries) {
      const c = FG.Buildings.costOf(e.type);
      for (const k of Object.keys(c)) total[k] = (total[k] || 0) + c[k];
    }
    return total;
  }

  /**
   * 放置校验（科技 + 配方 + 地形/占用 + 资源约束 + 施工计划占格）：
   * 返回 { ok, reason, cells:[{x,y,ok,reason}] }，cells 与 entries 同序（预览着色用）。
   * 一键流水线预设可在条目上带 require：
   *   require.terrain='ore'   须为矿脉格（oreType 指定矿种时还须矿种相符）
   *   require.terrain='water' 水泵：陆地格且四邻有水域
   *   require.terrain='oil'   须为油田格
   */
  function validate(game, bp, ox, oy) {
    const cells = [];
    let ok = true;
    const locked = new Set();
    const lockedRecipes = new Set();
    let blocked = 0, badOre = 0, noWater = 0, noOil = 0;
    for (const e of bp.entries) {
      const x = ox + e.dx, y = oy + e.dy;
      let cok = true, reason = '';
      if (!game.research.isBuildingUnlocked(e.type)) {
        cok = false; reason = 'tech';
        locked.add(FG.Buildings.byId(e.type).name);
      } else if (e.recipe && !game.research.isRecipeUnlocked(e.recipe)) {
        cok = false; reason = 'tech';
        lockedRecipes.add(FG.Recipes.byId(e.recipe).name);
      } else if (e.require && e.require.terrain === 'ore') {
        // 矿机：目标格必须是（指定种类的）矿脉
        const ore = game.map.inBounds(x, y) ? game.map.oreAt(x, y) : null;
        if (!ore) { cok = false; reason = 'terrain'; badOre++; }
        else if (e.require.oreType && ore !== e.require.oreType) { cok = false; reason = 'oretype'; badOre++; }
        else if (game.map.isOccupied(x, y) || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; blocked++;
        }
      } else if (e.require && e.require.terrain === 'water') {
        // 水泵：陆地（非水面）且四邻有水域
        const landOK = game.map.inBounds(x, y) && game.map.terrainAt(x, y) !== 'water';
        if (!landOK || !game.adjacentWater(x, y)) {
          cok = false; reason = 'terrain'; noWater++;
        } else if (game.map.isOccupied(x, y) || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; blocked++;
        }
      } else if (e.require && e.require.terrain === 'oil') {
        if (!game.map.isOil(x, y) || game.map.isOccupied(x, y)
            || (game.construction && game.construction.entryAt(x, y))) {
          cok = false; reason = 'terrain'; noOil++;
        }
      } else if (!game.canPlace(e.type, x, y)) {
        cok = false; reason = 'terrain'; blocked++;
      } else if (game.construction && game.construction.entryAt(x, y)) {
        cok = false; reason = 'planned'; blocked++;
      }
      if (!cok) ok = false;
      cells.push({ x, y, ok: cok, reason });
    }
    let msg = '';
    if (locked.size || lockedRecipes.size) {
      msg = '科技未解锁：' + Array.from(locked).concat(Array.from(lockedRecipes)).join('、');
    } else if (badOre) msg = badOre + ' 个矿机位未对准矿脉（矿机需落在对应矿脉上）';
    else if (noWater) msg = noWater + ' 个水泵位无效（需在陆地上且紧邻水域）';
    else if (noOil) msg = noOil + ' 个抽油机位未对准油田';
    else if (blocked) msg = blocked + ' 个位置被占用 / 地形不符 / 已有施工计划';
    return { ok, reason: msg, cells };
  }

  return { capture, rotate, costOf, validate };
})();

// ============================================================
FG.Construction = class Construction {
  constructor(game) {
    this.game = game;
    this.plans = [];   // [{id,name,priority,paused,deps:[{id,mode,count}],entries:[{...state,stock}],cursor,timer}]
    this.seq = 1;
    this.tierStart = { high: 0, normal: 0, low: 0 }; // 同级轮转起步游标（每 tick）
    this.stageRecords = []; // 阶段记录：已完工/取消且仍被后继前置引用的计划观察档案
  }

  /** 提交施工计划：蓝图条目落到世界坐标，进入统一调度队列 */
  addPlan(bp, ox, oy, opts) {
    opts = opts || {};
    const plan = {
      id: 'P' + (this.seq++),
      name: '蓝图 ' + bp.w + '×' + bp.h + ' #' + (this.seq - 1),
      kind: 'build',
      priority: VALID_PRIORITIES[opts.priority] ? opts.priority : 'normal',
      paused: false,
      deps: [],                 // 阶段前置 [{id,mode,count}]：门控全部放行前本计划挂起
      entries: bp.entries.map(e => ({
        type: e.type, from: null, x: ox + e.dx, y: oy + e.dy, dir: e.dir || 0,
        recipe: e.recipe || null, filter: e.filter || null,
        demandMode: !!e.demandMode, priority: e.priority || 'normal',
        stationName: e.stationName || null,
        state: 'wait',           // wait | done | skip
        stock: {},               // 该条目已预留（移出物流）的建材
      })),
      cursor: 0,
      timer: 0,
      waiting: false,            // 缺料等待（UI 状态）
      blocked: false,            // 等待前置依赖（UI 状态）
    };
    this.plans.push(plan);
    FG.Events.emit('construction:change');
    return plan;
  }

  /**
   * 提交原地升级计划：list 为 [{from,to,x,y,dir}]（框选产线生成）。
   * 逐栋按新建筑造价备料，凑齐后原地替换并迁移配方/库存/在途物料。
   */
  addUpgradePlan(list, opts) {
    opts = opts || {};
    const plan = {
      id: 'P' + (this.seq++),
      name: '产线升级 #' + (this.seq - 1),
      kind: 'upgrade',
      priority: VALID_PRIORITIES[opts.priority] ? opts.priority : 'normal',
      paused: false,
      deps: [],
      entries: list.map(u => ({
        type: u.to, from: u.from, x: u.x, y: u.y, dir: u.dir || 0,
        recipe: null, filter: null,            // 配方/筛选等落成时从旧建筑实时迁移
        demandMode: false, priority: 'normal',
        stationName: null,
        state: 'wait',
        stock: {},
      })),
      cursor: 0,
      timer: 0,
      waiting: false,
      blocked: false,
    };
    this.plans.push(plan);
    FG.Events.emit('construction:change');
    return plan;
  }

  /** 某格是否有待建条目（校验/悬浮提示用），暂停计划的格子同样占位 */
  entryAt(x, y) {
    for (const p of this.plans) {
      for (const e of p.entries) {
        if (e.state === 'wait' && e.x === x && e.y === y) return { plan: p, entry: e };
      }
    }
    return null;
  }

  // ================= 计划操作（面板） =================
  /** 设置计划优先级（高/中/低），立即参与下一轮统一分配 */
  setPriority(planId, priority) {
    const p = this.byId(planId);
    if (!p || !VALID_PRIORITIES[priority]) return false;
    p.priority = priority;
    FG.Events.emit('construction:change');
    return true;
  }

  setPaused(planId, paused) {
    const p = this.byId(planId);
    if (!p || p.paused === paused) return false;
    p.paused = paused;
    if (paused) this.releaseReserved(p); // 暂停即释放全部预留，建材回归物流
    FG.Events.emit('construction:change');
    return true;
  }

  togglePaused(planId) {
    const p = this.byId(planId);
    return p ? this.setPaused(planId, !p.paused) : false;
  }

  /**
   * 设置前置依赖（覆盖式）：depIds 为计划 id 或 {id,mode,count} 混合数组；
   * 自动剔除不存在/已完工/自身的 id，并做环检测；
   * 加入依赖会让计划立即挂起并释放预留，解除依赖后自动恢复。
   */
  setDeps(planId, depIds) {
    const p = this.byId(planId);
    if (!p) return false;
    const deps = [];
    for (const raw of depIds || []) {
      const d = normDep(raw);
      if (!d) continue;
      const target = this.byId(d.id);
      if (target && target !== p && !deps.some(x => x.id === d.id)) deps.push(d);
    }
    p.deps = deps;
    if (this.createsCycle(p)) {
      p.deps = [];
      this.game.logMsg('⚠ 无法为「' + p.name + '」设置前置：存在循环依赖', 'error');
      return false;
    }
    if (deps.length && !this.depsSatisfied(p)) this.releaseReserved(p);
    FG.Events.emit('construction:change');
    return true;
  }

  addDep(planId, depId, mode, count) {
    const p = this.byId(planId);
    if (!p) return false;
    if (p.deps.some(d => d.id === depId)) return true;
    const next = p.deps.concat([normDep({ id: depId, mode, count })]);
    return this.setDeps(planId, next);
  }

  removeDep(planId, depId) {
    const p = this.byId(planId);
    if (!p) return false;
    p.deps = p.deps.filter(d => d.id !== depId);
    FG.Events.emit('construction:change');
    return true;
  }

  /**
   * 设置某条前置的放行模式：'build' 建成放行 / 'produce' 试产达标放行（count 件）。
   * 切换后门控下一 tick 重新评估；若转为不满足，计划联动挂起并释放预留。
   */
  setDepMode(planId, depId, mode, count) {
    const p = this.byId(planId);
    if (!p) return false;
    const d = p.deps.find(x => x.id === depId);
    if (!d) return false;
    if (mode === 'build' || mode === 'produce') d.mode = mode;
    if (count !== undefined && count !== null && !isNaN(count)) {
      d.count = Math.max(1, Math.min(99999, Math.floor(count)));
    }
    if (d.mode === 'produce' && !(d.count > 0)) d.count = FG.Config.TRIAL_PRODUCE_DEFAULT;
    if (!this.depsSatisfied(p)) this.releaseReserved(p); // 门控关闭 → 立即释放预留
    FG.Events.emit('construction:change');
    return true;
  }

  byId(id) { return this.plans.find(p => p.id === id) || null; }
  recordById(id) { return this.stageRecords.find(r => r.id === id) || null; }

  /** 前置是否全部满足（逐条评估阶段门控，见 gateState） */
  depsSatisfied(p) {
    for (const d of p.deps) if (!this.gateState(d).satisfied) return false;
    return true;
  }

  /**
   * 单条阶段前置的门控状态（每 tick 连续评估，不锁存）：
   *  前置施工中 → building；前置已取消 → build 视为满足 / produce 条件失效挂起；
   *  前置已完工 → build 要求建成建筑仍在位（被拆 → demolished 联动挂起）；
   *              produce 要求生产建筑在位且累计试产 ≥ count（缺料 → starving 提示）。
   */
  gateState(dep) {
    const live = this.byId(dep.id);
    if (live) return { satisfied: false, reason: 'building', name: live.name };
    const rec = this.recordById(dep.id);
    if (!rec) {
      // 无记录：前置完工/取消时无人引用（或旧档缺字段）→ 视为满足，避免死锁
      return { satisfied: true, reason: 'gone', name: dep.id };
    }
    if (rec.cancelled) {
      return dep.mode === 'produce'
        ? { satisfied: false, reason: 'cancelled', name: rec.name }
        : { satisfied: true, reason: 'cancelled-ok', name: rec.name };
    }
    if (dep.mode === 'produce') {
      const need = dep.count > 0 ? dep.count : FG.Config.TRIAL_PRODUCE_DEFAULT;
      let missing = 0, starving = false;
      for (const w of rec.producers) {
        const b = this.game.map.buildingAt(w.x, w.y);
        if (!b || !isSameOrUpgrade(w.type, b.type)) missing++;
        else if (b.status === 'starving') starving = true;
      }
      if (missing) return { satisfied: false, reason: 'demolished', missing, name: rec.name };
      if ((rec.produced || 0) < need) {
        return { satisfied: false, reason: 'producing', name: rec.name,
          produced: rec.produced || 0, count: need, starving };
      }
      return { satisfied: true, reason: 'produced', name: rec.name, produced: rec.produced, count: need };
    }
    // build 模式：前置建成后其建成建筑须仍在位（原地升级的高级型号视为同一建筑）
    let missing = 0;
    for (const w of rec.buildings) {
      const b = this.game.map.buildingAt(w.x, w.y);
      if (!b || !isSameOrUpgrade(w.type, b.type)) missing++;
    }
    if (missing) return { satisfied: false, reason: 'demolished', missing, name: rec.name };
    return { satisfied: true, reason: 'built', name: rec.name };
  }

  /** 从 p 沿 deps 边是否能走回 p（环检测） */
  createsCycle(p) {
    const stack = p.deps.map(d => d.id);
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === p.id) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const d = this.byId(id);
      if (d) stack.push(...d.deps.map(x => x.id));
    }
    return false;
  }

  // ================= 阶段记录（分阶段施工的观察档案） =================
  /**
   * 前置计划完工/取消时留下阶段记录（仅当仍被其他计划的前置引用）：
   * 记录建成建筑坐标（build 门控观察）、生产建筑坐标与产量基线（produce 门控试产累计）。
   */
  leaveStageRecord(p, cancelled) {
    const referenced = this.plans.some(q => q !== p && q.deps.some(d => d.id === p.id));
    if (!referenced || this.recordById(p.id)) return;
    const rec = { id: p.id, name: p.name, kind: p.kind || 'build', cancelled: !!cancelled,
      buildings: [], producers: [], produced: 0, last: {} };
    if (!cancelled) {
      for (const e of p.entries) {
        if (e.state !== 'done') continue;
        rec.buildings.push({ x: e.x, y: e.y, type: e.type });
        const def = FG.Buildings.byId(e.type);
        if (def.recipeBuilding || e.type === 'miner') {
          rec.producers.push({ x: e.x, y: e.y, type: e.type });
          const b = this.game.map.buildingAt(e.x, e.y);
          rec.last[e.x + ',' + e.y] = b ? (b.totalCrafted || 0) : 0;
        }
      }
    }
    this.stageRecords.push(rec);
  }

  /** 每 tick 从在位的生产建筑累计试产量（差值法；被拆建筑保留基线，重建后续计） */
  accumulateTrial() {
    for (const rec of this.stageRecords) {
      if (rec.cancelled || !rec.producers.length) continue;
      for (const w of rec.producers) {
        const b = this.game.map.buildingAt(w.x, w.y);
        if (!b || !isSameOrUpgrade(w.type, b.type)) continue;
        const key = w.x + ',' + w.y;
        const cur = b.totalCrafted || 0;
        const prev = rec.last[key];
        if (prev === undefined) { rec.last[key] = cur; continue; }
        if (cur > prev) rec.produced += cur - prev;
        rec.last[key] = cur;
      }
    }
  }

  /** 门控未满足原因 → 日志/面板文案 */
  gateLogText(g) {
    if (!g) return '前置条件失效';
    switch (g.reason) {
      case 'building': return '前置「' + g.name + '」尚未完工';
      case 'cancelled': return '前置「' + g.name + '」已取消，试产条件失效';
      case 'demolished': return '前置「' + g.name + '」有建筑被拆除（' + g.missing + ' 栋）';
      case 'producing': return '前置「' + g.name + '」试产未达标（' + g.produced + '/' + g.count + '）';
      default: return '前置条件未满足';
    }
  }

  // ================= 主循环：统一建材池 × 优先级分层 × 同级轮转 =================
  tick() {
    // 先清理已无待建条目的计划（返还残余预留），避免 depsSatisfied 误判
    for (let i = this.plans.length - 1; i >= 0; i--) {
      const p = this.plans[i];
      if (!p.entries.some(e => e.state === 'wait')) {
        this.finish(p);
        this.plans.splice(i, 1);
      }
    }
    // 阶段记录：累计前置试产量，并清理不再被任何前置引用的档案
    this.accumulateTrial();
    if (this.stageRecords.length) {
      const refs = new Set();
      for (const p of this.plans) for (const d of p.deps) refs.add(d.id);
      this.stageRecords = this.stageRecords.filter(r => refs.has(r.id));
    }
    if (!this.plans.length) return;

    // 状态复位 + 暂停/挂起计划释放预留（不参与本轮分配）；
    // 阶段门控连续评估：前置取消/缺料/建筑被拆 → 门控关闭，后继联动挂起并释放预留
    for (const p of this.plans) {
      p.waiting = false;
      p.blocked = false;
      const gates = p.deps.map(d => this.gateState(d));
      const okAll = gates.every(g => g.satisfied);
      if (p._gateOk !== undefined && p._gateOk !== okAll && !p.paused) {
        if (okAll) {
          this.game.logMsg('✅ 前置条件已满足，「' + p.name + '」解除挂起、开始备料', 'unlock');
        } else {
          const g = gates.find(x => !x.satisfied);
          this.game.logMsg('⚠ ' + this.gateLogText(g) + '，「' + p.name + '」联动挂起并释放预留', 'error');
        }
      }
      p._gateOk = okAll;
      p._gates = gates;
      if (p.paused || !okAll) {
        p.blocked = !p.paused; // 暂停优先显示「已暂停」
        this.releaseReserved(p);
      }
    }

    // 全局自由建材池：箱子 → 地面物料堆（每 tick 盘点一次，所有计划共享预算）
    const pool = new MaterialPool(this.game);
    this.tierStart = { high: 0, normal: 0, low: 0 };

    for (const tier of TIERS) {
      const list = this.plans.filter(p => p.priority === tier && !p.paused && this.depsSatisfied(p));
      if (!list.length) continue;
      // 同级从轮转游标起步，每轮回到同一计划时其 cursor 已推进
      const start = this.tierStart[tier] % list.length;
      let progressed = false;
      for (let n = 0; n < list.length; n++) {
        const p = list[(start + n) % list.length];
        if (this.processPlan(p, pool)) progressed = true;
      }
      // 本轮有计划推进（预留/落成），下轮从它后面开始：同级公平
      if (progressed) this.tierStart[tier] = (start + 1) % list.length;
    }
  }

  /**
   * 条目当前可否落成：
   *  普通条目：目标格可放置（canPlace）；
   *  升级条目：该格仍是原型号 → 'ok'；已是目标型号（玩家手动替换过）→ 'done'（不耗料记完成）；
   *            原建筑被拆/变更 → 'skip'。
   */
  checkEntry(e) {
    if (!e.from) return this.game.canPlace(e.type, e.x, e.y) ? 'ok' : 'skip';
    const cur = this.game.map.buildingAt(e.x, e.y);
    if (cur && cur.type === e.type) return 'done';
    if (!cur || cur.type !== e.from) return 'skip';
    return 'ok';
  }

  /**
   * 推进单个计划一轮：
   *  1. 跳过已建成/被占位的条目，推进 cursor；
   *  2. 前沿条目尽量预留缺口建材（可部分预留），凑齐且间隔到期则建成；
   *  3. 前沿缺料时，向后找一栋「整套成本本轮能一次凑齐」的条目先建（推进可施工部分）。
   * 返回本轮是否有推进（预留到新料或落成建筑）。
   */
  processPlan(p, pool) {
    let progressed = false;

    // 落成节奏：相邻建筑间隔 CONSTRUCT_BUILD_INTERVAL tick（冷却中只推进游标，不占料）
    if (p.timer > 0) p.timer--;

    // 推进 cursor 到下一待建条目；顺带复验已不可放置的条目（提交后被占 → 跳过）
    while (p.cursor < p.entries.length) {
      const e = p.entries[p.cursor];
      if (e.state !== 'wait') { p.cursor++; continue; }
      const chk = this.checkEntry(e);
      if (chk === 'done') {   // 升级目标已就位（手动替换）：不耗料直接记完成
        e.state = 'done';
        this.releaseEntryStock(e);
        p.cursor++;
        progressed = true;
        continue;
      }
      if (chk === 'skip') {
        e.state = 'skip';
        this.releaseEntryStock(e);
        this.game.logMsg('⚠ 「' + p.name + '」跳过 (' + e.x + ',' + e.y + ') '
          + FG.Buildings.byId(e.type).name + '：'
          + (e.from ? '原建筑已被拆除或变更' : '位置被占用或地形不符'), 'error');
        p.cursor++;
        progressed = true;
        continue;
      }
      break;
    }
    if (p.cursor >= p.entries.length) return progressed;
    // 落成冷却中：不提前抢料（避免占着建材不公平），等间隔到期下轮再分配
    if (p.timer > 0) return progressed;

    // 前沿条目：尽量预留（部分预留），凑齐即可建成
    const head = p.entries[p.cursor];
    if (this.pullEntry(head, pool, false)) progressed = true;
    let target = this.entryReady(head) ? head : null;

    // 前沿凑不齐：向后找一栋「现在就能凑齐整套成本」的条目先建（不抢前沿已预留的料）
    if (!target) {
      p.waiting = true;
      for (let i = p.cursor + 1; i < p.entries.length; i++) {
        const e = p.entries[i];
        if (e.state !== 'wait' || this.checkEntry(e) !== 'ok') continue;
        // 已成套（可能上一 tick 冷却期已预留）或本轮能成套取出，即作为先建目标；
        // all=true 两阶段原子：成套或一件不取，无回滚
        if (this.entryReady(e) || this.pullEntry(e, pool, true)) { target = e; break; }
      }
    }

    if (target && p.timer <= 0) {
      this.consumeAndBuild(p, target);
      progressed = true;
      if (target === head) p.cursor++;
    }
    return progressed;
  }

  /** 条目预留是否已凑齐整套成本 */
  entryReady(e) {
    const cost = FG.Buildings.costOf(e.type);
    for (const item of Object.keys(cost)) {
      if ((e.stock[item] || 0) < cost[item]) return false;
    }
    return true;
  }

  /**
   * 从统一建材池预留该条目缺口建材（两阶段，先验后取，无回滚路径）：
   *  all=true 必须整套都能凑齐（任一料不足则一件不取，供「可施工部分」探测）；
   *  all=false 尽量取（前沿条目可部分预留）。返回是否实际取到料。
   */
  pullEntry(e, pool, all) {
    const cost = FG.Buildings.costOf(e.type);
    const items = Object.keys(cost);
    const want = {};
    for (const item of items) {
      want[item] = cost[item] - (e.stock[item] || 0);
      if (all && want[item] > 0 && pool.available(item) < want[item]) return false;
    }
    let gotAny = false;
    for (const item of items) {
      if (want[item] <= 0) continue;
      const got = pool.take(item, want[item]); // all 模式必足量；非 all 模式取尽其有
      if (got > 0) {
        e.stock[item] = (e.stock[item] || 0) + got;
        gotAny = true;
      }
    }
    return gotAny;
  }

  /** 消耗条目预留建材，落成建筑并接入生产调度 */
  consumeAndBuild(p, e) {
    const cost = FG.Buildings.costOf(e.type);
    for (const item of Object.keys(cost)) {
      e.stock[item] -= cost[item];
      if (e.stock[item] <= 0) delete e.stock[item];
    }
    this.buildEntry(e);
    e.state = 'done';
    p.timer = FG.Config.CONSTRUCT_BUILD_INTERVAL;
    FG.Events.emit('construction:change');
  }

  /** 落成一栋建筑：注册进地图与仿真，还原产线配置（配方/筛选/按需/优先级） */
  buildEntry(e) {
    if (e.from) return this.swapEntry(e);   // 升级条目：原地替换
    const g = this.game;
    const b = FG.Map.create(e.type, e.x, e.y, e.dir);
    if (b.type === 'miner') b.oreType = g.map.oreAt(e.x, e.y);
    if (b.def.railStation) {
      b.stationId = 'S' + (g.railway.stationSeq++);
      b.stationName = e.stationName || ('站点 ' + b.stationId.slice(1));
    }
    g.map.register(b);
    g.sim.register(b);   // 接入生产调度：纳入每 tick 调度/传送带/机械臂/生产更新
    if (b.type === 'rail' || b.def.railStation) g.railway.markDirty();
    if (e.recipe && b.def.recipeBuilding && g.research.isRecipeUnlocked(e.recipe)) {
      b.recipe = e.recipe;
      FG.Map.syncRecipeSlots(b);
    }
    if (b.def.inserterTier !== undefined) {
      b.filter = e.filter;
      b.demandMode = e.demandMode;
    }
    if (b.def.recipeBuilding || b.type === 'lab') b.priority = e.priority;
    g.absorbPile(b);     // 回收该格地面物料
    FG.Events.emit('building:placed', b);
    return b;
  }

  /**
   * 原地升级替换：旧建筑拆除的同时新建筑同格同向落成，
   * 配方/库存/在途物料全部迁移（在途预留标签以消费者坐标为键，替换后继续有效）。
   */
  swapEntry(e) {
    const g = this.game;
    const old = g.map.buildingAt(e.x, e.y);
    if (!old || old.type !== e.from) return null;   // 调用前 checkEntry 已校验，双保险
    const nb = FG.Map.create(e.type, e.x, e.y, old.dir);
    // —— 状态迁移（保留配方、库存与在途物料）——
    nb.recipe = old.recipe;              // 同配方组（recipeGroup），配方直接兼容
    nb.progress = old.progress;          // 生产进度不丢
    nb.slots = old.slots;                // 输入/输出槽库存整体搬迁（含换配方残留料）
    nb.fluidTanks = old.fluidTanks;      // 流体缓冲罐
    nb.items = old.items;                // 传送带在途物品（含在途预留标签）
    nb.rr = old.rr;                      // 合流轮转游标
    nb.held = old.held;                  // 机械臂手持物品（含预留标签）
    nb.phase = old.phase; nb.timer = old.timer;
    nb.filter = old.filter; nb.demandMode = old.demandMode;
    nb.priority = old.priority;
    nb.totalCrafted = old.totalCrafted;
    g.sim.unregister(old);
    g.map.unregister(old);
    g.map.register(nb);
    g.sim.register(nb);                  // 新建筑接入生产调度
    if (nb.def.recipeBuilding) FG.Map.syncRecipeSlots(nb);
    if (g.selection === old) g.selection = nb;   // 选中态跟随新建筑
    g.absorbPile(nb);                    // 回收该格地面物料（如取消返还落在旧建筑脚下的建材）
    FG.Events.emit('building:placed', nb);
    return nb;
  }

  // ================= 预留释放（暂停 / 挂起依赖 / 取消） =================
  /** 返还单个条目的预留建材到该条目坐标（优先箱子，余下落地） */
  releaseEntryStock(e) {
    if (!e || !e.stock || !Object.keys(e.stock).length) return;
    this.refundToLogistics(e.stock, e.x, e.y);
  }

  /** 释放整个计划的全部条目预留（暂停 / 等待前置 / 取消） */
  releaseReserved(p) {
    for (const e of p.entries) {
      if (e.state === 'wait') this.releaseEntryStock(e);
    }
  }

  /** 把库存建材返还物流：优先放回箱子，放不下的落到 (x,y) 地面堆 */
  refundToLogistics(stock, x, y) {
    for (const item of Object.keys(stock)) {
      let left = stock[item];
      if (left <= 0) { delete stock[item]; continue; }
      for (const b of this.game.map.buildings.values()) {
        if (left <= 0) break;
        if (b.type === 'chest') left = this.game.tryChestAdd(b, item, left);
      }
      if (left > 0) this.game.map.pileAdd(x, y, item, left);
      delete stock[item];
    }
  }

  /** 计划完工：剩余预留建材返还，留下阶段记录（若被后继前置引用），移出列表 */
  finish(p) {
    this.releaseReserved(p);
    this.leaveStageRecord(p, false);
    const built = p.entries.filter(e => e.state === 'done').length;
    const skipped = p.entries.filter(e => e.state === 'skip').length;
    this.game.logMsg((p.kind === 'upgrade' ? '⬆ 升级完成「' : '🏗 施工完成「') + p.name + '」：'
      + built + (p.kind === 'upgrade' ? ' 栋建筑已原地替换并接入生产调度' : ' 栋建筑建成并接入生产调度')
      + (skipped ? '，' + skipped + ' 栋被跳过' : ''), 'unlock');
    FG.Events.emit('construction:change');
  }

  /** 取消计划：已预留建材返还物流，已建成建筑保留；build 前置视为满足，produce 前置联动挂起 */
  cancel(planId) {
    const i = this.plans.findIndex(p => p.id === planId);
    if (i < 0) return false;
    const p = this.plans[i];
    this.releaseReserved(p);
    this.leaveStageRecord(p, true);   // 试产前置引用了它 → 留下「已取消」档案，后继联动挂起
    const built = p.entries.filter(e => e.state === 'done').length;
    this.plans.splice(i, 1);
    this.game.logMsg('已取消' + (p.kind === 'upgrade' ? '升级计划' : '施工计划') + '「' + p.name + '」：'
      + built + (p.kind === 'upgrade' ? ' 栋已升级保留' : ' 栋已建成保留') + '，未用建材已返还物流', 'info');
    FG.Events.emit('construction:change');
    return true;
  }

  // ================= 序列化（施工进度随存档恢复） =================
  serialize() {
    return {
      seq: this.seq,
      plans: this.plans.map(p => ({
        id: p.id, name: p.name, kind: p.kind || 'build',
        priority: p.priority, paused: !!p.paused,
        deps: (p.deps || []).map(d => ({ id: d.id, mode: d.mode, count: d.count })),
        cursor: p.cursor, timer: p.timer, waiting: p.waiting,
        entries: p.entries.map(e => ({
          type: e.type, from: e.from || null, x: e.x, y: e.y, dir: e.dir, recipe: e.recipe,
          filter: e.filter, demandMode: e.demandMode, priority: e.priority, state: e.state,
          stationName: e.stationName || null,
          stock: Object.assign({}, e.stock),
        })),
      })),
      // 阶段记录：前置完工/取消后的观察档案（建成建筑、试产累计与产量基线）
      stageRecords: this.stageRecords.map(r => ({
        id: r.id, name: r.name, kind: r.kind, cancelled: !!r.cancelled,
        buildings: r.buildings.map(w => ({ x: w.x, y: w.y, type: w.type })),
        producers: r.producers.map(w => ({ x: w.x, y: w.y, type: w.type })),
        produced: r.produced || 0,
        last: Object.assign({}, r.last),
      })),
    };
  }

  deserialize(data) {
    this.plans = [];
    this.seq = (data && data.seq) || 1;
    this.stageRecords = ((data && data.stageRecords) || []).map(r => ({
      id: r.id, name: r.name || r.id, kind: r.kind || 'build', cancelled: !!r.cancelled,
      buildings: Array.isArray(r.buildings) ? r.buildings.map(w => ({ x: w.x, y: w.y, type: w.type })) : [],
      producers: Array.isArray(r.producers) ? r.producers.map(w => ({ x: w.x, y: w.y, type: w.type })) : [],
      produced: r.produced || 0,
      last: r.last || {},
    }));
    for (const sp of ((data && data.plans) || [])) {
      const entries = (sp.entries || []).map(e => ({
        type: e.type, from: e.from || null, x: e.x, y: e.y, dir: e.dir || 0,
        recipe: e.recipe || null, filter: e.filter || null,
        demandMode: !!e.demandMode, priority: e.priority || 'normal',
        stationName: e.stationName || null,
        state: e.state || 'wait',
        stock: e.stock || {},
      }));
      const plan = {
        id: sp.id || ('P' + (this.seq - 1)),
        name: sp.name || '施工计划',
        kind: sp.kind === 'upgrade' ? 'upgrade' : 'build',   // 旧存档无 kind → 普通建造
        priority: VALID_PRIORITIES[sp.priority] ? sp.priority : 'normal',
        paused: !!sp.paused,
        // 旧存档兼容：deps 为字符串数组 → 迁移为 build 模式门控
        deps: Array.isArray(sp.deps) ? sp.deps.map(normDep).filter(Boolean) : [],
        cursor: sp.cursor || 0,
        timer: sp.timer || 0,
        waiting: !!sp.waiting,
        blocked: false,
        entries,
      };
      // 旧存档兼容：旧版预留记在计划级 p.stock，迁移到前沿待建条目，续建语义不变
      if (sp.stock && typeof sp.stock === 'object') {
        const head = entries.find(e => e.state === 'wait');
        if (head) head.stock = Object.assign({}, sp.stock);
      }
      plan.deps = plan.deps.filter(d => d.id !== plan.id);
      this.plans.push(plan);
    }
    // 二次清理悬空依赖：指向的计划不在档内且无阶段记录（旧档/前置已完工无人引用）→ 视为已满足
    const ids = new Set(this.plans.map(p => p.id));
    for (const r of this.stageRecords) ids.add(r.id);
    for (const p of this.plans) p.deps = p.deps.filter(d => ids.has(d.id));
  }
};

const TIERS = ['high', 'normal', 'low'];
const VALID_PRIORITIES = { high: 1, normal: 1, low: 1 };

/**
 * 前置依赖归一化：兼容字符串 id（旧存档/旧调用）与 {id,mode,count} 对象。
 *  mode='build'   建成放行（默认）；mode='produce' 试产达标放行（count 件）。
 */
function normDep(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return { id: raw, mode: 'build', count: 0 };
  if (!raw.id) return null;
  const mode = raw.mode === 'produce' ? 'produce' : 'build';
  let count = Math.floor(raw.count) || 0;
  if (mode === 'produce' && count <= 0) count = FG.Config.TRIAL_PRODUCE_DEFAULT;
  return { id: raw.id, mode, count };
}

/** 建筑是否同一产线建筑：同型号，或 watched 经升级链原地升级到的高级型号（不触发联动挂起） */
function isSameOrUpgrade(watched, actual) {
  let cur = watched, guard = 0;
  while (cur && guard++ < 8) {
    if (cur === actual) return true;
    const chain = FG.Buildings.UPGRADE_CHAIN[cur];
    cur = chain && chain.length ? chain[chain.length - 1] : null;
  }
  return false;
}

/**
 * 全局建材预算池：tick 初盘点全图自由建材（箱子→地面堆），
 * take 时同步物理取出（预留即移出物流，机械臂/调度不可再取）。
 */
class MaterialPool {
  constructor(game) {
    this.game = game;
    this.free = new Map();   // item -> 可分配总量
    this.chests = [];
    for (const b of game.map.buildings.values()) {
      if (!b.def.storage) continue;
      this.chests.push(b);
      for (const s of b.chest) {
        if (s.type && s.count > 0) this.free.set(s.type, (this.free.get(s.type) || 0) + s.count);
      }
    }
    this.piles = [];
    for (const [k, pile] of game.map.piles) {
      for (const s of pile) {
        if (s.type && s.count > 0) this.free.set(s.type, (this.free.get(s.type) || 0) + s.count);
      }
      this.piles.push([k, pile]);
    }
  }

  available(item) { return this.free.get(item) || 0; }

  /** 取走至多 n 件（箱子优先，不足再取地面堆），返回实际取得数 */
  take(item, n) {
    const avail = this.available(item);
    let left = Math.min(n, avail);
    if (left <= 0) return 0;
    const got = left;
    for (const b of this.chests) {
      if (left <= 0) break;
      for (const s of b.chest) {
        if (left <= 0) break;
        if (s.type === item && s.count > 0) {
          const take = Math.min(left, s.count);
          s.count -= take;
          left -= take;
        }
      }
    }
    if (left > 0) {
      for (const [k, pile] of this.piles) {
        if (left <= 0) break;
        const s = pile.find(x => x.type === item && x.count > 0);
        if (!s) continue;
        const take = Math.min(left, s.count);
        s.count -= take;
        left -= take;
        if (s.count <= 0) pile.splice(pile.indexOf(s), 1);
      }
      for (const [k, pile] of this.piles) {
        if (!pile.length) this.game.map.piles.delete(k);
      }
    }
    this.free.set(item, avail - got);
    return got;
  }
}

