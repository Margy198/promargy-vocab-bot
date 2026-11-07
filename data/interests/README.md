# Банк предложений по интересам

Один файл на тему: `<key>.json`:

```json
{ "key": "travel", "title": "Путешествия", "emoji": "✈️", "group": "Жизнь",
  "sentences": [ { "level": "A2", "en": "We booked a cheap flight to Lisbon for the long weekend.", "ru": "Мы забронировали дешёвый рейс в Лиссабон на длинные выходные.", "vocab": [ { "en": "booked", "ru": "забронировали" }, { "en": "flight", "ru": "рейс" } ] } ] }
```

Правила: 24 предложения (8×A2, 8×B1, 8×B2); `vocab[].en` — ровно та форма, что стоит в предложении; переводы естественные, не дословные.
Проверка: `python3 scripts/check-interests.py`.
