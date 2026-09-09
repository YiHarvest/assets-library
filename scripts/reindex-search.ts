import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import { loadConfig } from "../src/server/config";
import { db, pool } from "../src/server/db";
import { assetEntries } from "../src/server/db/schema";
import { enqueueSearchIndex } from "../src/server/repositories/assets";

async function main() {
  const config = loadConfig();
  if (!config.ELASTICSEARCH_URL || !config.embeddingConfigured) {
    throw new Error("请先配置 ELASTICSEARCH_URL 和 embedding 服务。");
  }
  console.log(`环境：${config.APP_MODE}，数据库：${config.databaseTarget.database}，目标索引：${config.ELASTICSEARCH_INDEX}`);
  let afterId = "";
  let count = 0;
  for (;;) {
    const batch = await db.select({ id: assetEntries.id, kind: assetEntries.kind })
      .from(assetEntries).where(and(
        gt(assetEntries.id, afterId), isNull(assetEntries.deletedAt),
        ne(assetEntries.reviewStatus, "deleted"), eq(assetEntries.processingStatus, "completed"),
      )).orderBy(asc(assetEntries.id)).limit(100);
    if (!batch.length) break;
    await db.transaction(async (tx) => {
      for (const asset of batch) await enqueueSearchIndex(tx, asset);
    });
    count += batch.length;
    afterId = batch.at(-1)!.id;
    console.log(`已提交 ${count} 条索引任务，目标索引：${config.ELASTICSEARCH_INDEX}`);
  }
  console.log(`共 ${count} 条素材已入队。运行 APP_MODE=${config.APP_MODE} pnpm start:worker 执行重建；状态见 search_index_state。`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "重建任务提交失败。");
  process.exitCode = 1;
}).finally(() => pool.end());
