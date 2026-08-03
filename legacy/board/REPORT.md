# The Definitive Industry Survey — 2026-07-21

Commissioned by Jimmy: "the most complete, standard, deep top-15. Investigate every product,
every mechanic, every building." Data: all 151 resources, all 54 buildings, live exchange
prices (142), live retail info (80 products), order-book depth (20 markets), restaurant
mechanics from the official guide, and every constant pulled from the public bundle.

## Method

Per-building steady-state net profit per hour, best of two routes:

- **Exchange**: `price×0.96 − transportation − inputs` × L1 rate − wage. (4% fee verified in
  the realm table; transport = units × $0.377.)
- **Retail chain**: producer + store share, throughput = min(production, store velocity),
  where velocity = unitsSoldAnHour × 0.9 — validated against our own store on apples (99.0
  model vs 99.8 measured). **Price elasticity is fierce**: selling coffee 1.8% above average
  halved its velocity, so 0.9 is the at-average-price bound.
- L1 rate = producedPerHourRaw × 0.8087 (reproduced three times) × active event modifiers.
- No acceleration (ours expires 2026-07-22 15:42 CDT).
- Excluded with reasons: 12 research resources (no product), 11 seasonal goods (off-season
  prices are fiction; low-level companies cannot even trade them), 1 accumulator resource
  (trees — flat-rate maths invalid), 14 unprofitable at L1, 2 with unpriced inputs.

## The Top 15 (net $/h per building, level-1, steady state)

| # | Product | Building | $/h | Margin | Payback | Risk notes |
|---|---------|----------|-----|--------|---------|-----------|
| 1 | Quadcopter | Aerospace electronics $155k | $3,862 | 12.1% ⚠️ | 40h | Thin margin; demand partly contest-era; does have real base consumption ($406/h) and electronics-store retail |
| 2 | Flight computer | Aerospace electronics | $3,154 | 9.4% ⚠️⚠️ | 49h | **Zero base consumption — demand is contest-driven, event ends 7/28** |
| 3 | Pumpkin soup | Catering $114k | $3,038 | 61.4% | 37h | Restaurant demand 22–27k/day and **growing**; but input pumpkin is off-season produce — COGS will drift up as stockpiles deplete |
| 4 | Attitude control | Aerospace electronics | $2,938 | 23.7% | 53h | Zero base consumption; contest risk |
| 5 | **Samosas** | **Catering** | **$2,781** | **81%** | **41h** | **The robust pick: 380k/day restaurant demand, book clears in ~8h, all inputs year-round** |
| 6 | Lasagna | Catering | $2,564 | 29.1% | 44h | Margin thinner than it looks (steak input) |
| 7 | Gravy boat | Catering | $2,407 | 93.5% | 47h | Highest margin in the game; also an input to lasagna/meatballs (double demand) |
| 8 | Hamburger | Catering | $2,202 | 79.6% | 52h | 29k/day restaurant demand, demand index 0.95 |
| 9 | Cocktails | Catering | $2,182 | 74.7% | 52h | Uses 8× coffee powder — synergy with our mill |
| 10 | Meatballs | Catering | $2,089 | 33.8% | 54h | |
| 11 | Salad | Catering | $1,878* | 62.5% | 61h* | ***Suppressed by a −28% production event until 8/3; rebounds to ~$2,850/h (#4) after*** |
| 12 | Solid rocket | Propulsion $113k | $1,850 | 38.7% | 61h | Contest risk |
| 13 | Rocket engine | Propulsion | $1,828 | 27.3% | 62h | Contest risk |
| 14 | Combustion engine | Propulsion | $1,802 | 24.6% | 63h | Durable (cars), deep book |
| 15 | Jet engine | Propulsion | $1,701 | 19.8% | 67h | |

Near-missers worth knowing: crude oil #16 ($1,649, 72.6% margin, $76k building — the most
*durable* business in the game, fuel feeds everything), tools #18 ($1,493, real hardware-store
demand), **dough #20 ($1,304 but a $42k Bakery → 31.9h payback, the best capital efficiency
in the entire survey)**.

## Alternative lenses

**Capital efficiency (payback)**: dough 32h · pumpkin soup 37h · quadcopter 40h · samosas 41h · lasagna 44h
**Margin robustness**: gravy boat 93.5% · samosas 81% · hamburger 79.6% · cocktails 74.7% · crude oil 72.6%
**Demand durability**: crude oil / methane (fuel) · combustion engine (cars) · tools (construction) · catering foods (0.95 demand index, restaurant-driven)

## The verdict

**Catering is the best industry in the game right now**, and it is not close once risk is
priced in. It holds 7 of the top 11 slots; its demand index is pinned at 0.95 (maximum) on
every dish; realm restaurants consume 380k samosas and 320k salads a day; the exchange books
clear in hours, not years. Aerospace posts bigger single numbers on 9–12% margins propped up
by a contest that ends July 28. One catering building can switch between all eight dishes as
prices move — built-in diversification the aerospace cluster lacks.

**Single best pick: samosas.** $2,781/h, 81% margin, bottomless restaurant demand, every
input available year-round, and price-crash resistant (a 4× input-price spike still leaves it
profitable). Pumpkin soup beats it on paper but rides on off-season pumpkins.

## Mechanics discovered this session (appendix)

1. **Two economies**: exchange (4% fee, player-to-player, price-ordered book — undercut and
   you sell now) and retail (fee-free, sells to simulated citizens, capped by per-product
   velocity and steep price elasticity). Restaurant demand is a third pool that dwarfs both
   for food items.
2. **Restaurants** (from the official guide): 12h uncancellable cycles; menu $60–350; must
   stock all 3 categories; leftover menu food **spoils**; economy seating 1000 seats vs
   luxury 500 (luxury halves wages, multiplies rating); pro staff = 5× wages; closing costs
   12.5% rating; occupancy computed against three customer segments (price/rating/both).
3. **Production**: L1 = 0.8087 × raw rate; each building level roughly adds another L1 unit
   of capacity; event modifiers are live (+21% coffee beans, +23% eggs, −28% salad until
   8/3); weather multiplies selling speed (0.80 observed); robots add speed at higher levels.
4. **Research/quality**: 6.25% patent conversion (server-rolled), quality raises retail
   price and priority; realm quality cap 12. Only lever: CTO science skill, damped hard.
5. **Economy state**: realm reports economyState 1 (normal); customer-segment sizes shift
   with the cycle. Contest #216 (Space Race) inflates aerospace demand until 7/28.
6. **Frictions**: 4% exchange fee + per-unit transport — together a margin filter that
   demotes thin-margin goods (quadcopter loses 27% of profit to them, samosas 4.7%).
7. **Levels**: order-length caps (5h → 24h at Lv.5 → 48h at Lv.15), building slots 4→14,
   capability unlocks (research Lv.10, executives Lv.15, buy orders Lv.25).
8. **Building economics**: wages range $79/h (nursery) to $759/h (hangar); upgrade cost of
   level n ≈ n × L1 cost; seasonal market stalls are cheap ($7.6–19k) but single-season.

## Consequences for our roadmap

Unchanged in direction, sharpened in destination:

1. **Mill tonight** (~$31k): coffee chain lifts us from $265/h to ~$1,013/h post-acceleration.
2. **Compound to ~$114k → Catering, open on samosas** (~$2,781/h per building), switching
   dishes opportunistically (salad after 8/3, gravy boat as second string).
3. **Restaurant ($99k) only after** owning Catering long enough to observe realm restaurant
   saturation; its demand pool is enormous but occupancy is a gamble the exchange route
   doesn't take.
4. Aerospace deferred until post-contest prices reveal the real demand floor — and then only
   with HGEC vertical integration (the 35% make-vs-buy saving) at high building levels.

## 2026-07-23 — 垂直整合 vs 纯组装:6-agent 对抗性验证结论

对 flight computer 的 vertical-vs-assembly 分析做了 6 个独立 agent 的对抗性验证(45项检查,零分歧)。结论:

**核心算术全部确认**(纯组装 $2636/建筑时、全自产 $895/建筑时、31栋、配方、价格均正确)。**但两个纠正:**

1. **【纠正】"航空全都输给咖啡"是错的。** 纯组装 FC 是 **$2636/建筑·小时,高于咖啡 $1593**。只有全自产($895/$908)才输给咖啡。正确表述:**全自产FC输咖啡,纯组装FC赢咖啡。**

2. **【纠正】HGEC 自产成本是 $272.5,不是 $594**(我说高了一倍)。仍是最值得自产的部件。

**三个必须记住的建模保留(以后所有产业分析都适用):**

- **⚠️ 渠道不可混比**:咖啡 $1593/h 是**零售**(卖消费者,受售速限)；FC $2636/h 是**交易所**(扣4%)。同是"每建筑·小时"但渠道不同,不是干净对比。
- **⚠️⚠️ 真瓶颈可能是"市场吸收量"而非"建筑格位"**:整个 per-building 排名假设"交易所无限吃货",但市场价格弹性很陡(实测过)。纯组装1条线 vs 全自产31栋,倒进市场的量天差地别。**如果瓶颈是市场吃不吃得下,全自产的总量 $27,788/h 反而可能更优。** 这是最大的建模盲点。
- **⚠️ 建筑数是连续理想值**:31.06/25.07 是100%利用率的上界,实际要向上取整且混合不同建筑类型,是上界不是可部署数。

## 2026-07-23 — 生产数量维度(5-agent 验证):最终产量 + 市场吸收才是真瓶颈

业主问"垂直整合会不会最终产品很少"——答案是对的,而且揭穿了更深的问题。

**① 成品产量由最后组装厂决定,与买/自产无关:** FC 无论纯组装(1栋)还是全自产(31栋)都是 8.1 台/h。多的30栋只喂料、贡献0台成品。每槽产出:组装8.1 vs 自产0.26(差31倍)。全自产换的是毛利率,不是产量。

**② 14格上限下全自产不可行:** 一条自产链要31栋 > 14上限,连半条都建不齐。

**③ 真瓶颈是市场吸收,不是建筑格位:** FC全服消耗≈0.057台/h。一条线8.1/h过剩143倍,14条线113/h过剩2000倍。$2636/建筑时是"涓流"快照,一上量价格就崩。**FC天生是坏的走量产品。**

**④ 产品定位铁律——先看需求池,再看单价:**
```
           单价    产量   真实需求       14槽利润
FC        $5100   8.1/h  ~0(没人买)     ~$2.6k/h(只等于1个建筑)
咖啡       低      40/h   283万/天(海量)  ~$19.7k/h(但已过剩)
萨莫萨     $745    5.7/h  38万/天(缺货)   ~$38.7k/h ← 走量赢家
```

**给董事会的规则:排产业时,per-building $/h 高不代表能实现——必须先查该产品的真实市场吸收量(resources[k].consumption + unitsSoldAnHour)。高单价低需求的产品(FC/航空件)的高$/h是"卖得掉第一个"的幻觉,不可复制产线。要走量选有缺货需求池的(萨莫萨)。**

## 2026-07-23 — 自产HGEC深度精算(5-agent):最终否决航空垂直整合

业主问"全自产HGEC呢"。5个agent 35项精算，裁决:不值得。

**① 黄金条炸弹:** HGEC配方含0.0625金条(微量)，但金条=200金矿，金矿只80.9/h → 自产金链炸成24-29栋。喂1条FC线的核心块=1FC+10HGEC=11栋(HGEC产能仅3.23/h是瓶颈)。

**② 省成本但账面≠实际:** HGEC自产$616 vs 买$895(省$278，其中$420是金条pass-through)。FC成本$4570→$3470，利润$326→$1425/台。但摊11栋只$1,048/栋·时。

**③ 14格最优=方案C:** 自产硅+化学+HGEC，买黄金条(自造金条只省1.6%不值)，用13格得$1,078/栋·时。

**④ 决定性对决(每11栋):**
```
萨莫萨      $30,382/h  ← 真能兑现(380k/天需求)
纯FC买HGEC  $2,617/栋·时
self-HGEC   账面$11,525 → 实际≈$0(FC卖不掉)
```
连"纯FC直接买HGEC"都比自产HGEC高——自产把10格沉进低吞吐环节，稀释回报。

**⑤ 最终裁决:自产HGEC只压低FC成本，但FC市场吸纳≈0，省的是卖不动的库存成本。同样11格放萨莫萨拿$30k/h真实利润，是self-HGEC的30倍。便宜HGEC解决错的问题(成本)，真约束是卖不掉(需求)。**

**航空/垂直整合三次workflow验证(算术→生产量→自产HGEC)全部否决。终局铁律:稀缺格位只留给有真实零售/餐厅需求的商品——萨莫萨(餐饮)是14格终极答案，不是航空。**
