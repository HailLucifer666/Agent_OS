# NOVA Brain Map — Locked 2026-07-08

All models below returned **HTTP 200** on live API calls. No guesswork.

---

## 🎙️ Voice Brain

| Slot | Provider | Model | Tested | Capacity |
|------|----------|-------|--------|----------|
| **Primary** | Groq | `llama-3.3-70b-versatile` | ✅ 200 OK | 1K RPD / 100K TPD = ~4 hrs voice/day, refills daily |
| **Fallback** | Mistral | `mistral-large-2512` | ✅ 200 OK | No daily cap. 1 req/sec. Never dies |
| **Offline** | Ollama | `qwen3:8b` | ✅ 200 OK | Local, unlimited, 14.5s/turn |

## 🏗️ Build Brain

| Slot | Provider | Model | Tested | Capacity |
|------|----------|-------|--------|----------|
| **Primary** | Mistral | `mistral-large-2512` | ✅ 200 OK | No daily cap. Build all day, every day |
| **Fallback** | NVIDIA | `GLM-5.2` (all 3 keys) | ✅ 200 OK | 40 RPM, ~1K/month, resets monthly |
| **Local** | Ollama | `ornith:9b` | ✅ 200 OK | 18.7s/turn, tools+thinking, 262K ctx, unlimited |

## ✉️ Simple Tasks

| Slot | Provider | Model | Tested | Capacity |
|------|----------|-------|--------|----------|
| **Only** | Ollama | `qwen3:8b` | ✅ 200 OK | Local, free, unlimited |

## 👁️ Vision

| Slot | Provider | Model | Tested | Capacity |
|------|----------|-------|--------|----------|
| **Primary** | Ollama | `qwen3.5:latest` | ✅ 200 OK | Local vision, 262K ctx, unlimited |
| **Fallback** | Ollama | `qwen2.5vl:7b` | ✅ 200 OK | 16.3s, 128K ctx, unlimited |

---

## Failover Chain

```
VOICE   → Groq 70b (4 hrs/day) → Mistral Large (∞) → Ollama 8b (∞)
BUILD   → Mistral Large (∞) → NVIDIA GLM-5.2 (~33/day) → Ollama ornith:9b (∞)
SIMPLE  → Ollama 8b (∞)
VISION  → Ollama qwen3.5 (∞) → Ollama qwen2.5vl (∞)
```

## Provider Economics

| Provider | Free Tier Type | Refills? | What You Actually Get |
|----------|---------------|----------|----------------------|
| **Mistral** | Unlimited free | ♾️ Yes | No daily cap. 1 req/sec only. Never dies. |
| **Groq** | Daily reset | ✅ Daily | 70b: 1K RPD / 100K TPD. 8b: 14.4K RPD / 500K TPD. |
| **Ollama** | Local inference | N/A | No limits. Costs electricity only. |
| **NVIDIA** | Monthly reset | ✅ Monthly | ~1K requests/month. 40 RPM. Dies mid-build ~step 10. |
| **SambaNova** | One-time $5 credit | ❌ Never | ~1,400 build steps total. Use wisely — never refills. |
| **OpenRouter** | Daily reset | ✅ Daily | 50 RPD. tencent/hy3:free works. |

## Tested & Rejected

| Provider | Why |
|----------|-----|
| **CloudFlare/Bluesminds** | 10K neurons/day — burns in minutes |
| **Puter** | Credits-based, $10/mo after free credits |
| **LM Studio (API)** | Cold load 118s, hangs on model swap. UI works, API doesn't |
| **SambaNova (as primary)** | $5 one-time — too precious for daily use |
