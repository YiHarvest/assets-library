**召回 v2 操作说明（尚未切换线上）**

所有命令从项目根目录运行。先阅读 [实施进度](recall-progress.md)。当前 `SEARCH_RECALL_ENGINE=v1`、`SEARCH_V2_WRITE_ENABLED=false`；只有通过真实效果和追平验收后才进入切换。以下命令中的构建号和环境名均为例子，执行前应使用实际审阅过的清单。脚本不调用 VLM，不上传媒体，不导入 legacy assets。

`recall-ops.ts` 使用 `loadConfig()` 解析的数据库和索引，必须额外传入相同的 `--base-index`。注意本项目在本地 macOS 的生产模式会改写内部服务地址；远程操作应在正确部署环境运行，不能假定本地 `.env` 原始连接串就是最终目标。脚本不导入自动迁移单例；0009 是单独的兼容性增量迁移，需要先按项目既有部署流程执行。

1. 准备清单与 tokenizer

```sh
node --import tsx scripts/prepare-recall-build.ts \
  --base-index asset_library_dev --build-id 000001 \
  --output data/recall-build-000001.json
```

固定下载版本、校验两份 tokenizer SHA-256，核对本地部署身份记录，生成不可覆盖的清单。已有文件散列不一致直接失败。此操作只写本地文件。部署身份记录来自 2026-09-09 的实际服务检查，模型或服务参数变化后须重新核实；本脚本不会登录服务端自动重新证明权重身份。

将清单中的 revision 配到 `EMBEDDING_REVISION`，配置 `SEARCH_V2_TOKENIZER_DIR`。先部署包含 v1/v2 的兼容代码，保持读 v1。新建构建后，在全部 Web/worker 写入进程开启 `SEARCH_V2_WRITE_ENABLED=true`；CLI 自己的环境开关不能证明其他实例已部署，需要通过部署版本与进程配置核对。

2. 新建索引与登记构建

```sh
node --env-file=.env --import tsx scripts/recall-ops.ts \
  --operation provision --manifest data/recall-build-000001.json \
  --base-index asset_library_dev --output data/recall-provision-plan.json
```

默认生成操作记录。检查后使用新的输出文件名并追加 `--apply`，才创建专用 ES 索引、校验模型运行时并登记不可变构建。失败可幂等重试；不会删除旧索引。生产 writer 的 ES 凭证应限制为已建目标索引的读写权限，去掉自动创建索引权限，避免物理索引被外部误删后被 ES 自动创建成错误 mapping。

3. 回填、追平与重扫

```sh
node --env-file=.env --import tsx scripts/recall-ops.ts \
  --operation backfill --manifest data/recall-build-000001.json \
  --base-index asset_library_dev --batch-size 100 --max-batches 1 \
  --output data/recall-backfill-001.json --apply

node --env-file=.env --import tsx scripts/recall-ops.ts \
  --operation check --manifest data/recall-build-000001.json \
  --base-index asset_library_dev --output data/recall-check-001.json
```

按 `asset_entries` 和保留的 `recall_sources` 主键合并扫描。每条素材单独事务捕获当前快照并入队，整批成功后推进游标；中断重放不重复产生相同版本的有效作业。实时写入负责覆盖已扫描游标之前的新 UUID。回填完成仅表示扫描结束，worker 尚需处理作业。

`check` 比较当前素材/分析/标签与持久快照、每构建 desired/indexedRevision、ES 素材身份/版本/内容指纹/删除标记，以及顶层文档总数。ES 扫描前后的来源清单必须一致。输出 `ready=false` 时按 blockers 处理；`--operation rescan --apply` 只重置目标构建游标，保留版本和已有作业，随后重新 backfill 可修复漏入队内容。当前核对工具上限为 65,536 条来源与 1,000,000 条标签关联，超出时明确失败，不能截断后宣称完成。

4. 受限影子重放与真实评测

详见 [真实样本评测说明](../benchmarks/search/REAL_EVALUATION.md)。影子重放使用独立进程、单查询并发、默认最多 20 条查询及请求间隔；不会参与业务响应。普通日志只有计数、版本、摘要，原始查询只存在于受限评测文件。

5. 切换与回退

`--operation switch` 需要 `--dataset`、`--baseline`、`--candidate`、`--policy`、四份重复的 `--ablation-runs` 参数，以及 `--expected-index`（首次别名不存在时写 `none`）。脚本从冻结样本和原始运行结果重新计算质量门槛，绑定策略和构建指纹，并即时重查索引追平。默认只生成记录；`--apply` 在门槛通过后才一次原子替换 v2 读别名。MySQL 命名锁序列化本工具对同一环境的操作，旧绑定的 remove 带 `must_exist=true`，别名已变化时失败。

CLI 只修改 v2 别名；实际部署时由实施过程根据记录中的 environmentChanges 同步 `.env`、策略文件及全部读实例的运行环境，再核对两个入口，用户无需手工同步。本地 `.env` 已补齐本次配置，当前仍读 v1。默认实验策略 `validated=false` 不具备切换资格；修改 validated 会改变策略指纹，正式测量应使用最终冻结文件。只有 `pinned-engine` 耗时的离线结果也会被门槛拒绝，必须补齐包含 MySQL 筛选和二次校验的共享召回性能证据。

回退 v1 前执行 `--operation rollback-check`：实际扫描旧索引的描述块文本，与当前来源逐素材精确核对，检测重复、陈旧和已删除素材残留，并检查是否仍有 legacy embed 作业在途。通过后按报告配置部署 `SEARCH_RECALL_ENGINE=v1`，保留 v2 双写。v1 缺少 durable revision，因此这只是当前时刻的核对，观察期须维持旧 worker 健康。回退到已验收的另一 v2 构建也必须先重新核对其追平，再使用 switch 的明确旧/新目标。

本轮不自动清理任何旧索引，不自动停止旧构建写入。至少覆盖一个完整业务观察周期，记录质量、错误率、p95、每路耗时和积压，再由部署流程确定何时结束回退窗口。

**尚待完成**：独立测试查询与视觉标注、消融质量结论、受控负载验收。已有 1,602 条素材的容量/更新成本记录，及两个 repository 入口各 200 条查询的共享召回性能诊断，详见 `docs/recall-progress.md`。assets-query 仍需其代表性查询样本，不要求提供部署位置。CLI 已在专用测试库及随机 ES 索引完成基础演练；实际上线时另行核对全部写入进程、生产追平和部署配置。
