/**
 * 步行/跑步速度档位：纯数据模块（零 Node 依赖）。
 * 渲染层（定位面板）与主进程引擎共用；不要在本文件 import node 内置模块，
 * 否则渲染层打包会被 vite 以 browser-external stub 外置、顶层访问即抛错白屏。
 */

export interface WalkProfile {
  speedMps: number;
  cadenceSpm: number;
}

export const PRESETS: Record<'walk' | 'brisk' | 'run', WalkProfile> = {
  walk: { speedMps: 1.4, cadenceSpm: 112 },
  brisk: { speedMps: 2.2, cadenceSpm: 132 },
  run: { speedMps: 3.6, cadenceSpm: 168 },
};

/** 步幅 = 速度 ÷ 步频（速度 m/s，步频 步/分） */
export function derivedStrideM(speedMps: number, cadenceSpm: number): number {
  const cad = cadenceSpm / 60;
  return cad > 0 ? speedMps / cad : 0;
}
