# LexiLoop 交接说明（给下一位接手的同事）

> 更新时间：2026-09-16。分支 `plan/lexiloop-implementation`。接手前先读完本文档。

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
