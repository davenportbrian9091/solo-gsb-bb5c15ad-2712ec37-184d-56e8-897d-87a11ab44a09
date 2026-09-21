/*
 * 压印质检（Emboss QC）核心模块（UMD，同时供 Node 服务端与浏览器使用）。
 *
 * 流程：
 *   1. parseMeasuredCsv：解析实测凸点 CSV（x_mm,y_mm，首行可为表头），
 *      任何解析错误都带具体物理行号；
 *   2. 校准：实测点先加上 X/Y 校准偏移，再与设计点比较；
 *   3. 关联：仅保留欧氏距离 ≤ 最大关联半径的候选边，做一对一最优匹配，
 *      目标按字典序为（配对数最多 → 总欧氏距离最小 → 设计点序号/CSV 行号
 *      组合决胜值最小），一个实测点绝不重复配对；
 *   4. 判定：配对距离 ≤ 合格公差 => 合格，否则 偏移超差；
 *      未配对设计点 => 缺失，未配对实测点 => 多余；
 *   5. 输出统计、四类分色叠加 SVG 与 CSV 报告。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Qc = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;                 // 半径/公差判等的数值容差（mm，远小于 0.001mm 坐标分辨率）
  var MAX_DESIGN = 5000;          // 设计点上限
  var MAX_MEASURED = 10000;       // 实测点上限

  var PASS = '合格';
  var FAIL = '偏移超差';
  var MISSING = '缺失';
  var EXTRA = '多余';

  function round3(n) { return Math.round(n * 1000) / 1000; }
  function round4(n) { return Math.round(n * 10000) / 10000; }

  function toNum(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  /* ---------------- 实测 CSV 解析（错误定位行号） ---------------- */

  var NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  function trim(s) { return s.trim(); }

  function parseMeasuredCsv(text) {
    var points = [];
    var errors = [];

    if (typeof text !== 'string' || text.trim() === '') {
      return {
        points: points,
        errors: [{ type: 'empty-csv', line: null, message: 'CSV 内容为空，请粘贴实测凸点坐标（每行 x_mm,y_mm）。' }]
      };
    }

    var str = text.replace(/^﻿/, ''); // 去 UTF-8 BOM
    var lines = str.split(/\r\n|\r|\n/);
    var seenFirst = false;

    for (var li = 0; li < lines.length; li++) {
      var lineNo = li + 1;
      var raw = lines[li];
      if (raw.trim() === '') continue; // 空行允许，不计点也不报错（行号仍按物理行计）

      var fields = raw.split(',').map(trim);

      if (!seenFirst) {
        seenFirst = true;
        // 首行恰好是 x_mm,y_mm 表头 -> 跳过；其他首行按数据行校验
        if (fields.length === 2 && /^x_mm$/i.test(fields[0]) && /^y_mm$/i.test(fields[1])) {
          continue;
        }
      }

      if (fields.length !== 2) {
        errors.push({
          type: 'csv-format',
          line: lineNo,
          message: '第 ' + lineNo + ' 行：应有 2 列（x_mm,y_mm），实际为 ' + fields.length + ' 列。'
        });
        continue;
      }

      var coords = [NaN, NaN];
      var rowBad = false;
      ['X', 'Y'].forEach(function (axis, k) {
        var f = fields[k];
        if (f === '') {
          errors.push({ type: 'csv-format', line: lineNo, message: '第 ' + lineNo + ' 行：' + axis + ' 坐标为空。' });
          rowBad = true;
        } else if (!NUM_RE.test(f)) {
          errors.push({
            type: 'csv-format',
            line: lineNo,
            message: '第 ' + lineNo + ' 行：' + axis + ' 坐标 “' + f + '” 不是合法数字。'
          });
          rowBad = true;
        } else {
          coords[k] = parseFloat(f);
        }
      });
      if (rowBad) continue;

      points.push({ row: lineNo, x: coords[0], y: coords[1] });

      if (points.length >= MAX_MEASURED) {
        errors.push({
          type: 'too-many-points',
          line: lineNo,
          message: '第 ' + lineNo + ' 行：实测点数量超过上限 ' + MAX_MEASURED + ' 个。'
        });
        break;
      }
    }

    if (!errors.length && points.length === 0) {
      errors.push({ type: 'empty-csv', line: null, message: 'CSV 中未解析到任何实测点（每行格式 x_mm,y_mm）。' });
    }
    return { points: points, errors: errors };
  }

  /* ---------------- 入参校验 ---------------- */

  function normalizeDesign(design, errors) {
    if (!Array.isArray(design)) {
      errors.push({ type: 'param', message: '缺少设计点基准数据（design 数组）。' });
      return [];
    }
    if (design.length > MAX_DESIGN) {
      errors.push({ type: 'param', message: '设计点数量超过上限 ' + MAX_DESIGN + ' 个。' });
      return [];
    }
    var out = [];
    for (var i = 0; i < design.length; i++) {
      var d = design[i] || {};
      var x = toNum(d.x);
      var y = toNum(d.y);
      if (!isFinite(x) || !isFinite(y)) {
        errors.push({ type: 'param', message: '第 ' + (i + 1) + ' 个设计点坐标不是合法数字。' });
        return [];
      }
      out.push({ x: x, y: y, r: isFinite(toNum(d.r)) ? toNum(d.r) : null });
    }
    return out;
  }

  function normalizeMeasured(list, errors) {
    var out = [];
    if (!Array.isArray(list)) {
      errors.push({ type: 'param', message: '实测点数据必须是数组。' });
      return out;
    }
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var x = toNum(m.x);
      var y = toNum(m.y);
      if (!isFinite(x) || !isFinite(y)) {
        errors.push({ type: 'param', message: '第 ' + (i + 1) + ' 个实测点坐标不是合法数字。' });
        return [];
      }
      var row = toNum(m.row);
      out.push({ row: isFinite(row) ? row : i + 1, x: x, y: y });
    }
    return out;
  }

  function normalizeQcParams(input, errors) {
    var p = {
      offsetX: input.offsetX === undefined || input.offsetX === null || input.offsetX === '' ? 0 : toNum(input.offsetX),
      offsetY: input.offsetY === undefined || input.offsetY === null || input.offsetY === '' ? 0 : toNum(input.offsetY),
      tolerance: input.tolerance === undefined || input.tolerance === null || input.tolerance === '' ? 0.5 : toNum(input.tolerance),
      maxRadius: input.maxRadius === undefined || input.maxRadius === null || input.maxRadius === '' ? 1.5 : toNum(input.maxRadius)
    };
    if (!isFinite(p.offsetX)) errors.push({ type: 'param', message: 'X 校准偏移必须是数字。' });
    if (!isFinite(p.offsetY)) errors.push({ type: 'param', message: 'Y 校准偏移必须是数字。' });
    if (!(p.tolerance >= 0)) errors.push({ type: 'param', message: '合格公差不能为负数。' });
    if (!(p.maxRadius > 0)) errors.push({ type: 'param', message: '最大关联半径必须为正数。' });
    if (isFinite(p.tolerance) && isFinite(p.maxRadius) && p.tolerance > p.maxRadius + EPS) {
      errors.push({
        type: 'param',
        message: '合格公差（' + p.tolerance + 'mm）不能大于最大关联半径（' + p.maxRadius + 'mm），否则公差内的点也无法配对。'
      });
    }
    return errors.length ? null : p;
  }

  /* ---------------- 最小费用最大流（lex 三元组费用） ----------------
   * 每条候选边费用为 [-1, distance, tie]：
   *   第一维 -1  => 配对数最多；
   *   第二维     => 总欧氏距离最小；
   *   第三维 tie = i*(m+1)+j => 同成本时偏向更小的设计点序号，
   *               再偏向更小的实测点（CSV 行）序号，保证结果稳定唯一。
   * Dijkstra + 势能，节点/边均按序号有序，结果不依赖运行时哈希顺序。
   */

  function cmpCost(a, b) {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
    return 0;
  }
  function addCost(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function negCost(a) { return [-a[0], -a[1], -a[2]]; }
  var ZERO = [0, 0, 0];

  function buildGraph(n, m, edges) {
    // 节点：0=源点，1..n=设计点 D_i，n+1..n+m=实测点 M_j，末尾=汇点
    var S = 0;
    var T = n + m + 1;
    var g = [];
    for (var k = 0; k <= T; k++) g.push([]);

    function addEdge(u, v, cap, cost, meta) {
      g[u].push({ to: v, rev: g[v].length, cap: cap, cost: cost, meta: meta || null });
      g[v].push({ to: u, rev: g[u].length - 1, cap: 0, cost: negCost(cost), meta: null });
    }

    for (var i = 0; i < n; i++) addEdge(S, 1 + i, 1, [0, 0, 0]);
    edges.forEach(function (e) {
      addEdge(1 + e.i, 1 + n + e.j, 1, [-1, e.d, e.i * (m + 1) + e.j], { di: e.i, mj: e.j });
    });
    for (var j = 0; j < m; j++) addEdge(1 + n + j, T, 1, [0, 0, 0]);
    return { g: g, S: S, T: T };
  }

  function initialPotentials(g, S, T, n, m) {
    // 初始残量网络是 DAG，直接按层求最短距离再取负作为势能
    var pot = new Array(g.length).fill(null);
    pot[S] = [0, 0, 0];
    for (var i = 0; i < n; i++) pot[1 + i] = [0, 0, 0];

    var bestT = null;
    for (var j = 0; j < m; j++) {
      var node = 1 + n + j;
      var best = null;
      for (var i = 0; i < n; i++) {
        var adj = g[1 + i];
        for (var k = 0; k < adj.length; k++) {
          var e = adj[k];
          if (e.to === node && e.meta) {
            if (best === null || cmpCost(e.cost, best) < 0) best = e.cost;
          }
        }
      }
      if (best !== null) {
        pot[node] = negCost(best);
        if (bestT === null || cmpCost(best, bestT) < 0) bestT = best;
      }
    }
    pot[T] = bestT === null ? null : negCost(bestT);
    return pot;
  }

  // 二叉小顶堆（元素 [node, costTuple]）
  function Heap() { this.a = []; }
  Heap.prototype.push = function (node, key) {
    var a = this.a;
    a.push([node, key]);
    var c = a.length - 1;
    while (c > 0) {
      var p = (c - 1) >> 1;
      if (cmpCost(a[p][1], a[c][1]) <= 0) break;
      var tmp = a[p]; a[p] = a[c]; a[c] = tmp;
      c = p;
    }
  };
  Heap.prototype.pop = function () {
    var a = this.a;
    var top = a[0];
    var last = a.pop();
    if (a.length) {
      a[0] = last;
      var p = 0;
      for (;;) {
        var l = 2 * p + 1, r = l + 1, s = p;
        if (l < a.length && cmpCost(a[l][1], a[s][1]) < 0) s = l;
        if (r < a.length && cmpCost(a[r][1], a[s][1]) < 0) s = r;
        if (s === p) break;
        var tmp = a[s]; a[s] = a[p]; a[p] = tmp;
        p = s;
      }
    }
    return top;
  };
  Object.defineProperty(Heap.prototype, 'size', { get: function () { return this.a.length; } });

  function minCostMaxFlow(g, S, T, pot) {
    var N = g.length;
    for (;;) {
      var dist = new Array(N).fill(null);
      var prevV = new Array(N).fill(-1);
      var prevE = new Array(N).fill(-1);
      dist[S] = [0, 0, 0];

      var heap = new Heap();
      heap.push(S, dist[S]);

      while (heap.size) {
        var top = heap.pop();
        var u = top[0];
        if (cmpCost(top[1], dist[u]) !== 0) continue; // 过期堆元素
        for (var k = 0; k < g[u].length; k++) {
          var e = g[u][k];
          if (!e.cap) continue;
          var pu = pot[u] || ZERO;
          var pv = pot[e.to] || ZERO;
          var reduced = addCost(e.cost, addCost(pu, negCost(pv)));
          var nd = addCost(dist[u], reduced);
          if (dist[e.to] === null || cmpCost(nd, dist[e.to]) < 0) {
            dist[e.to] = nd;
            prevV[e.to] = u;
            prevE[e.to] = k;
            heap.push(e.to, nd);
          }
        }
      }

      if (dist[T] === null) break; // 无可增广路 => 已是最大配对数

      for (var v = 0; v < N; v++) {
        if (dist[v] !== null) pot[v] = pot[v] === null ? dist[v] : addCost(pot[v], dist[v]);
      }

      // 所有边容量均为 1，沿增广路增广 1 个单位
      var x = T;
      while (x !== S) {
        var edge = g[prevV[x]][prevE[x]];
        edge.cap--;
        g[x][edge.rev].cap++;
        x = prevV[x];
      }
    }
  }

  function matchPairs(design, measured, p) {
    var n = design.length;
    var m = measured.length;

    // 1. 半径内候选边（偏移先作用于实测点）
    var edges = [];
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < m; j++) {
        var cx = measured[j].x + p.offsetX;
        var cy = measured[j].y + p.offsetY;
        var dx = cx - design[i].x;
        var dy = cy - design[i].y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d <= p.maxRadius + EPS) edges.push({ i: i, j: j, d: d });
      }
    }

    // 2. 最小费用最大流求一对一最优匹配
    var built = buildGraph(n, m, edges);
    var pot = initialPotentials(built.g, built.S, built.T, n, m);
    minCostMaxFlow(built.g, built.S, built.T, pot);

    // 3. 从满流的设计->实测边恢复配对（设计点序号升序，天然稳定）
    var pairs = [];
    var matchedDesign = new Array(n).fill(false);
    var matchedMeasured = new Array(m).fill(false);
    for (var di = 0; di < n; di++) {
      var adj = built.g[1 + di];
      for (var k = 0; k < adj.length; k++) {
        var e = adj[k];
        if (e.meta && e.cap === 0) {
          var mj = e.meta.mj;
          matchedDesign[di] = true;
          matchedMeasured[mj] = true;
          var mp = measured[mj];
          var calX = mp.x + p.offsetX;
          var calY = mp.y + p.offsetY;
          var ddx = calX - design[di].x;
          var ddy = calY - design[di].y;
          var dist = Math.sqrt(ddx * ddx + ddy * ddy);
          pairs.push({
            designIndex: di + 1,
            csvRow: mp.row,
            designX: round3(design[di].x),
            designY: round3(design[di].y),
            measuredX: round3(mp.x),
            measuredY: round3(mp.y),
            calibratedX: round3(calX),
            calibratedY: round3(calY),
            distance: round3(dist),
            result: dist <= p.tolerance + EPS ? PASS : FAIL
          });
        }
      }
    }

    return { pairs: pairs, matchedDesign: matchedDesign, matchedMeasured: matchedMeasured };
  }

  /* ---------------- 叠加 SVG（四类分色，单位 mm） ---------------- */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var COLOR_PASS = '#16a34a';
  var COLOR_FAIL = '#ea580c';
  var COLOR_MISSING = '#dc2626';
  var COLOR_EXTRA = '#7c3aed';
  var COLOR_BASE = '#c3cad3';

  function diamondPath(cx, cy, s) {
    return 'M ' + cx + ' ' + round3(cy - s) + ' L ' + (cx + s) + ' ' + cy + ' L ' + cx + ' ' + round3(cy + s) +
      ' L ' + round3(cx - s) + ' ' + cy + ' Z';
  }

  function buildQcSvg(plate, design, a) {
    plate = plate || {};
    var W = toNum(plate.width);
    var H = toNum(plate.height);
    if (!(isFinite(W) && W > 0) || !(isFinite(H) && H > 0)) {
      // 兜底：无板材尺寸时按所有点的包围盒取幅面
      var all = [];
      design.forEach(function (d) { all.push([d.x, d.y]); });
      a.pairs.forEach(function (p) { all.push([p.calibratedX, p.calibratedY]); });
      a.extra.forEach(function (p) { all.push([p.calibratedX, p.calibratedY]); });
      var maxX = 10, maxY = 10;
      all.forEach(function (q) { maxX = Math.max(maxX, q[0] + 5); maxY = Math.max(maxY, q[1] + 5); });
      W = round3(maxX); H = round3(maxY);
    }
    var margin = isFinite(toNum(plate.margin)) && toNum(plate.margin) >= 0 ? toNum(plate.margin) : null;

    var radii = design.map(function (d) { return d.r; }).filter(function (r) { return r && r > 0; });
    var avgR = radii.length ? radii.reduce(function (s, r) { return s + r; }, 0) / radii.length : 0.75;
    avgR = Math.max(0.4, avgR);

    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="0 0 ' + W + ' ' + H + '" data-unit="mm">');
    out.push('  <!-- 压印质检叠加图：灰=设计基准，绿=合格，橙=偏移超差，红=缺失，紫=多余；坐标单位 mm -->');
    out.push('  <rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');
    if (margin !== null && 2 * margin < W && 2 * margin < H) {
      out.push('  <rect x="' + margin + '" y="' + margin + '" width="' + round3(W - 2 * margin) +
        '" height="' + round3(H - 2 * margin) + '" fill="none" stroke="#bbbbbb" stroke-width="0.15" stroke-dasharray="1 1"/>');
    }

    // 设计基准底点（全部灰点）
    out.push('  <g id="design-base" fill="' + COLOR_BASE + '">');
    design.forEach(function (d, i) {
      out.push('    <circle cx="' + round3(d.x) + '" cy="' + round3(d.y) + '" r="' + round3(avgR + 0.14) +
        '" data-design-index="' + (i + 1) + '"/>');
    });
    out.push('  </g>');

    // 配对连线
    out.push('  <g id="pair-links" stroke-width="0.12" fill="none">');
    a.pairs.forEach(function (p) {
      out.push('    <line x1="' + p.designX + '" y1="' + p.designY + '" x2="' + p.calibratedX +
        '" y2="' + p.calibratedY + '" stroke="' + (p.result === PASS ? COLOR_PASS : COLOR_FAIL) +
        '" stroke-opacity="0.75" data-design-index="' + p.designIndex + '"/>');
    });
    out.push('  </g>');

    // 配对实测点：合格 / 偏移超差
    out.push('  <g id="paired-points">');
    a.pairs.forEach(function (p) {
      var color = p.result === PASS ? COLOR_PASS : COLOR_FAIL;
      out.push('    <circle cx="' + p.calibratedX + '" cy="' + p.calibratedY + '" r="' + round3(avgR) +
        '" fill="' + color + '" fill-opacity="0.9" stroke="#ffffff" stroke-width="0.08" data-result="' +
        esc(p.result) + '" data-design-index="' + p.designIndex + '" data-csv-row="' + p.csvRow + '"/>');
    });
    out.push('  </g>');

    // 缺失：设计点红圈 + 叉
    out.push('  <g id="missing-points" stroke="' + COLOR_MISSING + '" stroke-width="0.18" fill="none">');
    a.missing.forEach(function (p) {
      var r = round3(avgR + 0.18);
      out.push('    <circle cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" data-result="' + MISSING +
        '" data-design-index="' + p.designIndex + '"/>');
      var s = round3(avgR * 0.95);
      out.push('    <line x1="' + round3(p.x - s) + '" y1="' + round3(p.y - s) + '" x2="' + round3(p.x + s) +
        '" y2="' + round3(p.y + s) + '" data-design-index="' + p.designIndex + '"/>');
      out.push('    <line x1="' + round3(p.x - s) + '" y1="' + round3(p.y + s) + '" x2="' + round3(p.x + s) +
        '" y2="' + round3(p.y - s) + '" data-design-index="' + p.designIndex + '"/>');
    });
    out.push('  </g>');

    // 多余：实测点紫色菱形
    out.push('  <g id="extra-points" stroke="' + COLOR_EXTRA + '" stroke-width="0.18" fill="#ede9fe" fill-opacity="0.85">');
    a.extra.forEach(function (p) {
      out.push('    <path d="' + diamondPath(p.calibratedX, p.calibratedY, round3(avgR * 1.25)) +
        '" data-result="' + EXTRA + '" data-csv-row="' + p.csvRow + '"/>');
    });
    out.push('  </g>');

    // 图例（窄板材放左下，否则右上）
    var legendW = 30, legendH = 17.5;
    var lx = W >= 70 ? W - legendW - 2 : 2;
    var ly = W >= 70 ? 2 : Math.max(2, H - legendH - 2);
    out.push('  <g id="legend" font-family="sans-serif" font-size="2.4" fill="#374151">');
    out.push('    <rect x="' + lx + '" y="' + ly + '" width="' + legendW + '" height="' + legendH +
      '" rx="0.8" fill="#ffffff" fill-opacity="0.88" stroke="#9ca3af" stroke-width="0.12"/>');
    var items = [
      { color: COLOR_BASE, label: '设计基准', shape: 'base' },
      { color: COLOR_PASS, label: PASS, shape: 'circle' },
      { color: COLOR_FAIL, label: FAIL, shape: 'circle' },
      { color: COLOR_MISSING, label: MISSING, shape: 'cross' },
      { color: COLOR_EXTRA, label: EXTRA, shape: 'diamond' }
    ];
    items.forEach(function (it, k) {
      var cyy = ly + 2.6 + k * 3;
      var cxx = lx + 3;
      if (it.shape === 'base' || it.shape === 'circle') {
        out.push('      <circle cx="' + cxx + '" cy="' + cyy + '" r="0.9" fill="' + it.color + '"/>');
      } else if (it.shape === 'cross') {
        out.push('      <g stroke="' + it.color + '" stroke-width="0.22"><line x1="' + (cxx - 0.9) +
          '" y1="' + (cyy - 0.9) + '" x2="' + (cxx + 0.9) + '" y2="' + (cyy + 0.9) +
          '"/><line x1="' + (cxx - 0.9) + '" y1="' + (cyy + 0.9) + '" x2="' + (cxx + 0.9) +
          '" y2="' + (cyy - 0.9) + '"/></g>');
      } else {
        out.push('      <path d="' + diamondPath(cxx, cyy, 1.05) + '" fill="#ede9fe" stroke="' + it.color +
          '" stroke-width="0.2"/>');
      }
      out.push('      <text x="' + (lx + 5.5) + '" y="' + round3(cyy + 0.85) + '">' + esc(it.label) + '</text>');
    });
    out.push('  </g>');

    out.push('</svg>');
    return out.join('\n');
  }

  /* ---------------- CSV 报告 ---------------- */

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildReportCsv(a) {
    var header = ['设计点序号', '设计X_mm', '设计Y_mm', 'CSV行号', '实测X_mm', '实测Y_mm',
      '校准后X_mm', '校准后Y_mm', '距离_mm', '结论'];
    var lines = [header.map(csvCell).join(',')];

    function num(v) { return v === null || v === undefined ? '' : String(v); }

    // 先配对（按设计点序号升序），再缺失，最后多余（按 CSV 行号升序）
    a.pairs.forEach(function (p) {
      lines.push([
        p.designIndex, num(p.designX), num(p.designY),
        p.csvRow, num(p.measuredX), num(p.measuredY),
        num(p.calibratedX), num(p.calibratedY), num(p.distance), p.result
      ].map(csvCell).join(','));
    });
    a.missing.forEach(function (p) {
      lines.push([
        p.designIndex, num(round3(p.x)), num(round3(p.y)),
        '', '', '', '', '', '', MISSING
      ].map(csvCell).join(','));
    });
    a.extra.forEach(function (p) {
      lines.push([
        '', '', '', p.csvRow,
        num(round3(p.x)), num(round3(p.y)),
        num(p.calibratedX), num(p.calibratedY), '', EXTRA
      ].map(csvCell).join(','));
    });

    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /* ---------------- 主入口 ---------------- */

  function analyze(input) {
    input = input || {};
    var errors = [];

    var design = normalizeDesign(input.design, errors);

    var measured;
    if (input.csv !== undefined && input.csv !== null) {
      var parsed = parseMeasuredCsv(input.csv);
      errors.push.apply(errors, parsed.errors);
      measured = parsed.points;
    } else if (Array.isArray(input.measured)) {
      measured = normalizeMeasured(input.measured, errors);
    } else {
      errors.push({ type: 'empty-csv', line: null, message: '未提供实测凸点 CSV 或实测点数据。' });
      measured = [];
    }

    var p = normalizeQcParams(input, errors);

    var base = {
      ok: false,
      errors: errors,
      params: p,
      summary: null,
      pairs: [],
      missing: [],
      extra: [],
      svg: null,
      reportCsv: null
    };
    if (errors.length || !p) return base;

    var matched = matchPairs(design, measured, p);
    var pairs = matched.pairs;

    var missing = [];
    for (var i = 0; i < design.length; i++) {
      if (!matched.matchedDesign[i]) {
        missing.push({ designIndex: i + 1, x: design[i].x, y: design[i].y });
      }
    }
    var extra = [];
    for (var j = 0; j < measured.length; j++) {
      if (!matched.matchedMeasured[j]) {
        extra.push({
          csvRow: measured[j].row,
          x: measured[j].x,
          y: measured[j].y,
          calibratedX: round3(measured[j].x + p.offsetX),
          calibratedY: round3(measured[j].y + p.offsetY)
        });
      }
    }
    extra.sort(function (a, b) { return a.csvRow - b.csvRow; });

    var passCount = 0;
    var distSum = 0;
    var maxDist = 0;
    pairs.forEach(function (pr) {
      if (pr.result === PASS) passCount++;
      distSum += pr.distance;
      if (pr.distance > maxDist) maxDist = pr.distance;
    });

    base.ok = true;
    base.pairs = pairs;
    base.missing = missing;
    base.extra = extra;
    base.summary = {
      totalDesign: design.length,
      totalMeasured: measured.length,
      paired: pairs.length,
      pass: passCount,
      fail: pairs.length - passCount,
      missing: missing.length,
      extra: extra.length,
      passRate: design.length ? round4(passCount / design.length) : null,
      maxDeviation: pairs.length ? round3(maxDist) : null,
      avgDeviation: pairs.length ? round3(distSum / pairs.length) : null
    };
    base.svg = buildQcSvg(input.plate, design, base);
    base.reportCsv = buildReportCsv(base);
    return base;
  }

  return {
    PASS: PASS,
    FAIL: FAIL,
    MISSING: MISSING,
    EXTRA: EXTRA,
    parseMeasuredCsv: parseMeasuredCsv,
    analyze: analyze,
    buildQcSvg: buildQcSvg,
    buildReportCsv: buildReportCsv
  };
});
