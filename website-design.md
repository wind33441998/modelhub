# ModelHub 英文官网 — 需求分析与设计文档

> 版本：v1.0
> 日期：2026-07-28
> 定位：商业转化型网站，突出省钱对比 + 产品卖点

---

## 一、网站定位与目标

### 一句话定位

> The cheapest AI gateway for Claude Code & Codex. You bring API keys, we handle the rest.

### 核心目标

| 目标 | 衡量标准 |
|------|---------|
| 让访客 30 秒内理解产品价值 | 首屏跳出率 < 50% |
| 让访客看到省钱对比后下单 | 下单转化率 > 3% |
| 自然传播（病毒循环）| 推荐带来 > 20% 新用户 |

### 目标用户画像

| 角色 | 痛点 | 决策关键词 |
|------|------|----------|
| Claude Code 个人开发者 | API 被封/太贵/区域限制 | "cheap", "| Codex 用户 | 模型选择少/成本高 | "multi-model", "deepseek", "qwen" |
| AI 创业者 | 想降低推理成本 | "97% cheaper", "cost saving" |
| 中国出海开发者 | 需要国内模型 API 接入 | "Chinese model", "proxy" |

---

## 二、网站页面结构

```
claude-proxys.com
│
├── /                          Landing Page（核心转化页）
├── /pricing                   定价页（省钱对比表）
├── /how-it-works              产品原理（技术透明化）
├── /download                  下载页
├── /docs                      使用文档
├── /blog                      技术博客
│
├── /login                     用户登录
├── /register                  注册
├── /dashboard                 用户中心
│   ├── /dashboard/license      许可证管理
│   ├── /dashboard/devices      设备管理
│   ├── /dashboard/referral     推荐计划
│   └── /dashboard/history      激活记录
│
└── /ref/[code]                推荐链接着陆页
```

---


## 三、Landing Page 逐屏设计

### 第一屏：Hero（3 秒抓住用户）

**布局**：左侧文案 + 右侧 GIF 演示

**主标题（A/B 测试 3 版）**：

```
A: Run Claude Code on DeepSeek. 97% Cheaper.
B: Claude Code meets Chinese AI. $29 one-time.
C: Your AI Model Gateway. No subscriptions. No servers.
```

**副标题**：

```
One-click local proxy that routes Claude Code & Codex to DeepSeek, Qwen, Kimi, GLM, Gemini, Groq.
You keep your API keys. We keep it simple.
```

**CTA 按钮**：

```
[Download Free Trial →]   [See Pricing ↓]
```

**顶部导航**：

```
[Logo]  [Pricing]  [How It Works]  [Docs]  [Download]  [Login]  [Get Started →]
```

**社交证明（首屏底部）**：

```
  No setup    Pay once     Save 97%
  2 min ↓     $29 ↓        vs Anthropic ↓
```

---

### 第二屏：省钱对比（核心转化屏 — SEO 关键词密集区）

**标题**：How Much Can You Save with ModelHub?

**副标题**：Compare real API costs. Claude Code, Codex, or any OpenAI-compatible client.

**每百万 Token 价格对比表**：

| Provider | Model | Input $/1M | Output $/1M | vs Claude Savings |
|----------|-------|-----------|------------|-------------------|
| **Anthropic** | Claude Opus 4.8 | $5.00 | $25.00 | — |
| **Anthropic** | Claude Sonnet 4.6 | $3.00 | $15.00 | — |
| **OpenAI** | GPT-5.5 | $5.00 | $30.00 | — |
| **OpenAI** | GPT-4o | $10.00 | $30.00 | — |
| **Google** | Gemini 2.5 Pro | $1.25 | $10.00 | — |
| | | | | |
| **ModelHub + DeepSeek** | deepseek-v4-flash | **## 四、Dashboard / 用户中心设计

### 页面结构

```
┌──────────────────────────────────────────┐
│  ModelHub Dashboard                       │
│  ┌──────┬──────────────────────────────┐ │
│  │ 导航  │  主内容区                     │ │
│  │       │                              │ │
│  │ 📊    │  License Key: MHUB-XXXX-...  │ │
│  │ 概览  │  状态: ✅ Active             │ │
│  │       │  到期: 2027-07-28            │ │
│  │ 🔑    │                              │ │
│  │ 许可证 │  [Deactivate] [Reactivate]  │ │
│  │       │                              │ │
│  │ 💻    │  ─── Devices ───             │ │
│  │ 设备  │  Desktop-1 (this device)     │ │
│  │       │  Laptop-Win (2/5 used)       │ │
│  │       │                              │ │
│  │ 📣    │  ─── Referral ───            │ │
│  │ 推荐  │  11 months free earned       │ │
│  │       │  link: .../ref/abc123        │ │
│  │       │                              │ │
│  │ 📜    │  ─── History ───             │ │
│  │ 记录  │  2026-07-28  Activated       │ │
│  └──────┴──────────────────────────────┘ │
└──────────────────────────────────────────┘
```

### 核心页面

| 页面 | 内容 |
|------|------|
| `/dashboard` | License Key 展示、激活状态、到期日、设备概览 |
| `/dashboard/license` | 许可证升级、续费、历史记录 |
| `/dashboard/devices` | 设备列表、手动解绑、心跳时间 |
| `/dashboard/referral` | 推荐链接、收益统计、邀请记录 |
| `/dashboard/history` | License 激活/登录/IP 记录 |

---

## 五、病毒传播机制设计

### 5.1 推荐计划（Referral Program）

| 机制 | 说明 |
|------|------|
| 邀请者收益 | 朋友每付 $1，你得 1 天免费（累计上限 365 天）|
| 被邀请者收益 | 首单 9 折 |
| 追踪方式 | 链接 Cookie 30 天 |
| 展示位置 | Dashboard 显著位置 + 付费成功页 + EXE 启动页 |

### 5.2 自助传播点

| 触发时机 | 展示文案 | 分享到 |
|---------|---------|--------|
| 免费试用第 3 天 | "Loving ModelHub? Share and get 1 month!" | 复制链接 |
| 付费成功页 | "You just saved 97%. Tell your friends!" | Twitter / Reddit |
| EXE 启动时 | "ModelHub saved you $X today" | 统计分享 |
| 达到省钱里程碑 | "You've saved $500. Here's your referral link" | 激励分享 |

### 5.3 病毒系数估算

```
每位用户推荐 2 人
→ 20% 转化（付费）
→ 每位用户带来 0.4 个新付费用户
→ 病毒系数 K = 0.4（<1 但能显著降低获客成本）
```

---

## 六、技术方案

### 前端

| 项目 | 方案 | 理由 |
|------|------|------|
| 框架 | **Vanilla HTML + CSS + JS** | 不需要 SPA，页面数少，加载快 |
| 部署 | **Vercel** | 免费，全球 CDN，绑定域名 |
| 样式 | 自定义 CSS（暗色主题）| 与产品气质一致 |
| 图表 | 纯 CSS 表格 + 对比条 | 不依赖第三方库 |

### 后端（License Server）

| 项目 | 方案 |
|------|------|
| API | Vercel Serverless Functions（Node.js）|
| 数据库 | Vercel KV（Redis）或 Supabase Free |
| 认证 | Session / JWT（邮箱注册）|
| 邮件 | Resend（免费 100 封/天）|
| Webhook | Gumroad Ping → License Server |

### 页面路由

Vercel 的 `vercel.json` 配置：

```json
{
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

---

## 七、设计风格规范

### 品牌色

| 用途 | 色值 | 说明 |
|------|------|------|
| 主色 | `#10b981` (Emerald/绿) | 「省钱」的心理暗示 |
| 强调色 | `#3b82f6` (Blue) | 按钮/链接 |
| 背景 | `#0a0e15` | 暗色背景 |
| 卡片 | `#111827` | 卡片背景 |
| 文字 | `#f1f5f9` | 正文 |
| 亮点 | `#fbbf24` (Amber) | 价格/省钱数字 |

### 为什么选绿色做主色

用户心理：**绿色 = 省钱 = 安全 = 确认**
不使用红色（亏损感）或蓝色（纯粹技术感）。

### 字体

| 用途 | 字体 |
|------|------|
| 标题 | Inter / SF Pro Display |
| 正文 | Inter / system-ui |
| 代码/价格 | JetBrains Mono / SF Mono |

---

## 八、SEO 策略

### 每个页面的 TDK

| 页面 | Title | Description |
|------|-------|-------------|
| `/` | ModelHub - Run Claude Code on DeepSeek, 97% Cheaper | AI model gateway for Claude Code & Codex. Supports DeepSeek, Qwen, GLM, Kimi, Gemini. $29 one-time. |
| `/pricing` | ModelHub Pricing - Save 97% on Claude Code API Costs | Compare token costs: DeepSeek vs Anthropic. $29/year or $69 lifetime. |
| `/how-it-works` | How ModelHub Works - Claude Code Multi-Provider Proxy | Local proxy that routes Claude Code to cheap Chinese AI models. |

### 结构化数据（SEO 增强）

页面嵌入 Schema.org `SoftwareApplication` 标记：

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "ModelHub",
  "operatingSystem": "Windows 10+",
  "applicationCategory": "DeveloperApplication",
  "offers": {
    "@type": "Offer",
    "price": "29",
    "priceCurrency": "USD"
  }
}
```

---

## 九、页面加载性能目标

| 指标 | 目标 |
|------|------|
| LCP | < 1.5s |
| FID | < 100ms |
| CLS | < 0.1 |
| 首字节 | < 200ms（Vercel CDN）|
| 页面体积 | < 200KB（纯 HTML+CSS，无框架）|

---

## 十、开发优先级

| 优先级 | 页面/功能 | 估算工时 | 依赖 |
|--------|----------|---------|------|
| **P0** | Landing Page（Hero + 省钱对比 + 定价表）| 4h | — |
| **P0** | License Server API | 4h | — |
| **P0** | proxy.js license 校验 | 3h | License Server |
| **P1** | Dashboard（License 展示 + 设备管理）| 4h | — |
| **P1** | 注册/登录系统 | 3h | — |
| **P1** | Gumroad Webhook 集成 | 2h | Gumroad 商品就绪 |
| **P2** | Referral 推荐系统 | 3h | 用户系统 |
| **P2** | /how-it-works + 文档页 | 3h | — |
| **P2** | 博客 | 2h | — |
| **P3** | 邮件通知 | 1h | Resend 注册 |


---


## 十一、SEO 关键词策略（完整版）

### 核心关键词矩阵 — 加入 Codex

按搜索意图分为 6 类（新增第 6 类 Codex 专类）：

#### 类别 1：Claude Code + Proxy（高购买意图）

| 关键词 | 搜索量级 | 竞争 | 用在页面 |
|--------|---------|------|---------|
| claude code proxy | 中高 | 中 | H1, H2, 首屏 |
| claude code proxy setup | 中 | 低 | How It Works |
| claude code api proxy | 中 | 中 | 首屏 |
| claude code local proxy | 低 | 低 | 产品优势 |
| claude code self hosted proxy | 低 | 低 | 产品优势 |
| claude code custom api | 中 | 低 | 文档 |

#### 类别 2：Claude Code + DeepSeek（核心卖点）

| 关键词 | 搜索量级 | 竞争 | 用在页面 |
|--------|---------|------|---------|
| claude code deepseek | 中高 | 中 | H1, 定价对比 |
| use deepseek with claude code | 中 | 低 | How It Works |
| deepseek claude code setup | 中 | 低 | 博客/文档 |
| claude code deepseek proxy | 中 | 低 | 首屏 |
| run claude code on deepseek | 中 | 低 | H1 |

#### 类别 3：省钱 / 替代品（高情感驱动）

| 关键词 | 搜索量级 | 竞争 | 用在页面 |
|--------|---------|------|---------|
| claude code cheaper alternative | 高 | 高 | H1, 省钱对比 |
| claude code too expensive | 中 | 低 | 痛点卡片 |
| claude code api cost | 中 | 低 | 省钱对比 |
| replace anthropic api | 中 | 中 | 省钱对比 |
| cheaper than claude api | 中 | 低 | H1 |
| claude code alternative model | 中 | 低 | 产品优势 |

#### 类别 4：Claude Code + Model Router（技术用户）

| 关键词 | 搜索量级 | 竞争 | 用在页面 |
|--------|---------|------|---------|
| claude code multiple models | 中 | 低 | 产品优势 |
| claude code model router | 低 | 低 | 产品优势 |
| claude code switch model | 低 | 低 | 产品优势 |
| claude code multi provider | 低 | 低 | 定价页 |

#### 类别 5：各模型品牌词（长尾但精准）

| 关键词 | 搜索量级 | 竞争 | 用在页面 |
|--------|---------|------|---------|
| claude code qwen | 低 | 低 | 定价对比表 |
| claude code kimi | 低 | 低 | 定价对比表 |
| claude code glm | 低 | 低 | 定价对比表 |
| claude code gemini | 中 | 低 | 定价对比表 |
| claude code groq | 中 | 低 | 定价对比表 |
| claude code siliconflow | 低 | 低 | 产品优势 |

#### 类别 6：Codex 专类（新增 — 覆盖 Codex 用户）

| 关键词 | 搜索量级 | 竞争 | 用在页面 |
|--------|---------|------|---------|
| codex proxy | 中 | 低 | 首屏, H2 |
| codex deepseek | 低 | 低 | 首屏, 定价对比 |
| codex multi model | 低 | 低 | 产品优势 |
| codex model provider | 低 | 低 | How It Works |
| codex model hub | 低 | 低 | 页面描述 |
| codex cheap model | 低 | 低 | 省钱对比 |
| codex alternative provider | 低 | 低 | 产品优势 |
| codex custom api endpoint | 低 | 低 | 文档 |
| openai codex proxy | 低 | 低 | 博客 |
| codex local proxy | 低 | 低 | 产品优势 |
| codex self hosted | 低 | 低 | 产品优势 |

### 每页 TDK + 关键词映射

#### 首页（Landing Page）

```
Title:
ModelHub - Run Claude Code & Codex on DeepSeek, Qwen, Kimi, GLM | 97% Cheaper

Description:
Claude Code & Codex proxy that supports DeepSeek, Qwen, Kimi, GLM, Gemini, Groq.
Replace expensive Anthropic/OpenAI API. One-click setup. $29 one-time license.

H1: Run Claude Code & Codex on Any Model. Pay Once, Save 97%.

Keywords targeted: claude code mac proxy, claude code windows proxy, claude code deepseek, codex proxy,
codex deepseek, cheaper than claude api, claude code alternative
```

#### 定价页

```
Title:
ModelHub Pricing - Save 97% on Claude Code & Codex API Costs | $29/Year

Description:
Compare Claude Code & Codex API costs vs DeepSeek, Qwen, Kimi, GLM.
Save up to 99%. From $29/year. Free 7-day trial.

Keywords targeted: claude code api cost, codex cheap model, codex model provider,
cheaper than claude api, deepseek pricing, kimi api pricing
```

#### How It Works

```
Title:
How to Use DeepSeek with Claude Code & Codex - Proxy Setup Guide

Description:
Step-by-step guide to run Claude Code & Codex on DeepSeek, Qwen, Kimi, GLM, Gemini.
Setup takes 2 minutes. No coding required.

Keywords targeted: use deepseek with claude code, claude code proxy setup,
codex proxy setup, codex deepseek, deepseek claude code setup
```

### 各屏自然埋词（Codex 关键词）

```
第一屏（Hero）:
"Run Claude Code & Codex on DeepSeek, Qwen, Kimi, GLM, Gemini, and Groq.
97% cheaper than Anthropic/OpenAI API. One-click setup."

→ 嵌入关键词: claude code deepseek, codex proxy, codex deepseek, claude code proxy

第二屏（省钱对比）:
"Compare Claude Code & Codex API costs side by side.
If you use DeepSeek with Claude Code via ModelHub..."

→ 嵌入关键词: claude code api cost, codex cheap model, use deepseek with claude code

第三屏（痛点卡片 — 新增 Codex 痛点）:
"Codex users: tired of paying OpenAI rates? ModelHub routes Codex to DeepSeek, Qwen, or GLM."

→ 嵌入关键词: codex model provider, codex alternative provider, codex custom api endpoint
```

### 技术 SEO

```
- /sitemap.xml: 自动生成（Vercel 支持）
- /robots.txt: 允许全部
- Schema.org SoftwareApplication: 首页嵌入（name: "ModelHub", 
  applicationCategory: "DeveloperApplication", offers: $29）
- Open Graph / Twitter Card: 每个页面
- 图片 alt 属性: 全部填关键词
- URL 结构: /pricing, /how-it-works, /download（英文+关键词）
- 页面速度: 纯静态 HTML，Vercel CDN，<200KB
```

### 博客 SEO 文章计划（持续增加外链）

| 文章标题 | 目标关键词 | 发布平台 |
|---------|---------|---------|
| How to Use DeepSeek with Claude Code: Complete Setup Guide | use deepseek with claude code | 官网 + dev.to |
| Claude Code & Codex API Cost: How to Save 97% with Chinese Models | claude code api cost, codex cheap model | 官网 + Medium |
| Codex Proxy Setup: Route to Any OpenAI-Compatible API | codex proxy, codex custom api | 官网 |
| Claude Code Proxy Setup: Route to Any Model Provider | claude code proxy setup | 官网 |
| DeepSeek vs Claude API: Pricing Comparison 2026 | deepseek pricing | 官网 |
| How to Run Claude Code & Codex on Qwen, Kimi, and GLM | claude code qwen, codex multi model | 官网 + dev.to |



