---
tags: [atlas, architecture]
date: 2026-11-13
---

# Архитектура — одна Netlify-функция, Blobs и мини-приложение

- **Репозиторий:** `Margy198/promargy-vocab-bot`, ветка `main`. Сайт: https://magical-nougat-d42dea.netlify.app
- **Бот:** вся логика в одной функции `netlify/functions/telegram-webhook.js` (~12 тыс. строк). Telegram шлет апдейты вебхуком (`x-telegram-bot-api-secret-token`).
- **API мини-приложения:** тот же вебхук, POST с `{initData | appToken, action, …}` → JSON. Действия: `me`, `course`, `topic`, `courseSet`, `courseLevel`, `courseTrack`, `notes*`, `vocab*`, `league`, `settings`, `teacher*`, `hw*`, `content*` и др.
- **Мини-приложение:** один файл `public/app/index.html` (HTML+CSS+JS, без сборки). Вне Telegram — демо-режим (`DEMO`, `window.__dbg`).
- **Фоновые функции:** `course-rebuild-background.js` (сборка курса и заданий из Notion), `interest-generate-background` (свои темы через Anthropic API).
- **Общие модули:** `netlify/lib/course-builder.mjs` (Notion → темы), `netlify/lib/drill-builder.mjs` (упражнения → задания).
- **Данные:** [[хранилища Netlify Blobs и ключи]]; встроенный бандл курса `data/course/` (index.mjs вшит в функцию).
- **Cron:** GET `?remind=<secret>` — напоминания, домашка, дайджесты.

Связано: [[деплой — GitHub main автодеплоит Netlify]], [[карта файлов репозитория]].
