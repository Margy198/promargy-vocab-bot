---
tags: [bug, grammar]
date: 2026-11-13
---

# Неживые сочетания в модальных — needs to need

Генератор модальных брал все глаголы, включая слова-ловушки: «needs to need more time», «needed to mean trouble», «has to right the situation». Решение: `MODAL_OK_VERBS` без need, like, mean, right.
