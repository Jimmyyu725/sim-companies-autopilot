# 董事会议程:快速层改进方案(技术顾问提交,2026-07-23)

业主已阅,交董事会审议。请各位用本领域数字评估每项的优先级和取舍,CEO 裁决实施顺序。
背景数据(过去48h实测):tick 被 SKIP 59/562≈10%;产出失败/重试 472 次;空转告警 218 次。

## 待审议的六项意见

**#1 前瞻补货(响应式→预判式)** — 每 tick 计算当前订单结束时间和届时的原料需求,
提前30分钟补货。预期消除大部分472次产出失败,订单零间隙衔接,补货可挑价。改动量:中。

**#2 弹性定价** — 扫价档从固定的均价×[0.94..1.06]改为按 learn.js 实测的各商品价格弹性
动态生成(实证:咖啡粉+1.8%售速腰斩,苹果-2%售速+67%,弹性因商品而异)。预期营收+3-8%。改动量:中。

**#3 海滩市场认领** — Beach market 无人管理,循环里没有它的分支。给它极简逻辑:
有冰淇淋类库存就卖,没有就记录"有意跳过"。关联上届会议留的冰淇淋试单议程种子。改动量:小。

**#4 SKIP 短重试** — 10%的tick因锁竞争被跳过。SKIP时留10秒重试等锁释放,
预期把损失从10%压到2-3%。改动量:极小。

**#5 失败分级+卡死告警** — 失败分瞬时/结构/资金三类;同一原因连续失败≥3次自动写
fastloop-stuck.flag 唤醒战略层。历史依据:7小时农场死循环若有此机制,20分钟即被战略层修复。改动量:小。

**#6 给快速层加模型调用 — 顾问建议否决** — 成本翻几十倍,判断力收益有限。
正确分工是"脚本执行+学习层供参数+异常唤醒战略层"。请确认或反驳。

## 请各角色回答

- **CFO**:各项的成本/收益排序;#2 的营收增益如何验证;#6 的成本否决是否成立。
- **COO**:#1 前瞻补货的库存策略是否与 sweet-spot 原则冲突;#3 海滩市场值不值得占用开发精力;
  实施期间快速层的稳定性风险。
- **CMO**:#2 弹性定价对市场饱和度的影响(更精的定价会不会加速卷死自己的市场);
  #3 冰淇淋季末(8/29)前的窗口还值不值得进。

顾问推荐顺序:5→4→1→2→3(先堵事故,再提效率)。董事会可推翻。

---

## APPENDED 2026-07-24 (fast-loop deep-optimize workflow wf_d56259b6-3be — DEFERRED items for the board)

The workflow SHIPPED (already applied to tick.js/config.json): bean surplusWatch(118) so the real
~$6k frozen bean pile is visible; stuck-detector window slice(-40)→(-160) + throttled wake (it had
fired 0× ever = dead); price-history.jsonl bounded; realizable verdict annotation on surplus alerts;
wake target repointed to run-strategist-workflow.sh. It REJECTED the "divert grapes→beans" idea
(grapes were already draining; it would have grown the bean pile faster). These need the board:

1. **[HARD BLOCK] `recentEarnRate(buildingId)` ignores its argument** — every building's upgrade
   payback is priced off the STORE's sell rate, so an upgrade-payback number is currently wrong for
   any non-store building. **Do NOT enable any queued Farm/Mill/other L2 upgrade until this is
   fixed** (needs per-building tagging of observations.jsonl — a schema change, not a one-liner).
2. **[STRATEGY] Bean overproduction ~8:1 vs the Mill** (farm grows ~1,527/h beans, Mill drains
   ~180/h) — the structural cause of the $6k bean WIP. Fix is a strategy call: a 2nd Mill, smaller
   farm bean orders, or sell surplus beans. The fast loop can only make it VISIBLE (now done).
3. **[STRATEGY, dup of retail-lanes agenda] single store lane** — powder + steak + sausages + fruit
   contend for ONE sales queue; see board-agenda-retail-lanes.md.
4. **[LATENT] config.json lost-update race** on the accel-regime / build-success write paths —
   inert today (accel stable ×1, buildPlan disabled). If either re-arms, switch to
   re-read-then-patch-single-field. Flag, don't fix pre-emptively.
