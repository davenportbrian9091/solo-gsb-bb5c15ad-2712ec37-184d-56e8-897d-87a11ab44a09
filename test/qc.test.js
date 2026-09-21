'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Qc = require('../lib/qc');

const D = (x, y, r) => ({ x, y, r: r || 0.75 });

/* ---------- CSV 解析与行号定位 ---------- */

test('解析带表头的合法 CSV，记录物理行号', () => {
  const { points, errors } = Qc.parseMeasuredCsv('x_mm,y_mm\n5.0,5.0\n11, 7.5\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(points.map(p => [p.row, p.x, p.y]), [[2, 5.0, 5.0], [3, 11, 7.5]]);
});

test('无表头首行也能解析', () => {
  const { points, errors } = Qc.parseMeasuredCsv('5.0,5.0');
  assert.equal(errors.length, 0);
  assert.equal(points.length, 1);
});

test('错误定位到具体行号：列数错 / 非数字 / 空字段', () => {
  const csv = 'x_mm,y_mm\n1,2,3\n5\nabc,2\n3,';
  const { points, errors } = Qc.parseMeasuredCsv(csv);
  assert.equal(points.length, 0);
  assert.deepEqual(errors.map(e => e.line), [2, 3, 4, 5]);
  assert.match(errors[0].message, /第 2 行/);
  assert.match(errors[2].message, /X 坐标 “abc”/);
});

test('空行不报错且不改变后续物理行号；BOM 被去除', () => {
  const { points, errors } = Qc.parseMeasuredCsv('﻿x_mm,y_mm\n\n1,2\n');
  assert.equal(errors.length, 0);
  assert.equal(points[0].row, 3);
});

test('空内容报错', () => {
  assert.equal(Qc.parseMeasuredCsv('').errors[0].type, 'empty-csv');
  assert.equal(Qc.parseMeasuredCsv('  \n').errors[0].type, 'empty-csv');
});

/* ---------- 偏移、公差、关联半径 ---------- */

test('先应用校准偏移再判定合格/超差', () => {
  const design = [D(5, 5)];
  // 实测点本身偏 0.6mm（公差 0.5），不加偏移 => 超差；加 -0.6 校准偏移 => 合格
  const r = Qc.analyze({
    design,
    measured: [{ row: 2, x: 5.6, y: 5 }],
    offsetX: 0,
    tolerance: 0.5,
    maxRadius: 1.5
  });
  assert.equal(r.ok, true);
  assert.equal(r.pairs[0].result, Qc.FAIL);
  assert.ok(Math.abs(r.pairs[0].distance - 0.6) < 1e-9);

  const r2 = Qc.analyze({
    design,
    measured: [{ row: 2, x: 5.6, y: 5 }],
    offsetX: -0.6,
    tolerance: 0.5,
    maxRadius: 1.5
  });
  assert.equal(r2.pairs[0].result, Qc.PASS);
  assert.equal(r2.pairs[0].calibratedX, 5);
  assert.equal(r2.summary.pass, 1);
});

test('超出关联半径不配对：成为缺失与多余；半径内但超公差为偏移超差', () => {
  const r = Qc.analyze({
    design: [D(0, 0), D(20, 0)],
    measured: [{ row: 1, x: 0.4, y: 0 }, { row: 2, x: 23, y: 0 }],
    tolerance: 0.3,
    maxRadius: 1.0
  });
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].result, Qc.FAIL); // 0.4 > 0.3 但 <= 1.0
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].designIndex, 2);
  assert.equal(r.extra.length, 1);
  assert.equal(r.extra[0].csvRow, 2);
});

test('公差不能大于关联半径（否则参数非法）', () => {
  const r = Qc.analyze({
    design: [D(0, 0)],
    measured: [{ row: 1, x: 0, y: 0 }],
    tolerance: 3,
    maxRadius: 1
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /合格公差/.test(e.message)));
});

/* ---------- 一对一最优匹配 ---------- */

test('一对一：每个实测点最多匹配一个设计点', () => {
  // 一个实测点同时邻近两个设计点，两个设计点各有最近实测点 -> 不允许抢占
  const r = Qc.analyze({
    design: [D(0, 0), D(0.5, 0)],
    measured: [{ row: 1, x: 0, y: 0 }, { row: 2, x: 0.55, y: 0 }],
    tolerance: 1,
    maxRadius: 1
  });
  assert.equal(r.pairs.length, 2);
  assert.deepEqual(r.pairs.map(p => p.designIndex), [1, 2]);
});

test('优先配对数最多：最近邻贪心会失败，全局匹配得到 2 对', () => {
  // 设计点 A(0,0) 同时近 m1(0,0.6) 和 m2(0,0)；设计点 B(3,0) 只近 m1(2.7,0.6)
  // 贪心把 m2 给 A 后 m1 无法再用 => 1 对；最优为 A-m2 + B-m1 => 2 对
  const r = Qc.analyze({
    design: [D(0, 0), D(3, 0)],
    measured: [{ row: 1, x: 2.7, y: 0.6 }, { row: 2, x: 0, y: 0 }],
    tolerance: 2,
    maxRadius: 2
  });
  assert.equal(r.pairs.length, 2);
  const byDesign = Object.fromEntries(r.pairs.map(p => [p.designIndex, p.csvRow]));
  assert.equal(byDesign[1], 2);
  assert.equal(byDesign[2], 1);
});

test('同配对数时总欧氏距离最小', () => {
  // 两种完美匹配：(d1-m1,d2-m2) 总距 0.2+0.2=0.4；(d1-m2,d2-m1) 总距 0.1+0.1=0.2
  const r = Qc.analyze({
    design: [D(0, 0), D(10, 0)],
    measured: [{ row: 1, x: 0.1, y: 0 }, { row: 2, x: 9.9, y: 0 }],
    tolerance: 5,
    maxRadius: 5
  });
  assert.equal(r.pairs.length, 2);
  const byDesign = Object.fromEntries(r.pairs.map(p => [p.designIndex, p.csvRow]));
  assert.equal(byDesign[1], 1);
  assert.equal(byDesign[2], 2);
  assert.ok(Math.abs(r.summary.avgDeviation - 0.1) < 1e-9);
});

test('同成本按设计点序号与 CSV 行号稳定决胜（对称情形可复现）', () => {
  const r = Qc.analyze({
    design: [D(0, 0), D(0.5, 0)],
    measured: [{ row: 1, x: 0.25, y: 0 }, { row: 2, x: 0.25, y: 0 }],
    tolerance: 1,
    maxRadius: 1
  });
  assert.equal(r.pairs.length, 2);
  // 两种完美匹配距离完全相同，稳定决胜为 d1->m1, d2->m2
  assert.deepEqual(r.pairs.map(p => p.csvRow), [1, 2]);
});

/* ---------- 统计、SVG、CSV 报告 ---------- */

test('统计：通过率、最大/平均偏差', () => {
  const r = Qc.analyze({
    design: [D(0, 0), D(0, 10), D(0, 20)],
    measured: [{ row: 1, x: 0, y: 0 }, { row: 2, x: 0.3, y: 10 }],
    tolerance: 0.2,
    maxRadius: 1
  });
  assert.equal(r.summary.totalDesign, 3);
  assert.equal(r.summary.pass, 1);
  assert.equal(r.summary.fail, 1);
  assert.equal(r.summary.missing, 1);
  assert.ok(Math.abs(r.summary.passRate - 0.3333) < 1e-9); // 1/3，保留 4 位小数
  assert.ok(Math.abs(r.summary.maxDeviation - 0.3) < 1e-9);
  assert.ok(Math.abs(r.summary.avgDeviation - 0.15) < 1e-9);
});

test('CSV 报告包含双方坐标、距离与四类结论，含 BOM 与表头', () => {
  const r = Qc.analyze({
    design: [D(0, 0), D(0, 10)],
    csv: 'x_mm,y_mm\n0,0\n5,5',
    tolerance: 0.5,
    maxRadius: 1
  });
  assert.equal(r.ok, true);
  assert.ok(r.reportCsv.startsWith('﻿'));
  const text = r.reportCsv.replace(/^﻿/, '');
  assert.match(text, /^设计点序号,设计X_mm,设计Y_mm,CSV行号,实测X_mm,实测Y_mm,校准后X_mm,校准后Y_mm,距离_mm,结论/);
  assert.match(text, /,合格/);
  assert.match(text, /,缺失/);
  assert.match(text, /,多余/);
});

test('叠加 SVG 四类元素分组与分色，单位 mm', () => {
  const r = Qc.analyze({
    design: [D(0, 0), D(0, 10)],
    measured: [{ row: 1, x: 0, y: 0 }, { row: 2, x: 0, y: 10.4 }, { row: 3, x: 9, y: 9 }],
    tolerance: 0.2,
    maxRadius: 1,
    plate: { width: 20, height: 20, margin: 1 }
  });
  assert.match(r.svg, /id="design-base"/);
  assert.match(r.svg, /id="pair-links"/);
  assert.match(r.svg, /id="missing-points"/);
  assert.match(r.svg, /id="extra-points"/);
  assert.match(r.svg, /id="legend"/);
  assert.match(r.svg, /width="20mm"/);
  assert.match(r.svg, new RegExp(Qc.PASS));
  assert.match(r.svg, new RegExp(Qc.FAIL));
});

test('空基准（0 设计点）可正常分析，通过率为 null', () => {
  const r = Qc.analyze({ design: [], measured: [{ row: 1, x: 1, y: 1 }], tolerance: 0.5, maxRadius: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.summary.passRate, null);
  assert.equal(r.extra.length, 1);
});
