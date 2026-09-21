# 盲文标签排版台（Braille Label Studio）

输入英文标签文字与板材宽/高、点距、行距，系统按**六点一级盲文**转换并排版：

- 大写字母前自动添加大写前缀 `⠠`（点 6）
- 连续数字段只在段首添加一个数字前缀 `⠼`（点 3-4-5-6）
- 依据转换后的盲文单元**整词换行**，词间空一个空白单元
- 任何单词放不下、或总行数超出板材容量时，**明确指出原因，绝不裁切**
- 页面实时预览带毫米（mm）坐标的凸点 SVG，并可下载 **SVG** 与**排版 JSON**

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
npm test           # 运行转换/排版单元测试（node:test）
```

## 使用说明

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

健康检查：`GET /api/health`

## 项目结构

```
├── server.js            # Express 服务：静态页面 + /api/layout
├── lib/braille.js       # 核心：一级盲文转换、整词换行排版、毫米坐标 SVG 生成
├── public/              # 原生前端（index.html / app.js / style.css）
├── test/                # node:test 单元测试
├── Dockerfile           # 单阶段构建，npm install + 启动
└── docker-compose.yml   # 一条命令编排启动
```
