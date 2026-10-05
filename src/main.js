'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.argv.includes('--dev');

/**
 * GPU 降级：白板是纯 2D canvas，不需要任何 GPU 加速。
 *
 * 踩坑记录：最初还加了 `disable-software-rasterizer`，结果 Chromium 转而走
 * SwiftShader 软件 GL，仍然要创建 GLES3 context，在无显卡环境报
 *   "Failed to create GLES3 context" / "Failed to create shared context for virtualization"
 * 正确做法是不干预光栅化后端（保留 SwiftShader 兜底），只关掉 GPU 合成与加速。
 *
 * 开关必须在 app ready 之前设置，否则完全不生效。
 * 如需强制启用硬件加速：INKWELL_GPU=1 或命令行加 --use-gpu
 */
function applyGpuFallback() {
  if (process.env.INKWELL_GPU === '1' || process.argv.includes('--use-gpu')) return;
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  // 让 2D 绘制不经过 GPU 光栅化，进一步减少对 GL 上下文的依赖
  app.commandLine.appendSwitch('disable-gpu-rasterization');
  // 明确启用软件光栅化兜底（不要用 disable-software-rasterizer，那会逼 Chromium 用 SwiftShader GL）
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** 关闭放行标志：为 true 时 close 事件不再弹确认框 */
let allowClose = false;

/**
 * 渲染进程主动上报的"有未保存内容"标记。
 * 必须在 close 事件里**同步**读到，所以不能让主进程反查渲染进程
 * （executeJavaScript 是异步的，会把 close 卡住 → 窗口关不掉）。
 */
let hasUnsavedChanges = false;

/**
 * 启动诊断日志：出问题时看这个文件，不用猜。
 * 路径惰性求值 —— app.getPath() 在 ready 之前不可用。
 */
let LOG_FILE = null;
function logPath() {
  if (LOG_FILE) return LOG_FILE;
  try {
    LOG_FILE = path.join(app.getPath('userData'), 'inkwell.log');
  } catch (_) {
    LOG_FILE = path.join(process.cwd(), 'inkwell.log');
  }
  return LOG_FILE;
}

function diag(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(logPath(), line, 'utf8');
  } catch (_) {
    /* 日志失败不影响主流程 */
  }
  if (isDev) console.log('[inkwell] ' + msg);
}

// 软件渲染降级必须在 app ready 之前生效
applyGpuFallback();

diag('=== 启动 ===');
diag('Electron ' + process.versions.electron + ' / Node ' + process.versions.node);
diag('ELECTRON_RUN_AS_NODE=' + JSON.stringify(process.env.ELECTRON_RUN_AS_NODE));
diag('命令行: ' + process.argv.slice(1).join(' '));

// 单实例锁：第二次启动时聚焦已有窗口。
// 注意：app 的部分 API 在 ready 之前不可用，锁逻辑放进 whenReady 内。
app.whenReady().then(() => {
  diag('app ready');

  const gotLock = app.requestSingleInstanceLock();

  if (!gotLock) {
    // 已有实例在跑：静默退出是"点没反应"的元凶，必须给出可见提示
    diag('检测到已有实例在运行，本次启动退出');
    const { dialog } = require('electron');
    dialog.showMessageBox({
      type: 'info',
      buttons: ['确定'],
      title: 'InkWell 白板',
      message: '白板已经在运行了',
      detail: '请在任务栏或 Alt+Tab 中切换到已打开的窗口。\n如果找不到，可能窗口被最小化或跑到屏幕外了。',
    });
    app.quit();
    return;
  }

  diag('获得单实例锁');

  app.on('second-instance', () => {
    diag('收到第二次启动请求，聚焦已有窗口');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // 窗口可能被拖到屏幕外，拉回可见区域
      const b = mainWindow.getBounds();
      const { screen } = require('electron');
      const disp = screen.getDisplayMatching(b);
      const wa = disp.workArea;
      const off = b.x + b.width < wa.x || b.x > wa.x + wa.width || b.y + b.height < wa.y || b.y > wa.y + wa.height;
      if (off) {
        mainWindow.setBounds({
          x: Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width)),
          y: Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height)),
        });
        diag('窗口在屏幕外，已拉回');
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function createWindow() {
  diag('创建主窗口');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    title: 'InkWell 白板',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch((e) => {
    diag('!! 页面加载失败: ' + e.message);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    diag('!! did-fail-load ' + code + ' ' + desc + ' ' + url);
  });

  mainWindow.webContents.on('preload-error', (_e, file, err) => {
    diag('!! preload 错误 ' + file + ': ' + (err && err.message));
  });

  // 渲染进程的报错统一落盘，白屏时能追溯
  // 注意：Electron 新旧版本签名不同（(e, level, message) 与 (event, details)）
  mainWindow.webContents.on('console-message', (...args) => {
    const a = args[0];
    if (a && typeof a === 'object' && 'message' in a) {
      if ((a.level ?? 0) >= 2) {
        diag(
          '渲染进程: ' + a.message +
          '\n    位置: ' + (a.sourceId || '?') + ':' + (a.lineNumber || '?') + ':' + (a.columnNumber || '?') +
          '\n    栈: ' + (a.stack || '(无)')
        );
      }
    } else {
      const level = args[1];
      const message = args[2];
      const line = args[3];
      const src = args[4];
      if (level >= 2) diag('渲染进程[' + level + ']: ' + message + ' @' + src + ':' + line);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    diag('!! 渲染进程崩溃: ' + JSON.stringify(details));
  });

  mainWindow.once('ready-to-show', () => {
    diag('窗口就绪，显示中');
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  /**
   * 关闭确认（改用页面内 HTML 弹框，不用原生模态框）。
   *
   * 踩坑记录：
   *  1. 不能用渲染进程的 beforeunload —— 它能阻止关闭但**不显示任何提示**，
   *     表现为"点了叉窗口死活关不掉"。
   *  2. 也不要用 showMessageBoxSync —— 原生模态框在部分环境下不显示或阻塞，
   *     同样表现为"关不掉"，且用户看不到任何反馈。
   *  3. close 事件是**同步派发**的，在处理器里直接调 close() 会重入导致挂起，
   *     必须 setImmediate。
   *
   * 现在：拦截 close → 通知渲染进程弹 HTML 确认框 → 用户选择后回传结果。
   */
  mainWindow.on('close', (e) => {
    if (allowClose) return;

    // 无未保存内容：直接放行（延后一拍，避开同步重入）
    if (!hasUnsavedChanges) {
      diag('关闭：无未保存内容，直接关');
      allowClose = true;
      return;
    }

    // 有未保存内容：阻止本次关闭，交给渲染进程弹确认框
    e.preventDefault();
    diag('关闭：有未保存内容，弹出确认框');
    mainWindow.webContents.send('app:confirm-close');
  });


  mainWindow.on('closed', () => {
    diag('窗口已关闭');
    hasUnsavedChanges = false;
    allowClose = false;
    mainWindow = null;
  });

  // 外部链接交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------- IPC：文件读写 ------------------------- */

ipcMain.handle('file:save', async (_e, { defaultName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '保存白板',
    defaultPath: path.join(app.getPath('documents'), defaultName || 'untitled.inkwell.json'),
    filters: [
      { name: 'InkWell 白板', extensions: ['inkwell'] },
      { name: 'JSON', extensions: ['json'] },
    ],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(filePath, data, 'utf8');
  return { ok: true, filePath };
});

ipcMain.handle('file:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '打开白板',
    properties: ['openFile'],
    filters: [
      { name: 'InkWell 白板', extensions: ['inkwell', 'json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
  const filePath = filePaths[0];
  const data = await fs.promises.readFile(filePath, 'utf8');
  return { ok: true, filePath, data };
});

ipcMain.handle('file:exportImage', async (_e, { defaultName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出图片',
    defaultPath: path.join(app.getPath('pictures'), defaultName || 'inkwell.png'),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(filePath, Buffer.from(data.split(',')[1], 'base64'));
  return { ok: true, filePath };
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron,
}));

// 渲染进程启动后的自检回报
ipcMain.on('app:health', (_e, data) => {
  diag('渲染进程自检: ' + JSON.stringify(data));
});

// 交互追踪：用户报"点了没反应"时，靠这个定位断点
ipcMain.on('app:trace', (_e, msg) => {
  diag('[trace] ' + msg);
});

// 渲染进程主动上报未保存状态（供 close 事件同步读取）
ipcMain.on('app:dirty', (_e, dirty) => {
  hasUnsavedChanges = !!dirty;
});

// 关闭前选择「保存」：等渲染进程存完盘再真正关窗
ipcMain.on('app:save-done', (_e, ok) => {
  diag('关闭前保存完成: ' + (ok ? '成功' : '失败/取消'));
  forceClose();
});

/**
 * 渲染进程回传的关闭确认结果。
 * @param {'save'|'discard'|'cancel'} choice
 */
ipcMain.on('app:close-choice', (_e, choice) => {
  diag('关闭确认框选择: ' + choice);
  if (choice === 'cancel') return;          // 保持窗口
  if (choice === 'save') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:save-and-close');
    }
    return;
  }
  forceClose(); // discard
});

/** 真正关闭窗口（延后一拍，避开 close 事件的同步重入） */
function forceClose() {
  allowClose = true;
  setImmediate(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
}

// 快捷键：Ctrl+O / Ctrl+S / Ctrl+Shift+E 由渲染进程处理，这里仅做兜底提示
ipcMain.on('app:flash', () => {
  if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
});
