# 分段素材匹配回放

```bash
pnpm benchmark:matching .run/material-matching/two-requests.json
```

读取独立快照，运行当前 v1 入库、真实 Embedding + ES + RRF 和全局分配。业务数据库读取由快照替代；
脚本仅写随机生成的 `asset_matching_bench_*` ES 索引，结束后删除。固定 `isRandom=false` 消除同分随机性。
快照和报告放入被 Git 忽略的 `.run/`，避免将业务文案和素材信息提交到仓库。

输入格式见 `run.ts` 的 `Fixture`：`assets` 是包含当前分析、标签、分镜起止时间的 `AssetDetail` 快照；
`tasks` 每项包含 `id`、原始 `segments`、原始素材白名单 `assetUrls`，以及可选的人工评审记录 `judgments`。
评审记录用 `segmentId` 指定片段、`acceptable` 指定已确认可用素材 ID、`unacceptable` 指定已确认误配 ID。
没有列出的组合是未评价，不能一律当成正确或错误。快照不得含凭证或回调地址。

默认输出 `.run/material-matching/results/`，第二个位置参数可指定其他输出目录：

- 每个任务一份原始业务结果 JSON，字段保持不变。
- `report.json` 保存逐路候选、原始余弦、RRF 分项、命中字段、时间证据、分配结果和源码哈希。
- 自动核对请求片段字段及时间轴不变、无素材越权、无源素材重复、裁剪时长正确。
- 输出已知误配是否重现、已知好素材是否保留；不从少量局部评审推算整体准确率。

`unknown` 时间证据表示存量兼容回退，不能算作片头已验证。时间校验依赖 VLM 的时间事实，
并不能证明模型观察一定正确。此回放不下载/转码媒体，不验证生产数据库权限，也不是 QPS 压测。
首次准备快照时需核对真实画面；固定同一分析快照比较代码，再单独比较重新分析的影响。
