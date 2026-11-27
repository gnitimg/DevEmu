import fs from 'node:fs';
import path from 'node:path';

/** 四分之一圈：与模拟器 gRPC 的 SkinRotation 枚举同值 */
export type Quarter = 0 | 1 | 2 | 3;

export interface SkinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** layout 里的整幅叠加图（旧式皮肤的 fore 图）及其在 layout 内的位置 */
export interface SkinImage {
  file: string;
  x: number;
  y: number;
}

export interface SkinLayout {
  /** layout 名（portrait / landscape…） */
  name: string;
  width: number;
  height: number;
  /** 屏幕在 layout 内的矩形（已按部件旋转换算） */
  screen: SkinRect;
  /** 屏幕部件自身的旋转：非零表示这份 layout 画的是转过身的画面 */
  screenRotation: Quarter;
  /** 背景图（新式皮肤的屏幕处是透明洞） */
  backgrounds: SkinImage[];
  /** 屏幕前景遮罩（圆角与开孔），与屏幕同位同尺寸 */
  mask?: string;
  /** 盖在最上层的整幅叠加图 */
  onions: SkinImage[];
}

export interface SkinDefinition {
  /** guest 原生分辨率 */
  display: { width: number; height: number };
  layouts: SkinLayout[];
}

interface Node {
  props: Record<string, string>;
  blocks: Record<string, Node[]>;
}

const child = (node: Node, name: string): Node | undefined =>
  node.blocks[name]?.[0];

function tokenize(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/(#|\/\/).*$/, ''))
    .join('\n')
    .replace(/[{}]/g, ' $& ')
    .split(/\s+/)
    .filter(Boolean);
}

function parseBlock(tokens: string[], pos: [number]): Node {
  const node: Node = { props: {}, blocks: {} };
  while (pos[0] < tokens.length) {
    const key = tokens[pos[0]++];
    if (key === '}') return node;
    const next = tokens[pos[0]];
    if (next === undefined) throw new Error(`layout 文件在 ${key} 处截断`);
    if (next === '}') throw new Error(`layout 的 ${key} 缺少取值`);
    if (next === '{') {
      pos[0]++;
      (node.blocks[key] ??= []).push(parseBlock(tokens, pos));
    } else {
      node.props[key] = next;
      pos[0]++;
    }
  }
  return node;
}

const positiveInt = (value: string | undefined, what: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`layout 的 ${what} 非法`);
  return n;
};

const quarterOf = (value: string | undefined): Quarter => {
  const n = Number(value ?? 0);
  if (n !== 0 && n !== 1 && n !== 2 && n !== 3)
    throw new Error(`layout 的 rotation 非法：${value}`);
  return n;
};

/** 屏幕矩形。旋转部件的锚点有历史写法差异（layout 左上角 / 画面原角），
 *  取落在 layout 内的那个 */
function screenRect(
  layoutWidth: number,
  layoutHeight: number,
  display: { width: number; height: number },
  x: number,
  y: number,
  rotation: Quarter,
): SkinRect {
  const turned = rotation === 1 || rotation === 3;
  const w = turned ? display.height : display.width;
  const h = turned ? display.width : display.height;
  if (!turned) return { x, y, w, h };
  const anchors: [number, number][] = [
    [x, y],
    [x, y - h],
    [x - w, y],
  ];
  const inside = ([cx, cy]: [number, number]) =>
    cx >= 0 && cy >= 0 && cx + w <= layoutWidth && cy + h <= layoutHeight;
  const [cx, cy] = anchors.find(inside) ?? anchors[0]!;
  return { x: cx, y: cy, w, h };
}

/** 解析皮肤 layout 文件；结构不全或数值非法时抛错 */
export function parseSkin(text: string): SkinDefinition {
  const root = parseBlock(tokenize(text), [0]);
  const parts = child(root, 'parts');
  const displayNode = parts && child(child(parts, 'device') ?? root, 'display');
  if (!parts || !displayNode)
    throw new Error('layout 缺少 parts.device.display');
  const display = {
    width: positiveInt(displayNode.props.width, 'display.width'),
    height: positiveInt(displayNode.props.height, 'display.height'),
  };
  const layouts = child(root, 'layouts');
  if (!layouts?.blocks || Object.keys(layouts.blocks).length === 0)
    throw new Error('layout 缺少 layouts');
  const result: SkinLayout[] = [];
  for (const [name, nodes] of Object.entries(layouts.blocks)) {
    const node = nodes[0]!;
    const width = positiveInt(node.props.width, `${name}.width`);
    const height = positiveInt(node.props.height, `${name}.height`);
    const layout: SkinLayout = {
      name,
      width,
      height,
      screen: { x: 0, y: 0, w: 0, h: 0 },
      screenRotation: 0,
      backgrounds: [],
      onions: [],
    };
    let hasScreen = false;
    for (const placements of Object.values(node.blocks)) {
      for (const placement of placements) {
        const partName = placement.props.name;
        const part = partName ? child(parts, partName) : undefined;
        if (!partName || !part) continue;
        const x = Number(placement.props.x ?? 0);
        const y = Number(placement.props.y ?? 0);
        const rotation = quarterOf(placement.props.rotation);
        if (partName === 'device') {
          layout.screen = screenRect(width, height, display, x, y, rotation);
          layout.screenRotation = rotation;
          hasScreen = true;
          continue;
        }
        const background = child(part, 'background')?.props.image;
        if (background) layout.backgrounds.push({ file: background, x, y });
        const onion = child(part, 'onion')?.props.image;
        if (onion) layout.onions.push({ file: onion, x, y });
        const mask = child(part, 'foreground')?.props.mask;
        if (mask) layout.mask = mask;
      }
    }
    if (!hasScreen) throw new Error(`layout ${name} 缺少 device 部件`);
    result.push(layout);
  }
  return { display, layouts: result };
}

/** 读皮肤目录；没有 layout 文件或解析不了时返回 undefined */
export function readSkin(skinDir: string): SkinDefinition | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(skinDir, 'layout'), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseSkin(text);
  } catch {
    return undefined;
  }
}

/** 按 AVD 配置定位 SDK 皮肤目录（须含 layout 文件） */
export function findSkinDir(
  sdkRoot: string,
  config: Record<string, string>,
): string | undefined {
  const candidates = [config['skin.path']];
  for (const name of [config['skin.name'], config['hw.device.name']]) {
    if (name && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..')
      candidates.push(path.join(sdkRoot, 'skins', name));
  }
  for (const dir of candidates) {
    if (!dir || !path.isAbsolute(dir)) continue;
    try {
      if (!fs.statSync(path.join(dir, 'layout')).isFile()) continue;
    } catch {
      // SDK 迁移后旧 skin.path 可能失效，继续按机型查找。
      continue;
    }
    return dir;
  }
  return undefined;
}

/** 把朝向为 quarter 的画面转回原生竖屏所需的旋转角（画布坐标，正值顺时针）。
 *  真机实测：朝向 3（反转横屏）的帧逆时针转 90° 与 screencap 的原生画面逐像素吻合；
 *  枚举字面的"−90 degrees"是数学角，画布 y 轴朝下，符号相反。 */
export function restoreAngle(quarter: Quarter): number {
  return [0, 90, 180, -90][quarter]!;
}

const normalize = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** 把朝向为 frameRotation 的帧贴进"屏幕部件朝向"为 targetRotation 的位置，
 *  还需转多少度（画布坐标）。帧是原生画面转过 restoreAngle 的反方向得到的，
 *  目标位要的是另一种朝向时，差值就是这里要补的旋转。 */
export function frameAngle(
  frameRotation: Quarter,
  targetRotation: Quarter,
): number {
  return restoreAngle(frameRotation) - restoreAngle(targetRotation);
}

const landscapeOf = (layout: SkinLayout) => layout.screen.w > layout.screen.h;

/** 截图（guest 原生朝向的画面）该贴进哪份 layout */
export function pickStillLayout(
  skin: SkinDefinition,
  width: number,
  height: number,
): SkinLayout | undefined {
  const upright = (l: SkinLayout) => l.screenRotation === 0;
  const sameShape = (l: SkinLayout) =>
    l.screen.w === width && l.screen.h === height;
  const sameWay = (l: SkinLayout) => landscapeOf(l) === width > height;
  return (
    skin.layouts.find((l) => upright(l) && sameShape(l)) ??
    skin.layouts.find((l) => upright(l) && sameWay(l)) ??
    skin.layouts.find(sameWay) ??
    skin.layouts[0]
  );
}

/** 录屏：画布朝向取开始时的设备朝向；返回整幅画面相对 layout 还需旋转的角度
 *  （画布坐标，正值顺时针）。
 *  同为横向（或同为纵向）的 layout 优先——旧式皮肤两侧横屏共用一份横屏 layout，
 *  转到另一侧时与模拟器一致：整幅画面再转 180°。 */
export function pickRecordingLayout(
  skin: SkinDefinition,
  rotation: Quarter,
): { layout: SkinLayout; canvasRotation: number } | undefined {
  const sideways = (q: Quarter) => q === 1 || q === 3;
  const layout =
    skin.layouts.find((l) => l.screenRotation === rotation) ??
    skin.layouts.find(
      (l) => sideways(l.screenRotation) === sideways(rotation),
    ) ??
    skin.layouts[0];
  if (!layout) return undefined;
  return {
    layout,
    canvasRotation: normalize(
      restoreAngle(layout.screenRotation) - restoreAngle(rotation),
    ),
  };
}
