/** 文件名部分：提示文案里只报文件名，不报整条路径 */
export const baseName = (file: string): string =>
  file.split(/[\\/]/).pop() ?? file;

/** 录屏计时文案：不足 1 小时显示 m:ss，否则 h:mm:ss */
export function formatElapsed(ms: number): string {
  const left = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = String(left % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
