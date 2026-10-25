import fs from 'node:fs';
import path from 'node:path';
import { readZipFile, zipEntryNames } from './zip.ts';
import type { ApkMeta } from './types.ts';

/** HAP（HarmonyOS Ability Package）解析与导入 */

export interface HapInfo {
  bundleName?: string;
  label?: string;
  versionName?: string;
  module?: string;
  /** 入口 ability（供 aa start 使用） */
  ability?: string;
}

type Json = undefined | null | boolean | number | string | Json[] | { [k: string]: Json };

/** 深度查找对象中第一个字符串字段（限定键名集合） */
function deepFind(node: Json, keys: string[]): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = deepFind(item, keys);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(node)) {
    if (keys.includes(k) && typeof v === 'string' && v && !v.startsWith('$string:')) return v;
  }
  for (const v of Object.values(node)) {
    const hit = deepFind(v, keys);
    if (hit) return hit;
  }
  return undefined;
}

/** 从 module.json 的 abilities 中找主入口（带 action.system.home 的 skills） */
function findEntryAbility(module: Json): string | undefined {
  if (!module || typeof module !== 'object' || Array.isArray(module)) return undefined;
  const abilities = (module as { abilities?: Json }).abilities;
  if (!Array.isArray(abilities)) return undefined;
  const home = abilities.find((a) => {
    const skills = (a as { skills?: Json }).skills;
    if (!Array.isArray(skills)) return false;
    return skills.some((s) => {
      const actions = (s as { actions?: Json }).actions;
      return Array.isArray(actions) && actions.includes('action.system.home');
    });
  });
  const name = (home as { name?: Json } | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * 解析 HAP 安装包内的清单（stage 模型 module.json / FA 模型 config.json，
 * 字段做深度容错查找）
 */
export function parseHapManifest(buf: Buffer): HapInfo {
  const info: HapInfo = {};
  for (const name of ['module.json', 'config.json', 'pack.info']) {
    let content: Buffer | null = null;
    try {
      content = readZipFile(buf, name);
    } catch {
      continue;
    }
    if (!content) continue;
    let json: Json;
    try {
      json = JSON.parse(content.toString('utf8')) as Json;
    } catch {
      continue;
    }
    info.bundleName ??= deepFind(json, ['bundleName', 'packageName']);
    info.versionName ??= deepFind(json, ['versionName']);
    if (!info.versionName) {
      // FA 模型版本在 version.name
      const ver = (json as { app?: { version?: { name?: Json } } }).app?.version?.name;
      if (typeof ver === 'string') info.versionName = ver;
    }
    info.label ??= deepFind(json, ['label']);
    const module = (json as { module?: Json }).module;
    if (module && typeof module === 'object' && !Array.isArray(module)) {
      const mn = (module as { name?: Json }).name;
      if (typeof mn === 'string') info.module ??= mn;
      info.ability ??= findEntryAbility(module);
    }
    if (info.bundleName) break;
  }
  return info;
}

export async function importHap(appsDir: string, srcPath: string): Promise<ApkMeta> {
  fs.mkdirSync(appsDir, { recursive: true });
  const stat = fs.statSync(srcPath);
  const fileName = path.basename(srcPath);
  if (!/\.hap$/i.test(fileName)) throw new Error('只支持 .hap 文件');
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dest = path.join(appsDir, `${id}.hap`);
  fs.copyFileSync(srcPath, dest);

  let meta: ApkMeta = { id, fileName, kind: 'hap', size: stat.size, importedAt: new Date().toISOString() };
  try {
    const info = parseHapManifest(fs.readFileSync(dest));
    if (info.bundleName || info.label || info.ability) {
      meta = {
        ...meta,
        packageName: info.bundleName,
        versionName: info.versionName,
        label: info.label ?? fileName.replace(/\.hap$/i, ''),
        activity: info.ability,
      };
    }
  } catch {
    // 清单解析失败不阻塞导入，仅缺元数据
  }
  if (!meta.label) meta.label = fileName.replace(/\.hap$/i, '');
  fs.writeFileSync(path.join(appsDir, `${id}.meta.json`), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

/** 仅用于错误信息：列出包内条目名 */
export function hapEntryNames(buf: Buffer): string[] {
  return zipEntryNames(buf);
}
