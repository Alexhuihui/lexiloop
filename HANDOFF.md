# LexiLoop 交接说明（给下一位接手的同事）

> 更新时间：2026-09-16。分支 `plan/lexiloop-implementation`，工作树干净，所有已
> 完成工作均已提交。接手前先读完本文档。

## 当前状态（一句话）

Task 1–18 全部完成并通过评审；Task 19 的私有教材编译已完成到**发布已激活**
（`rel-dc997f599668b817`，21/22 个 Unit），Worker+PWA 已部署到 Cloudflare 并
绑定自定义域名 `https://lexiloop.juzong.cloud`。

## 已上线的东西

- Worker: `lexiloop-worker`（含每日备份 cron 0 19 * * *）
- 域名: `https://lexiloop.juzong.cloud`（workers.dev 在大陆被墙，用这个域名）
- D1: `lexiloop`（迁移 0001+0002 已应用；active_release_id 指向上述发布）
- R2: `lexiloop-audio`（私有；2,899+ 音频资产，实际 3,406 个清单条目）
- 账号: 3 个（alice/bob/carol）。**密码明文在
  `.lexiloop-private/users.private.txt`**（git-ignored），格式 `user:pass`。

## 唯一未完成的任务（P0）

**`PATCH /api/study/sessions/:id`（WORD_PRESENTED / FAMILIARITY_SET）在生产环境
返回 500 INTERNAL。** 本地/E2E 全绿，仅生产炸。

- 根因（已定位，未修）：Cloudflare Workers **免费版每请求限 50 次子请求**
  （每次 D1 查询算一次）。`apps/worker/src/study/familiarity.ts` 的
  `groupWordKeys` 对会话里每张卡发逐卡 `content.getCard` + 逐 key
  `aliases.resolve`（75 卡会话 ≈ 150+ 次查询）→ 超 50 上限 → D1 抛
  "Too many API requests" → 被包成 INTERNAL 500。
- 修法：批量查询。卡片定义用一次 IN 查询取齐（`packages/db` 可能需要加
  `getCards(releaseId, keys)` 批量方法），别名用现成的
  `AliasRepository.resolveMany` 一次解析。同时排查 grade.ts 的完整性检查、
  service.ts 的 toSessionView/newWordsCards/supplementalCards 是否有同类
  逐 key 循环。语义不变，纯查询数削减。
- 复现：部署后跑 `.lexiloop-private/prod-smoke.mjs`（完整冒烟脚本，注意它
  第 9 行的 header 合并 bug 已修：`{cookie:..., ...extra}`）。
- 日志抓取：`npx wrangler tail` 的 websocket 在大陆网络不通（这是为什么
  调试走了弯路）—— 用 D1 查询 + 本地复现代替。

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
npx wrangler deploy -c infra/wrangler/wrangler.toml
npx wrangler d1 execute lexiloop --remote -c infra/wrangler/wrangler.toml --json --command "SELECT ..."
```

## 编译产物位置

- 发布 bundle: `.lexiloop-private/releases/rel-dc997f599668b817`
- 工作目录: `.lexiloop-private/work/08496ec8927e15f5936…/`（OCR、规范化、
  卡片、音频、阶段账本）
- SDD 交接账本: `.superpowers/sdd/2026-09-10-lexiloop-implementation/progress.md`
