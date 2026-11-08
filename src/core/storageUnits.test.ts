import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayedStorageGb,
  isStorageBucketGb,
  rawStorageGb,
  STORAGE_BUCKETS_GB,
} from './storageUnits.ts';

test('容量档位判定只接受与客人机显示一致的 GB 值', () => {
  for (const gb of STORAGE_BUCKETS_GB) assert.equal(isStorageBucketGb(gb), true);
  assert.equal(isStorageBucketGb(6), false);
  assert.equal(isStorageBucketGb(18), false);
  assert.equal(isStorageBucketGb(24), false);
});

test('写入分区时按营销容量换算，避免 GiB 被顶到下一档', () => {
  assert.equal(rawStorageGb(8), 7);
  assert.equal(rawStorageGb(16), 15);
  assert.equal(rawStorageGb(32), 30);
  assert.equal(rawStorageGb(64), 60);
  assert.equal(rawStorageGb(128), 119);
  assert.equal(rawStorageGb(256), 238);
});

test('客人机设置页的显示档位与实测一致', () => {
  // 实测：10G 配置显示 16 GB，16G 与 18G 配置都显示 32 GB
  assert.equal(displayedStorageGb(10), 16);
  assert.equal(displayedStorageGb(16), 32);
  assert.equal(displayedStorageGb(18), 32);
  assert.equal(displayedStorageGb(15), 16);
});

test('档位经过写入与显示换算后保持不变', () => {
  for (const gb of STORAGE_BUCKETS_GB) {
    assert.equal(displayedStorageGb(rawStorageGb(gb)), gb);
  }
});
