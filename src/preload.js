'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('inkwell', {
  saveFile: (defaultName, data) => ipcRenderer.invoke('file:save', { defaultName, data }),
  openFile: () => ipcRenderer.invoke('file:open'),
  exportImage: (defaultName, data) => ipcRenderer.invoke('file:exportImage', { defaultName, data }),
  getInfo: () => ipcRenderer.invoke('app:info'),

  /* ---- 自绘窗口控制（1.2.0 无边框标题栏）---- */
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:maximize'),
  // 不叫 closeWindow 而是独立命名，提醒调用方它走的是正常关闭流程（含未保存确认）
  closeWindow: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  /**
   * 主进程广播的最大化状态变化（最大化/还原/全屏进出）。
   * 自绘的"最大化"按钮据此在「方框」和「还原」两个图标间切换。
   */
  onMaximizedChange: (cb) => ipcRenderer.on('window:maximized', (_e, isMax) => cb(!!isMax)),

  // 渲染进程自检结果回传主进程，落盘到日志
  reportHealth: (data) => ipcRenderer.send('app:health', data),
  /**
   * 交互追踪：把关键动作（切工具/点画布/开编辑器）写进 inkwell.log。
   * 用户报"点了没反应"这类无法本地复现的问题时，让用户跑一次，
   * 看日志就知道断在哪一步。
   */
  trace: (msg) => ipcRenderer.send('app:trace', String(msg)),
  /**
   * 主动上报"是否有未保存内容"。
   * 必须在 close 事件里同步读到脏标记，所以不能等主进程反查渲染进程
   * （executeJavaScript 是异步的，会把窗口卡住关不掉）。
   */
  setDirty: (dirty) => ipcRenderer.send('app:dirty', !!dirty),
  // 关闭流程：主进程请求确认，渲染进程弹 HTML 确认框后回传选择
  onConfirmClose: (cb) => ipcRenderer.on('app:confirm-close', () => cb()),
  closeChoice: (choice) => ipcRenderer.send('app:close-choice', choice),
  // 用户选择「保存」时主进程发来的存盘请求
  onSaveAndClose: (cb) => ipcRenderer.on('app:save-and-close', () => cb()),
  saveDone: (ok) => ipcRenderer.send('app:save-done', ok),
  platform: process.platform,
});
