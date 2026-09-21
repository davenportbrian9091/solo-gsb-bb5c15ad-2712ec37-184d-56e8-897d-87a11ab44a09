/*
 * 盲文标签排版台 前端逻辑
 * 模式一（排版）：输入变化 -> 防抖 POST /api/layout -> SVG 预览 / 错误原因 / 下载
 * 模式二（压印质检）：以最近一次成功排版的设计点为基准，POST /api/qc
 *   -> 四类分色叠加 SVG / 通过率、偏差统计 / CSV 报告下载
 */
(function () {
  'use strict';

  /* ---------------- 排版模式 ---------------- */

  var fields = ['text', 'plateWidth', 'plateHeight', 'dotSpacing', 'lineSpacing', 'margin', 'cellGap', 'dotDiameter'];
  var els = {};
  fields.forEach(function (id) { els[id] = document.getElementById(id); });

  var errorsBox = document.getElementById('errors');
  var statsBox = document.getElementById('stats');
  var preview = document.getElementById('preview');
  var brailleLine = document.getElementById('brailleLine');
  var btnSvg = document.getElementById('downloadSvg');
  var btnJson = document.getElementById('downloadJson');

  var lastResult = null; // 最近一次成功的排版结果（用于下载，并作为质检基准）
  var debounceTimer = null;

  function collectParams() {
    var p = { text: els.text.value };
    ['plateWidth', 'plateHeight', 'dotSpacing', 'lineSpacing', 'margin', 'cellGap', 'dotDiameter'].forEach(function (id) {
      var v = els[id].value.trim();
      if (v !== '') p[id] = Number(v);
    });
    return p;
  }

  function renderErrors(errors) {
    errorsBox.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      ul.appendChild(li);
    });
    errorsBox.appendChild(ul);
    errorsBox.hidden = false;
  }

  function renderStats(r) {
    var p = r.params;
    var s = r.stats;
    statsBox.innerHTML =
      '每行最多 <b>' + r.cellsPerLine + '</b> 个盲文单元，最多 <b>' + r.maxLines + '</b> 行；' +
      '本次 <b>' + s.totalLines + '</b> 行 / <b>' + s.totalCells + '</b> 个单元 / <b>' + s.totalDots + '</b> 个凸点<br>' +
      '占用幅面 ' + s.usedWidth + ' × ' + s.usedHeight + ' mm（板材 ' + p.plateWidth + ' × ' + p.plateHeight + ' mm，' +
      '字距 ' + p.cellGap + ' mm，凸点直径 ' + p.dotDiameter + ' mm）';
    statsBox.hidden = false;
  }

  function update() {
    var params = collectParams();
    fetch('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
      .then(function (res) { return res.json(); })
      .then(function (r) {
        if (r.ok) {
          lastResult = r;
          errorsBox.hidden = true;
          // 内联预览时去掉 XML 声明，避免被 HTML 解析器当作冗余节点
          preview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
          brailleLine.textContent = r.brailleText.replace(/\n/g, ' / ');
          renderStats(r);
          btnSvg.disabled = false;
          btnJson.disabled = false;
          if (currentMode === 'qc') refreshBaselineInfo();
        } else {
          lastResult = null;
          statsBox.hidden = true;
          brailleLine.textContent = '';
          preview.innerHTML = '<p class="placeholder">排版失败：请根据左侧原因调整参数</p>';
          renderErrors(r.errors || [{ message: '未知错误' }]);
          btnSvg.disabled = true;
          btnJson.disabled = true;
          if (currentMode === 'qc') refreshBaselineInfo();
        }
      })
      .catch(function () {
        lastResult = null;
        statsBox.hidden = true;
        preview.innerHTML = '<p class="placeholder">无法连接服务器</p>';
        renderErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
        btnSvg.disabled = true;
        btnJson.disabled = true;
        if (currentMode === 'qc') refreshBaselineInfo();
      });
  }

  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(update, 250);
  }

  fields.forEach(function (id) {
    els[id].addEventListener('input', scheduleUpdate);
  });

  function download(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  btnSvg.addEventListener('click', function () {
    if (lastResult) download('braille-label.svg', 'image/svg+xml;charset=utf-8', lastResult.svg);
  });

  btnJson.addEventListener('click', function () {
    if (!lastResult) return;
    var copy = {};
    Object.keys(lastResult).forEach(function (k) {
      if (k !== 'svg') copy[k] = lastResult[k]; // JSON 下载不含 svg 字符串本体
    });
    download('braille-layout.json', 'application/json;charset=utf-8', JSON.stringify(copy, null, 2));
  });

  /* ---------------- 模式切换 ---------------- */

  var currentMode = 'layout';
  var tabLayout = document.getElementById('tabLayout');
  var tabQc = document.getElementById('tabQc');
  var paneLayout = document.getElementById('paneLayout');
  var paneQc = document.getElementById('paneQc');
  var footerLayout = document.getElementById('footerLayout');
  var footerQc = document.getElementById('footerQc');

  function switchMode(mode) {
    currentMode = mode;
    var isQc = mode === 'qc';
    tabLayout.classList.toggle('active', !isQc);
    tabQc.classList.toggle('active', isQc);
    tabLayout.setAttribute('aria-selected', String(!isQc));
    tabQc.setAttribute('aria-selected', String(isQc));
    paneLayout.hidden = isQc;
    paneQc.hidden = !isQc;
    footerLayout.hidden = isQc;
    footerQc.hidden = !isQc;
    if (isQc) {
      refreshBaselineInfo();
      scheduleQc();
    }
    try { window.location.hash = isQc ? 'qc' : 'layout'; } catch (e) { /* 忽略 */ }
  }
  tabLayout.addEventListener('click', function () { switchMode('layout'); });
  tabQc.addEventListener('click', function () { switchMode('qc'); });

  /* ---------------- 压印质检模式 ---------------- */

  var qcCsv = document.getElementById('qcCsv');
  var qcOffsetX = document.getElementById('qcOffsetX');
  var qcOffsetY = document.getElementById('qcOffsetY');
  var qcTolerance = document.getElementById('qcTolerance');
  var qcRadius = document.getElementById('qcRadius');
  var qcErrors = document.getElementById('qcErrors');
  var qcStats = document.getElementById('qcStats');
  var qcPreview = document.getElementById('qcPreview');
  var qcBaseline = document.getElementById('qcBaseline');
  var qcLegendInline = document.getElementById('qcLegendInline');
  var btnQcSample = document.getElementById('qcSample');
  var btnQcDownload = document.getElementById('qcDownload');

  var lastQcResult = null;
  var qcTimer = null;

  qcLegendInline.innerHTML =
    '<i class="dot dot-base"></i>设计基准 ' +
    '<i class="dot dot-pass"></i>合格 ' +
    '<i class="dot dot-fail"></i>偏移超差 ' +
    '<i class="dot dot-miss"></i>缺失 ' +
    '<i class="dot dot-extra"></i>多余';

  function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }
  function fmtDev(v) { return v === null || v === undefined ? '—' : v.toFixed(3) + ' mm'; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function refreshBaselineInfo() {
    if (lastResult) {
      qcBaseline.className = 'qc-baseline ok';
      qcBaseline.innerHTML =
        '<b>质检基准</b>（最近一次成功排版）<br>' +
        '标签：<b>“' + esc(lastResult.params.text === '' ? '（空白）' : lastResult.params.text) + '”</b><br>' +
        '设计凸点 <b>' + lastResult.stats.totalDots + '</b> 个 · 板材 ' +
        lastResult.params.plateWidth + ' × ' + lastResult.params.plateHeight + ' mm';
    } else {
      qcBaseline.className = 'qc-baseline warn';
      qcBaseline.innerHTML = '<b>尚无质检基准</b><br>请先在“排版模式”完成一次成功排版，质检将以该次设计点为基准。';
    }
  }

  function renderQcErrors(errors) {
    qcErrors.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      ul.appendChild(li);
    });
    qcErrors.appendChild(ul);
    qcErrors.hidden = false;
  }

  function renderQcStats(r) {
    var s = r.summary;
    var rate = s.passRate === null ? '—' : fmtPct(s.passRate);
    qcStats.innerHTML =
      '通过率 <b>' + rate + '</b>' +
      '（合格 ' + s.pass + ' / 设计点 ' + s.totalDesign + '）<br>' +
      '最大偏差 <b>' + fmtDev(s.maxDeviation) + '</b> · 平均偏差 <b>' + fmtDev(s.avgDeviation) + '</b><br>' +
      '配对 ' + s.paired + '：合格 <b class="t-pass">' + s.pass + '</b> / ' +
      '偏移超差 <b class="t-fail">' + s.fail + '</b>；' +
      '缺失 <b class="t-miss">' + s.missing + '</b>；多余 <b class="t-extra">' + s.extra + '</b>；' +
      '实测共 ' + s.totalMeasured + ' 点';
    qcStats.hidden = false;
  }

  function scheduleQc() {
    clearTimeout(qcTimer);
    qcTimer = setTimeout(runQc, 250);
  }

  [qcCsv, qcOffsetX, qcOffsetY, qcTolerance, qcRadius].forEach(function (el) {
    el.addEventListener('input', scheduleQc);
  });

  function runQc() {
    lastQcResult = null;
    btnQcDownload.disabled = true;
    qcStats.hidden = true;
    qcErrors.hidden = true;

    if (!lastResult) {
      qcPreview.innerHTML = '<p class="placeholder">请先在“排版模式”完成一次成功排版，再回到本模式粘贴实测 CSV</p>';
      return;
    }
    if (qcCsv.value.trim() === '') {
      qcPreview.innerHTML = '<p class="placeholder">请粘贴实测凸点 CSV（每行 x_mm,y_mm，首行可留表头）</p>';
      return;
    }

    var body = {
      design: lastResult.dots.map(function (d) { return { x: d.x, y: d.y, r: d.r }; }),
      plate: {
        width: lastResult.params.plateWidth,
        height: lastResult.params.plateHeight,
        margin: lastResult.params.margin
      },
      csv: qcCsv.value,
      offsetX: qcOffsetX.value,
      offsetY: qcOffsetY.value,
      tolerance: qcTolerance.value,
      maxRadius: qcRadius.value
    };

    fetch('/api/qc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (res) { return res.json(); })
      .then(function (r) {
        if (!r.ok) {
          qcPreview.innerHTML = '<p class="placeholder">无法生成质检叠加图：请按左侧错误修正 CSV 或参数</p>';
          renderQcErrors(r.errors || [{ message: '未知错误' }]);
          return;
        }
        lastQcResult = r;
        qcErrors.hidden = true;
        qcPreview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
        renderQcStats(r);
        btnQcDownload.disabled = false;
      })
      .catch(function () {
        qcPreview.innerHTML = '<p class="placeholder">无法连接服务器</p>';
        renderQcErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
      });
  }

  // 基于当前基准生成一份带轻微抖动/偏移的示例 CSV，便于快速体验
  btnQcSample.addEventListener('click', function () {
    if (!lastResult) {
      renderQcErrors([{ message: '尚无成功排版基准，请先在“排版模式”完成一次成功排版。' }]);
      return;
    }
    var ox = parseFloat(qcOffsetX.value) || 0;
    var oy = parseFloat(qcOffsetY.value) || 0;
    var tol = parseFloat(qcTolerance.value) || 0.5;
    var radius = parseFloat(qcRadius.value) || 1.5;
    var lines = ['x_mm,y_mm'];
    lastResult.dots.forEach(function (d, i) {
      // 反向扣除校准偏移，再叠加确定性抖动，使“偏移+公差”的效果可预测
      var jx = 0.06 * Math.sin(i * 1.7) - ox;
      var jy = 0.06 * Math.cos(i * 2.3) - oy;
      lines.push((d.x + jx).toFixed(3) + ',' + (d.y + jy).toFixed(3));
    });
    // 一个偏移超差点（半径内、公差外），一个缺失点（删掉最后一个设计点），一个多余点
    if (lastResult.dots.length >= 2) {
      var first = lastResult.dots[0];
      var last = lastResult.dots[lastResult.dots.length - 1];
      var over = Math.min(radius, Math.max(tol + 0.2, tol * 1.4));
      lines[1] = (first.x + over - ox).toFixed(3) + ',' + (first.y - oy).toFixed(3);
      // 循环中已跳过最后一个设计点 -> 它在结果中表现为“缺失”
      lines.push((last.x + 4).toFixed(3) + ',' + (last.y + 4).toFixed(3)); // 多余点
    }
    qcCsv.value = lines.join('\n');
    scheduleQc();
  });

  btnQcDownload.addEventListener('click', function () {
    if (lastQcResult) {
      // 服务端报告已含 UTF-8 BOM，Excel 直接打开中文不乱码
      download('emboss-qc-report.csv', 'text/csv;charset=utf-8', lastQcResult.reportCsv);
    }
  });

  /* ---------------- 启动 ---------------- */

  update(); // 首屏立即排版
  refreshBaselineInfo();
  if ((window.location.hash || '') === '#qc') switchMode('qc');
})();
