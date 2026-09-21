# LexiLoop 交接说明（给下一位接手的同事）

## 2026-09-21 发布请求与门禁实测

- 用户已明确要求直接发布、清理旧生产数据、提交并推送代码，无需再次询问授权。
- 代码提交 `981bc64` 已推送 `origin/plan/lexiloop-implementation`；前端/Worker 已部署生产，Cloudflare Worker 版本 `7088e6bb-02a3-4873-b2d0-5f89ebd687ca`。生产完整冒烟通过：登录、CSRF、21 Unit bootstrap、75 卡会话、呈现/熟悉度事件、评分重放、撤销、统计、搜索、音频流、登出。按免费额度限制只运行 `remote-sample.ts`：13 条 D1 查询、8 词、8 卡、8 个 R2 对象均通过。
- 本轮执行 `pnpm compiler release package --source-hash 08496ec8927e15f59365319b243556f69922b42c6c7aa9635bde79a005d09e5e --previous-release rel-dc997f599668b817`，被 `RELEASE_GATE_UNMET` 拒绝：`IMAGE_EXTRACT` 账本状态为 `FAILED`（2026-09-18 的 `MEDIA_CONFIG_INVALID`）。后续结构、卡片、音频账本仍是内容修订前的记录，不能将旧产物重新命名为新发布。
- 视觉队列实测 `4394 total / 490 pending / 3904 resolved / 0 blocked`。另有未复核的例句字符质量问题；新内容、真题句音频和清理旧内容必须等真实编译与质量门禁完成后处理。当前 active release 仍是 `rel-dc997f599668b817`，不能删除正在服务用户的教材数据；即使新 release 激活，紧邻上一 release 按设计至少保留 14 天且供回滚，用户学习记录引用亦阻止直接删除。
- 本轮全仓 `pnpm verify` 通过（47 文件、802 Vitest、根目录 Python 1 项）；Playwright 24/24、OCR 专项 35/35、前端生产构建与 `git diff --check` 通过。Cloudflare Wrangler 登录状态正常。

## 2026-09-21 增量（生产仍是旧版）

- 用户要求一次性、限内存的高精度 OCR，持久化后统一校验。原始页 2× 行级 OCR 已对 3,674 条长行分别跑完 server/en 两模型；按原始字符完全不变、两模型同意新增英文字间空格筛出 840 候选，排除 `across→a cross` 误切后接受 839 条。补充例句行复读又接受 295 条，当前共 **1,134 条**在私有 `ocr-review-v1/accepted-spacing.jsonl`，SHA-256 为 `edf5d91dd1b7764b8c86f9280b4d5acfef4aabc4611dedda830abbaa59e4713b`；原始 `ocr.jsonl` 未改。`STRUCTURE_NORMALIZE` v9 通过原图哈希、bbox、OCR 引用哈希、旧文本逐项校验后才加载，且只允许新增字母间空格。计数保持 22/3545/4433/889/1862，归属异常 0；例句启发式警报由 1180 降到 1065，仍不可发布。
- 原始页对 196 条可疑释义做了逐页断点复读，结果在私有 `ocr-review-v1/sense-review-server/`。39 条可明确定位到助记、译文、页脚或其他文本串入释义后尾，保存为 `accepted-sense-trims.jsonl` 和独立证据文件；结构版本 v9 使用完整来源身份校验，并且只允许严格的原文前缀截断。最新全书计数不变，释义启发式警报 196→162。其余警报包含教材合法的 `[pl.]`、年份等，不能机械清理。
- 发现此前词头视觉复核把第 309 页原书 `plausible` 错修为 `planetwide`，已通过追加式 `reviseResult` 保留旧结果并改正。第 301 页原书 `hint` 被 OCR 截成 `int`，已做页码/bbox 限定的源页修复并对新词头包人工 PASS。词条总数、归属异常不变，待确认仍是 490 个音标字段。
- 为例句补充 OCR，先从当前 1,862 例句中选原始页物理短行；剔除已复读的长行、非英文行及页码后剩 4,990 行。`ocr_review_batch.py run-lines --examples ... --exclude-long-lines` 单页解码、单行 2× 裁图、原子页级断点。server 和 en 模型分别顺序跑完 387 页，结果在 `ocr-review-v1/example-lines-server/`、`example-lines-en/`，两者复跑均为 `new_pages=0,reused_pages=387`；不可并行加载两模型，以免 OOM。原始例句快照 `normalized-examples.jsonl` 及来源哈希已保存。双模型对齐后只有 297 个同字符、同空格位置的候选；第 85、321 页 2 条会令既有原书修复失效而被排除。接受其余 295 条前，影子编译证明所有词/释义/短语/例句键和数量一致，264 条变化的成品例句仅新增空格、无字符改写或归属异常。
- 双模型复读的 8,664 条行级结果又筛出 144 条高分、字符差异一致的候选，保存在 `ocr-review-v1/character-change-candidates.jsonl`，全部标记 `UNREVIEWED_CHARACTER_CHANGE`，**不得自动应用**。原书第 3–5 页已视觉核实并修复 Unit 1 的 `overstate` 真题句乱码、`Many young Americans cast doubts` 拼写和跨页英文空格；同页其他候选仍待核。
- 永久汇总脚本 `tools/content-compiler/scripts/audit-source-content.ts --work-dir <私有工作目录>` 只读本地保存的 OCR、两类已接受清单和视觉队列，重建 `ocr-review-v1/normalization-audit.json`、`normalization-summary.json`、`quality-flags.json`；无需重跑整页 OCR 或访问 D1/R2。最新快照哈希 `72653e41e92f9adcda18a6df2025e9bf320ab903a97c4acf4370c5f99ec45af2`。仍有 162 条释义启发式警报、1 条短语警报、1,064 条例句警报，含误报，但字符错误确实存在。当前验证为 `pnpm verify` 47 文件/802 个 Vitest、根目录 Python 1/1，OCR 专项 35/35、`git diff --check` 通过。
- 生产仍是 `rel-dc997f599668b817`。用户已授权发布与旧数据清理，但 490 音标与大量例句字符问题尚未达到来源质量门槛，不能部署、生成新 release 或删除旧生产内容。远程 D1/R2 仍只做小样本抽检。


## 2026-09-20 进展（生产仍是旧版）

用户已明确授权部署、新 release、访问生产 D1/R2 以及清除旧生产内容；同时要求远程 D1/R2 只抽检，节省免费额度。授权已具备，但**内容来源门槛尚未通过，不能发布或清理旧生产数据**。当前生产仍是 `rel-dc997f599668b817`。

- 本地基于原书扫描页重新归一化后有 22 Unit、3,545 词条、4,433 释义、889 短语、1,862 例句。视觉 OCR 还有 490 个音标字段待复核，内容归属检查为 **0**；这些数字来自已保存的 `.lexiloop-private/work/<source-sha>/ocr-review-v1/normalization-audit.json`，脚本为 `/tmp/lexiloop-audit.ts`。0 条仅代表当前确定性归属检查通过，不能解释成全书已校对完毕。
- 发现此前自动复核的伪阳性：第 109 页原书印有 `shift`，OCR 裁框漏掉前两字母成 `ift`，却被标记 PASS。现有追加式 `reviseResult` 保留原 PASS 并记录更正原因，新结果修为 `shift`；对应例句归属异常已消失。复核其他 PASS 时须检查完整书页，不能仅比较 OCR 裁框文字。
- 排除了把第 237 页 `fame of Allen's` 连字误认作新词头，以及把第 265 页 `visualise/-ize` 的 `Visualize` 例句重复建词。`-ise/-ize`、`-se/-ce` 后缀变体现在参与词条匹配。例句跨词条重分配复用了来源归属检查，避免把 `a broad` 当成 `abroad`；因此 `mental`、`rely` 等错配也被纠正。剩余 29 条空格粘连或派生词误分段已在本轮集中复识别和修正，当前归属异常为 0。
- 第 16 页前几个词条已与原书书页比对：`work`、`coworker`、`workforce`、`workplace`、`workout` 的主要释义和归属符合原书；仍可见例句的 OCR 拼写错误（例如 `worked works` 应是原书 `world works`），须在发布前完成来源校正。真题语音播放 UI 已接入，但新音频及 release 未生成。
- 第 95 页 `favo(u)rable` 例句跨左右栏，OCR 把右栏后半句误作短语。已依据原书书页合成完整例句并去除这条伪短语；归属异常由 39 降至 38。
- 第 170 页清理图被水印遮罩抹掉 `insure`，但保存的原始书页清晰可辨。归一化现在重组 OCR 分裂的词头和音标，下一页 `insure fire safety` 例句回到该词条；词头 PASS、音标 REPAIR 的视觉结果已入队留痕。归属异常加上短词连字/变形识别后降至 29。
- 针对用户提出的批量高精度 OCR，完整的已识别全书结果仍保存在私有 `ocr.jsonl`（约 19 MiB），不必反复扫描整页。另用**原始书页**对 509 个关键词头/音标裁图顺序运行三套识别模型，原始 JSONL、SHA-256 汇总和逐项比对保存在 `.lexiloop-private/work/<source-sha>/ocr-review-v1/`。192 个候选达到至少双模型相近读数，317 个冲突；这只是筛选，**绝不自动 PASS 或覆盖原书**。19 个已逐页看过原书的音标 REPAIR 已记录在正式视觉队列，故待复核为 490。三次顺序运行的峰值 RSS 约 643–751 MiB、0 swap；新 `ocr_review_batch.py` 支持原书小裁图、单模型单进程、按页原子持久化和断点复用。
- 对全部 29 条内容归属异常又集中运行了一次原始页局部分块 OCR，结果保存在同目录的 `content-findings.jsonl` 与 `content-issues-original-server.jsonl`；29/29 均已覆盖，约 267 个识别文本块。输出显示大量短语和例句是 OCR 词间空格丢失；第 308 页 `summarise/-ize` 是派生词误当成 `sum` 的短语。已按页限定修复，并从 `sum` 移除误收的派生词材料；重跑整书归属门禁由 29 降至 0。
- 三模型一致仍不能自动写入音标：在 19 个经原书人工确认的 REPAIR 中，模型合议候选只有 **1 个完全一致**、3 个相似度达 0.85。IPA 字符在模型中存在系统性错读，贸然将 174 个待处理合议候选自动通过会重现内容错误。当前 490 个待复核中 174 个有至少双模型候选、316 个互相冲突。
- 抽查部分归属门禁已通过的内容，仍发现独立的字符质量问题（如 `use` 释义混入 `[juis]`、`rage` 真题句混入杂字）。对 1,862 条例句的启发式扫描有 1,180 条触发长串英文/杂字警报，含误报，但抽样确认确有较多 OCR 粘词，故**不能把 0 条归属异常视为发布许可**。短行原页 2× 复识别实验在部分长英文行恢复空格；已对 414 页、3,674 条可疑 OCR 原始行顺序复识别，按页保存候选，不改写源 `ocr.jsonl`。其中 1,562 条在字符完全一致且二次识别分数至少 0.90 的条件下出现新增英文空格，汇总在私有 `spacing-candidates.jsonl`；这只是待核候选，不得直接当作全书已校对。
- 长行结果逐条校验了 `source_raw_ref_hash`、原始书页哈希和配置哈希，3,674/3,674 来源绑定正确；正式 `ocr_review_batch.py run-lines` 对现有 414 页断点复跑返回 `new_pages=0,reused_pages=414`。同模块 `report-lines` 可重建 `spacing-candidates.jsonl`，`run`/`report` 则管理三模型词头/音标裁图结果。仅原书原始 OCR 和候选报告保存在私有工作目录，均未写入生产。
- 最新验证：全仓 `pnpm verify` 通过（45 文件、796 个 Vitest；根目录 Python 1/1），OCR 专项 32/32、`git diff --check` 通过。全量内容编译、音频、新 release、生产部署与旧数据清理均尚未执行。
- 远程旧内容清理顺序：先新 release 完整门槛通过并上线抽检，再以 manifest 差集清理旧 release 独有 R2 对象及旧 release 范围内 D1 内容；保留别名、发布元数据和用户学习历史。不得远程全量扫描或删除整个 R2 bucket。

> 更新时间：2026-09-20。分支 `plan/lexiloop-implementation`。接手前先读完本文档；下方历史记录以顶部最新进展为准。

## 2026-09-18 本地修订（尚未部署）

用户抽查发现旧发布中的释义、常用短语和真题例句存在跨词条串行污染。本地已完成
结构归一化 v6 修订，并加入发布前的确定性来源归属门禁；**生产仍是旧发布，禁止在
视觉复核完成前部署本地 v6**。

- 全 440 页本地扫描结果：22 个 Unit、3,753 个词条、4,625 条释义、871 条短语、
  1,863 条例句；`SOURCE_CONTENT_OWNERSHIP_INVALID` 检查为 0 条。
- 修复了分栏/跨页例句、相关词词头、重复词条、括号变体、音标/词性拆行以及原书
  明确可核对的 OCR 损坏；真题句子音频按钮已接入学习页和词典详情页。
- 新解析恢复出更多词头，因此视觉 OCR 门当前为 5,819 条：旧队列 1,803 条已解决，
  新增 4,016 条待复核，0 BLOCK。新增项中仍有句子片段形态的可疑词头；不得降低
  置信度阈值、批量 PASS 或绕过队列。
- 结构版本已从 `STRUCTURE_NORMALIZE=5` 提升到 `6`；`LAYOUT_OCR=14`。只在已有
  OCR 产物上单独执行了结构阶段，没有重跑全书 OCR。
- OCR 已改为 1000×800、64px 重叠的顺序分块识别，识别批次为 1，CPU 线程为 2，
  并在每块/每页后释放数组和执行 GC。真实第 16 页 PaddleOCR 实测：74 blocks，
  17.95 秒，峰值 RSS 1,016,836 KiB（约 993 MiB），0 swap。全书必须继续使用
  12 页一个进程的可恢复分块流程，禁止高分辨率整页/整书单进程 OCR。
- 验证已通过：全仓 `pnpm verify`（44 files / 761 tests）、结构解析 152/152、OCR
  专项 27/27、Playwright 24/24。

当前视觉队列状态：

```bash
pnpm compiler agents visual-ocr status \
  --source-hash 08496ec8927e15f59365319b243556f69922b42c6c7aa9635bde79a005d09e5e
# packets total=5819 pending=4016 resolved=1803 blocked=0
```

后续顺序：先逐项解决新增视觉包并重新运行 `STRUCTURE_NORMALIZE`，再重跑语义、
卡片和真题语音阶段，生成全新 release；之后才可做有限 D1/R2 抽检并请求部署。
现有 `rel-dc997f599668b817` 只能作为旧生产回滚点，不能复用为 v6 发布。

## 当前状态（一句话）

Task 1–18 全部完成并通过评审；Task 19 的私有教材发布已激活
（`rel-dc997f599668b817`，批准的 V1 范围为 21/22 个 Unit），Worker+PWA 已部署到
Cloudflare 并绑定自定义域名 `https://lexiloop.juzong.cloud`。生产学习写入故障已修复，
完整冒烟通过。移动端界面已整体改版，当前生产 Worker 版本为
`55ebd60e-e7df-4f56-ab27-a85739c45ce9`。

## 已上线的东西

- Worker: `lexiloop-worker`（含每日备份 cron 0 19 * * *）
- 域名: `https://lexiloop.juzong.cloud`（workers.dev 在大陆被墙，用这个域名）
- D1: `lexiloop`（迁移 0001+0002 已应用；active_release_id 指向上述发布）
- R2: `lexiloop-audio`（私有；2,899+ 音频资产，实际 3,406 个清单条目）
- 账号: 3 个（alice/bob/carol）。**密码明文在
  `.lexiloop-private/users.private.txt`**（git-ignored），格式 `user:pass`。

## 已解决的生产写入故障（P0）

`PATCH /api/study/sessions/:id` 和首次评分此前在生产返回 500；现已修复并部署。

- 卡片定义和别名改为批量读取，`IN` 查询按 90 个 key 分块以遵守 D1 每条查询
  100 个绑定参数的上限；会话返回、建队列、PATCH、评分完整性检查和多会话列表
  均覆盖。新增模拟 D1 免费版预算的 110+ 卡 / 30 会话测试。
- 生产日志另外揭示了直接阻断写入的根因：请求统计的 `instrumentD1`
  把原生 prepared statement 包成普通对象，`D1.batch()` 因 `Malformed input`
  拒绝执行。`batch()` 现会解开包装并传回原生对象；增加 D1 形状测试。
- 生产完整冒烟：75 卡会话创建 201，WORD_PRESENTED / FAMILIARITY_SET / 评分 /
  重放 / 撤销 / 音频流 / 登出均为预期状态。生产 Worker 版本
  `f3244d62-c978-401e-abbe-557b855190c9`。
- `wrangler tail` 本轮已可用；调试时只提取状态和错误摘要，避免输出请求头。

## 免费额度下的远程抽检

按当前运行约束，不对生产 D1 和 R2 做全量读取。运行
`pnpm exec tsx scripts/remote-sample.ts rel-dc997f599668b817`：固定 13 条小范围
D1 查询，检查 8 条词记录、8 张卡定义和分布在 8 个哈希范围的 8 个 R2 音频对象；
抽检通过。这个结果是样本证据，不代表所有远程对象已逐个读取。离线 release
bundle 的全文件哈希验证、全仓测试和 Playwright 端到端另行通过。

## 移动端界面改版

- 今日、学习设置、单词学习、快速回忆、复习、词典、词条和数据页已统一为新的
  移动优先视觉系统；底部导航加入图标和明确选中态，长词表限制在卡片内滚动，
  30 天预测改为横向图表。
- 页面切换会回到新页面顶部，直接访问 `/login`、`/learn` 等 SPA 深链接会返回
  `index.html`，不会再由 Cloudflare Assets 返回 404。
- Service Worker shell cache 现在随前端构建变化，激活时删除旧 shell cache；登出
  清理等待异步缓存事件完成。现有用户刷新后会取得新版界面，离线壳不会永久停留
  在旧版本。
- 本地全仓门禁为 44 个测试文件、668 个测试全部通过，Playwright 24/24；生产仅用
  一个现有账号在 390px 视口抽检今日、学习、词典和数据页以及 Service Worker，
  没有对 D1 或 R2 做全量读取。

## 其他已知问题（按优先级）

1. `wrangler login` 的 OAuth 令牌时效短（几小时～1天），自动化跑长了会中途
   失效；`refresh_token` 用一次就轮换，脚本刷新易翻车。建议用 API Token
   （env `CLOUDFLARE_API_TOKEN`）替代交互式 OAuth。
2. c4.u1 BLOCKED（depredation 释义行在水印污染区被 OCR 整行漏识别）。修法：
   视觉转录补充该词证据 → 重新编译该 Unit → 用 unit-scope 重新打包。
3. TTS 对 MiMo 偶发空音频响应/慢挂起敏感；重试包装器 +
   `.lexiloop-private/rebuild-audio-manifest.mts`（从磁盘重建缓存清单）是
   现成的恢复工具。
4. Deferred minors 全记录在
   `.superpowers/sdd/2026-09-10-lexiloop-implementation/progress.md`
   （含最终全分支评审的分级处置），修 P0 后建议扫一遍。

## 常用命令

```bash
pnpm typecheck && pnpm test && pnpm test:python   # 全仓门禁
node .lexiloop-private/prod-smoke.mjs             # 生产冒烟
pnpm exec tsx scripts/remote-sample.ts rel-dc997f599668b817  # 有限远程抽检
npx wrangler deploy -c infra/wrangler/wrangler.toml
npx wrangler d1 execute lexiloop --remote -c infra/wrangler/wrangler.toml --json --command "SELECT ..."
```

## 编译产物位置

- 发布 bundle: `.lexiloop-private/releases/rel-dc997f599668b817`
- 工作目录: `.lexiloop-private/work/08496ec8927e15f5936…/`（OCR、规范化、
  卡片、音频、阶段账本）
- SDD 交接账本: `.superpowers/sdd/2026-09-10-lexiloop-implementation/progress.md`
