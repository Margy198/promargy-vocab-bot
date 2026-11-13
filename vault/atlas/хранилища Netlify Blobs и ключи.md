---
tags: [atlas, database]
date: 2026-11-13
---

# Хранилища Netlify Blobs и ключи

Хранилища (`getStore`): identity, stats, pending, vocab, admins, shared library, debug, `vocab-bot-course`.

## vocab-bot-course
- `course:index`, `course:level:<код>`, `course:topic:<id>`, `course:meta` — курс из Notion ([[курс A0–C1 собирается из Notion в Blobs course]]). Если нет — бандл `data/course`.
- `biz:index`, `biz:level:<код|BIZ>`, `biz:topic:<id>`, `biz:meta` — [[курс для работы — бизнес-план в Blobs biz]].
- `progress:<chatId>` — `{ topics: {id: {status, updatedAt, doneAt}}, level, bizLevel, track }`.
- `notes:<chatId>` — заметки ученика.
- `hw:<chatId>` — домашка ([[кабинет учителя и домашка]]).
- `rebuild:status` — статус и журнал пересборки.
- `grammar:items`, `grammar:dbId` — задания бота из базы Notion.
- `interest:custom:<slug>` — сгенерированные свои темы.

## identity
`approved`, `phrasesAccess`, `trialStartedAt`, `gender`, `recallMode`, … Записи старше поля `approved` считаются одобренными — см. [[доступ только по приглашению — никаких автоматических прав]].

Обновления — через `withOptimisticUpdate` (etag), чтобы не терять параллельные записи.
