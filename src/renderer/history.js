'use strict';

/**
 * 历史记录：命令模式 + 合并策略
 * 连续绘制同一条笔迹合并为一条历史，避免 Ctrl+Z 一下只退一个点
 */
class History {
  constructor(limit = 300) {
    this.limit = limit;
    this.stack = [];
    this.index = -1; // 指向最后一条已执行的命令
    this._pending = null;
  }

  push(command, { mergeKey = null } = {}) {
    // 合并：与栈顶同 key 且处于连续操作中
    if (mergeKey && this._pending && this._pending.key === mergeKey) {
      this.stack[this.index] = command;
      this._pending = { key: mergeKey, command };
      return;
    }

    this.stack.length = this.index + 1; // 丢弃 redo 分支
    this.stack.push(command);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    this._pending = mergeKey ? { key: mergeKey, command } : null;
  }

  /** 结束合并窗口（下一次 push 若 key 不同则不会合并） */
  seal() {
    this._pending = null;
  }

  canUndo() {
    return this.index >= 0;
  }

  canRedo() {
    return this.index < this.stack.length - 1;
  }

  undo() {
    if (!this.canUndo()) return null;
    const cmd = this.stack[this.index];
    cmd.undo();
    this.index -= 1;
    this._pending = null;
    return cmd;
  }

  redo() {
    if (!this.canRedo()) return null;
    const cmd = this.stack[this.index + 1];
    cmd.redo();
    this.index += 1;
    this._pending = null;
    return cmd;
  }

  clear() {
    this.stack = [];
    this.index = -1;
    this._pending = null;
  }

  toJSON() {
    return this.stack.slice(0, this.index + 1);
  }
}

module.exports = { History };
