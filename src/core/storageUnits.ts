/** Android 设置页把数据分区可用空间向上取整到 2 的幂（十进制 GB）显示，例如 18 GiB 显示为 32 GB */
const EXT4_USABLE_RATIO = 0.974;

/** 与客人机显示口径一致的容量档位（GB） */
export const STORAGE_BUCKETS_GB = [8, 16, 32, 64, 128, 256] as const;

export function isStorageBucketGb(gb: number): boolean {
  return (STORAGE_BUCKETS_GB as readonly number[]).includes(gb);
}

/** 客人机要显示 N GB 时，AVD 分区应写入的 GiB 数：按 1e9 字节的营销容量换算 */
export function rawStorageGb(advertisedGb: number): number {
  return Math.max(1, Math.round((advertisedGb * 1e9) / 1024 ** 3));
}

/** 把已写入的 GiB 分区换算成客人机设置页会显示的档位 */
export function displayedStorageGb(rawGb: number): number {
  const usableBytes = rawGb * 1024 ** 3 * EXT4_USABLE_RATIO;
  let advertisedGb = 1;
  while (advertisedGb * 1e9 < usableBytes) advertisedGb *= 2;
  return advertisedGb;
}
