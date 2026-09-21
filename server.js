/*
 * 盲文标签排版台 —— Express 服务端
 * 提供静态页面与排版 API：POST /api/layout
 */
'use strict';

const path = require('path');
const express = require('express');
const Braille = require('./lib/braille');
const Qc = require('./lib/qc');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 排版接口：输入标签文本与板材/点距/行距等参数，返回排版结果或放不下原因
app.post('/api/layout', (req, res) => {
  const body = req.body || {};
  const result = Braille.layout({
    text: body.text,
    plateWidth: body.plateWidth,
    plateHeight: body.plateHeight,
    dotSpacing: body.dotSpacing,
    lineSpacing: body.lineSpacing,
    margin: body.margin,
    cellGap: body.cellGap,
    dotDiameter: body.dotDiameter
  });
  res.json(result);
});

// 压印质检接口：以成功排版的设计点为基准，比较偏移校准后的实测 CSV
app.post('/api/qc', (req, res) => {
  const body = req.body || {};
  const result = Qc.analyze({
    design: body.design,
    csv: body.csv,
    offsetX: body.offsetX,
    offsetY: body.offsetY,
    tolerance: body.tolerance,
    maxRadius: body.maxRadius,
    plate: body.plate
  });
  res.json(result);
});

// 健康检查（容器编排用）
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'braille-label-studio', time: new Date().toISOString() });
});

// 未匹配 API 返回 404 JSON
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, errors: [{ type: 'not-found', message: '接口不存在' }] });
});

// 统一错误处理（含 JSON 解析失败）
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, errors: [{ type: 'bad-json', message: '请求体不是合法 JSON' }] });
  }
  console.error(err);
  res.status(500).json({ ok: false, errors: [{ type: 'server', message: '服务器内部错误' }] });
});

app.listen(PORT, () => {
  console.log(`盲文标签排版台已启动: http://localhost:${PORT}`);
});
