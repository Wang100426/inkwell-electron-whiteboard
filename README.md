# InkWell 白板

一款本地运行的桌面白板软件，Node.js + Electron + 原生 Canvas 2D 实现，无任何前端框架依赖。

![画板效果](smoke-board.png)

## 快速开始

**最简单的方式：双击 `启动白板.bat`**，它会自动清理环境变量、按需安装依赖并打开窗口。

命令行方式：

```bash
npm install
npm start          # 启动
npm run dev        # 启动 + 打开 DevTools
npm run test:all   # 跑全部测试（压感 + 橡皮 + 文字 + 端到端 + 冒烟）
```

单项测试：

```bash
npm run smoke               # 端到端冒烟
npm run test:pressure       # 压感逻辑（纯 Node，秒出）
npm run test:pressure:e2e   # 压感端到端（含像素校验）
npm run test:eraser         # 橡皮矢量擦除（纯 Node）
npm run test:fill           # 填充工具
npm run test:text           # 文字/便签编辑
npm run test:edit           # 编辑 + 关闭回归（含焦点转移模拟）
npm run test:close          # 关闭行为静态检查（纯 Node）
```

**Windows 打包**：

```bash
npm run dist       # 生成安装包 + 便携版到 dist/
npm run dist:dir   # 只出 win-unpacked，用于快速验证
```

产物：

| 文件 | 说明 |
|---|---|
| `dist/InkWell Setup 1.0.0.exe` | NSIS 安装包（可选安装目录、创建快捷方式） |
| `dist/InkWell 1.0.0.exe` | 免安装便携版，双击即用 |
| `dist/win-unpacked/` | 未打包的目录结构 |

打包前会自动跑两个修复脚本，无需手动调用：

- `fix:sign` — 修复 `winCodeSign` 解压（macOS 符号链接权限问题）
- `fix:builder` — 修复 `rcedit` 文件锁导致的打包中止（见下）

### 打包中止：rcedit 报 Unable to commit changes

**症状**：打包在 `updating asar integrity executable resource` 这一步失败，
重试 4 次后整个流程中止，产不出安装包。

**原因**：packaging 刚把 Electron 的 exe 复制到 `win-unpacked` 后，
electron-builder 会立刻调用 `rcedit` 写入版本信息和图标。
此时 exe 的文件句柄尚未完全释放（安全软件也常在此刻扫描新生成的大文件），
rcedit 替换文件失败。electron-builder 内置 3 次重试，但**间隔太短**，
全部撞在同一把锁上。

**处理**：`npm run fix:builder` 会 patch `app-builder-lib`，
把内置重试换成**递增延迟重试**（0.7s / 1.2s / 1.7s …，最多 8 次）。
实测通常第 3~4 次成功。

> `npm install` 会还原 `node_modules`，所以该脚本已接入 `dist` / `dist:dir`，
> 每次打包自动重新应用。
>
> 顺带修正了 electron-builder 把 `OriginalFilename` 写成空串的问题
> （语义上应为 exe 文件名）。

## 故障排查

**启动日志**：任何启动问题都会记录在
`%APPDATA%\inkwell-whiteboard\inkwell.log`，里面能看到启动参数、窗口创建、
渲染进程自检结果与未捕获异常。排查问题时先看这个文件。

| 现象 | 原因与处理 |
|---|---|
| 双击无反应 / 报 `app is undefined` | 环境变量 `ELECTRON_RUN_AS_NODE=1` 让 electron.exe 退化为纯 Node 运行时。用 `启动白板.bat` 启动（会自动清除），或手动 `set ELECTRON_RUN_AS_NODE=` |
| 提示"白板已经在运行了" | 已有实例存活。任务栏或 Alt+Tab 切换；窗口跑到屏幕外时程序会自动拉回 |
| 界面空白 | `bundle.js` 未构建，执行 `npm run build:renderer` |
| 提示 `GPU process isn't usable` | 无 GPU 环境（虚拟机/远程桌面）。程序已自动降级，如需强制启用硬件加速设 `INKWELL_GPU=1` |
| 打包报 7z 符号链接权限错误 | `winCodeSign` 包内含 macOS 的 `.dylib` 符号链接，Windows 无开发者模式时无法创建。执行 `npm run fix:sign`（手动解压并跳过 darwin 目录） |
| 打包时 `rcedit` 报 `Unable to commit changes` | **会导致整个打包中止，产不出安装包**（不是可以忽略的警告）。原因见下方「打包发布」 |

## 功能

### 绘图工具（11 种）

| 工具 | 快捷键 | 说明 |
|---|---|---|
| 选择 | `V` | 单选 / Shift 多选、拖动移动、方向键微调 |
| 画笔 | `B` | 二次贝塞尔平滑，笔迹圆角连接 |
| 橡皮 | `E` | 按 z-order 语义擦除，遵循图层顺序 |
| 填充 | `F` | 油漆桶，点矩形/椭圆上色，再点取消 |
| 矩形 | `R` | 圆角矩形，Shift 拖正方形 |
| 椭圆 | `O` | Shift 拖正圆 |
| 直线 | `L` | Shift 吸附 45° |
| 箭头 | `A` | 带三角头部，Shift 吸附 45° |
| 文字 | `T` | 浮层编辑，Ctrl+Enter 确认 |
| 便签 | `N` | 黄色纸片 + 阴影，双击编辑内容 |
| 抓手 | `H` / 空格 | 平移画布 |

### 填充

填充是**独立工具**，不是样式开关。新画的图形一律只有描边，
想上色就切到填充工具点一下。

| 点击对象 | 效果 |
|---|---|
| 未填充的矩形/椭圆 | 填上当前填充色 |
| 已填充·同一颜色 | 取消填充 |
| 已填充·不同颜色 | 换成当前填充色 |
| 填充色选「无填充」 | 视为取消填充 |
| 线条 / 箭头 / 笔迹 / 文字 | 提示不支持 |

填充操作**可撤销**（进历史栈）。填充色板只在填充工具下显示。

> **为什么不做成样式开关**：早前"启用填充"是个粘性开关，
> 而且切换到便签工具时会**偷偷把全局填充打开、颜色改成黄色**，
> 导致之后画的矩形莫名被填成黄色。改成独立工具后这个耦合被彻底切断，
> 便签的黄色也写死在自己的 `makeBase` 里（`NOTE_COLOR`）。

> **拾取不能用 `hitTest`**：它对未填充的矩形/椭圆只认边框，
> 用它会形成"要点中才能填充、要填充才能点中"的死循环 ——
> 点内部永远没反应。填充工具用 `fillTargetAt()`：
> 先按精确命中找最上层图形（正确处理遮挡），
> 落空再退化为包围盒判定（覆盖"点在未填充图形内部"）。

### 样式

- 24 色调色板 + 任意颜色拾取
- 4 档线宽预设 + 1~40 无级调节
- 矩形/椭圆/便签支持填充色
- 全局不透明度 10%~100%
- 文字字号 10~72

### 视图

- 滚轮缩放（10%~800%），以光标为锚点
- 空格 / 中键 / 抓手工具拖拽平移
- 网格背景开关
- 「适应窗口」一键框选全部内容

### 文件

- 保存 / 打开 `.inkwell.json`（自描述 JSON，含全部图形）
- 导出 PNG（2 倍分辨率，自动裁剪到内容边界）
- 关闭前未保存会拦截提醒

### 快捷键

| 操作 | 快捷键 |
|---|---|
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y`、`Ctrl+Shift+Z` |
| 保存 / 打开 | `Ctrl+S` / `Ctrl+O` |
| 导出 PNG | `Ctrl+Shift+E` |
| 全选 | `Ctrl+A` |
| 复制 | `Ctrl+D` |
| 删除 | `Delete` / `Backspace` |
| 缩放 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| 适应窗口 | `Shift+1` |
| 网格 | `G` |

## 手写笔压感

检测到手写笔（`PointerEvent.pointerType === 'pen'`）时，画笔笔画粗细**随笔压实时变化**。

![压感效果](pressure-demo.png)

### 面板设置

| 项 | 说明 |
|---|---|
| 手写笔力度控粗细 | 开关，默认开启 |
| 最粗 | 压感满值时的线宽（6~60，默认 18） |
| 设备 / 笔压 | 实时显示当前输入设备与笔压百分比 |

面板仅在**画笔 / 橡皮**工具下显示。

### 压力 → 宽度映射

压力不是线性映射的，实际手感接近类感知曲线，故用指数曲线：

```js
width = base + (max - base) * pow(pressure, 1.6)
```

指数 1.6 让轻触时笔画明显更细，接近真实笔尖。宽度做了**低通平滑**
（`prev + (cur - prev) * 0.35`），避免笔迹忽粗忽细呈锯齿状。

### 变宽笔迹的渲染

**单一路径统一 `lineWidth` 无法表现粗细变化**，必须逐段描边
（`strokeVariableWidth`）：

1. 起点补圆
2. 逐段 `lineTo` + `stroke`，每段线宽取两端较细的一端 ×1.06
3. 每个采样点补圆，填平分段接缝

> 取 `min` 而非 `avg`：快速转折处平均值会让笔画宽度超出实际轮廓，
> 视觉上出现"鳞片"感。压感笔迹的采样间距也收紧到 0.8px（普通笔迹 1.2px）。

### 设备差异处理

`pressure` 字段各家设备报法不同，必须按 `pointerType` 分别处理：

| 设备 | 处理 |
|---|---|
| 手写笔 | 读真实 0~1 压力；报 0 时兜底为极小值（笔尖轻触） |
| 鼠标 | 无压感，按下恒为满宽，保持原有手感 |
| 触摸 | 多数屏不报压力（0 或 1），兜底为满宽；少数报真实值则直接用 |

**鼠标必须显式排除在变宽路径之外** —— 它的 `pressure` 恒为 1，
若只看压感开关会把鼠标笔迹误判为压感，白白损失渲染性能。

### 笔杆橡皮端

部分手写笔尾部是橡皮，浏览器报 `buttons & 32`（`button` 可能为 `5`）。
检测到即自动切换为擦除工具，无需手动切换。

### 数据持久化

笔迹的每个采样点都带 `w` 字段，保存到 `.inkwell.json` 时一并写入，
读档后压感完整保留。旧文件无 `w` 字段时自动回退为等宽渲染。

## 架构

```
src/
├── main.js              主进程：窗口、单实例锁、IPC 文件读写
├── preload.js           contextBridge 暴露安全的文件 API
└── renderer/
    ├── index.html       界面结构
    ├── styles.css       深色主题样式
    ├── geometry.js      几何计算：包围盒、点线距、曲线平滑、擦除裁剪、压感
    ├── eraser.js        矢量擦除：按图形类型裁剪数据
    ├── history.js       历史记录：命令模式 + 合并策略
    ├── board.js         核心引擎：图形模型、渲染、命中检测、PNG 导出
    ├── app.js           交互层：指针事件、快捷键、UI 绑定
    └── bundle.js        ← 自动生成，勿手改
```

### 为什么需要 bundle.js

应用开启了 `nodeIntegration: false`（安全最佳实践），此时渲染进程**无法 `require()` 本地模块**。
`build-bundle.js` 会把 `geometry/history/board/eraser/app` 按依赖顺序拼成单个 `bundle.js`，
并剥离 CommonJS 语法。**修改任一源文件后必须重新构建**，`npm start` 已自动包含该步骤。

```bash
npm run build:renderer
```

### 撤销重做设计

采用**命令模式**而非快照式：每次操作记录一条命令（`AddShape` / `RemoveShapes` /
`TransformShapes` / `ReplaceAll`），撤销即反向执行。相比整份快照，内存占用与图形数量无关。

连续画同一笔时通过 `mergeKey` 合并为单条历史，避免按一次 `Ctrl+Z` 只退一个点。

> **所有命令必须按 `id` 匹配图形，不能用对象引用。**
> 变换类命令（`TransformShapesCommand`）会整体替换 `shapes` 数组为深拷贝，
> 此前保存的对象引用随之失效。若用 `indexOf(shape)` 查找，
> 撤销删除/新增会静默失效。`AddShapeCommand` 与 `RemoveShapesCommand`
> 均已改为按 id 匹配，删除撤销还能按原索引顺序插回，保持图层顺序。

## 环境说明

### 窗口关闭

点右上角叉时的行为：

| 画布状态 | 行为 |
|---|---|
| 空 / 已保存 | 直接关闭 |
| 有未保存内容 | 页面内弹框：**保存 / 不保存 / 取消** |

确认框是**页面内 HTML 实现**，不是原生弹框。原因（都是实际踩过的坑）：

1. **不能用 `beforeunload`** —— 它能阻止关闭但**不显示任何提示**，
   表现为"点了叉窗口死活关不掉"。
2. **不能用 `showMessageBoxSync`** —— 原生模态框在部分环境不显示或阻塞，
   同样表现为"关不掉"，用户看不到任何反馈。
3. **`close` 事件是同步派发的** —— 在处理器里直接调 `close()` 会重入导致挂起。
   真正关闭统一走 `forceClose()`，内部用 `setImmediate` 延后一拍。
4. **脏标记必须同步可读** —— `close` 处理器里不能 `executeJavaScript` 反查
   渲染进程（异步会卡死）。改为渲染进程主动 `send('app:dirty', ...)`，
   主进程缓存供 close 时同步读取。

### 启动日志

任何启动问题都会记录在
`%APPDATA%\inkwell-whiteboard\inkwell.log`，包含启动参数、窗口创建、
渲染进程自检结果、关闭确认选择、以及所有未捕获异常（带文件名行号）。
排查问题时先看这个文件。

`BoardRenderer.render(state, shapes)` 的图形数据由 **store 显式传入**，
不从 `state` 解构。`state` 只承载交互态（草稿 / 选中 / 悬停），
图形的所有权在 `BoardStore`。混用两者会导致 `shapes is not iterable`
——这是开发过程中真实踩过的坑。

### 文字与便签编辑

两者共用同一套编辑器浮层（`openEditor` / `commitEdit`）：

| 操作 | 效果 |
|---|---|
| 选文字/便签工具后点击画布 | 立即弹出编辑器输入内容 |
| 双击已有文字/便签 | 编辑其内容 |
| 选中后按 `Enter` | 编辑其内容 |
| `Enter` / `Ctrl+Enter` | 提交（便签中单 `Enter` 换行，不提交） |
| `Esc` | 取消修改 |
| 编辑中点击画布 | 先提交当前内容，再开始新交互 |
| 点击别处失焦 | 自动提交 |

> 早前便签用 `window.prompt()` 编辑，而 **Electron 默认禁用该 API**，
> 导致双击便签毫无反应。现已改为统一的浮层编辑器。
> 便签使用 `is-note` 样式（浅黄底 + 深色字），与纸片配色一致。

**关键约定 1：文字图形必须携带 `fontSize` / `align` / `fontFamily`。**
缺失 `fontSize` 会让 `boundsOf` 算出 `NaN`，导致包围盒失效、
命中检测静默失败（双击和选中都打不开）——且不报错，极难排查。
`makeBase('text', ...)` 已统一注入这些默认值，`boundsOf` 与 `drawShape`
也各加了一层防御。

**关键约定 2：`openEditor` 重复调用前必须先提交。**
编辑中点击画布会再次触发 `openEditor`，若不先提交，
`editing` 会被覆盖导致之前输入的内容**永久丢失**。
`openEditor` 开头与 canvas 的 `pointerdown` 开头都有这道保护。

**关键约定 3：失焦提交只用 `focusout`，不要加全局监听或轮询。**
曾经为了"更可靠"加过全局 `focusin` 监听 + 200ms 轮询兜底，
结果**适得其反**：真实鼠标点击会引发焦点转移（`textarea` → `body`），
编辑器刚打开就被判定"失焦"、立刻提交空内容并关闭，
表现为「文字和便签根本编辑不了」。

> 这类问题**合成事件测不出来** —— `dispatchEvent` 不触发真实焦点转移。
> 回归测试 `scripts/test-edit-close.js` 专门模拟焦点转移来覆盖它。

现在只有三处明确提交点：`focusout` / `Enter`·`Esc` / 画布 `pointerdown`。

### 橡皮：矢量擦除，不是渲染遮罩

橡皮**不会**作为图形存在于 `shapes` 数组中。拖动时记录扫过的线段，
在数据层直接裁剪命中的图形：

| 图形类型 | 擦除行为 |
|---|---|
| 笔迹 `pen` | 按擦除区间切成多段（`splitPolylineByStroke`） |
| 直线/箭头 | 线段被切断成两段（`clipSegmentByStroke`） |
| 矩形/椭圆/文字/便签 | 命中即删除 |

早前实现把 eraser 存进 `shapes`、靠 `destination-out` 混合渲染，
导致橡皮会出现在图形计数、选区、保存的 JSON 里，语义混乱。
现已在 `src/renderer/eraser.js` 中实现为纯数据操作。
旧文件中的 eraser 图形会在加载时被自动丢弃。

擦除尺寸是独立的常量 `ERASER_SIZE`，**不共用画笔线宽滑块**。

### GPU 降级

白板是纯 2D canvas，不需要 GPU 加速。检测到无 GPU 环境时自动降级。

> 踩坑：最初额外加了 `disable-software-rasterizer`，结果 Chromium 转而走
> SwiftShader 软件 GL，**仍然要创建 GLES3 context**，在无显卡环境报
> `Failed to create GLES3 context` / `Failed to create shared context for virtualization`。
> 正确做法是**不干预光栅化后端**，只关 GPU 合成与加速，并显式
> `enable-unsafe-swiftshader` 兜底。

这些开关**必须在 `app.whenReady()` 之前设置**，否则完全不生效。
需要强制启用硬件加速时设 `INKWELL_GPU=1`。

不要用 `in-process-gpu`，实测会导致 `Failed to create GLES3 context`。

### 渲染调度

`requestRender()` 用 `rafPending` 标志去重，并配 60ms 定时器兜底。
原因是 `requestAnimationFrame` 在窗口隐藏/失焦时可能长时间不触发，
若仅用 `if (rafId) return` 去重，待执行的 rAF 标志会一直挂着，
导致后续所有重绘被静默丢弃、画布僵死。

### 隐藏元素必须靠 `[hidden]`

样式表开头有一条强制规则：

```css
[hidden] { display: none !important; }
```

**不能省。** 作者样式表里的任何 `display` 声明都会压过浏览器默认的
`[hidden] { display: none }`（UA 样式表优先级低于作者样式表，
与选择器权重无关）。

曾经 `.modal-mask { display: grid }` 与 `.panel-group { display: flex }`
让 `hidden` 完全失效，引发连锁问题：

- 关闭确认遮罩 `position: fixed; inset: 0; z-index: 200` **常驻全屏**
  → 拦截一切页面内点击 → 表现为「文字和便签根本编辑不了」
- 同一个遮罩从启动起就可见 → 表现为「一进去就是未保存提示」
- 只有系统标题栏的叉在页面之外，仍可点击 → 表现为「正常能关」
- 填充/字号面板也无法按工具切换

**新增需要隐藏的元素时，用 `hidden` 属性和 `.hidden = true` 即可，
但务必确认该元素没有被别的 `display` 覆盖。**

### 常见问题

**启动报 `app is undefined`**
环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 退化为纯 Node 运行时。
某些 CI / 容器环境会预设该变量，需清除后再启动。用 `启动白板.bat` 可自动处理。

**界面空白**
`bundle.js` 未构建。执行 `npm run build:renderer`。

**界面被一层看不见的东西挡住，点什么都没反应**
`hidden` 失效导致遮罩常驻。检查元素有没有被 `display` 覆盖，
`[hidden]` 强制规则是否还在样式表开头。

**撤销后选中框消失**
已通过 `Store._swapShapes()` 的 id 重绑定处理，若仍遇到请附上复现步骤反馈。

## 许可

MIT
