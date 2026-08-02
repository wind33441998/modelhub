# GitHub 自然流量优化清单（ModelHub）

> 目标：让搜 `claude code proxy` / `deepseek claude code` / `codex multi-model` / `claude code cheap alternative` 的海外用户，能通过 **GitHub 站内搜索 + Google 索引** 找到本仓库。
>
> 现状：`gh` 当前未登录（`gh auth status` → not logged in）。以下 description / topics / release notes 需通过 `gh auth login`（设备流，会弹浏览器授权）或 GitHub Web 设置。README.md 已改好（英文 SEO 版），可直接 commit/push。

---

## 1. Repository description
设置位置：repo → **Settings → General → Description**，或 `gh repo edit`。

```
Self-hosted AI gateway for Claude Code & Codex — route to DeepSeek, Qwen, Kimi, GLM, Gemini, Groq with your own API key. Up to 97% cheaper. 7-day free trial.
```

## 2. Topics / 标签
设置位置：repo → **About → ⚙ → Topics**。

```
claude-code
codex
deepseek
qwen
kimi
glm
gemini
groq
ai-proxy
model-gateway
llm-router
openai-compatible
anthropic
byok
self-hosted
tool-use
cheap-llm
```

## 3. Release notes 模板（下次发版 / 更新 latest release 时使用）
要点：含 SEO 关键词 + 下载指引 + 购买/激活指引。GitHub Release 正文也会被 Google 索引。

```
## ModelHub vX.Y.Z

Self-hosted AI gateway for **Claude Code & Codex**. Route to DeepSeek, Qwen, Kimi, GLM, Gemini, Groq with your own API key (BYOK). Up to 97% cheaper than Anthropic.

### What's new
- ...

### Download
- Windows / macOS builds attached below (include the `activate` tool)
- Or: `npm install -g modelhub-cli`

### License
- 7-day free trial (no signup)
- Monthly $3 · Yearly $29 · Lifetime $69
- Get a license from our site / Gumroad, then `modelhub activate <key>`
```

---

## 4. 操作命令（需先 `gh auth login`）

```bash
# 登录（设备流，按提示在浏览器授权）
gh auth login

# 设置 description
gh repo edit wind33441998/modelhub \
  --description "Self-hosted AI gateway for Claude Code & Codex — route to DeepSeek, Qwen, Kimi, GLM, Gemini, Groq with your own API key. Up to 97% cheaper. 7-day free trial."

# 设置 topics
gh repo edit wind33441998/modelhub \
  --add-topic claude-code --add-topic codex --add-topic deepseek \
  --add-topic qwen --add-topic kimi --add-topic glm --add-topic gemini \
  --add-topic groq --add-topic ai-proxy --add-topic model-gateway \
  --add-topic llm-router --add-topic openai-compatible --add-topic anthropic \
  --add-topic byok --add-topic self-hosted --add-topic tool-use --add-topic cheap-llm
```

---

## 5. ⚠️ 合规提醒（独立任务，不在本清单执行范围）

当前 `site/index.html` 的 `<meta name="keywords">` 含**违规词**：

```
free claude code, free codex, free ai models, free tokens, free api,
free model credits, free deepseek, 免费token, 免费额度, 免费Claude Code, 免费Codex ...
```

根据合规红线：「免费 / 免费 token / 免费额度」必须指向**用户自带 Key (BYOK)**，严禁写「产品赠送额度」；不碰「破解 / 绕过付费」。

→ 这些 meta 词暗示"产品送额度"，不符合 BYOK 表述，存在下架/违规风险。
→ 建议另立任务：把官网 meta 改为 BYOK 表述（如 "bring your own DeepSeek key", "use your own API key"），删除 `free tokens / 免费额度` 类词。

---

## 6. 验证方式

改完后验证搜索可见性：
- GitHub 站内搜 `claude code proxy` / `deepseek claude code` → 本 repo 应出现在结果。
- Google 搜 `site:github.com/wind33441998/modelhub` → README 应被索引。
- 约 1–2 周后 Google 搜核心词观察排名（GitHub 高权重域名，通常几周内收录）。
