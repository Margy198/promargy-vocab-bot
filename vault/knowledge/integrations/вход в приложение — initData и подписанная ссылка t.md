---
tags: [integration, telegram, auth]
date: 2026-11-13
---

# Вход в приложение — initData и подписанная ссылка t

1. Обычно Telegram передает `initData` (подпись проверяется на сервере, возраст до 30 дней).
2. Запасной вход: бот добавляет в адрес `?t=<chatId>.<срок>.<HMAC-SHA256 base64url>` (ключ — `TELEGRAM_WEBHOOK_SECRET`, срок 30 дней). Приложение кладет его в localStorage `__appToken` и шлет как `appToken`; сервер — `verifyAppToken` (timingSafeEqual).
3. Скрипт до SDK забирает параметры запуска (`window.__tgLaunch`), мост после SDK чинит пустой `initData` — см. [[SDK Telegram стирает tgWebAppData — забирать параметры до SDK]].
4. Откуда открывать: кнопка клавиатуры «📱 Приложение» (с токеном), `/app` → inline «Открыть тренажёр», личная кнопка меню после `/start`.

Решения: [[inline-кнопка, а не KeyboardButton — иначе нет initData]], [[глобальная кнопка меню без личного токена]].
