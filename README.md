# ModelHub

> Self-hosted AI gateway for **Claude Code** & **Codex** — route to **DeepSeek, Qwen, Kimi, GLM, Gemini, Groq** with your own API key. Up to 97% cheaper than Anthropic. 7-day free trial.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Latest Release](https://img.shields.io/github/v/release/wind33441998/modelhub)](https://github.com/wind33441998/modelhub/releases)

**ModelHub** is a lightweight, self-hosted proxy that lets [Claude Code](https://docs.claude.com/claude-code) and OpenAI **Codex** talk to **any OpenAI-compatible model provider** — especially low-cost models like DeepSeek, Qwen, Kimi, and Zhipu GLM. You bring your own API key (BYOK); ModelHub translates the Anthropic Messages API ↔ OpenAI Chat Completions format and handles **tool use** end-to-end.

> 🔑 **Bring your own key (BYOK).** ModelHub is a router — it does not sell or bundle API credits. You pay providers (DeepSeek, OpenRouter, etc.) directly with your own key. Many providers offer their own free tiers.

## ✨ Why ModelHub?

- **Slash your API bill** — run Claude Code on DeepSeek / Qwen / Gemini for up to 97% less than Anthropic's API. You pay the provider directly via your own key.
- **Claude Code & Codex ready** — full Anthropic ↔ OpenAI protocol conversion with **complete `tool_use` support** (file read/write, shell commands, sub-agents all work).
- **Multi-model router** — 8 providers, 21+ models; switch at runtime in the Web UI without restarting Claude Code.
- **Zero dependencies** — a single Node.js binary. No Docker, no Python, no `npm install` required to run.
- **Web management UI** — set keys, switch models, view logs in your browser at `http://127.0.0.1:4000`.
- **Privacy-first** — runs 100% on your machine; your keys never leave localhost.
- **Windows & macOS** — first-class Windows support; paths/encoding edge cases handled.

## 📦 Install

**Option A — Download the release (recommended, includes the `activate` tool):**

1. Go to **[Releases](https://github.com/wind33441998/modelhub/releases)** and grab the latest build for your OS.
2. Unzip and run `modelhub` (or `modelhub.exe`). A **7-day free trial** starts automatically — no signup needed.

**Option B — npm:**

```bash
npm install -g modelhub-cli
modelhub start
```

(Requires Node ≥ 14.)

**Option C — Claude Code / CodeBuddy plugin marketplace:**

```
/plugin marketplace add wind33441998/modelhub
/plugin install anymodel-for-claude-code@anymodel-marketplace
```

## 🚀 Quick start

```bash
# 1. Start the proxy (Web UI at http://127.0.0.1:4000)
modelhub start

# 2. Add your provider API key (BYOK) — e.g. DeepSeek
modelhub keys set deepseek sk-xxxxxxxx

# 3. Open the Web UI to pick a model
modelhub ui
```

Then point Claude Code at the local proxy.

**Environment variables**

```bash
export ANTHROPIC_API_URL=http://127.0.0.1:4000
export ANTHROPIC_AUTH_TOKEN=sk-local-proxy
export ANTHROPIC_MODEL=default
```

**Or `~/.claude/settings.json`**

```json
{
  "env": {
    "ANTHROPIC_API_URL": "http://127.0.0.1:4000",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
    "ANTHROPIC_AUTH_TOKEN": "sk-local-proxy",
    "ANTHROPIC_MODEL": "default",
    "ANTHROPIC_SMALL_FAST_MODEL": "default",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "default",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "default",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "default",
    "CLAUDE_CODE_SUBAGENT_MODEL": "default"
  }
}
```

> 💡 Use `127.0.0.1` (not `localhost`) to avoid IPv6 `::1` resolution issues. Set `ANTHROPIC_MODEL=default` to hot-swap models from the Web UI without restarting. Fully quit and reopen Claude Code after saving.

ModelHub also targets **OpenAI Codex** — point Codex at the same proxy as an OpenAI-compatible backend.

## 🔌 Supported providers

| Provider | Region | Sample models | Env var |
|----------|--------|---------------|---------|
| 🐋 **DeepSeek** | China | deepseek-chat, deepseek-reasoner | `DEEPSEEK_KEY` |
| 🌊 **SiliconFlow** | China | Qwen, DeepSeek, GLM hosted | `SILICONFLOW_KEY` |
| 🧠 **Zhipu GLM** | China | glm-4-plus, glm-4-air | `ZHIPU_KEY` |
| 🌙 **Kimi (Moonshot)** | China | moonshot-v1-8k | `MOONSHOT_KEY` |
| 🐱 **Qwen (Alibaba)** | China | qwen-max, qwen-plus, qwen-turbo | `QWEN_KEY` |
| 🌐 **OpenRouter** | Global | 200+ models | `OPENROUTER_KEY` |
| ✨ **Google Gemini** | Global | gemini-2.5-pro, 2.5-flash | `GEMINI_KEY` |
| ⚡ **Groq** | Global | Llama 3, DeepSeek-R1 | `GROQ_KEY` |

Bring **your own key** for any of these — ModelHub routes requests and converts protocols. The `default` / `auto` aliases resolve to whatever model you've selected in the Web UI; the built-in `echo` alias is a key-free loopback for testing the proxy chain.

## 💳 Pricing & License

ModelHub is **free to try for 7 days** (one device, full features). After the trial, choose a license:

| Plan | Price | Duration | Devices |
|------|-------|----------|---------|
| **Trial** | Free | 7 days | 1 |
| **Monthly** | $3 | 30 days | 3 |
| **Yearly** | $29 | 365 days | 5 |
| **Lifetime** | $69 | Forever | 10 |

Get a license from the official site or Gumroad (links in **[Releases](https://github.com/wind33441998/modelhub/releases)**), then activate:

```bash
modelhub activate <YOUR_LICENSE_KEY>
```

> Licenses are BYOK — you always use your own provider API keys. ModelHub is the gateway, not a credit reseller.

## 🛠 CLI reference

| Command | Description |
|---------|-------------|
| `modelhub start [-d] [-p PORT]` | Start proxy (`-d` daemon, `-p` port) |
| `modelhub stop` | Stop background proxy |
| `modelhub status` | Show status + current model |
| `modelhub models` | List available models |
| `modelhub switch <model>` | Switch active model |
| `modelhub keys [list]` | List configured keys |
| `modelhub keys set <provider> <key>` | Set a provider key |
| `modelhub keys del <provider>` | Delete a provider key |
| `modelhub ui` | Open Web UI in browser |
| `modelhub doctor` | Environment self-check |
| `modelhub selftest` | Run proxy chain self-test (no key needed) |
| `modelhub activate <key>` | Activate a license |

## 🏗 How it works

```
Claude Code / Codex
   │  Anthropic Messages API
   ▼
ModelHub proxy  (http://127.0.0.1:4000)
   │  OpenAI Chat Completions
   ▼
┌──────────────┴──────────────┐
Domestic providers        Global providers
(DeepSeek, Qwen,          (OpenRouter, Gemini,
 Kimi, GLM — no VPN)       Groq)
```

ModelHub converts Anthropic Messages API requests into OpenAI Chat Completions, forwards them upstream, then streams the response back as Anthropic SSE — with **bidirectional `tool_use` conversion** so Claude Code's core capabilities (shell, file I/O, sub-agents) keep working.

### Management API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` , `/ui` | Web UI |
| GET | `/api/models` | Current model + providers |
| GET | `/api/status` | Health check |
| GET | `/api/selftest` | Key-free loopback test |
| POST | `/api/switch` | Switch model |
| POST | `/api/keys` | Save / clear keys |
| POST | `/v1/messages` | Anthropic proxy entry (used by Claude Code) |

## 🧑‍💻 Local development

```bash
git clone https://github.com/wind33441998/modelhub.git
cd modelhub
node bin/modelhub.js start
```

Repackage the Skill: `python build_skill.py`.

## 📂 Repo structure

```
modelhub/
├── bin/modelhub.js          # CLI entry
├── lib/cli.js               # CLI dispatch (11 commands)
├── lib/proxy.js             # Proxy core (protocol + UI API)
├── assets/config.json       # Provider config (8 providers, 21+ models)
├── assets/ui.html           # Web UI
├── package.json             # npm package
├── plugins/                 # Skill form factor
└── README.md
```

## 📄 License

MIT — see [LICENSE](LICENSE).
