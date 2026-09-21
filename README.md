# 盲文标签排版台（Braille Label Studio）

输入英文标签文字与板材宽/高、点距、行距，系统按**六点一级盲文**转换并排版：

- 大写字母前自动添加大写前缀 `⠠`（点 6）
- 连续数字段只在段首添加一个数字前缀 `⠼`（点 3-4-5-6）
- 依据转换后的盲文单元**整词换行**，词间空一个空白单元
- 任何单词放不下、或总行数超出板材容量时，**明确指出原因，绝不裁切**
- 页面实时预览带毫米（mm）坐标的凸点 SVG，并可下载 **SVG** 与**排版 JSON**
- 内置**压印质检**模式：以最近一次成功排版的设计点为基准，比对实测凸点 CSV

## 一条命令启动（Docker Compose）

```bash
docker compose up --build
```

Compose 会在构建镜像时自动完成依赖安装与初始化。启动后在浏览器访问：

**http://localhost:3000** （容器内外端口均为 `3000`）

停止：`docker compose down`

## 本地开发（不用 Docker）

```bash
npm install
npm start          # 同样监听 http://localhost:3000
npm test           # 运行转换/排版/质检单元测试（node:test）
```

## 两种模式的入口

页面顶部有两个标签页：

- **排版模式**（默认，`http://localhost:3000/` 或 `#layout`）：标签转盲文、排版、下载 SVG/JSON
- **压印质检**（`http://localhost:3000/#qc`，点击顶部“压印质检”标签进入）：
  1. 质检基准自动取**最近一次成功排版**的设计点（先在排版模式完成一次排版；页面左上角显示基准标签文字与设计点数）；
  2. 在文本框粘贴实测凸点 CSV，每行 `x_mm,y_mm`（首行可留表头 `x_mm,y_mm`，允许空行；解析错误会指出**具体行号**，如“第 4 行：X 坐标 “abc” 不是合法数字。”）；
  3. 设置 **X/Y 校准偏移 (mm)**、**合格公差 (mm)** 与 **最大关联半径 (mm)**（可点“基于当前基准生成示例”快速体验）；
  4. 实测点**先应用校准偏移**，再在关联半径内做一对一最优匹配后叠加显示，点“下载质检 CSV 报告”导出。

质检判定规则：

| 类别 | 含义 | 叠加图颜色/形状 |
| --- | --- | --- |
| 合格 | 配对距离 ≤ 合格公差 | 绿色实心圆 |
| 偏移超差 | 已配对但距离 > 合格公差（仍在关联半径内） | 橙色实心圆 |
| 缺失 | 未配对的设计点 | 红色圆圈加叉 |
| 多余 | 未配对的实测点 | 紫色菱形 |

匹配目标按优先级为：**配对数最多 → 总欧氏距离最小 → 同成本按设计点序号、CSV 行号稳定决胜**；严格一对一，一个实测点绝不重复匹配。统计区显示**通过率**（合格数 / 设计点数）、**最大偏差**与**平均偏差**（mm）。

质检报告 CSV（UTF-8 带 BOM，Excel 直接打开）列：

`设计点序号, 设计X_mm, 设计Y_mm, CSV行号, 实测X_mm, 实测Y_mm, 校准后X_mm, 校准后Y_mm, 距离_mm, 结论`

## 使用说明（排版模式）

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| 标签文字 | 英文标签（A–Z、a–z、0–9 及常用标点，≤500 字符） | `EXIT Door 2` |
| 板材宽度 / 高度 | 标签板材幅面，单位 mm | 100 × 50 |
| 点距 | 单元内相邻凸点中心距，单位 mm | 2.5（标准盲文） |
| 行距 | 相邻两行顶行点的中心距，单位 mm | 10（标准盲文） |
| 边距（高级） | 板材四周边距，单位 mm | 5 |
| 字距（高级） | 相邻单元净间距，留空 = 1.4×点距（标准 → 6mm 单元pitch） | 自动 |
| 凸点直径（高级） | 留空 = 0.6×点距（标准 ≈1.5mm） | 自动 |

放不下时的报错示例：

- `单词 “EXIT” 转换后占 6 个盲文单元（含大写/数字前缀），超过每行最多 4 个单元……`
- `整词换行后共需 5 行，板材有效高度仅容纳 4 行……`

## API

`POST /api/layout`，请求体：

```json
{ "text": "EXIT Door 2", "plateWidth": 100, "plateHeight": 50, "dotSpacing": 2.5, "lineSpacing": 10, "margin": 5 }
```

返回 `{ ok, errors, params, cellsPerLine, maxLines, lines, dots, brailleText, stats, svg }`：

- `ok=false` 时 `errors` 列出放不下的具体原因，`svg/dots` 为空（不输出裁切结果）
- `dots[].x/y/r` 为每个凸点的毫米坐标，`svg` 为完整 SVG 文档（`width/height` 以 mm 标注）

`POST /api/qc`（压印质检），请求体：

```json
{
  "design": [{ "x": 5.0, "y": 5.0, "r": 0.75 }],
  "csv": "x_mm,y_mm\n5.02,4.98",
  "offsetX": 0, "offsetY": 0,
  "tolerance": 0.5, "maxRadius": 1.5,
  "plate": { "width": 100, "height": 50, "margin": 5 }
}
```

返回 `{ ok, errors, params, summary, pairs, missing, extra, svg, reportCsv }`：

- CSV 解析错误带物理行号（`errors[].line`），此时不输出结果
- `summary` 含 `passRate / maxDeviation / avgDeviation` 与四类计数
- `pairs[]` 含双方坐标、校准后坐标、距离与结论；`reportCsv` 为完整质检报告

健康检查：`GET /api/health`

## 项目结构

```
├── server.js            # Express 服务：静态页面 + /api/layout + /api/qc
├── lib/braille.js       # 核心：一级盲文转换、整词换行排版、毫米坐标 SVG 生成
├── lib/qc.js            # 核心：实测 CSV 解析（行号错误）、偏移、一对一最优匹配、质检 SVG/CSV
├── public/              # 原生前端（index.html / app.js / style.css，双模式标签页）
├── test/                # node:test 单元测试（排版 + 质检）
├── Dockerfile           # 单阶段构建，npm install + 启动
└── docker-compose.yml   # 一条命令编排启动
```
