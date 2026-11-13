---
tags: [atlas, config]
date: 2026-11-13
---

# Переменные окружения Netlify

| Переменная | Зачем |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | токен бота |
| `TELEGRAM_WEBHOOK_SECRET` | защита вебхука + ключ подписи ссылки приложения |
| `URL` / `MINI_APP_URL` | адрес сайта / приложения |
| `NOTION_TOKEN` | пересборка курса и заданий из Notion |
| `NOTION_COURSE_ROOT` | корень основного плана (по умолчанию 34c2f2f8690d814e82e8fb81e078333e) |
| `NOTION_BUSINESS_ROOT` | корень бизнес-плана (по умолчанию 4022f2f8690d8143b223fce9744efecb) |
| `NOTION_GRAMMAR_DB` | база «Задания бота» |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | свои темы ([[мои темы — предложения по интересам]]) |
| `RATE_LIMIT_MS`, `DEBUG_BLOB_LOG` | служебные |

Значения секретов в заметки не пишем.
