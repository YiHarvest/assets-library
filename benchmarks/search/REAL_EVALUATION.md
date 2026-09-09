**真实素材召回评测**

原有 `run.ts` 和 results 是合成阈值实验。新 `evaluation.ts`、`scripts/shadow-recall.ts`、`scripts/evaluate-recall.ts` 处理独立业务样本，评测止于返回候选，不模拟随机选材、limit=1 或跨段分配。

先由真实业务表达准备查询，覆盖 `assets-query`、`segment-match` 两类入口及个人库、候选白名单、名称/人工标签唯一信息、长文案、近似干扰与无合适素材。不能直接把素材描述改写当作真实查询分布。现阶段已从近期 match 作业导出真实分段表达，尚未收到可复用标注集，因此没有真实质量结论。

`node --env-file=.env --import tsx scripts/export-recall-evaluation-input.ts --output data/NEW_INPUT.json` 可只读导出当前素材快照及近 14 天匹配查询；该脚本直接使用显式 DATABASE_URL，不调用 `loadConfig()` 的主机改写，不进行迁移。输出是 stage=unjudged-input，需补充另一入口、主题分组和人工判断，再转换为下方冻结格式。不会把旧随机选材结果当成正例，也不自动重建逐段已用素材集合。

数据保存在被忽略的 `data/` 或其他受控目录，不提交业务查询、素材描述、私有素材 ID 和标注数据。新输出使用独占创建、文件权限 0600；已有冻结文件不会被覆盖。

**冻结格式**

数据 JSON 包含 schemaVersion=1、frozenAt（UTC ISO）、provenance（business/synthetic）、sourceSnapshotHash、assets 和 queries。`freezeDataset()` 校验后对完整内容计算 SHA-256，结果文件必须引用同一 datasetHash。修改标签、范围或查询后会生成新指纹，旧运行文件不能直接复用。

| 字段 | 含义 |
| --- | --- |
| assets[].assetId | 当前素材 ID，继续使用线上身份 |
| assets[].sourceGroup | 来源视频 ID；图片使用稳定来源组，不能把同视频切片伪装成不同来源 |
| assets[].partition | train / tune / test，同 sourceGroup 不跨集合 |
| queries[].id / text | 稳定查询 ID 与入口归一化前的真实表达 |
| queries[].entry | assets-query / segment-match |
| queries[].group / partition | 主题/改写组与集合，同主题不跨集合 |
| queries[].eligibleAssetIds | 经过当前业务权限、审核和显式范围筛选的素材 ID，仅使用同集合素材；空数组保持空范围 |
| queries[].noMatch | 人工确认无适合素材=true，有相关素材=false；尚未判读=null |
| queries[].poolComplete | 候选池及人工补充已完成判读的明确记录，不能由脚本自动设为 true |
| queries[].focus | 可选 name-only / human-tag-only 专项 |
| judgments[].assetId / grade | 0 不相关、1 部分相关、2 直接可用；未标注不填写 judgment |
| judgments[].visualReviewed | 已看真实画面，而不是只看现有描述或模型分数 |
| judgments[].descriptionContainsEvidence | 描述是否包含决定性信息；未知=null |

完整字段结构以 `datasetSchema` 为准。来源组在素材层划分，查询的 eligibleAssetIds 不能跨集合。冻结 test 后只在 tune 选参数；测试失败应记录差距，不能反复修改同一测试集直到过线。检索索引也必须来自被冻结的来源快照，见下方独立构建流程。

`scripts/prepare-recall-judging-draft.ts` 从准备输入按任务来源轮流采样，默认 200 条，输出全部位于 tune 的待判读草稿。任务来源仅用于均衡抽样，不能代替人工主题分组；脚本不会创建独立 test 样本，也不会自动赋标签。

**独立索引与 v1 基线**

使用 `scripts/prepare-recall-build.ts` 的 `--source-snapshot INPUT` 将来源散列写入清单。新方案指定 `--chunker visual-v2`，旧分块对照指定 `--chunker legacy-v1`，后者必须配套 trim-v1 及零重叠。构建 ID 以 `eval_` 开头。

`scripts/build-recall-evaluation-index.ts --input INPUT --manifest MANIFEST --base-index BASE --max-assets COUNT --output NEW_REPORT` 默认只在本地构建文档；追加 `--apply` 才创建全新的 `BASE_recall_v2_eval_*` 索引。逐素材调用同一原子 writer，单并发，实验中延后 refresh 并在末尾显式刷新；因此构建耗时不能当作线上单次更新可见延迟。报告记录块数、最大 token、写入耗时及主分片体积，不记录普通日志中的原文或向量。

旧分块对照可加 `--reuse-manifest NEW_LAYOUT_MANIFEST`：只有当前已核实模型/服务/归一化/tokenizer 身份相同，且 **实际送入模型的文本逐字相同** 时，才离线复用新实验索引中的向量；不同输入重新生成。这是独立实验的输入缓存，生产 writer 的完整 embedding 指纹规则保持原样，也不使用没有模型指纹的历史 v1 向量。

`scripts/build-recall-v1-baseline.ts --input INPUT --legacy-manifest MANIFEST --base-index BASE --index BASE_recall_eval_v1_ID --output NEW_REPORT --apply` 使用同一来源恢复 v1 原始分块顺序、文档 ID 与 mapping，从已核实的旧分块对照取完全相同文本的向量。生成的是同模型下重建的 v1 行为基线，不是线上 ES 的存储快照。原 v1 召回、阈值和按分块融合逻辑保持不变。

构建完成后写入完成记录，并设置实验索引 `index.blocks.write=true`。重放会检查快照散列、完整构建标记、文档计数与只读状态，部分构建或未固定的索引不能用于重放。v1 重放额外传 `--v1-index BASE_recall_eval_v1_ID`。普通线上构建不使用这些实验脚本，保持持久 revision/双写流程；正式切换还需要目标构建上的效果与追平报告。

**运行与候选池**

```sh
node --env-file=.env --import tsx scripts/shadow-recall.ts \
  --dataset data/recall-dataset.json --manifest data/recall-build.json \
  --policy config/recall/experimental-policy.json --system v2-hybrid \
  --base-index asset_library_dev --hardware dedicated-eval-1 \
  --max-queries 20 --interval-ms 250 --output data/v2-shadow-001.json

node --import tsx scripts/evaluate-recall.ts \
  --dataset data/recall-dataset.json --pool \
  --runs data/v1-run.json --runs data/v2-run.json \
  --runs data/semantic-run.json --runs data/lexical-run.json \
  --output data/judging-pool-001.json
```

影子脚本是独立进程，单并发、最多 1,000 条的显式预算。默认 20 条只做小批核对，不是完整验收。v1 重放要求配置 `SEARCH_RECALL_ENGINE=v1` 并指定上述冻结基线；v2 直接固定清单的物理索引，不修改线上别名。输出包含候选 ID/耗时/错误标志，普通日志不写查询与命中文本。这里测量固定索引后的召回阶段，不包含业务 MySQL 筛选、每请求别名解析和 HTTP 响应。`measurement.boundary=pinned-engine`（或旧文件缺失该字段）不能通过性能验收；正式报告要求实际测量从 MySQL 范围筛选开始、到召回及二次校验完成的 `shared-recall` 边界，不能直接改标签代替补测。硬件标记必须如实描述实际相同的模型服务、ES 和负载条件；脚本不能测出两个任意字符串是否代表相同机器。

候选池由各版本返回并集加人工补充组成。导出中的 grade=null 表示待标注，不能作为 0 导入。完成判读后重新冻结正式样本，再重新重放各方案，绑定最终数据指纹。主观或争议样本复核。无匹配结论必须针对该查询冻结的允许素材范围。

**指标与门槛**

```sh
node --import tsx scripts/evaluate-recall.ts \
  --dataset data/frozen-test.json --baseline data/v1-final.json \
  --candidate data/v2-final.json --output data/evaluation-final.json
```

生成 Recall@20/50/100、Success@20、nDCG@10、MRR、Precision@10、无匹配误召回率、Wilson 95% 区间及 p95，并分别统计两个入口。Recall 分母为已判读的 grade>0 集合，只能解释为对标注池的覆盖；未知相关素材会使 Recall 偏高。Top-10 或首个相关结果之前存在未判读项时，相应排序指标为 null，不当成负例。Precision@10 固定分母 10。

允许素材范围为空的查询保留为空范围行为测试，仍检查错误与范围越界；不计入负例数量或误召回率分母，不能用这类必然返回空的查询补足负例质量样本。

实现采用保守验收：至少 200 条独立 **test** 查询、500 条总素材、20 条确认无匹配查询，两类入口均有正查询；这是对计划样本规模的保守落地，样本不足时不自动放行。20 条负查询的区间仍可能很宽，需展示不确定性。R@50 至少 95%，两入口覆盖和排序不低于 v1；误召回不超过 5% 且不差于 v1；p95 不超过同条件 v1 的 1.2 倍。名称/人工标签专项必须有样本且命中。未判读、越界、异常、重复素材或未完成候选池都阻止验收。退出码 2 表示报告已生成但门槛未通过。

消融要求 v1、v2 语义、词法、双路、无元数据、旧分块，六类均已支持并通过真实服务的 CLI 回归。旧分块必须绑定实际 legacy-v1 构建，不能改个标签冒充对照。还需补齐真实画面判读、完整消融结论及相同负载下的性能报告。工具通过回归不代表效果门槛已经满足。

2026-09-09 已另行测量两个实际 repository 入口的 `shared-recall` 边界：真实素材快照装载到专用本地 MySQL，连接现有 ES/模型服务，每轮 800 个案例。索引元数据请求合并前后的候选集合一致，但背景服务延迟波动明显；assets-query 借用 segment-match 文本、私人所有者为测试数据，不能当作其真实请求分布或正式负载验收。两轮性能数据先于向量同分排序修复，具体数值、限制及受限本地记录见 `docs/recall-progress.md`。后续查询样本可独立提供，无需部署位置。
