# Sim Companies 自动化架构（文字精确版）

```mermaid
flowchart TB
    subgraph BOARD["🏛️ 董事会 — 每天 9am & 9pm"]
        direction LR
        CFO["💰 CFO<br/>利润表/资产负债/现金流"]
        COO["🏭 COO<br/>仓库/建筑/合约/订单簿"]
        CMO["📈 CMO<br/>零售价/饱和度/天气"]
        LOCKED["🔒 CTO(Lv10) HR(Lv15)"]
        R1["Round 1<br/>提案"] --> R2["Round 2<br/>相互质询"] --> R3["Round 3<br/>CEO 裁决+执行"]
    end

    subgraph STRAT["🧠 战略层 — 每 4 小时 (:43)"]
        CHAT["💬 回复玩家/助理报价"]
        ALERT["⚠️ 价格警报 涨跌±6-8%"]
        REPAIR["🔧 自我修复代码"]
    end

    subgraph FAST["⚙️ 快速层 — 每 2 分钟"]
        direction LR
        C1["收取产出+现金"] --> C2["续单<br/>sweet-spot尺寸"] --> C3["扫价<br/>读游戏利润投影"] --> C4["买原料<br/>预算封顶"] --> C5["建造/升级<br/>回本≤48h"]
    end

    subgraph STATE["📁 共享状态文件"]
        CONFIG["config.json 策略旋钮"]
        BDATA["board-data.json 数据快照"]
        KNOW["knowledge.json 学到的售速"]
        PLAN["plan-state.json 状态机"]
        JOURNAL["JOURNAL.md 决策记忆"]
    end

    subgraph GAME["🎮 游戏 simcompanies.com"]
        CHROME["headless Chrome :9222<br/>单标签 + flock 锁"]
        CITY["农场/杂货店×2/海滩市场<br/>磨坊(建造中的目标)"]
    end

    subgraph EXEC["🤖 执行器状态机 (董事会批准的方案)"]
        direction LR
        S1["✅建二店"] --> S2["卖葡萄"] --> S3["现金≥$18,200"] --> S4["🛡️拆店<br/>100%退料<br/>(需手动arm)"] --> S5["BUILD MILL"]
    end

    BOARD -->|"改 config.json"| STATE
    STATE -->|"≤2分钟生效"| FAST
    BOARD -->|"笔录"| MINUTES["📄 minutes/ → Windows桌面"]
    BOARD <-->|"读写记忆"| JOURNAL
    FAST -->|"chat/price flag 唤醒"| STRAT
    STRAT -->|"修复"| FAST
    FAST <--> CHROME
    EXEC <--> CHROME
    CHROME <--> CITY
    BDATA --> BOARD
```

## 关键机制
- **决策→执行链**：董事会改 config.json → 快速层下一个 tick(≤2分钟)自动按新策略跑
- **记忆链**：JOURNAL.md 让董事会跨会议不失忆；market-snapshots 让 CMO 察觉玩家涌入
- **安全阀**：拆除不可逆 → 两阶段（先只读记录对话框 → scrapArmed:true 才真拆）→ API验证
- **锁**：所有浏览器操作抢同一把 .tick.lock，永不并发冲突
