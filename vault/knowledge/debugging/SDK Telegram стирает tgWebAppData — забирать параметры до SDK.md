---
tags: [bug, telegram]
date: 2026-11-13
---

# SDK Telegram стирает tgWebAppData — забирать параметры до SDK

Симптом: в Telegram приложение показывает демо («просмотр в обычном браузере»), диагностика `sdk:да данные:нет`. Причина 1: официальный `telegram-web-app.js` стирает `#tgWebAppData` из адреса. Решение: скрипт **до** SDK сохраняет параметры (`__tgLaunch`, sessionStorage). Причина 2: кнопка клавиатуры не передает `initData` вовсе — см. [[inline-кнопка, а не KeyboardButton — иначе нет initData]]. Причина 3: iOS иногда присылает только Version/Platform/Theme — спас [[вход в приложение — initData и подписанная ссылка t]].
