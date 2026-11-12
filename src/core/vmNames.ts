/** 默认名称：手机型号-YYYYMMDDNN，NN 从 01 起按同型号同日已有序号递增 */

export function sanitizeAvdModel(model: string): string {
  // AVD 名称只允许字母/数字/下划线/点/短横线：型号里的空格等转下划线
  const cleaned = model
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '');
  return cleaned.slice(0, 60) || 'device';
}

export function sanitizeHosModel(model: string): string {
  const cleaned = model.trim().replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '');
  return cleaned.slice(0, 40) || 'device';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function datedVmName(model: string, existing: readonly string[], at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const prefix = `${model}-${day}`;
  const re = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);
  let max = 0;
  for (const name of existing) {
    const m = re.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

export function avdDefaultName(model: string, existing: readonly string[], at = new Date()): string {
  return datedVmName(sanitizeAvdModel(model), existing, at);
}

export function hosDefaultName(model: string, existing: readonly string[], at = new Date()): string {
  return datedVmName(sanitizeHosModel(model), existing, at);
}
