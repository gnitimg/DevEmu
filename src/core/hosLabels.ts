import type { HosImage } from './types.ts';

const DEVICE_LABELS: Record<string, string> = {
  phone: '手机',
  foldable: '折叠屏',
  triplefold: '三折叠',
  widefold: '宽折叠',
  tablet: '平板',
  '2in1': '2in1',
  '2in1 Foldable': '2in1 折叠',
  wearable: '手表',
  wearablekid: '儿童手表',
  tv: '电视',
  car: '车机',
};

export function hosDeviceLabel(type: string): string {
  return DEVICE_LABELS[type] ?? type;
}

/** 设备类型展示顺序：手机系靠前，其余垫底并按名称稳定排列 */
const DEVICE_ORDER = [
  'phone',
  'foldable',
  'triplefold',
  'widefold',
  'tablet',
  '2in1',
  '2in1 Foldable',
  'wearable',
  'wearablekid',
  'tv',
  'car',
];

export function hosDeviceOrder(type: string): number {
  const i = DEVICE_ORDER.indexOf(type);
  return i < 0 ? DEVICE_ORDER.length : i;
}

/** 镜像下载任务标识，渲染层与主进程共用 */
export function hosImageKey(deviceType: string, osVersion: string): string {
  return `hos-image:${deviceType}|${osVersion}`;
}

/** "HarmonyOS 6.0.0(20)" → "HarmonyOS 6"；非标准串原样返回 */
export function hosSeries(osVersion: string): string {
  const m = /^HarmonyOS\s+(\d+)/i.exec(osVersion);
  return m ? `HarmonyOS ${m[1]}` : osVersion;
}

const SCREEN_TYPE_LABELS: Record<string, string> = {
  phone: '直板',
  foldable: '折叠屏',
  triplefold: '三折叠',
  widefold: '宽折叠',
  tablet: '平板',
  '2in1': '2in1',
  '2in1 Foldable': '折叠屏',
  wearable: '手表',
  wearablekid: '儿童手表',
  tv: '电视',
  car: '车机',
};

/**
 * 机型的屏幕形态，用于在型号清单里标注。
 * 手机镜像清单里混有小折叠机型（nova flip、Pocket），它们的 deviceType 仍是 phone。
 */
export function hosScreenTypeLabel(deviceType: string, model?: string): string {
  if (deviceType === 'phone' && model && /flip|^Pocket\b/i.test(model)) return '折叠屏';
  return SCREEN_TYPE_LABELS[deviceType] ?? hosDeviceLabel(deviceType);
}

/** 型号归入产品线：Mate 90 Pro / Mate X7 / MatePad → Mate、MatePad 等系列名 */
export function hosModelBrand(model: string): string {
  const name = model.trim();
  if (/^Mate\b/.test(name)) return 'Mate';
  if (/^Pura\b/.test(name)) return 'Pura';
  if (/^nova\b/.test(name)) return 'nova';
  if (/^Enjoy\b/.test(name)) return 'Enjoy';
  if (/^Pocket\b/.test(name)) return 'Pocket';
  if (/^P\s?\d/.test(name)) return 'P';
  if (/^MatePad\b/.test(name)) return 'MatePad';
  if (/^MateBook\b/.test(name)) return 'MateBook';
  if (/^Watch\b/.test(name)) return 'Watch';
  if (name.startsWith('Huawei')) return 'Huawei';
  return name;
}

export interface HosModelGroup {
  name: string;
  models: string[];
}

/** 按首次出现顺序归并型号，系列顺序与模拟器机型清单一致（新的在前） */
export function groupHosModels(models: string[]): HosModelGroup[] {
  const map = new Map<string, HosModelGroup>();
  for (const model of models) {
    const name = hosModelBrand(model);
    let g = map.get(name);
    if (!g) {
      g = { name, models: [] };
      map.set(name, g);
    }
    g.models.push(model);
  }
  return [...map.values()];
}

export interface HosImageFamily {
  id: string;
  label: string;
  /** 共用一个系统镜像的设备形态，首个为安装/卸载时用的规范类型 */
  types: string[];
}

/**
 * 折叠与直板只是同一手机镜像的不同屏幕规格；2in1 与 2in1 折叠同理。
 * 镜像清单按此合并，避免同一版本因形态不同重复出现。
 */
export const HOS_IMAGE_FAMILIES: HosImageFamily[] = [
  { id: 'phone', label: '手机', types: ['phone', 'foldable', 'triplefold', 'widefold'] },
  { id: 'tablet', label: '平板', types: ['tablet'] },
  { id: '2in1', label: '2in1', types: ['2in1', '2in1 Foldable'] },
  { id: 'wearable', label: '手表', types: ['wearable'] },
  { id: 'wearablekid', label: '儿童手表', types: ['wearablekid'] },
  { id: 'tv', label: '电视', types: ['tv'] },
  { id: 'car', label: '车机', types: ['car'] },
];

export function hosDeviceFamily(type: string): HosImageFamily {
  return (
    HOS_IMAGE_FAMILIES.find((f) => f.types.includes(type)) ?? {
      id: type,
      label: hosDeviceLabel(type),
      types: [type],
    }
  );
}

export function hosFamilyOrder(id: string): number {
  const i = HOS_IMAGE_FAMILIES.findIndex((f) => f.id === id);
  return i < 0 ? HOS_IMAGE_FAMILIES.length : i;
}

/** Emulator.exe -storage 设置的是 /data 数据分区；界面上报的是含系统分区的整机容量 */
export const HOS_SYSTEM_STORAGE_GB = 6;

/**
 * 不支持自定义屏幕规格的设备形态：-screenProfileList 为空，
 * 创建时只能省略 -screenProfile，由模拟器取该形态的默认机型。
 */
export const HOS_DEFAULT_MODELS: Record<string, string> = {
  triplefold: 'Mate XT',
  '2in1 Foldable': 'MateBook Fold',
};

export interface HosImageGroup {
  family: string;
  label: string;
  osVersion: string;
  softwareVersion?: string;
  /** 该镜像家族的规范设备类型，安装/卸载都以它为准 */
  deviceType: string;
  downloaded: boolean;
}

/** 按镜像家族合并同版本的多条设备形态记录，家族内取最靠前的形态作为操作对象 */
export function groupHosImages(images: HosImage[]): HosImageGroup[] {
  const map = new Map<string, HosImageGroup>();
  for (const img of images) {
    const family = hosDeviceFamily(img.deviceType);
    const id = `${family.id}|${img.osVersion}`;
    let g = map.get(id);
    if (!g) {
      g = {
        family: family.id,
        label: family.label,
        osVersion: img.osVersion,
        softwareVersion: img.softwareVersion,
        deviceType: img.deviceType,
        downloaded: false,
      };
      map.set(id, g);
    }
    if (family.types.indexOf(img.deviceType) < family.types.indexOf(g.deviceType))
      g.deviceType = img.deviceType;
    if (img.downloaded) g.downloaded = true;
  }
  return [...map.values()].sort(
    (a, b) =>
      hosFamilyOrder(a.family) - hosFamilyOrder(b.family) ||
      b.osVersion.localeCompare(a.osVersion),
  );
}
