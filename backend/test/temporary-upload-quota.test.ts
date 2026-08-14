import assert from "node:assert/strict";
import test from "node:test";
import { PayloadTooLargeException } from "@nestjs/common";
import { UPLOAD_URL_TTL_SECONDS } from "../src/config";
import { temporaryUploadErrorPayload } from "../src/modules/temporary-files/temporary-upload-exception.filter";
import { TemporaryUploadDiskQuota, TemporaryUploadQuotaError } from "../src/services/temporary-upload-disk-quota";

function quota(overrides: Partial<ConstructorParameters<typeof TemporaryUploadDiskQuota>[0]> = {}) {
  return new TemporaryUploadDiskQuota({
    imageBytes: 20,
    videoBytes: 200,
    batchBytes: 200,
    processBytes: 300,
    activeFiles: 3,
    ...overrides,
  });
}

test("已知图片在流式接收阶段按20MiB等价阈值立即中止", () => {
  const policy = quota();
  const request = {};
  policy.begin(request, "image", "image");
  policy.add("image", 20);
  assert.throws(() => policy.add("image", 1), TemporaryUploadQuotaError);
});

test("单请求累计最多一个视频等价大小，未知类型不能累积绕过", () => {
  const policy = quota();
  const request = {};
  policy.begin(request, "unknown-1", "unknown");
  policy.add("unknown-1", 150);
  policy.release("unknown-1");
  policy.begin(request, "unknown-2", "unknown");
  assert.throws(() => policy.add("unknown-2", 51), TemporaryUploadQuotaError);
});

test("视频禁止与同批文件混合且全进程配额/并发在release后恢复", () => {
  const mixed = quota();
  const request = {};
  mixed.begin(request, "video", "video");
  assert.throws(() => mixed.begin(request, "image", "image"), TemporaryUploadQuotaError);

  const process = quota({ processBytes: 200, activeFiles: 1 });
  process.begin({}, "first", "unknown");
  process.add("first", 200);
  assert.throws(() => process.begin({}, "second", "unknown"), TemporaryUploadQuotaError);
  process.release("first");
  assert.deepEqual(process.snapshot(), { activeFiles: 0, processBytes: 0 });
  assert.doesNotThrow(() => process.begin({}, "second", "unknown"));
});

test("临时上传所有异常使用稳定invalid_file错误码", () => {
  assert.deepEqual(
    temporaryUploadErrorPayload(new PayloadTooLargeException("批次过大")),
    { error: { code: "invalid_file", message: "批次过大" } },
  );
  assert.equal(temporaryUploadErrorPayload(new Error("secret")).error.code, "invalid_file");
  assert.equal(UPLOAD_URL_TTL_SECONDS, 86_400);
});
