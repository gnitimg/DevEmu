import type fs from 'node:fs';

export interface FrameFile {
  path: string;
  bytes: number;
}

type FsLike = Pick<typeof fs, 'openSync' | 'closeSync'> & {
  readSync(
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ): number;
};

/** 现开一个句柄读一段。模拟器映射共享文件之前就打开的句柄只会读到旧数据，
 * 所以不能复用句柄，每次都现开现关。 */
function readFresh(fs: FsLike, file: FrameFile, length: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file.path, 'r');
    const buf = Buffer.allocUnsafe(length);
    return fs.readSync(fd, buf, 0, length, 0) === length ? buf : null;
  } catch {
    // 文件已不在（帧流结束）或被占用：这一帧作废
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;

/**
 * 读一帧像素。模拟器往共享文件写完才发帧通知，但它不等人：我们读的时候它可能
 * 已经在写下一帧。读完再核对开头一段，变了就说明撞上了，重读一遍。
 * 读不到（文件没了、连续撞上）返回 null。
 */
export function readSharedFrame(
  fs: FsLike,
  file: FrameFile,
): ArrayBuffer | null {
  const probe = Math.min(64 * 1024, file.bytes);
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = readFresh(fs, file, file.bytes);
    if (!body) return null;
    const head = readFresh(fs, file, probe);
    if (!head) return null;
    if (head.equals(body.subarray(0, head.length))) return toArrayBuffer(body);
  }
  return null;
}
