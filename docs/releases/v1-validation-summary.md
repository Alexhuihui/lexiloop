# V1 release validation summary (redacted)

Metrics and hashes only. No textbook excerpts, credentials, user data, or
private object keys. Source content artifacts (PDF, page images, OCR text,
audio, bundles) live exclusively under git-ignored private paths.

## Source and scope

- Source: 440-page scanned textbook, PDF SHA-256 `08496ec8927e15f5936…`（与
  批准的源清单一致；440/440 页期望校验通过）。
- 结构化结果：22 个 Unit（21 个进入 V1 发布范围；`c4.u1` 因一个词条的释义行
  在水印污染区被 OCR 整行漏识别、无法生成任何卡片而按规范 BLOCKED，见
  "已知限制"）；1,390 词；1,382 义项；5,312 短语；2,158 例句。
- 卡片：8,833 张（四种卡型规则生成，稳定 content_card_key 与 release 无关，
  重跑字节级一致由测试钉住）。

## 编译管线（Content Compiler）

- 13 阶段可续跑管线全部 PASSED（SOURCE_FINGERPRINT → … → RELEASE_PACKAGE）。
- 版面 OCR：PaddleOCR PP-StructureV3（模型版本在 manifest 与配置中锁定），
  440 页全量；低置信关键字段全部走视觉 Agent 复核——1,797 个视觉复核包全部
  由独立 Agent 裁决（PASS/REPAIR），0 个 BLOCK，原始 OCR 证据未被修改，纠正
  以独立溯源记录保存。
- 语义内容门禁：22 个 Unit 全部通过 生成 → 独立审核 → 确定性验证 → 修复
  循环（上限三轮）。共 98 个语义包（22 生成 + 37 审核 + 39 修复），最终轮
  全部 PASS；生成与审核使用不同 agent_run_id，源字段零改动。
- 音频：Xiaomi MiMo `mimo-v2.5-tts`，3,406 条唯一文本全部合成并通过确定性
  门禁（解码、采样率/声道/容器、时长区间、静音、削波、text_hash 匹配）。
  无 ASR 组件。

## 已知限制

- `c4.u1`（第 4 章词表桶，236 词）BLOCKED：`depredation`（第 390 页）的释义
  行位于水印污染区，PaddleOCR 未输出该行，词级证据为空。按规范该 Unit 不得
  进入发布；V1 目标范围为其余 21 个 Unit（manifest `target_units` 明确声明）。
  后续可用视觉转录补充该词证据后重新编译。
- 书籍排印的 IPA 字体被 OCR 系统性 ASCII 化（ɪ→i、ə→a、重音/长音符号丢失）；
  全部 1,797 个受影响字段经视觉 Agent 逐字形核对修复。
- `WORKER_RELEASE_ID`、`ALLOWED_ORIGINS` 等部署变量记录在未跟踪的生产配置。

## 发布与部署

- Release id：`rel-dc997f599668b817`（21 个目标 Unit；bundle manifest 含
  每文件 SHA-256；`release verify` 通过）。
- 存储：单个 D1（`lexiloop`，迁移 0001+0002 已应用）+ 单个私有 R2 桶
  （`lexiloop-audio`，无公开访问）。
- 预置账户：3 个（本地 PBKDF2-SHA256 生成盐/verifier 后导入，凭据仅存于
  git-ignored 私有文件；`session_version=1`）。
- 生产回滚目标：null（首个生产发布；本地双发布回滚演练见 Playwright
  content-upgrade 套件，为 V1 回滚证据）。

## 验证

- 全仓门禁：`pnpm lint`、`pnpm typecheck`（7 包）、`pnpm test`（659 TS）、
  `pnpm test:python`（72+1）、Playwright 24 条端到端（含账户隔离、别名
  激活/回滚、重试幂等、安全头）、`pnpm --filter @lexiloop/web build` 全部
  通过；秘密扫描确认无密钥/PDF/教材内容入库。
