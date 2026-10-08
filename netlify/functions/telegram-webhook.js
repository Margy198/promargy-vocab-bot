// Telegram-бот "Словарный квиз" для promargy.com
// Формат: квиз с 4 вариантами перевода, кнопки под сообщением.
// Работает как Netlify Function (webhook), состояние и сам словарь хранятся
// в Netlify Blobs — отдельного сервера или базы данных не нужно.
//
// Словарь можно пополнять прямо из Telegram, без редеплоя:
//   - просто вставь в чат с ботом одну или несколько строк вида "English . перевод"
//   - или используй /add <строка>
//   - /delete <English> удаляет слово
//   - /count показывает, сколько слов сейчас в базе
//
// Все обновления состояния (счёт и словарь) идут через безопасное к гонкам
// чтение-изменение-запись (ETag + onlyIfMatch), чтобы два почти одновременных
// нажатия кнопки не затирали прогресс друг друга.

import { getStore } from "@netlify/blobs";
import { VOCAB as DEFAULT_VOCAB } from "../../data/vocab.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET; // опционально, но рекомендуется
const API = `https://api.telegram.org/bot${TOKEN}`;

// consistency: "strong" — по умолчанию Netlify Blobs "eventually consistent"
// (запись может долетать до чтения до 60 секунд), из-за чего самое первое
// нажатие кнопки иногда "не находило" только что записанный вопрос. Строгая
// консистентность чуть медленнее, но гарантирует, что запись видна сразу же.
const pendingStore = () => getStore("vocab-bot-pending", { consistency: "strong" });
const statsStore = () => getStore("vocab-bot-stats", { consistency: "strong" });
const wordsStore = () => getStore("vocab-bot-words", { consistency: "strong" });
const debugStore = () => getStore("vocab-bot-debug", { consistency: "strong" });
const rateLimitStore = () => getStore("vocab-bot-ratelimit", { consistency: "strong" });
const identityStore = () => getStore("vocab-bot-identities", { consistency: "strong" });
const adminStore = () => getStore("vocab-bot-admins", { consistency: "strong" });
const sharedLibraryStore = () => getStore("vocab-bot-shared-library", { consistency: "strong" });

// Секретное слово для самостоятельного получения прав администратора —
// команда /claimadmin <секрет>. Кто пришлёт верный секрет, тот сразу
// становится админом (без переписки с разработчиком и без передеплоя).
// Секрет можно передать и другому человеку (например, помощнику), если ему
// тоже нужен доступ к /students.
const CLAIM_ADMIN_SECRET = "GCfVjhtMz9-wJSgQ";
// Отдельный секрет для пригласительной ссылки: t.me/<имя_бота>?start=<INVITE_SECRET>
// Кто угодно с этой ссылкой получает доступ мгновенно, без ручного /approve.
// Не совпадает с CLAIM_ADMIN_SECRET — этим секретом нельзя получить права админа.
const INVITE_SECRET = "PromargyStart2026";
// Отдельная бесплатная ссылка ТОЛЬКО на "150 американских фраз":
// t.me/<имя_бота>?start=<PHRASES_INVITE_SECRET>. Не даёт approved: true —
// человек не становится полноценным учеником, а получает phrasesAccess
// (постоянный бесплатный доступ к фразам) + TRIAL_DAYS пробного периода на
// всё остальное (общая библиотека, грамматика, неправильные глаголы).
const PHRASES_INVITE_SECRET = "150Phrases2026";
const TRIAL_DAYS = 5;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;

function isTrialExpired(identity) {
  if (!identity || !identity.trialStartedAt) return false;
  return Date.now() - new Date(identity.trialStartedAt).getTime() > TRIAL_MS;
}

async function isAdmin(chatId) {
  const v = await adminStore().get(String(chatId), { type: "json" });
  return !!v;
}

// Запоминаем, кто стоит за этим чатом (имя/username из Telegram), чтобы
// потом можно было отличить одного ученика от другого в /students.
// Не критично для работы бота — если не получится записать, просто молча
// продолжаем.
async function rememberIdentity(chatId, from) {
  if (!from) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Новым чатам (существующей записи ещё нет) сразу проставляем
    // approved: false — доступ только по приглашению. У УЖЕ существующих
    // чатов ничего не трогаем: раз existing содержит их прежние данные,
    // поле approved (или его отсутствие) сохраняется как было — так все,
    // кто уже пользовался ботом до этой правки, не теряют доступ
    // автоматически.
    //
    // updateIdentity (атомарный read-modify-write, см. определение) —
    // намеренно, а не обычный get()+setJSON(): это сообщение может прийти
    // почти одновременно с тем, как админ меняет ту же запись (/approve,
    // пригласительная ссылка и т.п.), и без защиты от гонки более позднее
    // из двух обновлений тихо стирало бы другое.
    await updateIdentity(
      chatId,
      (current) => {
        const activeDays = Array.isArray(current.activeDays) ? [...current.activeDays] : [];
        if (!activeDays.includes(today)) activeDays.push(today);
        const firstSeen = current.firstSeen || new Date().toISOString();
        return {
          ...current,
          firstName: from.first_name || "",
          lastName: from.last_name || "",
          username: from.username || "",
          lastSeen: new Date().toISOString(),
          firstSeen,
          activeDays,
        };
      },
      () => ({ approved: false })
    );
  } catch (err) {
    // не критично
  }
}

// Telegram официально рекомендует не больше ~1 сообщения в секунду в один и
// тот же чат — при превышении сообщение не отклоняется (наш вызов API
// получает "ok"), а тихо откладывается на стороне Telegram и доставляется
// клиенту позже. Это может объяснять "второй вопрос не приходит сразу":
// если отвечать быстрее раза в секунду, каждое следующее сообщение рискует
// попасть в такую отложенную доставку. Выдерживаем паузу перед отправкой,
// если предыдущее сообщение в этот чат ушло меньше секунды назад.
const MIN_MS_BETWEEN_MESSAGES = process.env.RATE_LIMIT_MS != null ? parseInt(process.env.RATE_LIMIT_MS, 10) : 1100;

async function waitForRateLimit(chatId) {
  const key = String(chatId);
  const last = await rateLimitStore().get(key, { type: "json" });
  const now = Date.now();
  if (last && typeof last.at === "number") {
    const elapsed = now - last.at;
    if (elapsed < MIN_MS_BETWEEN_MESSAGES) {
      await new Promise((resolve) => setTimeout(resolve, MIN_MS_BETWEEN_MESSAGES - elapsed));
    }
  }
}

async function markMessageSent(chatId) {
  try {
    await rateLimitStore().setJSON(String(chatId), { at: Date.now() });
  } catch (err) {
    // Не критично, если запись не удалась — просто следующий вызов
    // подождёт чуть дольше, чем нужно.
  }
}

// Собственный маленький журнал отладки в Blobs — не зависит от того, работает
// ли сейчас просмотр логов в самой панели Netlify. Хранит последние 150
// записей. Читается через GET-запрос к этой же функции с ?debug=<секрет>.
async function dbg(msg) {
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await debugStore().getWithMetadata("log", { type: "json" });
      const arr = existing && Array.isArray(existing.data) ? existing.data : [];
      arr.push(`${new Date().toISOString()} ${msg}`);
      while (arr.length > 150) arr.shift();
      try {
        if (existing) {
          await debugStore().setJSON("log", arr, { onlyIfMatch: existing.etag });
        } else {
          await debugStore().setJSON("log", arr, { onlyIfNew: true });
        }
        return;
      } catch (err) {
        if (attempt === 9) throw err;
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 30));
      }
    }
  } catch (err) {
    // Отладочное логирование никогда не должно ронять бота — но теперь хотя
    // бы не теряет записи молча при конфликте, а честно повторяет попытку.
    console.error("dbg() failed after retries:", err);
  }
}

const CYR = /[а-яёА-ЯЁ]/;
const LAT = /[A-Za-z]/;

function emptyStats() {
  return { answered: 0, correct: 0, streak: 0, bestStreak: 0, wrong: {} };
}

async function log(...args) {
  console.log(...args);
  await dbg(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}

// Безопасное к гонкам обновление: читаем текущее значение вместе с ETag,
// применяем mutate(), и пишем обратно только "если ничего не изменилось
// с момента чтения" (onlyIfMatch). Если кто-то другой успел записать
// раньше нас — перечитываем и пробуем снова, с небольшой случайной паузой,
// чтобы конкурирующие попытки не сталкивались раз за разом синхронно.
//
// Важно: раньше после исчерпания попыток был "аварийный" безусловный
// force-write — он мог тихо затереть более свежие данные, записанные кем-то
// параллельно. Теперь при исчерпании попыток бросаем ошибку — это безопаснее:
// лучше один раз не обработать нажатие, чем незаметно испортить прогресс.
//
// (Была ещё попытка добавить перечитывание-и-сверку после каждой записи —
// откатила: сама проверка могла попадать в ту же задержку консистентности,
// из-за чего вместо редкого "слово застряло" бот иногда переставал отвечать
// вовсе, натыкаясь на таймаут функции. Пока просто доверяем ответу "ok" от
// самой записи.)
async function withOptimisticUpdate(store, key, defaultValue, mutate, maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const existing = await store.getWithMetadata(key, { type: "json" });
    const current = existing ? existing.data : defaultValue();
    const updated = mutate(current);
    try {
      if (existing) {
        await store.setJSON(key, updated, { onlyIfMatch: existing.etag });
      } else {
        await store.setJSON(key, updated, { onlyIfNew: true });
      }
      return updated;
    } catch (err) {
      if (attempt === maxAttempts - 1) {
        throw new Error(`withOptimisticUpdate: giving up on "${key}" after ${maxAttempts} attempts: ${err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 90));
    }
  }
}

// Обёртка withOptimisticUpdate специально для identityStore (доступ,
// approved/phrasesAccess/remindersEnabled и т.п.). До этой правки все места,
// трогающие identity-запись (rememberIdentity, /approve, /revoke,
// пригласительные ссылки, напоминания, /register), делали обычное
// "прочитать — целиком переписать" без защиты от гонки. Проблема: у каждого
// входящего сообщения rememberIdentity тоже читает-и-переписывает ту же самую
// запись (обновляет lastSeen/activeDays). Если ученик пишет боту почти
// одновременно с тем, как админ жмёт /approve (например, нетерпеливо
// повторяет /start в ожидании ответа), обе записи гонятся за одним и тем же
// ключом без какой-либо синхронизации — и чьё бы обновление ни завершилось
// последним, оно тихо стирает другое. Так approved:true от /approve мог
// пропасть, если rememberIdentity (прочитавший старое approved:false чуть
// раньше) дозаписывался позже. updateIdentity даёт каждому месту атомарное
// read-modify-write: при конфликте перечитывает актуальное состояние и
// применяет то же изменение заново, а не переписывает вслепую.
async function updateIdentity(chatId, mutate, defaultValue = () => ({})) {
  return withOptimisticUpdate(identityStore(), String(chatId), defaultValue, mutate);
}

// Как и выше — без блокирующей перепроверки, просто доверяем ответу записи.
// Проверка ограничена (максимум 3 попытки, короткая фиксированная пауза) —
// в отличие от прежней версии withOptimisticUpdate, эта запись не является
// общим ключом, за который конкурируют несколько запросов одновременно
// (только "победитель" claimPending когда-либо пишет сюда за один раз),
// поэтому здесь бесконечный цикл повторов из-за постоянной конкуренции не
// грозит — можно позволить себе разумную перепроверку.
async function verifiedSet(store, key, value, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await store.setJSON(key, value);
    const verify = await store.get(key, { type: "json" });
    if (JSON.stringify(verify) === JSON.stringify(value)) return;
    if (attempt < maxAttempts - 1) {
      await log(`[verifiedSet] mismatch on "${key}" (attempt ${attempt}) — retrying`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await log(`[verifiedSet] still mismatched on "${key}" after ${maxAttempts} attempts — proceeding with last write anyway`);
}

async function getStats(chatId) {
  const s = await statsStore().get(String(chatId), { type: "json" });
  return s || emptyStats();
}

// --- Словарь: хранится в Blobs ОТДЕЛЬНО ДЛЯ КАЖДОГО ЧАТА (каждый ученик
// видит и редактирует только свой собственный список слов). У нового чата
// словарь пустой (0 слов) — раньше сеялся стартовым набором из
// data/vocab.mjs, но это был просто список слов ОДНОГО конкретного
// человека из ранних тестов бота, и не должен доставаться всем по
// умолчанию. Прежний общий словарь всё ещё доступен через /migrate, если
// кому-то он нужен явно. ---

async function getVocab(chatId) {
  const v = await wordsStore().get(`words:${chatId}`, { type: "json" });
  return Array.isArray(v) ? v : [];
}

// --- Общая библиотека (Quizlet-блок): одна и та же лексика видна ВСЕМ
// ученикам, отдельно от личного словаря каждого. Организована в два
// уровня — сложность (например "A1-A2") и тема внутри неё (например
// "медицина") — оба уровня свободный текст, задаёт сама Маргарита при
// добавлении. Хранится в отдельном Blobs-сторе, ключ вида
// "shared:<сложность>:<тема>" (оба слагаются в нижний регистр для
// единообразия), значение — как обычно, массив {en, ru}. ---

function slugifyLevel(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, "_");
}

function sharedKey(difficulty, topic) {
  return `shared:${slugifyLevel(difficulty)}:${slugifyLevel(topic)}`;
}

async function getSharedVocab(difficulty, topic) {
  const v = await sharedLibraryStore().get(sharedKey(difficulty, topic), { type: "json" });
  return Array.isArray(v) ? v : [];
}

async function addSharedWords(difficulty, topic, pairs) {
  let added = 0;
  let total = 0;
  await withOptimisticUpdate(
    sharedLibraryStore(),
    sharedKey(difficulty, topic),
    () => [],
    (vocab) => {
      const next = [...vocab];
      const seen = new Set(next.map((w) => w.en.toLowerCase()));
      added = 0;
      for (const p of pairs) {
        const key = p.en.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(p);
        added += 1;
      }
      total = next.length;
      return next;
    }
  );
  return { added, total };
}

async function deleteSharedWords(difficulty, topic, terms) {
  let removedCount = 0;
  let total = 0;
  const termSet = new Set(terms.map((t) => t.toLowerCase().trim()));
  await withOptimisticUpdate(
    sharedLibraryStore(),
    sharedKey(difficulty, topic),
    () => [],
    (vocab) => {
      const next = vocab.filter((w) => !termSet.has(w.en.toLowerCase().trim()));
      removedCount = vocab.length - next.length;
      total = next.length;
      return next;
    }
  );
  return { removedCount, total };
}

// Возвращает список всех непустых пар "сложность/тема" в общей библиотеке
// вместе с человекочитаемыми исходными названиями (не только слагами) и
// количеством слов — используется и для меню ученика, и для /sharedlist.
async function listSharedLibrary() {
  const list = await sharedLibraryStore().list({ prefix: "shared:" });
  const entries = list && list.blobs ? list.blobs : [];
  const result = [];
  for (const entry of entries) {
    const parts = entry.key.split(":");
    if (parts.length !== 3) continue;
    const vocab = await sharedLibraryStore().get(entry.key, { type: "json" });
    const count = Array.isArray(vocab) ? vocab.length : 0;
    if (count === 0) continue;
    result.push({ difficultySlug: parts[1], topicSlug: parts[2], count });
  }
  return result;
}

// Разбирает одну строку вида "English term . перевод" (разделители: . - — – → = ->)

// Стартовый набор общей библиотеки (загружен Маргаритой единоразово,
// уровень A2, 10 тем, 400 слов) — подгружается автоматически один раз
// после деплоя (см. .github/workflows/seed-shared-library.yml), так что
// вручную отправлять эти слова боту не нужно. Повторные запуски безопасны
// (addSharedWords сам пропускает дубли).
const SEED_SHARED_LIBRARY_A2 = {
  difficulty: "A2",
  topics: {
    "путешествия": [
      { en: "journey", ru: "путешествие / дорога" },
      { en: "holiday", ru: "отпуск / каникулы" },
      { en: "flight", ru: "рейс" },
      { en: "luggage", ru: "багаж" },
      { en: "suitcase", ru: "чемодан" },
      { en: "backpack", ru: "рюкзак" },
      { en: "return ticket", ru: "билет туда и обратно" },
      { en: "single ticket", ru: "билет в одну сторону" },
      { en: "boarding pass", ru: "посадочный талон" },
      { en: "gate", ru: "выход на посадку" },
      { en: "departure", ru: "отправление" },
      { en: "arrival", ru: "прибытие" },
      { en: "delay", ru: "задержка" },
      { en: "to check in", ru: "регистрироваться" },
      { en: "to board", ru: "садиться (на рейс)" },
      { en: "platform", ru: "платформа" },
      { en: "to catch a train", ru: "успеть на поезд" },
      { en: "to miss a train", ru: "опоздать на поезд" },
      { en: "to change trains", ru: "делать пересадку" },
      { en: "abroad", ru: "за границей" },
      { en: "destination", ru: "пункт назначения" },
      { en: "to book", ru: "бронировать" },
      { en: "reservation", ru: "бронь" },
      { en: "to cancel", ru: "отменять" },
      { en: "hostel", ru: "хостел" },
      { en: "double room", ru: "двухместный номер" },
      { en: "to pack", ru: "собирать вещи" },
      { en: "guidebook", ru: "путеводитель" },
      { en: "sightseeing", ru: "осмотр достопримечательностей" },
      { en: "tourist", ru: "турист" },
      { en: "souvenir", ru: "сувенир" },
      { en: "seaside", ru: "морское побережье" },
      { en: "resort", ru: "курорт" },
      { en: "to sunbathe", ru: "загорать" },
      { en: "to go camping", ru: "ходить в поход с палаткой" },
      { en: "travel insurance", ru: "страховка для путешествий" },
      { en: "currency", ru: "валюта" },
      { en: "to exchange money", ru: "обменять деньги" },
      { en: "view", ru: "вид" },
      { en: "to have a good time", ru: "хорошо провести время" },
    ],
    "здоровье": [
      { en: "head", ru: "голова" },
      { en: "face", ru: "лицо" },
      { en: "neck", ru: "шея" },
      { en: "throat", ru: "горло" },
      { en: "chest", ru: "грудь" },
      { en: "stomach", ru: "живот / желудок" },
      { en: "back", ru: "спина" },
      { en: "shoulder", ru: "плечо" },
      { en: "arm", ru: "рука (от плеча)" },
      { en: "elbow", ru: "локоть" },
      { en: "wrist", ru: "запястье" },
      { en: "hand", ru: "кисть руки" },
      { en: "finger", ru: "палец руки" },
      { en: "leg", ru: "нога" },
      { en: "knee", ru: "колено" },
      { en: "ankle", ru: "лодыжка" },
      { en: "foot", ru: "ступня" },
      { en: "toe", ru: "палец ноги" },
      { en: "skin", ru: "кожа" },
      { en: "bone", ru: "кость" },
      { en: "heart", ru: "сердце" },
      { en: "illness", ru: "болезнь" },
      { en: "disease", ru: "заболевание" },
      { en: "headache", ru: "головная боль" },
      { en: "sore throat", ru: "боль в горле" },
      { en: "cough", ru: "кашель" },
      { en: "fever", ru: "высокая температура" },
      { en: "temperature", ru: "температура" },
      { en: "pain", ru: "боль" },
      { en: "injury", ru: "травма" },
      { en: "bruise", ru: "синяк" },
      { en: "to hurt", ru: "болеть / повредить" },
      { en: "to feel sick", ru: "чувствовать тошноту" },
      { en: "to catch a cold", ru: "простудиться" },
      { en: "to recover", ru: "выздоравливать" },
      { en: "to get better", ru: "поправляться" },
      { en: "painkiller", ru: "обезболивающее" },
      { en: "prescription", ru: "рецепт (на лекарство)" },
      { en: "to take medicine", ru: "принимать лекарство" },
      { en: "to make an appointment", ru: "записаться на прием" },
    ],
    "эмоции": [
      { en: "excited", ru: "взволнованный (радостно)" },
      { en: "nervous", ru: "нервный" },
      { en: "worried", ru: "обеспокоенный" },
      { en: "surprised", ru: "удивленный" },
      { en: "proud", ru: "гордый" },
      { en: "jealous", ru: "ревнивый / завистливый" },
      { en: "confident", ru: "уверенный" },
      { en: "upset", ru: "расстроенный" },
      { en: "relaxed", ru: "расслабленный" },
      { en: "lonely", ru: "одинокий" },
      { en: "embarrassed", ru: "смущенный" },
      { en: "calm", ru: "спокойный" },
      { en: "glad", ru: "радый" },
      { en: "pleased", ru: "довольный" },
      { en: "annoyed", ru: "раздраженный" },
      { en: "disappointed", ru: "разочарованный" },
      { en: "friendly", ru: "дружелюбный" },
      { en: "shy", ru: "застенчивый" },
      { en: "honest", ru: "честный" },
      { en: "lazy", ru: "ленивый" },
      { en: "hard-working", ru: "трудолюбивый" },
      { en: "polite", ru: "вежливый" },
      { en: "rude", ru: "грубый" },
      { en: "selfish", ru: "эгоистичный" },
      { en: "generous", ru: "щедрый" },
      { en: "patient", ru: "терпеливый" },
      { en: "cheerful", ru: "жизнерадостный" },
      { en: "serious", ru: "серьезный" },
      { en: "brave", ru: "смелый" },
      { en: "helpful", ru: "отзывчивый" },
      { en: "talkative", ru: "разговорчивый" },
      { en: "to feel", ru: "чувствовать" },
      { en: "to cheer up", ru: "подбадривать / веселеть" },
      { en: "to calm down", ru: "успокаиваться" },
      { en: "to get on well", ru: "хорошо ладить" },
      { en: "to be in a good mood", ru: "быть в хорошем настроении" },
      { en: "to be in a bad mood", ru: "быть в плохом настроении" },
      { en: "to lose one's temper", ru: "выйти из себя" },
      { en: "to be fed up", ru: "быть сытым по горло" },
      { en: "to feel like", ru: "хотеть (что-то сделать)" },
    ],
    "праздники": [
      { en: "festival", ru: "фестиваль / праздник" },
      { en: "celebration", ru: "празднование" },
      { en: "to celebrate", ru: "праздновать" },
      { en: "birthday", ru: "день рождения" },
      { en: "anniversary", ru: "годовщина" },
      { en: "wedding", ru: "свадьба" },
      { en: "guest", ru: "гость" },
      { en: "to invite", ru: "приглашать" },
      { en: "invitation", ru: "приглашение" },
      { en: "present", ru: "подарок" },
      { en: "gift", ru: "подарок" },
      { en: "to give a present", ru: "дарить подарок" },
      { en: "greeting card", ru: "поздравительная открытка" },
      { en: "candle", ru: "свеча" },
      { en: "balloon", ru: "воздушный шарик" },
      { en: "decoration", ru: "украшение" },
      { en: "to decorate", ru: "украшать" },
      { en: "fireworks", ru: "фейерверк" },
      { en: "party", ru: "вечеринка" },
      { en: "to throw a party", ru: "устроить вечеринку" },
      { en: "cake", ru: "торт" },
      { en: "to blow out candles", ru: "задувать свечи" },
      { en: "to make a wish", ru: "загадать желание" },
      { en: "tradition", ru: "традиция" },
      { en: "custom", ru: "обычай" },
      { en: "New Year", ru: "Новый год" },
      { en: "Christmas", ru: "Рождество" },
      { en: "Easter", ru: "Пасха" },
      { en: "Halloween", ru: "Хэллоуин" },
      { en: "to exchange gifts", ru: "обмениваться подарками" },
      { en: "to dress up", ru: "наряжаться" },
      { en: "costume", ru: "костюм" },
      { en: "to gather", ru: "собираться (вместе)" },
      { en: "feast", ru: "застолье" },
      { en: "to toast", ru: "произносить тост" },
      { en: "Happy birthday!", ru: "С днем рождения!" },
      { en: "Congratulations!", ru: "Поздравляю!" },
      { en: "Best wishes!", ru: "Всего наилучшего!" },
      { en: "public holiday", ru: "государственный праздник" },
      { en: "to have a day off", ru: "иметь выходной" },
    ],
    "спорт": [
      { en: "sport", ru: "спорт" },
      { en: "football", ru: "футбол" },
      { en: "basketball", ru: "баскетбол" },
      { en: "volleyball", ru: "волейбол" },
      { en: "tennis", ru: "теннис" },
      { en: "swimming", ru: "плавание" },
      { en: "athletics", ru: "легкая атлетика" },
      { en: "cycling", ru: "велоспорт" },
      { en: "skiing", ru: "катание на лыжах" },
      { en: "skating", ru: "катание на коньках" },
      { en: "boxing", ru: "бокс" },
      { en: "gym", ru: "спортзал" },
      { en: "team", ru: "команда" },
      { en: "player", ru: "игрок" },
      { en: "coach", ru: "тренер" },
      { en: "referee", ru: "судья" },
      { en: "opponent", ru: "соперник" },
      { en: "match", ru: "матч" },
      { en: "competition", ru: "соревнование" },
      { en: "championship", ru: "чемпионат" },
      { en: "tournament", ru: "турнир" },
      { en: "score", ru: "счет" },
      { en: "goal", ru: "гол" },
      { en: "winner", ru: "победитель" },
      { en: "to win", ru: "побеждать" },
      { en: "to lose", ru: "проигрывать" },
      { en: "to draw", ru: "сыграть вничью" },
      { en: "to train", ru: "тренироваться" },
      { en: "to practise", ru: "практиковаться" },
      { en: "to work out", ru: "заниматься спортом" },
      { en: "to keep fit", ru: "поддерживать форму" },
      { en: "to score a goal", ru: "забить гол" },
      { en: "to beat", ru: "обыграть" },
      { en: "pitch", ru: "поле (футбольное)" },
      { en: "court", ru: "корт / площадка" },
      { en: "stadium", ru: "стадион" },
      { en: "fan", ru: "болельщик" },
      { en: "to support a team", ru: "болеть за команду" },
      { en: "medal", ru: "медаль" },
      { en: "to take part in", ru: "участвовать в" },
    ],
    "искусство": [
      { en: "art", ru: "искусство" },
      { en: "painting", ru: "картина / живопись" },
      { en: "drawing", ru: "рисунок" },
      { en: "artist", ru: "художник" },
      { en: "painter", ru: "живописец" },
      { en: "gallery", ru: "галерея" },
      { en: "exhibition", ru: "выставка" },
      { en: "sculpture", ru: "скульптура" },
      { en: "portrait", ru: "портрет" },
      { en: "landscape", ru: "пейзаж" },
      { en: "style", ru: "стиль" },
      { en: "brush", ru: "кисть" },
      { en: "canvas", ru: "холст" },
      { en: "to sketch", ru: "делать набросок" },
      { en: "singer", ru: "певец" },
      { en: "band", ru: "группа (музыкальная)" },
      { en: "musician", ru: "музыкант" },
      { en: "composer", ru: "композитор" },
      { en: "concert", ru: "концерт" },
      { en: "orchestra", ru: "оркестр" },
      { en: "choir", ru: "хор" },
      { en: "instrument", ru: "инструмент" },
      { en: "drums", ru: "барабаны" },
      { en: "violin", ru: "скрипка" },
      { en: "trumpet", ru: "труба" },
      { en: "to perform", ru: "выступать" },
      { en: "performance", ru: "выступление" },
      { en: "voice", ru: "голос" },
      { en: "lyrics", ru: "слова песни" },
      { en: "melody", ru: "мелодия" },
      { en: "rhythm", ru: "ритм" },
      { en: "album", ru: "альбом" },
      { en: "track", ru: "трек" },
      { en: "tune", ru: "мотив / мелодия" },
      { en: "live music", ru: "живая музыка" },
      { en: "audience", ru: "публика / зрители" },
      { en: "stage", ru: "сцена" },
      { en: "talented", ru: "талантливый" },
      { en: "to be into", ru: "увлекаться" },
      { en: "masterpiece", ru: "шедевр" },
    ],
    "технологии": [
      { en: "computer", ru: "компьютер" },
      { en: "laptop", ru: "ноутбук" },
      { en: "smartphone", ru: "смартфон" },
      { en: "tablet", ru: "планшет" },
      { en: "screen", ru: "экран" },
      { en: "keyboard", ru: "клавиатура" },
      { en: "mouse", ru: "мышь" },
      { en: "charger", ru: "зарядное устройство" },
      { en: "cable", ru: "кабель / провод" },
      { en: "battery", ru: "батарея / аккумулятор" },
      { en: "headphones", ru: "наушники" },
      { en: "earphones", ru: "вкладыши-наушники" },
      { en: "speaker", ru: "колонка / динамик" },
      { en: "remote control", ru: "пульт" },
      { en: "printer", ru: "принтер" },
      { en: "plug", ru: "вилка (штепсель)" },
      { en: "socket", ru: "розетка" },
      { en: "button", ru: "кнопка" },
      { en: "device", ru: "устройство" },
      { en: "gadget", ru: "гаджет" },
      { en: "app", ru: "приложение" },
      { en: "message", ru: "сообщение" },
      { en: "file", ru: "файл" },
      { en: "folder", ru: "папка" },
      { en: "password", ru: "пароль" },
      { en: "to switch on", ru: "включать" },
      { en: "to switch off", ru: "выключать" },
      { en: "to turn up", ru: "делать громче" },
      { en: "to turn down", ru: "делать тише" },
      { en: "to charge", ru: "заряжать" },
      { en: "to plug in", ru: "подключать к сети" },
      { en: "to unplug", ru: "отключать от сети" },
      { en: "to press", ru: "нажимать" },
      { en: "to connect", ru: "подключать" },
      { en: "to install", ru: "устанавливать" },
      { en: "to update", ru: "обновлять" },
      { en: "to back up", ru: "делать резервную копию" },
      { en: "to delete", ru: "удалять" },
      { en: "to type", ru: "печатать (набирать)" },
      { en: "to download", ru: "скачивать" },
    ],
    "покупки": [
      { en: "customer", ru: "покупатель" },
      { en: "cashier", ru: "кассир" },
      { en: "receipt", ru: "чек" },
      { en: "change", ru: "сдача" },
      { en: "discount", ru: "скидка" },
      { en: "sale", ru: "распродажа" },
      { en: "special offer", ru: "спецпредложение" },
      { en: "half price", ru: "за полцены" },
      { en: "refund", ru: "возврат денег" },
      { en: "to try on", ru: "примерять" },
      { en: "to fit", ru: "подходить (по размеру)" },
      { en: "to afford", ru: "позволить себе" },
      { en: "to spend", ru: "тратить" },
      { en: "to save", ru: "копить / экономить" },
      { en: "to cost", ru: "стоить" },
      { en: "to pay for", ru: "платить за" },
      { en: "in cash", ru: "наличными" },
      { en: "by card", ru: "картой" },
      { en: "price tag", ru: "ценник" },
      { en: "shopping list", ru: "список покупок" },
      { en: "in stock", ru: "в наличии" },
      { en: "out of stock", ru: "нет в наличии" },
      { en: "bargain", ru: "выгодная покупка" },
      { en: "to queue", ru: "стоять в очереди" },
      { en: "bill", ru: "счет" },
      { en: "to lend", ru: "одолжить (кому-то)" },
      { en: "to borrow", ru: "взять в долг" },
      { en: "to owe", ru: "быть должным" },
      { en: "income", ru: "доход" },
      { en: "to waste money", ru: "тратить деньги впустую" },
      { en: "wallet", ru: "кошелек" },
      { en: "purse", ru: "женский кошелек" },
      { en: "coin", ru: "монета" },
      { en: "banknote", ru: "банкнота" },
      { en: "to withdraw", ru: "снимать (деньги)" },
      { en: "cash machine", ru: "банкомат" },
      { en: "shopping centre", ru: "торговый центр" },
      { en: "to return a product", ru: "вернуть товар" },
      { en: "to do the shopping", ru: "делать покупки" },
      { en: "value for money", ru: "хорошее соотношение цены и качества" },
    ],
    "работа": [
      { en: "employee", ru: "сотрудник" },
      { en: "employer", ru: "работодатель" },
      { en: "interview", ru: "собеседование" },
      { en: "to apply for", ru: "подавать заявку на" },
      { en: "application", ru: "заявка / заявление" },
      { en: "CV", ru: "резюме" },
      { en: "experience", ru: "опыт" },
      { en: "skills", ru: "навыки" },
      { en: "qualification", ru: "квалификация" },
      { en: "task", ru: "задача" },
      { en: "project", ru: "проект" },
      { en: "deadline", ru: "срок" },
      { en: "to hire", ru: "нанимать" },
      { en: "to employ", ru: "принимать на работу" },
      { en: "to earn", ru: "зарабатывать" },
      { en: "wages", ru: "заработок / зарплата (почасовая)" },
      { en: "full-time", ru: "полный рабочий день" },
      { en: "part-time", ru: "неполный рабочий день" },
      { en: "shift", ru: "смена" },
      { en: "to work overtime", ru: "работать сверхурочно" },
      { en: "to be fired", ru: "быть уволенным" },
      { en: "to be unemployed", ru: "быть безработным" },
      { en: "to look for a job", ru: "искать работу" },
      { en: "staff", ru: "персонал" },
      { en: "uniform", ru: "униформа" },
      { en: "accountant", ru: "бухгалтер" },
      { en: "lawyer", ru: "юрист" },
      { en: "dentist", ru: "стоматолог" },
      { en: "electrician", ru: "электрик" },
      { en: "plumber", ru: "сантехник" },
      { en: "mechanic", ru: "механик" },
      { en: "hairdresser", ru: "парикмахер" },
      { en: "chef", ru: "повар" },
      { en: "shop assistant", ru: "продавец" },
      { en: "receptionist", ru: "администратор" },
      { en: "to retire", ru: "выходить на пенсию" },
      { en: "to get a job", ru: "устроиться на работу" },
      { en: "to lose a job", ru: "потерять работу" },
      { en: "colleague", ru: "коллега" },
      { en: "to be good at", ru: "хорошо уметь" },
    ],
    "город": [
      { en: "corner", ru: "угол" },
      { en: "crossroads", ru: "перекресток" },
      { en: "roundabout", ru: "круговое движение" },
      { en: "traffic lights", ru: "светофор" },
      { en: "pedestrian crossing", ru: "пешеходный переход" },
      { en: "pavement", ru: "тротуар" },
      { en: "zebra crossing", ru: "зебра (переход)" },
      { en: "bridge", ru: "мост" },
      { en: "underground station", ru: "станция метро" },
      { en: "bus stop", ru: "автобусная остановка" },
      { en: "car park", ru: "парковка" },
      { en: "chemist", ru: "аптека" },
      { en: "department store", ru: "универмаг" },
      { en: "post office", ru: "почта" },
      { en: "petrol station", ru: "заправка" },
      { en: "to turn left", ru: "повернуть налево" },
      { en: "to turn right", ru: "повернуть направо" },
      { en: "to go straight on", ru: "идти прямо" },
      { en: "to go past", ru: "пройти мимо" },
      { en: "to cross the road", ru: "переходить дорогу" },
      { en: "to take the first turning", ru: "повернуть на первом повороте" },
      { en: "opposite", ru: "напротив" },
      { en: "next to", ru: "рядом с" },
      { en: "between", ru: "между" },
      { en: "behind", ru: "позади" },
      { en: "in front of", ru: "перед" },
      { en: "on the corner of", ru: "на углу" },
      { en: "around the corner", ru: "за углом" },
      { en: "at the end of", ru: "в конце" },
      { en: "nearby", ru: "поблизости" },
      { en: "far from", ru: "далеко от" },
      { en: "How do I get to...?", ru: "Как пройти к...?" },
      { en: "Is it far?", ru: "Это далеко?" },
      { en: "to get lost", ru: "заблудиться" },
      { en: "directions", ru: "указания пути" },
      { en: "on the left", ru: "слева" },
      { en: "on the right", ru: "справа" },
      { en: "It's a five-minute walk", ru: "Это в пяти минутах ходьбы" },
      { en: "Go along this street", ru: "Идите по этой улице" },
      { en: "straight ahead", ru: "прямо впереди" },
    ],
    "маркетинг": [
      { en: "audience", ru: "аудитория" },
      { en: "target group", ru: "целевая группа" },
      { en: "campaign", ru: "кампания" },
      { en: "launch a product", ru: "выпустить продукт на рынок" },
      { en: "budget", ru: "бюджет" },
      { en: "cost", ru: "стоимость, затраты" },
      { en: "profit", ru: "прибыль" },
      { en: "demand", ru: "спрос" },
      { en: "supply", ru: "предложение на рынке" },
      { en: "competitor", ru: "конкурент" },
      { en: "compare", ru: "сравнивать" },
      { en: "research", ru: "исследование" },
      { en: "survey", ru: "опрос" },
      { en: "result", ru: "результат" },
      { en: "increase", ru: "рост, расти" },
      { en: "decrease", ru: "снижение, снижаться" },
      { en: "grow", ru: "расти" },
      { en: "feedback", ru: "обратная связь" },
      { en: "review", ru: "отзыв" },
      { en: "customer service", ru: "обслуживание клиентов" },
      { en: "loyal customer", ru: "постоянный клиент" },
      { en: "value for money", ru: "соотношение цены и качества" },
      { en: "special offer", ru: "спецпредложение" },
      { en: "content", ru: "контент" },
      { en: "banner", ru: "баннер" },
      { en: "newsletter", ru: "рассылка" },
      { en: "subscriber", ru: "подписчик" },
      { en: "follower", ru: "подписчик в соцсетях" },
      { en: "influencer", ru: "блогер, инфлюенсер" },
      { en: "share", ru: "делиться, репостить" },
      { en: "comment", ru: "комментарий, комментировать" },
      { en: "order", ru: "заказ" },
      { en: "delivery", ru: "доставка" },
      { en: "supplier", ru: "поставщик" },
      { en: "presentation", ru: "презентация" },
      { en: "deadline", ru: "срок сдачи" },
      { en: "word of mouth", ru: "сарафанное радио" },
    ],
  },
};

// --- Уровень A1 (900+ слов, объединено из A1_* и вспомогательных списков) ---
const SEED_SHARED_LIBRARY_A1 = {
  difficulty: "A1",
  topics: {
    "семья": [
      { en: "mother", ru: "мама / мать" },
      { en: "father", ru: "папа / отец" },
      { en: "parent", ru: "родитель" },
      { en: "parents", ru: "родители" },
      { en: "son", ru: "сын" },
      { en: "daughter", ru: "дочь" },
      { en: "brother", ru: "брат" },
      { en: "sister", ru: "сестра" },
      { en: "husband", ru: "муж" },
      { en: "wife", ru: "жена" },
      { en: "child", ru: "ребёнок" },
      { en: "children", ru: "дети" },
      { en: "baby", ru: "малыш" },
      { en: "kid", ru: "ребёнок (разг.)" },
      { en: "twins", ru: "близнецы" },
      { en: "grandmother", ru: "бабушка" },
      { en: "grandfather", ru: "дедушка" },
      { en: "grandparents", ru: "бабушка и дедушка" },
      { en: "grandson", ru: "внук" },
      { en: "granddaughter", ru: "внучка" },
      { en: "grandchild", ru: "внук / внучка" },
      { en: "uncle", ru: "дядя" },
      { en: "aunt", ru: "тётя" },
      { en: "cousin", ru: "двоюродный брат / сестра" },
      { en: "nephew", ru: "племянник" },
      { en: "niece", ru: "племянница" },
      { en: "relative", ru: "родственник" },
      { en: "family", ru: "семья" },
      { en: "mother-in-law", ru: "свекровь / тёща" },
      { en: "father-in-law", ru: "свёкор / тесть" },
      { en: "brother-in-law", ru: "деверь / шурин" },
      { en: "sister-in-law", ru: "золовка / невестка" },
      { en: "stepmother", ru: "мачеха" },
      { en: "stepfather", ru: "отчим" },
      { en: "stepbrother", ru: "сводный брат" },
      { en: "stepsister", ru: "сводная сестра" },
      { en: "half-brother", ru: "сводный брат (по одному родителю)" },
      { en: "half-sister", ru: "сводная сестра (по одному родителю)" },
      { en: "friend", ru: "друг" },
      { en: "best friend", ru: "лучший друг" },
      { en: "boyfriend", ru: "парень" },
      { en: "girlfriend", ru: "девушка" },
      { en: "partner", ru: "партнёр" },
      { en: "neighbour", ru: "сосед" },
      { en: "classmate", ru: "одноклассник" },
      { en: "colleague", ru: "коллега" },
      { en: "married", ru: "женат / замужем" },
      { en: "single", ru: "холост / не замужем" },
      { en: "divorced", ru: "в разводе" },
      { en: "engaged", ru: "обручён" },
      { en: "widow", ru: "вдова" },
      { en: "widower", ru: "вдовец" },
      { en: "kind", ru: "добрый" },
      { en: "friendly", ru: "дружелюбный" },
      { en: "shy", ru: "стеснительный" },
      { en: "generous", ru: "щедрый" },
      { en: "lazy", ru: "ленивый" },
      { en: "hardworking", ru: "трудолюбивый" },
      { en: "talkative", ru: "болтливый" },
      { en: "quiet", ru: "тихий" },
      { en: "funny", ru: "смешной" },
      { en: "serious", ru: "серьёзный" },
      { en: "honest", ru: "честный" },
      { en: "polite", ru: "вежливый" },
      { en: "patient", ru: "терпеливый" },
      { en: "helpful", ru: "отзывчивый" },
      { en: "clever", ru: "умный" },
      { en: "smart", ru: "умный (амер.)" },
      { en: "strict", ru: "строгий" },
      { en: "calm", ru: "спокойный" },
      { en: "nice", ru: "приятный" },
      { en: "rude", ru: "грубый" },
      { en: "tall", ru: "высокий" },
      { en: "short", ru: "низкий / невысокий" },
      { en: "slim", ru: "стройный" },
      { en: "plump", ru: "полный" },
      { en: "beautiful", ru: "красивая" },
      { en: "handsome", ru: "красивый (о мужчине)" },
      { en: "pretty", ru: "симпатичная" },
      { en: "cute", ru: "милый" },
      { en: "young", ru: "молодой" },
      { en: "old", ru: "старый" },
      { en: "middle-aged", ru: "среднего возраста" },
      { en: "hair", ru: "волосы" },
      { en: "eyes", ru: "глаза" },
      { en: "beard", ru: "борода" },
      { en: "moustache", ru: "усы" },
      { en: "glasses", ru: "очки" },
      { en: "curly hair", ru: "кудрявые волосы" },
      { en: "straight hair", ru: "прямые волосы" },
      { en: "long hair", ru: "длинные волосы" },
      { en: "short hair", ru: "короткие волосы" },
      { en: "blonde", ru: "светловолосый" },
      { en: "brunette", ru: "брюнет" },
      { en: "red-haired", ru: "рыжий" },
      { en: "blue eyes", ru: "голубые глаза" },
      { en: "green eyes", ru: "зелёные глаза" },
      { en: "brown eyes", ru: "карие глаза" },
      { en: "dark eyes", ru: "тёмные глаза" },
    ],
    "работа": [
      { en: "teacher", ru: "учитель" },
      { en: "doctor", ru: "врач" },
      { en: "nurse", ru: "медсестра" },
      { en: "engineer", ru: "инженер" },
      { en: "manager", ru: "менеджер" },
      { en: "designer", ru: "дизайнер" },
      { en: "programmer", ru: "программист" },
      { en: "developer", ru: "разработчик" },
      { en: "lawyer", ru: "юрист" },
      { en: "journalist", ru: "журналист" },
      { en: "accountant", ru: "бухгалтер" },
      { en: "chef", ru: "шеф-повар" },
      { en: "cook", ru: "повар" },
      { en: "driver", ru: "водитель" },
      { en: "waiter", ru: "официант" },
      { en: "waitress", ru: "официантка" },
      { en: "salesperson", ru: "продавец" },
      { en: "shop assistant", ru: "продавец-консультант" },
      { en: "electrician", ru: "электрик" },
      { en: "plumber", ru: "сантехник" },
      { en: "mechanic", ru: "механик" },
      { en: "builder", ru: "строитель" },
      { en: "architect", ru: "архитектор" },
      { en: "artist", ru: "художник" },
      { en: "musician", ru: "музыкант" },
      { en: "actor", ru: "актёр" },
      { en: "actress", ru: "актриса" },
      { en: "singer", ru: "певец" },
      { en: "writer", ru: "писатель" },
      { en: "photographer", ru: "фотограф" },
      { en: "dentist", ru: "стоматолог" },
      { en: "vet", ru: "ветеринар" },
      { en: "police officer", ru: "полицейский" },
      { en: "firefighter", ru: "пожарный" },
      { en: "soldier", ru: "солдат" },
      { en: "pilot", ru: "пилот" },
      { en: "flight attendant", ru: "бортпроводник" },
      { en: "farmer", ru: "фермер" },
      { en: "hairdresser", ru: "парикмахер" },
      { en: "cleaner", ru: "уборщик" },
      { en: "secretary", ru: "секретарь" },
      { en: "banker", ru: "банкир" },
      { en: "businessman", ru: "бизнесмен" },
      { en: "businesswoman", ru: "бизнес-леди" },
      { en: "student", ru: "студент" },
      { en: "scientist", ru: "учёный" },
      { en: "researcher", ru: "исследователь" },
      { en: "translator", ru: "переводчик" },
      { en: "office", ru: "офис" },
      { en: "desk", ru: "рабочий стол" },
      { en: "chair", ru: "стул" },
      { en: "computer", ru: "компьютер" },
      { en: "laptop", ru: "ноутбук" },
      { en: "printer", ru: "принтер" },
      { en: "phone", ru: "телефон" },
      { en: "email", ru: "электронная почта" },
      { en: "meeting", ru: "встреча" },
      { en: "boss", ru: "начальник" },
      { en: "team", ru: "команда" },
      { en: "salary", ru: "зарплата" },
      { en: "contract", ru: "контракт" },
      { en: "deadline", ru: "срок / дедлайн" },
      { en: "project", ru: "проект" },
      { en: "client", ru: "клиент" },
      { en: "customer", ru: "покупатель / клиент" },
      { en: "job", ru: "работа" },
      { en: "career", ru: "карьера" },
      { en: "company", ru: "компания" },
      { en: "business", ru: "бизнес" },
      { en: "office hours", ru: "рабочее время" },
      { en: "break", ru: "перерыв" },
      { en: "lunch break", ru: "обеденный перерыв" },
      { en: "work", ru: "работать" },
      { en: "earn", ru: "зарабатывать" },
      { en: "hire", ru: "нанимать" },
      { en: "fire", ru: "увольнять" },
      { en: "apply", ru: "подавать заявку" },
      { en: "sign", ru: "подписывать" },
      { en: "attend", ru: "посещать" },
      { en: "present", ru: "представлять" },
      { en: "manage", ru: "управлять" },
      { en: "report", ru: "отчитываться" },
      { en: "quit", ru: "уволиться" },
      { en: "retire", ru: "выйти на пенсию" },
      { en: "get a job", ru: "устроиться на работу" },
      { en: "get promoted", ru: "получить повышение" },
      { en: "look for a job", ru: "искать работу" },
      { en: "work from home", ru: "работать из дома" },
      { en: "busy", ru: "занятой" },
      { en: "free", ru: "свободный" },
      { en: "stressed", ru: "на нервах" },
      { en: "tired", ru: "уставший" },
      { en: "unemployed", ru: "безработный" },
      { en: "employed", ru: "трудоустроенный" },
      { en: "full-time", ru: "полный рабочий день" },
      { en: "part-time", ru: "частичная занятость" },
      { en: "freelance", ru: "фриланс" },
      { en: "remote", ru: "удалённый" },
    ],
    "дом": [
      { en: "house", ru: "дом" },
      { en: "flat", ru: "квартира" },
      { en: "apartment", ru: "квартира (амер.)" },
      { en: "cottage", ru: "коттедж" },
      { en: "villa", ru: "вилла" },
      { en: "studio", ru: "студия" },
      { en: "room", ru: "комната" },
      { en: "building", ru: "здание" },
      { en: "floor", ru: "этаж" },
      { en: "ground floor", ru: "первый этаж" },
      { en: "balcony", ru: "балкон" },
      { en: "garden", ru: "сад" },
      { en: "yard", ru: "двор" },
      { en: "garage", ru: "гараж" },
      { en: "entrance", ru: "вход" },
      { en: "lift", ru: "лифт" },
      { en: "elevator", ru: "лифт (амер.)" },
      { en: "stairs", ru: "лестница" },
      { en: "kitchen", ru: "кухня" },
      { en: "bathroom", ru: "ванная" },
      { en: "bedroom", ru: "спальня" },
      { en: "living room", ru: "гостиная" },
      { en: "dining room", ru: "столовая" },
      { en: "study", ru: "кабинет" },
      { en: "basement", ru: "подвал" },
      { en: "attic", ru: "чердак" },
      { en: "hallway", ru: "прихожая" },
      { en: "toilet", ru: "туалет" },
      { en: "sofa", ru: "диван" },
      { en: "armchair", ru: "кресло" },
      { en: "chair", ru: "стул" },
      { en: "table", ru: "стол" },
      { en: "desk", ru: "рабочий стол" },
      { en: "bed", ru: "кровать" },
      { en: "wardrobe", ru: "шкаф (для одежды)" },
      { en: "bookshelf", ru: "книжная полка" },
      { en: "shelf", ru: "полка" },
      { en: "cupboard", ru: "буфет / шкафчик" },
      { en: "drawer", ru: "ящик" },
      { en: "mirror", ru: "зеркало" },
      { en: "lamp", ru: "лампа" },
      { en: "carpet", ru: "ковёр" },
      { en: "rug", ru: "коврик" },
      { en: "curtains", ru: "шторы" },
      { en: "pillow", ru: "подушка" },
      { en: "blanket", ru: "одеяло" },
      { en: "sheet", ru: "простыня" },
      { en: "fridge", ru: "холодильник" },
      { en: "oven", ru: "духовка" },
      { en: "stove", ru: "плита" },
      { en: "dishwasher", ru: "посудомойка" },
      { en: "washing machine", ru: "стиральная машина" },
      { en: "microwave", ru: "микроволновка" },
      { en: "kettle", ru: "чайник" },
      { en: "toaster", ru: "тостер" },
      { en: "TV", ru: "телевизор" },
      { en: "remote control", ru: "пульт" },
      { en: "vacuum cleaner", ru: "пылесос" },
      { en: "iron", ru: "утюг" },
      { en: "hairdryer", ru: "фен" },
      { en: "sink", ru: "раковина" },
      { en: "bath", ru: "ванна" },
      { en: "shower", ru: "душ" },
      { en: "toothbrush", ru: "зубная щётка" },
      { en: "toothpaste", ru: "зубная паста" },
      { en: "soap", ru: "мыло" },
      { en: "towel", ru: "полотенце" },
      { en: "shampoo", ru: "шампунь" },
      { en: "door", ru: "дверь" },
      { en: "window", ru: "окно" },
      { en: "wall", ru: "стена" },
      { en: "ceiling", ru: "потолок" },
      { en: "roof", ru: "крыша" },
      { en: "key", ru: "ключ" },
      { en: "lock", ru: "замок" },
      { en: "clock", ru: "часы" },
      { en: "picture", ru: "картина" },
      { en: "plant", ru: "растение" },
      { en: "flowers", ru: "цветы" },
      { en: "candle", ru: "свеча" },
      { en: "photo", ru: "фотография" },
      { en: "cook", ru: "готовить" },
      { en: "clean", ru: "убирать" },
      { en: "wash", ru: "мыть" },
      { en: "tidy", ru: "наводить порядок" },
      { en: "repair", ru: "чинить" },
      { en: "fix", ru: "починить" },
      { en: "sleep", ru: "спать" },
      { en: "relax", ru: "отдыхать" },
      { en: "live", ru: "жить" },
      { en: "move", ru: "переезжать" },
      { en: "rent", ru: "снимать" },
      { en: "buy", ru: "покупать" },
      { en: "sell", ru: "продавать" },
      { en: "own", ru: "владеть" },
      { en: "share", ru: "делить" },
    ],
    "еда": [
      { en: "bread", ru: "хлеб" },
      { en: "toast", ru: "тост" },
      { en: "rice", ru: "рис" },
      { en: "pasta", ru: "макароны" },
      { en: "noodles", ru: "лапша" },
      { en: "cereal", ru: "хлопья" },
      { en: "flour", ru: "мука" },
      { en: "milk", ru: "молоко" },
      { en: "cheese", ru: "сыр" },
      { en: "butter", ru: "масло (сливочное)" },
      { en: "yogurt", ru: "йогурт" },
      { en: "cream", ru: "сливки" },
      { en: "meat", ru: "мясо" },
      { en: "beef", ru: "говядина" },
      { en: "pork", ru: "свинина" },
      { en: "chicken", ru: "курица" },
      { en: "turkey", ru: "индейка" },
      { en: "lamb", ru: "баранина" },
      { en: "fish", ru: "рыба" },
      { en: "salmon", ru: "лосось" },
      { en: "tuna", ru: "тунец" },
      { en: "shrimp", ru: "креветки" },
      { en: "egg", ru: "яйцо" },
      { en: "eggs", ru: "яйца" },
      { en: "vegetable", ru: "овощ" },
      { en: "vegetables", ru: "овощи" },
      { en: "potato", ru: "картошка" },
      { en: "tomato", ru: "помидор" },
      { en: "cucumber", ru: "огурец" },
      { en: "onion", ru: "лук" },
      { en: "garlic", ru: "чеснок" },
      { en: "carrot", ru: "морковь" },
      { en: "cabbage", ru: "капуста" },
      { en: "pepper", ru: "перец (овощ)" },
      { en: "salad", ru: "салат" },
      { en: "mushroom", ru: "гриб" },
      { en: "broccoli", ru: "брокколи" },
      { en: "fruit", ru: "фрукт" },
      { en: "fruits", ru: "фрукты" },
      { en: "apple", ru: "яблоко" },
      { en: "banana", ru: "банан" },
      { en: "orange", ru: "апельсин" },
      { en: "lemon", ru: "лимон" },
      { en: "strawberry", ru: "клубника" },
      { en: "grapes", ru: "виноград" },
      { en: "watermelon", ru: "арбуз" },
      { en: "pineapple", ru: "ананас" },
      { en: "peach", ru: "персик" },
      { en: "pear", ru: "груша" },
      { en: "sugar", ru: "сахар" },
      { en: "salt", ru: "соль" },
      { en: "chocolate", ru: "шоколад" },
      { en: "cake", ru: "торт" },
      { en: "cookie", ru: "печенье" },
      { en: "ice cream", ru: "мороженое" },
      { en: "jam", ru: "джем" },
      { en: "honey", ru: "мёд" },
      { en: "oil", ru: "масло (растительное)" },
      { en: "olive oil", ru: "оливковое масло" },
      { en: "vinegar", ru: "уксус" },
      { en: "sauce", ru: "соус" },
      { en: "ketchup", ru: "кетчуп" },
      { en: "mayonnaise", ru: "майонез" },
      { en: "water", ru: "вода" },
      { en: "coffee", ru: "кофе" },
      { en: "tea", ru: "чай" },
      { en: "juice", ru: "сок" },
      { en: "wine", ru: "вино" },
      { en: "beer", ru: "пиво" },
      { en: "cocktail", ru: "коктейль" },
      { en: "champagne", ru: "шампанское" },
      { en: "sparkling water", ru: "газированная вода" },
      { en: "still water", ru: "негазированная вода" },
      { en: "breakfast", ru: "завтрак" },
      { en: "lunch", ru: "обед" },
      { en: "dinner", ru: "ужин" },
      { en: "brunch", ru: "поздний завтрак" },
      { en: "snack", ru: "перекус" },
      { en: "dessert", ru: "десерт" },
      { en: "appetiser", ru: "закуска" },
      { en: "main course", ru: "основное блюдо" },
      { en: "cook", ru: "готовить" },
      { en: "boil", ru: "варить" },
      { en: "fry", ru: "жарить" },
      { en: "bake", ru: "печь" },
      { en: "grill", ru: "жарить на гриле" },
      { en: "cut", ru: "резать" },
      { en: "mix", ru: "смешивать" },
      { en: "add", ru: "добавлять" },
      { en: "serve", ru: "подавать" },
      { en: "order", ru: "заказывать" },
      { en: "taste", ru: "пробовать" },
      { en: "sweet", ru: "сладкий" },
      { en: "salty", ru: "солёный" },
      { en: "spicy", ru: "острый" },
      { en: "sour", ru: "кислый" },
      { en: "bitter", ru: "горький" },
      { en: "fresh", ru: "свежий" },
      { en: "delicious", ru: "вкусный" },
      { en: "hot", ru: "горячий" },
      { en: "cold", ru: "холодный" },
      { en: "plate", ru: "тарелка" },
      { en: "fork", ru: "вилка" },
      { en: "knife", ru: "нож" },
      { en: "spoon", ru: "ложка" },
      { en: "glass", ru: "стакан" },
      { en: "cup", ru: "чашка" },
      { en: "mug", ru: "кружка" },
      { en: "bottle", ru: "бутылка" },
      { en: "bowl", ru: "миска" },
      { en: "napkin", ru: "салфетка" },
    ],
    "время": [
      { en: "time", ru: "время" },
      { en: "morning", ru: "утро" },
      { en: "afternoon", ru: "день (после полудня)" },
      { en: "evening", ru: "вечер" },
      { en: "night", ru: "ночь" },
      { en: "midnight", ru: "полночь" },
      { en: "noon", ru: "полдень" },
      { en: "midday", ru: "полдень" },
      { en: "sunrise", ru: "рассвет" },
      { en: "sunset", ru: "закат" },
      { en: "dawn", ru: "рассвет" },
      { en: "dusk", ru: "сумерки" },
      { en: "Monday", ru: "понедельник" },
      { en: "Tuesday", ru: "вторник" },
      { en: "Wednesday", ru: "среда" },
      { en: "Thursday", ru: "четверг" },
      { en: "Friday", ru: "пятница" },
      { en: "Saturday", ru: "суббота" },
      { en: "Sunday", ru: "воскресенье" },
      { en: "weekend", ru: "выходные" },
      { en: "weekday", ru: "будний день" },
      { en: "day", ru: "день" },
      { en: "January", ru: "январь" },
      { en: "February", ru: "февраль" },
      { en: "March", ru: "март" },
      { en: "April", ru: "апрель" },
      { en: "May", ru: "май" },
      { en: "June", ru: "июнь" },
      { en: "July", ru: "июль" },
      { en: "August", ru: "август" },
      { en: "September", ru: "сентябрь" },
      { en: "October", ru: "октябрь" },
      { en: "November", ru: "ноябрь" },
      { en: "December", ru: "декабрь" },
      { en: "month", ru: "месяц" },
      { en: "season", ru: "сезон" },
      { en: "spring", ru: "весна" },
      { en: "summer", ru: "лето" },
      { en: "autumn", ru: "осень" },
      { en: "fall", ru: "осень (амер.)" },
      { en: "winter", ru: "зима" },
      { en: "year", ru: "год" },
      { en: "century", ru: "век" },
      { en: "decade", ru: "десятилетие" },
      { en: "second", ru: "секунда" },
      { en: "minute", ru: "минута" },
      { en: "hour", ru: "час" },
      { en: "half an hour", ru: "полчаса" },
      { en: "quarter of an hour", ru: "четверть часа" },
      { en: "week", ru: "неделя" },
      { en: "fortnight", ru: "две недели" },
      { en: "o'clock", ru: "часов (ровно)" },
      { en: "half past", ru: "половина" },
      { en: "quarter past", ru: "четверть после" },
      { en: "quarter to", ru: "без четверти" },
      { en: "am", ru: "утра" },
      { en: "pm", ru: "вечера" },
      { en: "always", ru: "всегда" },
      { en: "usually", ru: "обычно" },
      { en: "often", ru: "часто" },
      { en: "sometimes", ru: "иногда" },
      { en: "rarely", ru: "редко" },
      { en: "seldom", ru: "редко" },
      { en: "never", ru: "никогда" },
      { en: "every day", ru: "каждый день" },
      { en: "every week", ru: "каждую неделю" },
      { en: "every month", ru: "каждый месяц" },
      { en: "every year", ru: "каждый год" },
      { en: "once a week", ru: "раз в неделю" },
      { en: "twice a week", ru: "два раза в неделю" },
      { en: "three times a week", ru: "три раза в неделю" },
      { en: "once a month", ru: "раз в месяц" },
      { en: "once a year", ru: "раз в год" },
      { en: "today", ru: "сегодня" },
      { en: "yesterday", ru: "вчера" },
      { en: "tomorrow", ru: "завтра" },
      { en: "the day before yesterday", ru: "позавчера" },
      { en: "the day after tomorrow", ru: "послезавтра" },
      { en: "now", ru: "сейчас" },
      { en: "later", ru: "позже" },
      { en: "soon", ru: "скоро" },
      { en: "early", ru: "рано" },
      { en: "late", ru: "поздно" },
      { en: "on time", ru: "вовремя" },
      { en: "in time", ru: "к нужному моменту" },
      { en: "birthday", ru: "день рождения" },
      { en: "holiday", ru: "праздник / отпуск" },
      { en: "vacation", ru: "отпуск (амер.)" },
      { en: "anniversary", ru: "годовщина" },
      { en: "appointment", ru: "встреча (запланированная)" },
      { en: "date", ru: "свидание / дата" },
      { en: "meeting", ru: "встреча" },
      { en: "event", ru: "событие" },
      { en: "schedule", ru: "расписание" },
      { en: "timetable", ru: "расписание (поездов, занятий)" },
      { en: "calendar", ru: "календарь" },
      { en: "diary", ru: "ежедневник" },
      { en: "clock", ru: "часы (настенные)" },
      { en: "watch", ru: "часы (наручные)" },
      { en: "alarm", ru: "будильник" },
      { en: "moment", ru: "момент" },
    ],
    "страны": [
      { en: "country", ru: "страна" },
      { en: "city", ru: "город" },
      { en: "town", ru: "городок" },
      { en: "village", ru: "деревня" },
      { en: "capital", ru: "столица" },
      { en: "state", ru: "штат / государство" },
      { en: "region", ru: "регион" },
      { en: "continent", ru: "континент" },
      { en: "border", ru: "граница" },
      { en: "abroad", ru: "за границей" },
      { en: "foreign", ru: "иностранный" },
      { en: "local", ru: "местный" },
      { en: "nationality", ru: "национальность" },
      { en: "language", ru: "язык" },
      { en: "Russia", ru: "Россия" },
      { en: "the USA", ru: "США" },
      { en: "the UK", ru: "Великобритания" },
      { en: "England", ru: "Англия" },
      { en: "Scotland", ru: "Шотландия" },
      { en: "Ireland", ru: "Ирландия" },
      { en: "Wales", ru: "Уэльс" },
      { en: "Germany", ru: "Германия" },
      { en: "France", ru: "Франция" },
      { en: "Italy", ru: "Италия" },
      { en: "Spain", ru: "Испания" },
      { en: "Portugal", ru: "Португалия" },
      { en: "Poland", ru: "Польша" },
      { en: "the Netherlands", ru: "Нидерланды" },
      { en: "Belgium", ru: "Бельгия" },
      { en: "Sweden", ru: "Швеция" },
      { en: "Norway", ru: "Норвегия" },
      { en: "Finland", ru: "Финляндия" },
      { en: "Denmark", ru: "Дания" },
      { en: "Greece", ru: "Греция" },
      { en: "Turkey", ru: "Турция" },
      { en: "China", ru: "Китай" },
      { en: "Japan", ru: "Япония" },
      { en: "Korea", ru: "Корея" },
      { en: "South Korea", ru: "Южная Корея" },
      { en: "India", ru: "Индия" },
      { en: "Vietnam", ru: "Вьетнам" },
      { en: "Thailand", ru: "Таиланд" },
      { en: "Brazil", ru: "Бразилия" },
      { en: "Argentina", ru: "Аргентина" },
      { en: "Mexico", ru: "Мексика" },
      { en: "Canada", ru: "Канада" },
      { en: "Australia", ru: "Австралия" },
      { en: "New Zealand", ru: "Новая Зеландия" },
      { en: "Egypt", ru: "Египет" },
      { en: "South Africa", ru: "ЮАР" },
      { en: "Russian (person)", ru: "русский" },
      { en: "American", ru: "американец" },
      { en: "British", ru: "британец" },
      { en: "English (person)", ru: "англичанин" },
      { en: "Scottish", ru: "шотландец" },
      { en: "Irish", ru: "ирландец" },
      { en: "Welsh", ru: "валлиец" },
      { en: "German (person)", ru: "немец" },
      { en: "French (person)", ru: "француз" },
      { en: "Italian (person)", ru: "итальянец" },
      { en: "Spanish (person)", ru: "испанец" },
      { en: "Portuguese (person)", ru: "португалец" },
      { en: "Polish (person)", ru: "поляк" },
      { en: "Dutch", ru: "голландец" },
      { en: "Swedish (person)", ru: "швед" },
      { en: "Norwegian", ru: "норвежец" },
      { en: "Finnish", ru: "финн" },
      { en: "Danish", ru: "датчанин" },
      { en: "Greek", ru: "грек" },
      { en: "Turkish (person)", ru: "турок" },
      { en: "Chinese (person)", ru: "китаец" },
      { en: "Japanese (person)", ru: "японец" },
      { en: "Korean (person)", ru: "кореец" },
      { en: "Indian", ru: "индиец" },
      { en: "Vietnamese (person)", ru: "вьетнамец" },
      { en: "Thai (person)", ru: "таец" },
      { en: "Brazilian", ru: "бразилец" },
      { en: "Mexican", ru: "мексиканец" },
      { en: "Canadian", ru: "канадец" },
      { en: "Australian", ru: "австралиец" },
      { en: "Egyptian", ru: "египтянин" },
      { en: "African", ru: "африканец" },
      { en: "European", ru: "европеец" },
      { en: "Asian", ru: "азиат" },
      { en: "English (language)", ru: "английский язык" },
      { en: "Russian (language)", ru: "русский язык" },
      { en: "Spanish (language)", ru: "испанский язык" },
      { en: "French (language)", ru: "французский язык" },
      { en: "German (language)", ru: "немецкий язык" },
      { en: "Italian (language)", ru: "итальянский язык" },
      { en: "Portuguese (language)", ru: "португальский язык" },
      { en: "Chinese (language)", ru: "китайский язык" },
      { en: "Mandarin", ru: "мандаринский китайский" },
      { en: "Japanese (language)", ru: "японский язык" },
      { en: "Korean (language)", ru: "корейский язык" },
      { en: "Arabic", ru: "арабский язык" },
      { en: "Turkish (language)", ru: "турецкий язык" },
      { en: "Hindi", ru: "хинди" },
      { en: "mother tongue", ru: "родной язык" },
      { en: "native speaker", ru: "носитель языка" },
      { en: "accent", ru: "акцент" },
      { en: "fluent", ru: "свободно говорящий" },
    ],
    "хобби": [
      { en: "hobby", ru: "хобби" },
      { en: "free time", ru: "свободное время" },
      { en: "sport", ru: "спорт" },
      { en: "football", ru: "футбол" },
      { en: "soccer", ru: "футбол (амер.)" },
      { en: "basketball", ru: "баскетбол" },
      { en: "volleyball", ru: "волейбол" },
      { en: "tennis", ru: "теннис" },
      { en: "table tennis", ru: "настольный теннис" },
      { en: "badminton", ru: "бадминтон" },
      { en: "swimming", ru: "плавание" },
      { en: "running", ru: "бег" },
      { en: "jogging", ru: "пробежка" },
      { en: "cycling", ru: "велоспорт" },
      { en: "yoga", ru: "йога" },
      { en: "pilates", ru: "пилатес" },
      { en: "gym", ru: "спортзал" },
      { en: "fitness", ru: "фитнес" },
      { en: "boxing", ru: "бокс" },
      { en: "karate", ru: "каратэ" },
      { en: "golf", ru: "гольф" },
      { en: "hiking", ru: "пешие походы" },
      { en: "climbing", ru: "скалолазание" },
      { en: "skiing", ru: "лыжи" },
      { en: "snowboarding", ru: "сноуборд" },
      { en: "skateboarding", ru: "скейтбординг" },
      { en: "surfing", ru: "сёрфинг" },
      { en: "horse riding", ru: "верховая езда" },
      { en: "dancing", ru: "танцы" },
      { en: "painting", ru: "рисование (краски)" },
      { en: "drawing", ru: "рисование (карандаш)" },
      { en: "photography", ru: "фотография" },
      { en: "knitting", ru: "вязание" },
      { en: "sewing", ru: "шитьё" },
      { en: "cooking", ru: "готовка" },
      { en: "baking", ru: "выпечка" },
      { en: "writing", ru: "писательство" },
      { en: "poetry", ru: "поэзия" },
      { en: "crafts", ru: "рукоделие" },
      { en: "gardening", ru: "садоводство" },
      { en: "music", ru: "музыка" },
      { en: "guitar", ru: "гитара" },
      { en: "piano", ru: "пианино" },
      { en: "violin", ru: "скрипка" },
      { en: "drums", ru: "барабаны" },
      { en: "flute", ru: "флейта" },
      { en: "singing", ru: "пение" },
      { en: "concert", ru: "концерт" },
      { en: "band", ru: "группа" },
      { en: "song", ru: "песня" },
      { en: "album", ru: "альбом" },
      { en: "playlist", ru: "плейлист" },
      { en: "reading", ru: "чтение" },
      { en: "book", ru: "книга" },
      { en: "novel", ru: "роман" },
      { en: "magazine", ru: "журнал" },
      { en: "newspaper", ru: "газета" },
      { en: "watching films", ru: "смотреть фильмы" },
      { en: "film", ru: "фильм" },
      { en: "movie", ru: "фильм (амер.)" },
      { en: "series", ru: "сериал" },
      { en: "TV show", ru: "телешоу" },
      { en: "listening to music", ru: "слушать музыку" },
      { en: "podcast", ru: "подкаст" },
      { en: "gaming", ru: "компьютерные игры" },
      { en: "video games", ru: "видеоигры" },
      { en: "board games", ru: "настольные игры" },
      { en: "puzzles", ru: "пазлы" },
      { en: "chess", ru: "шахматы" },
      { en: "travel", ru: "путешествие" },
      { en: "trip", ru: "поездка" },
      { en: "holiday", ru: "отпуск" },
      { en: "vacation", ru: "отпуск (амер.)" },
      { en: "journey", ru: "поездка / путь" },
      { en: "visit", ru: "посещать" },
      { en: "sightseeing", ru: "осмотр достопримечательностей" },
      { en: "beach", ru: "пляж" },
      { en: "mountains", ru: "горы" },
      { en: "camping", ru: "кемпинг" },
      { en: "backpacking", ru: "поход с рюкзаком" },
      { en: "party", ru: "вечеринка" },
      { en: "cinema", ru: "кино" },
      { en: "theatre", ru: "театр" },
      { en: "museum", ru: "музей" },
      { en: "restaurant", ru: "ресторан" },
      { en: "cafe", ru: "кафе" },
      { en: "club", ru: "клуб" },
      { en: "shopping", ru: "шопинг" },
      { en: "date", ru: "свидание" },
      { en: "play", ru: "играть" },
      { en: "go", ru: "ходить / идти" },
      { en: "watch", ru: "смотреть" },
      { en: "read", ru: "читать" },
      { en: "listen", ru: "слушать" },
      { en: "collect", ru: "собирать" },
      { en: "enjoy", ru: "наслаждаться" },
      { en: "love", ru: "любить" },
      { en: "like", ru: "нравиться" },
      { en: "prefer", ru: "предпочитать" },
      { en: "hate", ru: "ненавидеть" },
      { en: "hang out", ru: "тусоваться" },
      { en: "chill", ru: "отдыхать" },
    ],
    "транспорт": [
      { en: "transport", ru: "транспорт" },
      { en: "car", ru: "машина" },
      { en: "bus", ru: "автобус" },
      { en: "train", ru: "поезд" },
      { en: "plane", ru: "самолёт" },
      { en: "ship", ru: "корабль" },
      { en: "boat", ru: "лодка" },
      { en: "ferry", ru: "паром" },
      { en: "taxi", ru: "такси" },
      { en: "bike", ru: "велосипед" },
      { en: "bicycle", ru: "велосипед" },
      { en: "motorbike", ru: "мотоцикл" },
      { en: "tram", ru: "трамвай" },
      { en: "underground", ru: "метро" },
      { en: "subway", ru: "метро (амер.)" },
      { en: "metro", ru: "метро" },
      { en: "helicopter", ru: "вертолёт" },
      { en: "truck", ru: "грузовик" },
      { en: "van", ru: "фургон" },
      { en: "scooter", ru: "скутер" },
      { en: "station", ru: "станция" },
      { en: "train station", ru: "железнодорожный вокзал" },
      { en: "bus stop", ru: "автобусная остановка" },
      { en: "airport", ru: "аэропорт" },
      { en: "port", ru: "порт" },
      { en: "platform", ru: "платформа" },
      { en: "ticket", ru: "билет" },
      { en: "ticket office", ru: "билетная касса" },
      { en: "seat", ru: "место" },
      { en: "passenger", ru: "пассажир" },
      { en: "driver", ru: "водитель" },
      { en: "luggage", ru: "багаж" },
      { en: "suitcase", ru: "чемодан" },
      { en: "go by car", ru: "ехать на машине" },
      { en: "take a bus", ru: "ехать на автобусе" },
      { en: "take a taxi", ru: "взять такси" },
      { en: "catch a train", ru: "успеть на поезд" },
      { en: "miss the train", ru: "опоздать на поезд" },
      { en: "get on", ru: "садиться (в транспорт)" },
      { en: "get off", ru: "выходить (из транспорта)" },
      { en: "drive", ru: "водить" },
      { en: "ride", ru: "кататься" },
      { en: "park", ru: "парковаться" },
      { en: "arrive", ru: "прибывать" },
      { en: "leave", ru: "отправляться" },
      { en: "depart", ru: "отправляться" },
      { en: "city", ru: "город" },
      { en: "town", ru: "городок" },
      { en: "street", ru: "улица" },
      { en: "road", ru: "дорога" },
      { en: "avenue", ru: "проспект" },
      { en: "square", ru: "площадь" },
      { en: "museum", ru: "музей" },
      { en: "theatre", ru: "театр" },
      { en: "cinema", ru: "кинотеатр" },
      { en: "library", ru: "библиотека" },
      { en: "bank", ru: "банк" },
      { en: "hospital", ru: "больница" },
      { en: "clinic", ru: "поликлиника" },
      { en: "post office", ru: "почта" },
      { en: "school", ru: "школа" },
      { en: "university", ru: "университет" },
      { en: "church", ru: "церковь" },
      { en: "shop", ru: "магазин" },
      { en: "supermarket", ru: "супермаркет" },
      { en: "market", ru: "рынок" },
      { en: "restaurant", ru: "ресторан" },
      { en: "cafe", ru: "кафе" },
      { en: "bar", ru: "бар" },
      { en: "hotel", ru: "гостиница" },
      { en: "pharmacy", ru: "аптека" },
      { en: "police station", ru: "полицейский участок" },
      { en: "fire station", ru: "пожарная часть" },
      { en: "gym", ru: "спортзал" },
      { en: "swimming pool", ru: "бассейн" },
      { en: "stadium", ru: "стадион" },
      { en: "zoo", ru: "зоопарк" },
      { en: "bridge", ru: "мост" },
      { en: "tunnel", ru: "тоннель" },
      { en: "fountain", ru: "фонтан" },
      { en: "statue", ru: "статуя" },
      { en: "monument", ru: "памятник" },
      { en: "crossing", ru: "пешеходный переход" },
      { en: "zebra crossing", ru: "зебра" },
      { en: "traffic lights", ru: "светофор" },
      { en: "roundabout", ru: "кольцевая развязка" },
      { en: "corner", ru: "угол" },
      { en: "junction", ru: "перекрёсток" },
      { en: "pavement", ru: "тротуар" },
      { en: "sidewalk", ru: "тротуар (амер.)" },
      { en: "go", ru: "идти" },
      { en: "come", ru: "приходить" },
      { en: "return", ru: "возвращаться" },
      { en: "walk", ru: "ходить пешком" },
      { en: "run", ru: "бежать" },
      { en: "travel", ru: "путешествовать" },
      { en: "stop", ru: "останавливаться" },
      { en: "cross", ru: "переходить" },
      { en: "turn", ru: "поворачивать" },
      { en: "turn left", ru: "повернуть налево" },
      { en: "turn right", ru: "повернуть направо" },
      { en: "follow", ru: "следовать" },
      { en: "get lost", ru: "заблудиться" },
      { en: "village", ru: "деревня" },
      { en: "country", ru: "страна" },
      { en: "capital", ru: "столица" },
      { en: "store", ru: "магазин (US)" },
      { en: "map", ru: "карта" },
    ],
    "природа": [
      { en: "weather", ru: "погода" },
      { en: "sunny", ru: "солнечный" },
      { en: "cloudy", ru: "облачный" },
      { en: "rainy", ru: "дождливый" },
      { en: "windy", ru: "ветреный" },
      { en: "snowy", ru: "снежный" },
      { en: "foggy", ru: "туманный" },
      { en: "stormy", ru: "штормовой" },
      { en: "hot", ru: "жаркий" },
      { en: "warm", ru: "тёплый" },
      { en: "cool", ru: "прохладный" },
      { en: "cold", ru: "холодный" },
      { en: "freezing", ru: "морозный" },
      { en: "humid", ru: "влажный" },
      { en: "dry", ru: "сухой" },
      { en: "clear", ru: "ясный" },
      { en: "mild", ru: "мягкий (о погоде)" },
      { en: "sun", ru: "солнце" },
      { en: "rain", ru: "дождь" },
      { en: "snow", ru: "снег" },
      { en: "wind", ru: "ветер" },
      { en: "cloud", ru: "облако" },
      { en: "storm", ru: "гроза / буря" },
      { en: "thunder", ru: "гром" },
      { en: "lightning", ru: "молния" },
      { en: "fog", ru: "туман" },
      { en: "mist", ru: "дымка" },
      { en: "rainbow", ru: "радуга" },
      { en: "ice", ru: "лёд" },
      { en: "hail", ru: "град" },
      { en: "shower", ru: "ливень (короткий)" },
      { en: "breeze", ru: "лёгкий ветер" },
      { en: "sunshine", ru: "солнечный свет" },
      { en: "drizzle", ru: "морось" },
      { en: "flood", ru: "наводнение" },
      { en: "heatwave", ru: "жара / волна жары" },
      { en: "temperature", ru: "температура" },
      { en: "degree", ru: "градус" },
      { en: "plus", ru: "плюс" },
      { en: "minus", ru: "минус" },
      { en: "zero", ru: "ноль" },
      { en: "freezing point", ru: "точка замерзания" },
      { en: "season", ru: "сезон" },
      { en: "spring", ru: "весна" },
      { en: "summer", ru: "лето" },
      { en: "autumn", ru: "осень" },
      { en: "fall", ru: "осень (амер.)" },
      { en: "winter", ru: "зима" },
      { en: "nature", ru: "природа" },
      { en: "forest", ru: "лес" },
      { en: "wood", ru: "лес (небольшой)" },
      { en: "tree", ru: "дерево" },
      { en: "flower", ru: "цветок" },
      { en: "grass", ru: "трава" },
      { en: "leaf", ru: "лист" },
      { en: "leaves", ru: "листья" },
      { en: "plant", ru: "растение" },
      { en: "bush", ru: "куст" },
      { en: "field", ru: "поле" },
      { en: "meadow", ru: "луг" },
      { en: "garden", ru: "сад" },
      { en: "park", ru: "парк" },
      { en: "river", ru: "река" },
      { en: "lake", ru: "озеро" },
      { en: "sea", ru: "море" },
      { en: "ocean", ru: "океан" },
      { en: "beach", ru: "пляж" },
      { en: "sand", ru: "песок" },
      { en: "island", ru: "остров" },
      { en: "waterfall", ru: "водопад" },
      { en: "stream", ru: "ручей" },
      { en: "mountain", ru: "гора" },
      { en: "hill", ru: "холм" },
      { en: "valley", ru: "долина" },
      { en: "desert", ru: "пустыня" },
      { en: "cliff", ru: "скала" },
      { en: "volcano", ru: "вулкан" },
      { en: "rock", ru: "камень" },
      { en: "stone", ru: "камень" },
      { en: "cave", ru: "пещера" },
      { en: "sky", ru: "небо" },
      { en: "star", ru: "звезда" },
      { en: "moon", ru: "луна" },
      { en: "planet", ru: "планета" },
      { en: "earth", ru: "земля" },
      { en: "animal", ru: "животное" },
      { en: "bird", ru: "птица" },
      { en: "dog", ru: "собака" },
      { en: "cat", ru: "кошка" },
      { en: "horse", ru: "лошадь" },
      { en: "cow", ru: "корова" },
      { en: "sheep", ru: "овца" },
      { en: "pig", ru: "свинья" },
      { en: "fish", ru: "рыба" },
      { en: "butterfly", ru: "бабочка" },
      { en: "bee", ru: "пчела" },
      { en: "insect", ru: "насекомое" },
      { en: "wildlife", ru: "дикая природа" },
      { en: "environment", ru: "окружающая среда" },
      { en: "climate", ru: "климат" },
      { en: "boiling", ru: "очень жарко" },
      { en: "wet", ru: "мокрый" },
    ],
    "глаголы": [
      { en: "be", ru: "быть" },
      { en: "have", ru: "иметь" },
      { en: "do", ru: "делать" },
      { en: "go", ru: "идти, ехать" },
      { en: "come", ru: "приходить" },
      { en: "get", ru: "получать, добираться" },
      { en: "make", ru: "делать (создавать)" },
      { en: "take", ru: "брать" },
      { en: "give", ru: "давать" },
      { en: "put", ru: "класть" },
      { en: "say", ru: "говорить, сказать" },
      { en: "tell", ru: "рассказывать" },
      { en: "ask", ru: "спрашивать" },
      { en: "answer", ru: "отвечать" },
      { en: "speak", ru: "говорить" },
      { en: "talk", ru: "разговаривать" },
      { en: "listen", ru: "слушать" },
      { en: "hear", ru: "слышать" },
      { en: "see", ru: "видеть" },
      { en: "look", ru: "смотреть" },
      { en: "watch", ru: "смотреть (наблюдать)" },
      { en: "read", ru: "читать" },
      { en: "write", ru: "писать" },
      { en: "eat", ru: "есть" },
      { en: "drink", ru: "пить" },
      { en: "sleep", ru: "спать" },
      { en: "wake up", ru: "просыпаться" },
      { en: "get up", ru: "вставать" },
      { en: "work", ru: "работать" },
      { en: "study", ru: "учиться" },
      { en: "learn", ru: "учить" },
      { en: "teach", ru: "учить (преподавать)" },
      { en: "know", ru: "знать" },
      { en: "think", ru: "думать" },
      { en: "understand", ru: "понимать" },
      { en: "remember", ru: "помнить" },
      { en: "forget", ru: "забывать" },
      { en: "like", ru: "нравиться" },
      { en: "love", ru: "любить" },
      { en: "hate", ru: "ненавидеть" },
      { en: "want", ru: "хотеть" },
      { en: "need", ru: "нуждаться" },
      { en: "live", ru: "жить" },
      { en: "play", ru: "играть" },
      { en: "sing", ru: "петь" },
      { en: "dance", ru: "танцевать" },
      { en: "run", ru: "бежать" },
      { en: "walk", ru: "идти пешком" },
      { en: "buy", ru: "покупать" },
      { en: "help", ru: "помогать" },
    ],
    "прилагательные": [
      { en: "big", ru: "большой" },
      { en: "small", ru: "маленький" },
      { en: "little", ru: "маленький, небольшой" },
      { en: "tall", ru: "высокий" },
      { en: "short", ru: "короткий, низкий" },
      { en: "long", ru: "длинный" },
      { en: "high", ru: "высокий" },
      { en: "low", ru: "низкий" },
      { en: "good", ru: "хороший" },
      { en: "bad", ru: "плохой" },
      { en: "nice", ru: "приятный" },
      { en: "beautiful", ru: "красивый" },
      { en: "pretty", ru: "симпатичный" },
      { en: "ugly", ru: "некрасивый" },
      { en: "new", ru: "новый" },
      { en: "old", ru: "старый" },
      { en: "young", ru: "молодой" },
      { en: "happy", ru: "счастливый" },
      { en: "sad", ru: "грустный" },
      { en: "angry", ru: "злой" },
      { en: "tired", ru: "усталый" },
      { en: "hungry", ru: "голодный" },
      { en: "thirsty", ru: "испытывающий жажду" },
      { en: "sick", ru: "больной" },
      { en: "healthy", ru: "здоровый" },
      { en: "strong", ru: "сильный" },
      { en: "weak", ru: "слабый" },
      { en: "fast", ru: "быстрый" },
      { en: "slow", ru: "медленный" },
      { en: "easy", ru: "лёгкий, простой" },
      { en: "hard", ru: "трудный, твёрдый" },
      { en: "difficult", ru: "сложный" },
      { en: "cheap", ru: "дешёвый" },
      { en: "expensive", ru: "дорогой" },
      { en: "free", ru: "бесплатный, свободный" },
      { en: "busy", ru: "занятой" },
      { en: "lazy", ru: "ленивый" },
      { en: "clever", ru: "умный" },
      { en: "smart", ru: "умный, элегантный" },
      { en: "stupid", ru: "глупый" },
      { en: "funny", ru: "смешной" },
      { en: "boring", ru: "скучный" },
      { en: "interesting", ru: "интересный" },
      { en: "important", ru: "важный" },
      { en: "ready", ru: "готовый" },
      { en: "empty", ru: "пустой" },
      { en: "full", ru: "полный" },
      { en: "open", ru: "открытый" },
      { en: "closed", ru: "закрытый" },
      { en: "right", ru: "правильный, правый" },
      { en: "wrong", ru: "неправильный" },
    ],
    "маркетинг": [
      { en: "brand", ru: "бренд" },
      { en: "company", ru: "компания" },
      { en: "product", ru: "продукт, товар" },
      { en: "service", ru: "услуга" },
      { en: "customer", ru: "клиент, покупатель" },
      { en: "market", ru: "рынок" },
      { en: "price", ru: "цена" },
      { en: "sale", ru: "продажа" },
      { en: "sales", ru: "продажи, объём продаж" },
      { en: "discount", ru: "скидка" },
      { en: "ad", ru: "реклама (одно объявление)" },
      { en: "advertising", ru: "реклама (сфера, деятельность)" },
      { en: "advertise", ru: "рекламировать" },
      { en: "promote", ru: "продвигать" },
      { en: "buy", ru: "покупать" },
      { en: "sell", ru: "продавать" },
      { en: "offer", ru: "предложение" },
      { en: "free", ru: "бесплатный" },
      { en: "cheap", ru: "дешёвый" },
      { en: "expensive", ru: "дорогой" },
      { en: "quality", ru: "качество" },
      { en: "popular", ru: "популярный" },
      { en: "logo", ru: "логотип" },
      { en: "slogan", ru: "слоган" },
      { en: "packaging", ru: "упаковка" },
      { en: "website", ru: "сайт" },
      { en: "online store", ru: "интернет-магазин" },
      { en: "social media", ru: "соцсети" },
      { en: "post", ru: "пост, публикация" },
      { en: "photo", ru: "фото" },
      { en: "video", ru: "видео" },
      { en: "email", ru: "письмо, имейл" },
      { en: "team", ru: "команда" },
      { en: "meeting", ru: "встреча, созвон" },
      { en: "report", ru: "отчёт" },
    ],
  },
};

// --- Уровень C1 ---
const SEED_SHARED_LIBRARY_C1 = {
  difficulty: "C1",
  topics: {
    "глобпроблемы": [
      { en: "climate change", ru: "изменение климата" },
      { en: "global warming", ru: "глобальное потепление" },
      { en: "greenhouse gas emissions", ru: "выбросы парниковых газов" },
      { en: "carbon footprint", ru: "углеродный след" },
      { en: "deforestation", ru: "вырубка лесов" },
      { en: "biodiversity loss", ru: "утрата биоразнообразия" },
      { en: "renewable energy", ru: "возобновляемая энергия" },
      { en: "fossil fuels", ru: "ископаемое топливо" },
      { en: "sustainability", ru: "устойчивое развитие" },
      { en: "overpopulation", ru: "перенаселение" },
      { en: "food insecurity", ru: "продовольственная нестабильность" },
      { en: "famine", ru: "голод (массовый)" },
      { en: "drought", ru: "засуха" },
      { en: "natural disaster", ru: "стихийное бедствие" },
      { en: "rising sea levels", ru: "повышение уровня моря" },
      { en: "pollution", ru: "загрязнение" },
      { en: "plastic waste", ru: "пластиковые отходы" },
      { en: "ozone depletion", ru: "разрушение озонового слоя" },
      { en: "endangered species", ru: "вымирающие виды" },
      { en: "extinction", ru: "вымирание" },
      { en: "scarcity of resources", ru: "нехватка ресурсов" },
      { en: "water shortage", ru: "дефицит воды" },
      { en: "migration crisis", ru: "миграционный кризис" },
      { en: "refugee", ru: "беженец" },
      { en: "displacement", ru: "вынужденное переселение" },
      { en: "poverty", ru: "бедность" },
      { en: "inequality", ru: "неравенство" },
      { en: "wealth gap", ru: "разрыв в благосостоянии" },
      { en: "humanitarian aid", ru: "гуманитарная помощь" },
      { en: "pandemic", ru: "пандемия" },
      { en: "public health", ru: "общественное здравоохранение" },
      { en: "human rights", ru: "права человека" },
      { en: "exploitation", ru: "эксплуатация" },
      { en: "sweatshop", ru: "потогонное производство" },
      { en: "child labour", ru: "детский труд" },
      { en: "arms race", ru: "гонка вооружений" },
      { en: "nuclear proliferation", ru: "распространение ядерного оружия" },
      { en: "terrorism", ru: "терроризм" },
      { en: "geopolitical tension", ru: "геополитическая напряженность" },
      { en: "sanctions", ru: "санкции" },
      { en: "trade war", ru: "торговая война" },
      { en: "economic collapse", ru: "экономический крах" },
      { en: "recession", ru: "рецессия" },
      { en: "unemployment", ru: "безработица" },
      { en: "urbanisation", ru: "урбанизация" },
      { en: "slum", ru: "трущобы" },
      { en: "overconsumption", ru: "избыточное потребление" },
      { en: "carbon neutrality", ru: "углеродная нейтральность" },
      { en: "mitigation", ru: "смягчение последствий" },
      { en: "adaptation", ru: "адаптация" },
      { en: "sustainable development", ru: "устойчивое развитие" },
      { en: "the developing world", ru: "развивающиеся страны" },
      { en: "foreign aid", ru: "иностранная помощь" },
      { en: "debt relief", ru: "списание долга" },
      { en: "corruption", ru: "коррупция" },
      { en: "governance", ru: "государственное управление" },
      { en: "activism", ru: "активизм" },
      { en: "grassroots movement", ru: "низовое движение" },
      { en: "to tackle a problem", ru: "решать проблему" },
      { en: "to raise awareness", ru: "повышать осведомленность" },
      { en: "to address an issue", ru: "заниматься проблемой" },
      { en: "pressing", ru: "насущный, неотложный" },
      { en: "to exacerbate", ru: "усугублять" },
      { en: "to alleviate", ru: "облегчать, смягчать" },
      { en: "far-reaching consequences", ru: "далеко идущие последствия" },
    ],
    "философия": [
      { en: "ethics", ru: "этика" },
      { en: "morality", ru: "нравственность" },
      { en: "moral dilemma", ru: "моральная дилемма" },
      { en: "virtue", ru: "добродетель" },
      { en: "vice", ru: "порок" },
      { en: "integrity", ru: "честность, цельность" },
      { en: "conscience", ru: "совесть" },
      { en: "free will", ru: "свобода воли" },
      { en: "determinism", ru: "детерминизм" },
      { en: "existence", ru: "существование" },
      { en: "consciousness", ru: "сознание" },
      { en: "perception", ru: "восприятие" },
      { en: "reality", ru: "реальность" },
      { en: "truth", ru: "истина" },
      { en: "knowledge", ru: "знание" },
      { en: "belief", ru: "убеждение" },
      { en: "reasoning", ru: "рассуждение" },
      { en: "logic", ru: "логика" },
      { en: "argument", ru: "довод, аргумент" },
      { en: "premise", ru: "предпосылка, посылка" },
      { en: "conclusion", ru: "вывод" },
      { en: "fallacy", ru: "логическая ошибка" },
      { en: "contradiction", ru: "противоречие" },
      { en: "paradox", ru: "парадокс" },
      { en: "assumption", ru: "допущение" },
      { en: "justification", ru: "обоснование" },
      { en: "to justify", ru: "обосновывать" },
      { en: "rational", ru: "рациональный" },
      { en: "subjective", ru: "субъективный" },
      { en: "objective", ru: "объективный" },
      { en: "relativism", ru: "релятивизм" },
      { en: "absolute", ru: "абсолютный" },
      { en: "principle", ru: "принцип" },
      { en: "value", ru: "ценность" },
      { en: "norm", ru: "норма" },
      { en: "duty", ru: "долг" },
      { en: "obligation", ru: "обязательство" },
      { en: "righteous", ru: "праведный" },
      { en: "just", ru: "справедливый" },
      { en: "fairness", ru: "справедливость" },
      { en: "equity", ru: "равенство, беспристрастность" },
      { en: "the greater good", ru: "всеобщее благо" },
      { en: "utilitarianism", ru: "утилитаризм" },
      { en: "consequence", ru: "последствие" },
      { en: "intent", ru: "намерение" },
      { en: "accountability", ru: "ответственность" },
      { en: "blame", ru: "вина" },
      { en: "guilt", ru: "чувство вины" },
      { en: "empathy", ru: "эмпатия" },
      { en: "compassion", ru: "сострадание" },
      { en: "altruism", ru: "альтруизм" },
      { en: "self-interest", ru: "личный интерес" },
      { en: "hypocrisy", ru: "лицемерие" },
      { en: "dogma", ru: "догма" },
      { en: "doctrine", ru: "доктрина" },
      { en: "ideology", ru: "идеология" },
      { en: "to ponder", ru: "размышлять" },
      { en: "to contemplate", ru: "созерцать, обдумывать" },
      { en: "profound", ru: "глубокий" },
      { en: "inherent", ru: "присущий, врожденный" },
      { en: "to uphold a value", ru: "придерживаться ценности" },
      { en: "to question", ru: "подвергать сомнению" },
      { en: "worldview", ru: "мировоззрение" },
      { en: "the human condition", ru: "человеческая природа" },
    ],
    "право": [
      { en: "law", ru: "закон" },
      { en: "legislation", ru: "законодательство" },
      { en: "statute", ru: "нормативный акт" },
      { en: "regulation", ru: "постановление" },
      { en: "to enact a law", ru: "принимать закон" },
      { en: "to enforce", ru: "обеспечивать соблюдение" },
      { en: "jurisdiction", ru: "юрисдикция" },
      { en: "court", ru: "суд" },
      { en: "trial", ru: "судебный процесс" },
      { en: "hearing", ru: "слушание" },
      { en: "judge", ru: "судья" },
      { en: "jury", ru: "присяжные" },
      { en: "verdict", ru: "вердикт" },
      { en: "sentence", ru: "приговор" },
      { en: "to convict", ru: "осудить (признать виновным)" },
      { en: "to acquit", ru: "оправдать" },
      { en: "defendant", ru: "обвиняемый, ответчик" },
      { en: "plaintiff", ru: "истец" },
      { en: "prosecution", ru: "обвинение" },
      { en: "defence", ru: "защита" },
      { en: "attorney", ru: "адвокат, юрист" },
      { en: "testimony", ru: "показания" },
      { en: "evidence", ru: "доказательства" },
      { en: "witness", ru: "свидетель" },
      { en: "to plead guilty", ru: "признать вину" },
      { en: "alibi", ru: "алиби" },
      { en: "crime", ru: "преступление" },
      { en: "offence", ru: "правонарушение" },
      { en: "felony", ru: "тяжкое преступление" },
      { en: "misdemeanour", ru: "мелкое правонарушение" },
      { en: "fraud", ru: "мошенничество" },
      { en: "embezzlement", ru: "растрата" },
      { en: "bribery", ru: "взяточничество" },
      { en: "theft", ru: "кража" },
      { en: "burglary", ru: "кража со взломом" },
      { en: "assault", ru: "нападение" },
      { en: "homicide", ru: "убийство" },
      { en: "manslaughter", ru: "непредумышленное убийство" },
      { en: "perpetrator", ru: "преступник" },
      { en: "suspect", ru: "подозреваемый" },
      { en: "to arrest", ru: "арестовать" },
      { en: "to detain", ru: "задерживать" },
      { en: "custody", ru: "заключение под стражу" },
      { en: "bail", ru: "залог" },
      { en: "imprisonment", ru: "тюремное заключение" },
      { en: "parole", ru: "условно-досрочное освобождение" },
      { en: "probation", ru: "условный срок" },
      { en: "fine", ru: "штраф" },
      { en: "liability", ru: "юридическая ответственность" },
      { en: "negligence", ru: "халатность" },
      { en: "breach of contract", ru: "нарушение договора" },
      { en: "lawsuit", ru: "судебный иск" },
      { en: "to sue", ru: "подавать в суд" },
      { en: "to appeal", ru: "обжаловать" },
      { en: "settlement", ru: "урегулирование" },
      { en: "the rule of law", ru: "верховенство права" },
      { en: "due process", ru: "надлежащая правовая процедура" },
      { en: "presumption of innocence", ru: "презумпция невиновности" },
      { en: "to uphold the law", ru: "соблюдать закон" },
      { en: "to break the law", ru: "нарушать закон" },
      { en: "deterrent", ru: "сдерживающий фактор" },
      { en: "rehabilitation", ru: "реабилитация" },
    ],
    "наука": [
      { en: "research", ru: "исследование" },
      { en: "study", ru: "исследование (научная работа)" },
      { en: "hypothesis", ru: "гипотеза" },
      { en: "theory", ru: "теория" },
      { en: "experiment", ru: "эксперимент" },
      { en: "methodology", ru: "методология" },
      { en: "data", ru: "данные" },
      { en: "sample", ru: "выборка" },
      { en: "sample size", ru: "размер выборки" },
      { en: "variable", ru: "переменная" },
      { en: "control group", ru: "контрольная группа" },
      { en: "to conduct research", ru: "проводить исследование" },
      { en: "to carry out a study", ru: "проводить исследование" },
      { en: "findings", ru: "результаты, выводы" },
      { en: "results", ru: "результаты" },
      { en: "outcome", ru: "итог, исход" },
      { en: "evidence", ru: "доказательства" },
      { en: "to analyse", ru: "анализировать" },
      { en: "analysis", ru: "анализ" },
      { en: "to measure", ru: "измерять" },
      { en: "measurement", ru: "измерение" },
      { en: "to observe", ru: "наблюдать" },
      { en: "observation", ru: "наблюдение" },
      { en: "to test", ru: "проверять, тестировать" },
      { en: "trial", ru: "испытание" },
      { en: "clinical trial", ru: "клиническое испытание" },
      { en: "peer review", ru: "рецензирование" },
      { en: "to publish", ru: "публиковать" },
      { en: "journal", ru: "научный журнал" },
      { en: "paper", ru: "научная статья" },
      { en: "abstract", ru: "аннотация" },
      { en: "literature review", ru: "обзор литературы" },
      { en: "citation", ru: "цитирование, ссылка" },
      { en: "to replicate", ru: "воспроизводить" },
      { en: "reproducibility", ru: "воспроизводимость" },
      { en: "correlation", ru: "корреляция" },
      { en: "causation", ru: "причинно-следственная связь" },
      { en: "significant", ru: "значимый" },
      { en: "statistically significant", ru: "статистически значимый" },
      { en: "bias", ru: "систематическая ошибка, предвзятость" },
      { en: "margin of error", ru: "погрешность" },
      { en: "to validate", ru: "подтверждать, проверять" },
      { en: "to verify", ru: "проверять" },
      { en: "to confirm", ru: "подтверждать" },
      { en: "to refute", ru: "опровергать" },
      { en: "to disprove", ru: "опровергать" },
      { en: "empirical", ru: "эмпирический" },
      { en: "quantitative", ru: "количественный" },
      { en: "qualitative", ru: "качественный" },
      { en: "to estimate", ru: "оценивать" },
      { en: "estimate", ru: "оценка" },
      { en: "breakthrough", ru: "прорыв" },
      { en: "discovery", ru: "открытие" },
      { en: "innovation", ru: "инновация" },
      { en: "to invent", ru: "изобретать" },
      { en: "patent", ru: "патент" },
      { en: "laboratory", ru: "лаборатория" },
      { en: "specimen", ru: "образец" },
      { en: "to simulate", ru: "моделировать" },
      { en: "model", ru: "модель" },
      { en: "framework", ru: "концептуальная схема" },
      { en: "assumption", ru: "допущение" },
      { en: "limitation", ru: "ограничение" },
      { en: "scope", ru: "охват, рамки" },
      { en: "to draw a conclusion", ru: "делать вывод" },
      { en: "to interpret", ru: "интерпретировать" },
      { en: "underlying", ru: "лежащий в основе" },
      { en: "robust", ru: "надежный, устойчивый" },
      { en: "preliminary", ru: "предварительный" },
    ],
    "академический": [
      { en: "academia", ru: "академическая среда" },
      { en: "scholar", ru: "ученый" },
      { en: "scholarship", ru: "научная деятельность, стипендия" },
      { en: "discipline", ru: "дисциплина, область" },
      { en: "field of study", ru: "область исследования" },
      { en: "thesis", ru: "тезис, диссертация" },
      { en: "dissertation", ru: "диссертация" },
      { en: "argument", ru: "аргумент, тезис" },
      { en: "claim", ru: "утверждение" },
      { en: "to argue", ru: "утверждать, доказывать" },
      { en: "to assert", ru: "утверждать" },
      { en: "to contend", ru: "утверждать" },
      { en: "to maintain", ru: "придерживаться мнения" },
      { en: "to acknowledge", ru: "признавать" },
      { en: "to address", ru: "рассматривать (вопрос)" },
      { en: "to examine", ru: "исследовать" },
      { en: "to explore", ru: "изучать" },
      { en: "to investigate", ru: "исследовать" },
      { en: "to demonstrate", ru: "демонстрировать" },
      { en: "to illustrate", ru: "иллюстрировать" },
      { en: "to highlight", ru: "подчеркивать" },
      { en: "to emphasise", ru: "акцентировать" },
      { en: "to outline", ru: "обрисовать" },
      { en: "to summarise", ru: "резюмировать" },
      { en: "to evaluate", ru: "оценивать" },
      { en: "to assess", ru: "оценивать" },
      { en: "to critique", ru: "критически разбирать" },
      { en: "critical", ru: "критический" },
      { en: "coherent", ru: "связный, логичный" },
      { en: "coherence", ru: "связность" },
      { en: "to substantiate", ru: "обосновывать" },
      { en: "to elaborate", ru: "развивать мысль" },
      { en: "notion", ru: "понятие" },
      { en: "concept", ru: "концепция" },
      { en: "perspective", ru: "точка зрения" },
      { en: "approach", ru: "подход" },
      { en: "framework", ru: "структура, рамки" },
      { en: "paradigm", ru: "парадигма" },
      { en: "to conceptualise", ru: "осмыслять" },
      { en: "nuance", ru: "нюанс" },
      { en: "implication", ru: "следствие, подтекст" },
      { en: "to imply", ru: "подразумевать" },
      { en: "to infer", ru: "делать вывод" },
      { en: "inference", ru: "умозаключение" },
      { en: "rationale", ru: "обоснование" },
      { en: "premise", ru: "посылка" },
      { en: "to presuppose", ru: "предполагать" },
      { en: "explicit", ru: "явный" },
      { en: "implicit", ru: "неявный" },
      { en: "ambiguous", ru: "неоднозначный" },
      { en: "to clarify", ru: "прояснять" },
      { en: "to define", ru: "определять" },
      { en: "definition", ru: "определение" },
      { en: "respectively", ru: "соответственно" },
      { en: "namely", ru: "а именно" },
      { en: "thereby", ru: "тем самым" },
      { en: "hence", ru: "следовательно" },
      { en: "notwithstanding", ru: "несмотря на" },
      { en: "albeit", ru: "хотя и" },
      { en: "to a certain extent", ru: "до определенной степени" },
      { en: "in this regard", ru: "в этом отношении" },
      { en: "with respect to", ru: "в отношении" },
      { en: "prior to", ru: "до, перед" },
      { en: "subsequent", ru: "последующий" },
      { en: "comprehensive", ru: "всесторонний" },
    ],
    "переговоры": [
      { en: "negotiation", ru: "переговоры" },
      { en: "to negotiate", ru: "вести переговоры" },
      { en: "deal", ru: "сделка" },
      { en: "agreement", ru: "соглашение" },
      { en: "contract", ru: "контракт" },
      { en: "terms", ru: "условия" },
      { en: "clause", ru: "пункт (договора)" },
      { en: "proposal", ru: "предложение" },
      { en: "counteroffer", ru: "встречное предложение" },
      { en: "to make a concession", ru: "идти на уступку" },
      { en: "concession", ru: "уступка" },
      { en: "compromise", ru: "компромисс" },
      { en: "to compromise", ru: "идти на компромисс" },
      { en: "common ground", ru: "общая позиция" },
      { en: "to reach an agreement", ru: "достичь соглашения" },
      { en: "to close a deal", ru: "заключить сделку" },
      { en: "to seal a deal", ru: "скрепить сделку" },
      { en: "bargaining power", ru: "переговорная сила" },
      { en: "leverage", ru: "рычаг влияния" },
      { en: "to leverage", ru: "использовать (как рычаг)" },
      { en: "stakeholder", ru: "заинтересованная сторона" },
      { en: "counterpart", ru: "партнер по переговорам" },
      { en: "mutual benefit", ru: "взаимная выгода" },
      { en: "win-win", ru: "взаимовыгодный" },
      { en: "trade-off", ru: "компромисс, размен" },
      { en: "bottom line", ru: "итоговая позиция, минимум" },
      { en: "deal-breaker", ru: "неприемлемое условие" },
      { en: "to walk away", ru: "выйти из сделки" },
      { en: "to back down", ru: "отступить" },
      { en: "to stand firm", ru: "стоять на своем" },
      { en: "to meet halfway", ru: "пойти навстречу" },
      { en: "incentive", ru: "стимул" },
      { en: "to incentivise", ru: "стимулировать" },
      { en: "to undercut", ru: "сбивать цену" },
      { en: "margin", ru: "маржа, наценка" },
      { en: "markup", ru: "наценка" },
      { en: "quote", ru: "ценовое предложение" },
      { en: "to quote a price", ru: "назвать цену" },
      { en: "discount", ru: "скидка" },
      { en: "bulk discount", ru: "оптовая скидка" },
      { en: "to haggle", ru: "торговаться" },
      { en: "to barter", ru: "обмениваться" },
      { en: "clincher", ru: "решающий аргумент" },
      { en: "to finalise", ru: "завершать, оформлять" },
      { en: "binding", ru: "обязательный (юридически)" },
      { en: "non-binding", ru: "необязательный" },
      { en: "in good faith", ru: "добросовестно" },
      { en: "to honour an agreement", ru: "соблюдать договоренность" },
      { en: "to renege", ru: "отказаться от обещанного" },
      { en: "breach", ru: "нарушение" },
      { en: "liability", ru: "ответственность" },
      { en: "to delegate", ru: "делегировать" },
      { en: "to defer", ru: "откладывать" },
      { en: "deadlock", ru: "тупик" },
      { en: "stalemate", ru: "безвыходное положение" },
      { en: "to break the deadlock", ru: "выйти из тупика" },
      { en: "ultimatum", ru: "ультиматум" },
      { en: "to give and take", ru: "взаимные уступки" },
      { en: "vendor", ru: "поставщик" },
      { en: "procurement", ru: "закупки" },
      { en: "to outsource", ru: "передавать на аутсорс" },
      { en: "to scale", ru: "масштабировать" },
      { en: "projected revenue", ru: "прогнозируемая выручка" },
      { en: "overheads", ru: "накладные расходы" },
    ],
    "литература": [
      { en: "metaphor", ru: "метафора" },
      { en: "simile", ru: "сравнение" },
      { en: "personification", ru: "олицетворение" },
      { en: "hyperbole", ru: "гипербола" },
      { en: "understatement", ru: "преуменьшение" },
      { en: "irony", ru: "ирония" },
      { en: "sarcasm", ru: "сарказм" },
      { en: "satire", ru: "сатира" },
      { en: "allegory", ru: "аллегория" },
      { en: "symbolism", ru: "символизм" },
      { en: "imagery", ru: "образность" },
      { en: "motif", ru: "мотив" },
      { en: "theme", ru: "тема" },
      { en: "tone", ru: "тон" },
      { en: "mood", ru: "настроение" },
      { en: "foreshadowing", ru: "предзнаменование" },
      { en: "flashback", ru: "ретроспекция" },
      { en: "allusion", ru: "аллюзия, отсылка" },
      { en: "juxtaposition", ru: "противопоставление" },
      { en: "oxymoron", ru: "оксюморон" },
      { en: "paradox", ru: "парадокс" },
      { en: "pun", ru: "каламбур" },
      { en: "alliteration", ru: "аллитерация" },
      { en: "assonance", ru: "ассонанс" },
      { en: "onomatopoeia", ru: "звукоподражание" },
      { en: "rhyme", ru: "рифма" },
      { en: "rhythm", ru: "ритм" },
      { en: "meter", ru: "метр (стихотворный)" },
      { en: "verse", ru: "стих, строфа" },
      { en: "stanza", ru: "строфа" },
      { en: "prose", ru: "проза" },
      { en: "narrative", ru: "повествование" },
      { en: "narrator", ru: "рассказчик" },
      { en: "first-person", ru: "от первого лица" },
      { en: "omniscient", ru: "всеведущий" },
      { en: "point of view", ru: "точка зрения" },
      { en: "protagonist", ru: "главный герой" },
      { en: "antagonist", ru: "антагонист" },
      { en: "character development", ru: "развитие персонажа" },
      { en: "foil", ru: "персонаж-контраст" },
      { en: "plot", ru: "сюжет" },
      { en: "subplot", ru: "побочная сюжетная линия" },
      { en: "climax", ru: "кульминация" },
      { en: "denouement", ru: "развязка" },
      { en: "exposition", ru: "экспозиция" },
      { en: "conflict", ru: "конфликт" },
      { en: "twist", ru: "неожиданный поворот" },
      { en: "cliffhanger", ru: "интрига в финале" },
      { en: "genre", ru: "жанр" },
      { en: "to convey", ru: "передавать (смысл)" },
      { en: "to evoke", ru: "вызывать (чувство)" },
      { en: "to depict", ru: "изображать" },
      { en: "to portray", ru: "изображать" },
      { en: "connotation", ru: "коннотация" },
      { en: "denotation", ru: "прямое значение" },
      { en: "ambiguity", ru: "неоднозначность" },
      { en: "diction", ru: "выбор слов, слог" },
      { en: "syntax", ru: "синтаксис" },
      { en: "figurative", ru: "образный" },
      { en: "literal", ru: "буквальный" },
      { en: "vivid", ru: "яркий" },
      { en: "poignant", ru: "трогательный" },
    ],
    "психология": [
      { en: "behaviour", ru: "поведение" },
      { en: "cognition", ru: "познание" },
      { en: "subconscious", ru: "подсознание" },
      { en: "mindset", ru: "мышление, установка" },
      { en: "attitude", ru: "отношение" },
      { en: "emotion", ru: "эмоция" },
      { en: "temperament", ru: "темперамент" },
      { en: "personality", ru: "личность" },
      { en: "trait", ru: "черта характера" },
      { en: "introvert", ru: "интроверт" },
      { en: "extrovert", ru: "экстраверт" },
      { en: "self-esteem", ru: "самооценка" },
      { en: "self-awareness", ru: "самосознание" },
      { en: "motivation", ru: "мотивация" },
      { en: "instinct", ru: "инстинкт" },
      { en: "impulse", ru: "порыв, импульс" },
      { en: "habit", ru: "привычка" },
      { en: "conditioning", ru: "обусловливание" },
      { en: "reinforcement", ru: "подкрепление" },
      { en: "trigger", ru: "триггер, спусковой крючок" },
      { en: "response", ru: "реакция" },
      { en: "stimulus", ru: "стимул, раздражитель" },
      { en: "coping mechanism", ru: "механизм совладания" },
      { en: "defence mechanism", ru: "защитный механизм" },
      { en: "denial", ru: "отрицание" },
      { en: "projection", ru: "проекция" },
      { en: "repression", ru: "вытеснение" },
      { en: "cognitive dissonance", ru: "когнитивный диссонанс" },
      { en: "confirmation bias", ru: "предвзятость подтверждения" },
      { en: "peer pressure", ru: "давление сверстников" },
      { en: "conformity", ru: "конформизм" },
      { en: "resilience", ru: "устойчивость, жизнестойкость" },
      { en: "anxiety", ru: "тревожность" },
      { en: "stress", ru: "стресс" },
      { en: "burnout", ru: "выгорание" },
      { en: "trauma", ru: "травма" },
      { en: "phobia", ru: "фобия" },
      { en: "obsession", ru: "навязчивая идея" },
      { en: "compulsion", ru: "компульсия" },
      { en: "disorder", ru: "расстройство" },
      { en: "therapy", ru: "терапия" },
      { en: "to cope with", ru: "справляться с" },
      { en: "to internalise", ru: "усваивать (внутренне)" },
      { en: "to suppress", ru: "подавлять" },
      { en: "to project", ru: "проецировать" },
      { en: "to rationalise", ru: "рационализировать" },
      { en: "to perceive", ru: "воспринимать" },
      { en: "nature versus nurture", ru: "природа против воспитания" },
      { en: "nurture", ru: "воспитание, среда" },
      { en: "to condition", ru: "формировать (поведение)" },
      { en: "deep-seated", ru: "глубоко укоренившийся" },
      { en: "to manifest", ru: "проявляться" },
      { en: "self-fulfilling prophecy", ru: "самосбывающееся пророчество" },
      { en: "gut feeling", ru: "интуитивное чувство" },
      { en: "state of mind", ru: "душевное состояние" },
      { en: "frame of mind", ru: "настрой" },
    ],
    "медицина": [
      { en: "health", ru: "здоровье" },
      { en: "illness", ru: "болезнь" },
      { en: "disease", ru: "заболевание" },
      { en: "condition", ru: "состояние, заболевание" },
      { en: "symptom", ru: "симптом" },
      { en: "diagnosis", ru: "диагноз" },
      { en: "to diagnose", ru: "диагностировать" },
      { en: "prognosis", ru: "прогноз" },
      { en: "treatment", ru: "лечение" },
      { en: "to treat", ru: "лечить" },
      { en: "remedy", ru: "средство, лекарство" },
      { en: "cure", ru: "излечение, лекарство" },
      { en: "to cure", ru: "излечивать" },
      { en: "recovery", ru: "выздоровление" },
      { en: "to recover", ru: "выздоравливать" },
      { en: "relapse", ru: "рецидив" },
      { en: "chronic", ru: "хронический" },
      { en: "acute", ru: "острый" },
      { en: "terminal", ru: "неизлечимый" },
      { en: "contagious", ru: "заразный" },
      { en: "infectious", ru: "инфекционный" },
      { en: "outbreak", ru: "вспышка" },
      { en: "epidemic", ru: "эпидемия" },
      { en: "pandemic", ru: "пандемия" },
      { en: "immune system", ru: "иммунная система" },
      { en: "immunity", ru: "иммунитет" },
      { en: "vaccine", ru: "вакцина" },
      { en: "vaccination", ru: "вакцинация" },
      { en: "antibiotic", ru: "антибиотик" },
      { en: "prescription", ru: "рецепт" },
      { en: "to prescribe", ru: "выписывать (лекарство)" },
      { en: "dose", ru: "доза" },
      { en: "dosage", ru: "дозировка" },
      { en: "side effect", ru: "побочный эффект" },
      { en: "overdose", ru: "передозировка" },
      { en: "surgery", ru: "операция, хирургия" },
      { en: "to undergo surgery", ru: "перенести операцию" },
      { en: "procedure", ru: "процедура" },
      { en: "to operate", ru: "оперировать" },
      { en: "transplant", ru: "трансплантация" },
      { en: "to monitor", ru: "наблюдать, отслеживать" },
      { en: "to screen", ru: "обследовать" },
      { en: "check-up", ru: "осмотр" },
      { en: "GP", ru: "терапевт (врач общей практики)" },
      { en: "specialist", ru: "специалист" },
      { en: "referral", ru: "направление к врачу" },
      { en: "ward", ru: "больничная палата" },
      { en: "intensive care", ru: "интенсивная терапия" },
      { en: "emergency", ru: "неотложная помощь" },
      { en: "first aid", ru: "первая помощь" },
      { en: "to resuscitate", ru: "реанимировать" },
      { en: "mental health", ru: "психическое здоровье" },
      { en: "depression", ru: "депрессия" },
      { en: "to deteriorate", ru: "ухудшаться" },
      { en: "to relieve", ru: "облегчать" },
      { en: "to alleviate", ru: "облегчать" },
      { en: "to manage a condition", ru: "контролировать заболевание" },
      { en: "preventive", ru: "профилактический" },
      { en: "to prevent", ru: "предотвращать" },
      { en: "nutrition", ru: "питание" },
      { en: "to boost immunity", ru: "укреплять иммунитет" },
      { en: "chronic fatigue", ru: "хроническая усталость" },
    ],
    "идиомы": [
      { en: "to bite the bullet", ru: "стиснуть зубы и сделать" },
      { en: "to hit the nail on the head", ru: "попасть в точку" },
      { en: "to cut corners", ru: "халтурить, экономить на качестве" },
      { en: "to get the ball rolling", ru: "запустить дело" },
      { en: "to be on the same page", ru: "понимать одинаково" },
      { en: "to think outside the box", ru: "мыслить нестандартно" },
      { en: "to take something into account", ru: "учитывать что-либо" },
      { en: "to come across as", ru: "производить впечатление" },
      { en: "to get cold feet", ru: "струсить в последний момент" },
      { en: "to break the ice", ru: "растопить лед, разрядить обстановку" },
      { en: "to play it by ear", ru: "действовать по обстоятельствам" },
      { en: "to be in the same boat", ru: "быть в одной лодке" },
      { en: "to go the extra mile", ru: "приложить дополнительные усилия" },
      { en: "to cut to the chase", ru: "перейти к сути" },
      { en: "to be a blessing in disguise", ru: "не было бы счастья, да несчастье помогло" },
      { en: "to jump on the bandwagon", ru: "примкнуть к большинству" },
      { en: "to be over the moon", ru: "быть на седьмом небе" },
      { en: "to feel under the weather", ru: "неважно себя чувствовать" },
      { en: "to have a lot on one's plate", ru: "быть перегруженным" },
      { en: "to get on like a house on fire", ru: "прекрасно ладить" },
      { en: "to bend over backwards", ru: "из кожи вон лезть" },
      { en: "to be snowed under", ru: "быть заваленным работой" },
      { en: "to call it a day", ru: "закончить на сегодня" },
      { en: "to touch base", ru: "связаться, свериться" },
      { en: "to be up in the air", ru: "быть нерешенным" },
      { en: "to take a rain check", ru: "перенести на потом" },
      { en: "to be a piece of cake", ru: "проще простого" },
      { en: "to ring a bell", ru: "звучать знакомо" },
      { en: "to be the last straw", ru: "последняя капля" },
      { en: "to add insult to injury", ru: "усугубить положение" },
      { en: "to beat around the bush", ru: "ходить вокруг да около" },
      { en: "to be in hot water", ru: "быть в беде" },
      { en: "to let the cat out of the bag", ru: "проболтаться" },
      { en: "to spill the beans", ru: "выдать секрет" },
      { en: "to be on the ball", ru: "быть расторопным" },
      { en: "to pull someone's leg", ru: "разыгрывать кого-то" },
      { en: "to be a wake-up call", ru: "быть тревожным сигналом" },
      { en: "to face the music", ru: "отвечать за последствия" },
      { en: "to get out of hand", ru: "выйти из-под контроля" },
      { en: "to be worth a shot", ru: "стоит попробовать" },
      { en: "to keep an eye on", ru: "присматривать за" },
      { en: "to be in someone's shoes", ru: "быть на чьем-то месте" },
      { en: "to read between the lines", ru: "читать между строк" },
      { en: "to sit on the fence", ru: "занимать нейтральную позицию" },
      { en: "to throw in the towel", ru: "сдаться" },
      { en: "to be water under the bridge", ru: "дело прошлое" },
      { en: "once in a blue moon", ru: "очень редко" },
      { en: "to take with a grain of salt", ru: "относиться скептически" },
      { en: "the bottom line", ru: "суть, главное" },
      { en: "to be a game changer", ru: "кардинально менять ситуацию" },
      { en: "to move the goalposts", ru: "менять правила по ходу" },
      { en: "to be par for the course", ru: "в порядке вещей" },
      { en: "at the end of the day", ru: "в конечном итоге" },
      { en: "to wrap one's head around", ru: "осмыслить, понять" },
      { en: "to be a long shot", ru: "маловероятный вариант" },
      { en: "to go down a rabbit hole", ru: "уйти с головой во что-то" },
      { en: "to be the elephant in the room", ru: "очевидная замалчиваемая проблема" },
      { en: "to be on thin ice", ru: "быть в рискованном положении" },
      { en: "to bite off more than one can chew", ru: "переоценить свои силы" },
      { en: "to keep one's options open", ru: "не связывать себя обязательствами" },
      { en: "food for thought", ru: "пища для размышлений" },
      { en: "to have second thoughts", ru: "засомневаться" },
    ],
    "маркетинг": [
      { en: "product-market fit", ru: "попадание продукта в рынок" },
      { en: "category creation", ru: "создание новой категории" },
      { en: "share of voice", ru: "доля бренда в медиапространстве" },
      { en: "brand equity", ru: "накопленный капитал бренда" },
      { en: "brand salience", ru: "насколько бренд первым приходит в голову" },
      { en: "differentiation", ru: "чем мы отличаемся от остальных" },
      { en: "commoditize", ru: "обезличить, свести к цене" },
      { en: "price elasticity", ru: "чувствительность спроса к цене" },
      { en: "margin", ru: "маржа" },
      { en: "payback period", ru: "срок окупаемости" },
      { en: "blended CAC", ru: "усреднённая стоимость привлечения по всем каналам" },
      { en: "incrementality", ru: "реальный прирост именно от канала" },
      { en: "halo effect", ru: "эффект ореола, побочная польза для других каналов" },
      { en: "cannibalization", ru: "каннибализация, отъедание у своего же канала" },
      { en: "audience saturation", ru: "насыщение аудитории" },
      { en: "diminishing returns", ru: "убывающая отдача от вложений" },
      { en: "media mix", ru: "распределение бюджета по каналам" },
      { en: "cohort", ru: "когорта" },
      { en: "statistical significance", ru: "статистическая значимость" },
      { en: "directional data", ru: "данные, задающие направление, но не точные" },
      { en: "proxy metric", ru: "метрика-заместитель" },
      { en: "vanity metric", ru: "красивая метрика, не связанная с деньгами" },
      { en: "north star metric", ru: "главная метрика продукта" },
      { en: "narrative", ru: "нарратив, история, которую мы продаём" },
      { en: "reframe", ru: "сместить рамку, подать под другим углом" },
      { en: "positioning statement", ru: "формулировка позиционирования" },
      { en: "land and expand", ru: "зайти малым, потом расширяться внутри клиента" },
      { en: "flywheel", ru: "маховик, самораскручивающийся рост" },
      { en: "moat", ru: "устойчивое преимущество, которое сложно скопировать" },
      { en: "table stakes", ru: "базовый минимум, без которого не заходишь на рынок" },
      { en: "headwinds", ru: "встречные обстоятельства" },
      { en: "tailwinds", ru: "попутные обстоятельства, рынок помогает" },
      { en: "de-risk", ru: "снизить риск заранее" },
      { en: "sunk cost", ru: "уже потраченное, что не вернуть" },
      { en: "hedge", ru: "подстраховаться" },
      { en: "greenlight", ru: "дать зелёный свет" },
      { en: "sunset a product", ru: "закрыть, вывести из линейки" },
      { en: "soft launch", ru: "тихий запуск на узкой аудитории" },
      { en: "socialize an idea", ru: "обкатать идею на людях до решения" },
      { en: "get buy-in", ru: "заручиться поддержкой" },
      { en: "make the case for smth", ru: "обосновать, аргументировать" },
      { en: "build consensus", ru: "свести всех к общему решению" },
      { en: "caveat", ru: "оговорка, важное «но»" },
      { en: "back-of-the-envelope", ru: "прикидка на коленке" },
      { en: "take smth with a grain of salt", ru: "относиться с осторожностью" },
      { en: "overpromise and underdeliver", ru: "наобещать и не вытянуть" },
      { en: "set expectations", ru: "обозначить, чего ждать" },
      { en: "manage up", ru: "выстраивать коммуникацию с руководством" },
    ],
  },
};

// --- Уровень B1 ---
const SEED_SHARED_LIBRARY_B1 = {
  difficulty: "B1",
  topics: {
    "работа": [
      { en: "job", ru: "работа (место)" },
      { en: "career", ru: "карьера" },
      { en: "employer", ru: "работодатель" },
      { en: "employee", ru: "сотрудник" },
      { en: "colleague", ru: "коллега" },
      { en: "boss", ru: "начальник" },
      { en: "staff", ru: "персонал" },
      { en: "to apply for a job", ru: "подавать на работу" },
      { en: "application", ru: "заявление / отклик" },
      { en: "CV", ru: "резюме" },
      { en: "job interview", ru: "собеседование" },
      { en: "to hire", ru: "нанимать" },
      { en: "to employ", ru: "нанимать / трудоустраивать" },
      { en: "to be employed", ru: "быть трудоустроенным" },
      { en: "unemployed", ru: "безработный" },
      { en: "to earn", ru: "зарабатывать" },
      { en: "salary", ru: "зарплата (оклад)" },
      { en: "wage", ru: "зарплата (почасовая)" },
      { en: "to get a promotion", ru: "получить повышение" },
      { en: "to be promoted", ru: "быть повышенным" },
      { en: "full-time", ru: "полная занятость" },
      { en: "part-time", ru: "частичная занятость" },
      { en: "to work overtime", ru: "работать сверхурочно" },
      { en: "day off", ru: "выходной" },
      { en: "to take a break", ru: "делать перерыв" },
      { en: "deadline", ru: "срок сдачи" },
      { en: "task", ru: "задача" },
      { en: "meeting", ru: "совещание" },
      { en: "project", ru: "проект" },
      { en: "to be in charge of", ru: "отвечать за" },
      { en: "responsibility", ru: "обязанность" },
      { en: "skill", ru: "навык" },
      { en: "experience", ru: "опыт" },
      { en: "training", ru: "обучение" },
      { en: "to resign", ru: "увольняться" },
      { en: "to quit", ru: "бросать (работу)" },
      { en: "to fire", ru: "увольнять" },
      { en: "to be made redundant", ru: "попасть под сокращение" },
      { en: "workplace", ru: "рабочее место" },
      { en: "office", ru: "офис" },
      { en: "to work from home", ru: "работать из дома" },
      { en: "teamwork", ru: "командная работа" },
      { en: "to get on with colleagues", ru: "ладить с коллегами" },
      { en: "busy", ru: "занятый" },
      { en: "stressful", ru: "стрессовый" },
      { en: "rewarding", ru: "приносящий удовлетворение" },
      { en: "to look for a job", ru: "искать работу" },
      { en: "to fill in a form", ru: "заполнять анкету" },
      { en: "qualification", ru: "квалификация" },
      { en: "to be good at", ru: "быть хорошим в" },
    ],
    "образование": [
      { en: "to study", ru: "учиться / изучать" },
      { en: "to learn", ru: "учить / узнавать" },
      { en: "subject", ru: "предмет" },
      { en: "lesson", ru: "урок" },
      { en: "classroom", ru: "класс" },
      { en: "schedule", ru: "расписание" },
      { en: "homework", ru: "домашнее задание" },
      { en: "to do homework", ru: "делать домашку" },
      { en: "to take notes", ru: "делать заметки" },
      { en: "to pass an exam", ru: "сдать экзамен" },
      { en: "to fail an exam", ru: "провалить экзамен" },
      { en: "to take an exam", ru: "сдавать экзамен" },
      { en: "mark / grade", ru: "оценка" },
      { en: "to revise", ru: "повторять (к экзамену)" },
      { en: "to make progress", ru: "делать успехи" },
      { en: "to get a degree", ru: "получить диплом" },
      { en: "university", ru: "университет" },
      { en: "college", ru: "колледж" },
      { en: "student", ru: "студент" },
      { en: "teacher", ru: "учитель" },
      { en: "lecturer", ru: "преподаватель (вуза)" },
      { en: "lecture", ru: "лекция" },
      { en: "course", ru: "курс" },
      { en: "to enrol", ru: "записаться (на курс)" },
      { en: "to graduate", ru: "окончить (вуз)" },
      { en: "graduation", ru: "выпуск" },
      { en: "scholarship", ru: "стипендия" },
      { en: "tuition fee", ru: "плата за обучение" },
      { en: "knowledge", ru: "знания" },
      { en: "to memorise", ru: "заучивать" },
      { en: "to concentrate", ru: "сосредотачиваться" },
      { en: "to pay attention", ru: "быть внимательным" },
      { en: "to make a mistake", ru: "делать ошибку" },
      { en: "to correct", ru: "исправлять" },
      { en: "to explain", ru: "объяснять" },
      { en: "to understand", ru: "понимать" },
      { en: "to give a presentation", ru: "делать презентацию" },
      { en: "to do research", ru: "проводить исследование" },
      { en: "to hand in", ru: "сдавать (работу)" },
      { en: "deadline", ru: "срок сдачи" },
      { en: "distance learning", ru: "дистанционное обучение" },
      { en: "to drop out", ru: "бросить учёбу" },
      { en: "to attend", ru: "посещать (занятия)" },
      { en: "qualification", ru: "квалификация" },
      { en: "to be good at a subject", ru: "быть способным к предмету" },
      { en: "to fall behind", ru: "отставать" },
      { en: "to catch up", ru: "догонять" },
      { en: "educated", ru: "образованный" },
      { en: "academic", ru: "учебный / академический" },
    ],
    "отношения": [
      { en: "relationship", ru: "отношения" },
      { en: "friendship", ru: "дружба" },
      { en: "to make friends", ru: "заводить друзей" },
      { en: "close friend", ru: "близкий друг" },
      { en: "to get to know", ru: "узнать (познакомиться)" },
      { en: "to meet", ru: "встречать / знакомиться" },
      { en: "to fall in love", ru: "влюбиться" },
      { en: "to be in love", ru: "быть влюблённым" },
      { en: "couple", ru: "пара" },
      { en: "partner", ru: "партнёр" },
      { en: "boyfriend", ru: "парень" },
      { en: "girlfriend", ru: "девушка" },
      { en: "to date", ru: "встречаться" },
      { en: "to get engaged", ru: "обручиться" },
      { en: "to get married", ru: "пожениться" },
      { en: "marriage", ru: "брак" },
      { en: "wedding", ru: "свадьба" },
      { en: "husband", ru: "муж" },
      { en: "wife", ru: "жена" },
      { en: "to trust", ru: "доверять" },
      { en: "to support", ru: "поддерживать" },
      { en: "to argue", ru: "спорить / ссориться" },
      { en: "argument", ru: "ссора / спор" },
      { en: "to break up", ru: "расстаться" },
      { en: "to split up", ru: "разойтись" },
      { en: "to get divorced", ru: "развестись" },
      { en: "divorce", ru: "развод" },
      { en: "to get on well", ru: "хорошо ладить" },
      { en: "to have a lot in common", ru: "иметь много общего" },
      { en: "to spend time together", ru: "проводить время вместе" },
      { en: "to keep in touch", ru: "поддерживать связь" },
      { en: "to lose touch", ru: "потерять связь" },
      { en: "to make up", ru: "мириться" },
      { en: "to apologise", ru: "извиняться" },
      { en: "to forgive", ru: "прощать" },
      { en: "loyal", ru: "верный" },
      { en: "honest", ru: "честный" },
      { en: "caring", ru: "заботливый" },
      { en: "jealous", ru: "ревнивый" },
      { en: "to cheat on", ru: "изменять" },
      { en: "to miss someone", ru: "скучать по кому-то" },
      { en: "neighbour", ru: "сосед" },
      { en: "acquaintance", ru: "знакомый" },
      { en: "to rely on", ru: "полагаться на" },
      { en: "to get along", ru: "уживаться" },
      { en: "to fall out", ru: "поссориться" },
      { en: "to introduce", ru: "представлять (знакомить)" },
      { en: "to invite", ru: "приглашать" },
      { en: "relative", ru: "родственник" },
    ],
    "сми": [
      { en: "news", ru: "новости" },
      { en: "the media", ru: "СМИ" },
      { en: "newspaper", ru: "газета" },
      { en: "magazine", ru: "журнал" },
      { en: "article", ru: "статья" },
      { en: "headline", ru: "заголовок" },
      { en: "journalist", ru: "журналист" },
      { en: "reporter", ru: "репортёр" },
      { en: "to report", ru: "сообщать" },
      { en: "report", ru: "репортаж / отчёт" },
      { en: "to broadcast", ru: "транслировать" },
      { en: "channel", ru: "канал" },
      { en: "to interview", ru: "брать интервью" },
      { en: "interview", ru: "интервью" },
      { en: "front page", ru: "первая полоса" },
      { en: "breaking news", ru: "срочные новости" },
      { en: "current affairs", ru: "текущие события" },
      { en: "to publish", ru: "публиковать" },
      { en: "to be published", ru: "быть опубликованным" },
      { en: "to announce", ru: "объявлять" },
      { en: "announcement", ru: "объявление" },
      { en: "to cover a story", ru: "освещать событие" },
      { en: "coverage", ru: "освещение (в СМИ)" },
      { en: "press", ru: "пресса" },
      { en: "the public", ru: "общественность" },
      { en: "audience", ru: "аудитория" },
      { en: "viewer", ru: "зритель" },
      { en: "reader", ru: "читатель" },
      { en: "to subscribe", ru: "подписываться" },
      { en: "subscription", ru: "подписка" },
      { en: "fake news", ru: "фейковые новости" },
      { en: "reliable", ru: "надёжный (источник)" },
      { en: "biased", ru: "предвзятый" },
      { en: "to spread", ru: "распространять(ся)" },
      { en: "rumour", ru: "слух" },
      { en: "scandal", ru: "скандал" },
      { en: "to censor", ru: "цензурировать" },
      { en: "freedom of the press", ru: "свобода прессы" },
      { en: "editor", ru: "редактор" },
      { en: "weather forecast", ru: "прогноз погоды" },
      { en: "to keep up with the news", ru: "следить за новостями" },
      { en: "to go viral", ru: "стать вирусным" },
      { en: "trending", ru: "в тренде" },
      { en: "source", ru: "источник" },
      { en: "headline news", ru: "главные новости" },
      { en: "documentary", ru: "документальный фильм" },
      { en: "to update", ru: "обновлять" },
      { en: "in the spotlight", ru: "в центре внимания" },
    ],
    "экология": [
      { en: "the environment", ru: "окружающая среда" },
      { en: "environmental", ru: "экологический" },
      { en: "nature", ru: "природа" },
      { en: "climate", ru: "климат" },
      { en: "climate change", ru: "изменение климата" },
      { en: "global warming", ru: "глобальное потепление" },
      { en: "pollution", ru: "загрязнение" },
      { en: "to pollute", ru: "загрязнять" },
      { en: "polluted", ru: "загрязнённый" },
      { en: "waste", ru: "отходы / мусор" },
      { en: "rubbish", ru: "мусор" },
      { en: "litter", ru: "мусор (на улице)" },
      { en: "to throw away", ru: "выбрасывать" },
      { en: "to recycle", ru: "перерабатывать" },
      { en: "recycling", ru: "переработка" },
      { en: "to reuse", ru: "использовать повторно" },
      { en: "to reduce", ru: "сокращать" },
      { en: "plastic", ru: "пластик" },
      { en: "packaging", ru: "упаковка" },
      { en: "energy", ru: "энергия" },
      { en: "to save energy", ru: "экономить энергию" },
      { en: "to waste", ru: "тратить впустую" },
      { en: "renewable", ru: "возобновляемый" },
      { en: "solar power", ru: "солнечная энергия" },
      { en: "wind power", ru: "энергия ветра" },
      { en: "fossil fuels", ru: "ископаемое топливо" },
      { en: "to protect", ru: "защищать" },
      { en: "to harm", ru: "вредить" },
      { en: "harmful", ru: "вредный" },
      { en: "endangered", ru: "под угрозой исчезновения" },
      { en: "species", ru: "вид (животных)" },
      { en: "wildlife", ru: "дикая природа" },
      { en: "forest", ru: "лес" },
      { en: "to cut down trees", ru: "вырубать деревья" },
      { en: "deforestation", ru: "вырубка лесов" },
      { en: "to plant trees", ru: "сажать деревья" },
      { en: "ocean", ru: "океан" },
      { en: "to clean up", ru: "убирать (очищать)" },
      { en: "eco-friendly", ru: "экологичный" },
      { en: "sustainable", ru: "устойчивый / экологичный" },
      { en: "carbon footprint", ru: "углеродный след" },
      { en: "to cause", ru: "вызывать (быть причиной)" },
      { en: "effect", ru: "последствие / эффект" },
      { en: "drought", ru: "засуха" },
      { en: "flood", ru: "наводнение" },
      { en: "natural disaster", ru: "стихийное бедствие" },
      { en: "to raise awareness", ru: "повышать осведомлённость" },
    ],
    "технологии": [
      { en: "technology", ru: "технология" },
      { en: "device", ru: "устройство" },
      { en: "gadget", ru: "гаджет" },
      { en: "screen", ru: "экран" },
      { en: "to switch on", ru: "включать" },
      { en: "to switch off", ru: "выключать" },
      { en: "to download", ru: "скачивать" },
      { en: "to upload", ru: "загружать (в сеть)" },
      { en: "to install", ru: "устанавливать" },
      { en: "to update", ru: "обновлять" },
      { en: "app", ru: "приложение" },
      { en: "software", ru: "программное обеспечение" },
      { en: "file", ru: "файл" },
      { en: "folder", ru: "папка" },
      { en: "to save", ru: "сохранять" },
      { en: "to delete", ru: "удалять" },
      { en: "password", ru: "пароль" },
      { en: "to log in", ru: "входить (в аккаунт)" },
      { en: "to log out", ru: "выходить (из аккаунта)" },
      { en: "to sign up", ru: "регистрироваться" },
      { en: "account", ru: "аккаунт" },
      { en: "the Internet", ru: "интернет" },
      { en: "website", ru: "сайт" },
      { en: "web page", ru: "веб-страница" },
      { en: "link", ru: "ссылка" },
      { en: "to click", ru: "нажимать (кликать)" },
      { en: "to browse", ru: "просматривать (в сети)" },
      { en: "search engine", ru: "поисковик" },
      { en: "to search for", ru: "искать" },
      { en: "online", ru: "онлайн" },
      { en: "offline", ru: "офлайн" },
      { en: "to connect", ru: "подключать(ся)" },
      { en: "connection", ru: "подключение" },
      { en: "Wi-Fi", ru: "вай-фай" },
      { en: "network", ru: "сеть" },
      { en: "social media", ru: "соцсети" },
      { en: "to post", ru: "публиковать" },
      { en: "to share", ru: "делиться" },
      { en: "to comment", ru: "комментировать" },
      { en: "to like", ru: "ставить лайк" },
      { en: "to follow", ru: "подписываться" },
      { en: "message", ru: "сообщение" },
      { en: "to text", ru: "писать сообщения" },
      { en: "video call", ru: "видеозвонок" },
      { en: "to charge", ru: "заряжать" },
      { en: "battery", ru: "батарея / аккумулятор" },
      { en: "data", ru: "данные" },
      { en: "virus", ru: "вирус" },
    ],
    "кулинария": [
      { en: "recipe", ru: "рецепт" },
      { en: "ingredient", ru: "ингредиент" },
      { en: "to prepare", ru: "готовить (подготавливать)" },
      { en: "to cook", ru: "готовить" },
      { en: "to bake", ru: "печь" },
      { en: "to fry", ru: "жарить" },
      { en: "to boil", ru: "варить / кипятить" },
      { en: "to roast", ru: "запекать / жарить (в духовке)" },
      { en: "to grill", ru: "готовить на гриле" },
      { en: "to steam", ru: "готовить на пару" },
      { en: "to mix", ru: "смешивать" },
      { en: "to stir", ru: "помешивать" },
      { en: "to add", ru: "добавлять" },
      { en: "to chop", ru: "нарезать (крупно)" },
      { en: "to slice", ru: "нарезать ломтиками" },
      { en: "to peel", ru: "чистить (овощи)" },
      { en: "to pour", ru: "наливать" },
      { en: "to taste", ru: "пробовать на вкус" },
      { en: "flavour", ru: "вкус / аромат" },
      { en: "spicy", ru: "острый" },
      { en: "sweet", ru: "сладкий" },
      { en: "sour", ru: "кислый" },
      { en: "bitter", ru: "горький" },
      { en: "salty", ru: "солёный" },
      { en: "fresh", ru: "свежий" },
      { en: "frozen", ru: "замороженный" },
      { en: "raw", ru: "сырой" },
      { en: "ripe", ru: "спелый" },
      { en: "dish", ru: "блюдо" },
      { en: "meal", ru: "приём пищи" },
      { en: "starter", ru: "закуска" },
      { en: "main course", ru: "основное блюдо" },
      { en: "dessert", ru: "десерт" },
      { en: "portion", ru: "порция" },
      { en: "to serve", ru: "подавать (на стол)" },
      { en: "to feed", ru: "кормить" },
      { en: "to be on a diet", ru: "быть на диете" },
      { en: "vegetarian", ru: "вегетарианский" },
      { en: "to put on weight", ru: "набирать вес" },
      { en: "tasty", ru: "вкусный" },
      { en: "delicious", ru: "очень вкусный" },
      { en: "disgusting", ru: "отвратительный" },
      { en: "to follow a recipe", ru: "следовать рецепту" },
      { en: "cookbook", ru: "кулинарная книга" },
      { en: "oven", ru: "духовка" },
      { en: "saucepan", ru: "кастрюля" },
      { en: "frying pan", ru: "сковорода" },
      { en: "leftovers", ru: "остатки еды" },
    ],
    "город": [
      { en: "city", ru: "город (крупный)" },
      { en: "town", ru: "город (небольшой)" },
      { en: "village", ru: "деревня" },
      { en: "the countryside", ru: "сельская местность" },
      { en: "suburb", ru: "пригород" },
      { en: "neighbourhood", ru: "район" },
      { en: "city centre", ru: "центр города" },
      { en: "downtown", ru: "центр (амер.)" },
      { en: "district", ru: "район / округ" },
      { en: "to live in", ru: "жить в" },
      { en: "resident", ru: "житель" },
      { en: "local", ru: "местный (житель)" },
      { en: "traffic", ru: "движение / транспорт" },
      { en: "traffic jam", ru: "пробка" },
      { en: "rush hour", ru: "час пик" },
      { en: "public transport", ru: "общественный транспорт" },
      { en: "to commute", ru: "ездить на работу" },
      { en: "underground / metro", ru: "метро" },
      { en: "bus stop", ru: "остановка" },
      { en: "to get around", ru: "передвигаться" },
      { en: "pedestrian", ru: "пешеход" },
      { en: "crossing", ru: "переход" },
      { en: "pavement", ru: "тротуар" },
      { en: "crowded", ru: "переполненный" },
      { en: "busy", ru: "оживлённый" },
      { en: "noisy", ru: "шумный" },
      { en: "quiet", ru: "тихий" },
      { en: "safe", ru: "безопасный" },
      { en: "dangerous", ru: "опасный" },
      { en: "to cross the road", ru: "переходить дорогу" },
      { en: "facilities", ru: "удобства / инфраструктура" },
      { en: "shopping centre", ru: "торговый центр" },
      { en: "skyscraper", ru: "небоскрёб" },
      { en: "building", ru: "здание" },
      { en: "flat / apartment", ru: "квартира" },
      { en: "block of flats", ru: "многоквартирный дом" },
      { en: "rent", ru: "аренда" },
      { en: "to rent", ru: "снимать (жильё)" },
      { en: "landlord", ru: "арендодатель" },
      { en: "cost of living", ru: "стоимость жизни" },
      { en: "lifestyle", ru: "образ жизни" },
      { en: "to move (house)", ru: "переезжать" },
      { en: "to settle", ru: "обосноваться" },
      { en: "green space", ru: "зелёная зона" },
      { en: "park", ru: "парк" },
      { en: "litter", ru: "мусор (на улице)" },
      { en: "streetlight", ru: "уличный фонарь" },
      { en: "to be within walking distance", ru: "быть в пешей доступности" },
    ],
    "реклама": [
      { en: "advertising", ru: "реклама (сфера)" },
      { en: "advertisement / advert / ad", ru: "рекламное объявление" },
      { en: "to advertise", ru: "рекламировать" },
      { en: "commercial", ru: "рекламный ролик" },
      { en: "billboard", ru: "рекламный щит" },
      { en: "poster", ru: "плакат" },
      { en: "brand", ru: "бренд" },
      { en: "logo", ru: "логотип" },
      { en: "slogan", ru: "слоган" },
      { en: "product", ru: "продукт" },
      { en: "to promote", ru: "продвигать" },
      { en: "promotion", ru: "продвижение / акция" },
      { en: "campaign", ru: "кампания" },
      { en: "to launch", ru: "запускать (продукт)" },
      { en: "target audience", ru: "целевая аудитория" },
      { en: "consumer", ru: "потребитель" },
      { en: "customer", ru: "клиент" },
      { en: "to attract", ru: "привлекать" },
      { en: "to persuade", ru: "убеждать" },
      { en: "to influence", ru: "влиять" },
      { en: "to sell", ru: "продавать" },
      { en: "sales", ru: "продажи" },
      { en: "to increase", ru: "увеличивать" },
      { en: "discount", ru: "скидка" },
      { en: "offer", ru: "предложение" },
      { en: "special offer", ru: "спецпредложение" },
      { en: "on sale", ru: "в продаже / по акции" },
      { en: "free sample", ru: "бесплатный образец" },
      { en: "to afford", ru: "позволить себе" },
      { en: "demand", ru: "спрос" },
      { en: "to launch a product", ru: "выпустить продукт" },
      { en: "market", ru: "рынок" },
      { en: "to compete", ru: "конкурировать" },
      { en: "competitor", ru: "конкурент" },
      { en: "brand new", ru: "совершенно новый" },
      { en: "logo design", ru: "дизайн логотипа" },
      { en: "eye-catching", ru: "привлекающий внимание" },
      { en: "to stand out", ru: "выделяться" },
      { en: "to make a profit", ru: "получать прибыль" },
      { en: "profit", ru: "прибыль" },
      { en: "to spend money on", ru: "тратить деньги на" },
      { en: "to be worth", ru: "стоить (того)" },
      { en: "catchy", ru: "запоминающийся" },
      { en: "trustworthy", ru: "заслуживающий доверия" },
      { en: "word of mouth", ru: "сарафанное радио" },
      { en: "to recommend", ru: "рекомендовать" },
      { en: "review", ru: "отзыв" },
    ],
    "маркетинг": [
      { en: "target audience", ru: "целевая аудитория" },
      { en: "brand awareness", ru: "узнаваемость бренда" },
      { en: "launch", ru: "запуск (продукта, кампании)" },
      { en: "run a campaign", ru: "вести кампанию" },
      { en: "reach", ru: "охват" },
      { en: "engagement", ru: "вовлечённость" },
      { en: "lead", ru: "лид, потенциальный клиент" },
      { en: "landing page", ru: "посадочная страница, лендинг" },
      { en: "conversion", ru: "конверсия" },
      { en: "conversion rate", ru: "процент конверсии" },
      { en: "click-through rate (CTR)", ru: "кликабельность" },
      { en: "ad spend", ru: "расходы на рекламу" },
      { en: "paid ads", ru: "платная реклама" },
      { en: "organic traffic", ru: "органический трафик" },
      { en: "copy", ru: "рекламный текст" },
      { en: "headline", ru: "заголовок" },
      { en: "call to action (CTA)", ru: "призыв к действию" },
      { en: "creative", ru: "рекламный материал, креатив" },
      { en: "asset", ru: "материал (баннер, видео, текст)" },
      { en: "channel", ru: "канал" },
      { en: "placement", ru: "место размещения" },
      { en: "impression", ru: "показ" },
      { en: "audience segment", ru: "сегмент аудитории" },
      { en: "brief", ru: "бриф, техзадание" },
      { en: "deliverable", ru: "то, что сдаём по итогу" },
      { en: "stakeholder", ru: "тот, кого касается решение" },
      { en: "milestone", ru: "контрольная точка" },
      { en: "mock-up", ru: "макет" },
      { en: "reach out to smb", ru: "написать, связаться" },
      { en: "follow up", ru: "вернуться к вопросу, напомнить" },
      { en: "sign off on smth", ru: "утвердить, согласовать" },
      { en: "share of the market", ru: "доля рынка" },
    ],
  },
};

// --- Уровень B2 ---
const SEED_SHARED_LIBRARY_B2 = {
  difficulty: "B2",
  topics: {
    "работа": [
      { en: "career path", ru: "карьерный путь" },
      { en: "to climb the career ladder", ru: "подниматься по карьерной лестнице" },
      { en: "to land a job", ru: "получить работу" },
      { en: "to apply for a position", ru: "подавать заявку на должность" },
      { en: "job interview", ru: "собеседование" },
      { en: "to be shortlisted", ru: "попасть в шорт-лист" },
      { en: "to hire", ru: "нанимать" },
      { en: "to be promoted", ru: "получить повышение" },
      { en: "promotion", ru: "повышение" },
      { en: "to resign", ru: "увольняться (по собственному)" },
      { en: "to quit a job", ru: "бросить работу" },
      { en: "to be made redundant", ru: "попасть под сокращение" },
      { en: "notice period", ru: "срок отработки при увольнении" },
      { en: "workload", ru: "объём работы" },
      { en: "to take on responsibilities", ru: "брать на себя обязанности" },
      { en: "to meet a deadline", ru: "уложиться в срок" },
      { en: "to be under pressure", ru: "быть под давлением" },
      { en: "work-life balance", ru: "баланс работы и жизни" },
      { en: "to work overtime", ru: "работать сверхурочно" },
      { en: "to burn out", ru: "выгорать" },
      { en: "to take a day off", ru: "взять выходной" },
      { en: "salary", ru: "оклад" },
      { en: "to negotiate a pay rise", ru: "договариваться о повышении зарплаты" },
      { en: "benefits", ru: "льготы и бонусы" },
      { en: "perks", ru: "дополнительные привилегии" },
      { en: "to work from home", ru: "работать из дома" },
      { en: "remote work", ru: "удалённая работа" },
      { en: "flexible hours", ru: "гибкий график" },
      { en: "colleague", ru: "коллега" },
      { en: "line manager", ru: "непосредственный руководитель" },
      { en: "to report to someone", ru: "подчиняться кому-то" },
      { en: "to be in charge of", ru: "отвечать за" },
      { en: "to delegate tasks", ru: "делегировать задачи" },
      { en: "teamwork", ru: "командная работа" },
      { en: "to meet expectations", ru: "оправдывать ожидания" },
      { en: "performance review", ru: "оценка эффективности" },
      { en: "to give feedback", ru: "давать обратную связь" },
      { en: "to set goals", ru: "ставить цели" },
      { en: "to gain experience", ru: "набираться опыта" },
      { en: "skill set", ru: "набор навыков" },
      { en: "to upskill", ru: "повышать квалификацию" },
      { en: "to switch careers", ru: "менять профессию" },
      { en: "freelance", ru: "фриланс" },
      { en: "self-employed", ru: "работающий на себя" },
      { en: "to run a business", ru: "вести бизнес" },
      { en: "networking", ru: "налаживание профессиональных связей" },
      { en: "to make a good impression", ru: "произвести хорошее впечатление" },
      { en: "CV (resume)", ru: "резюме" },
      { en: "cover letter", ru: "сопроводительное письмо" },
      { en: "job vacancy", ru: "вакансия" },
      { en: "to be qualified for", ru: "иметь квалификацию для" },
      { en: "dead-end job", ru: "бесперспективная работа" },
      { en: "demanding job", ru: "требовательная работа" },
      { en: "rewarding job", ru: "приносящая удовлетворение работа" },
      { en: "to take pride in", ru: "гордиться (своей работой)" },
      { en: "to call it a day", ru: "закончить работу на сегодня" },
    ],
    "образование": [
      { en: "to enrol in a course", ru: "записаться на курс" },
      { en: "to pursue a degree", ru: "получать степень" },
      { en: "undergraduate", ru: "студент бакалавриата" },
      { en: "postgraduate", ru: "аспирант / магистрант" },
      { en: "to major in", ru: "специализироваться на" },
      { en: "tuition fees", ru: "плата за обучение" },
      { en: "scholarship", ru: "стипендия (за заслуги)" },
      { en: "to apply to university", ru: "поступать в университет" },
      { en: "to graduate from", ru: "окончить (учебное заведение)" },
      { en: "to drop out", ru: "бросить учёбу" },
      { en: "lecture", ru: "лекция" },
      { en: "seminar", ru: "семинар" },
      { en: "tutorial", ru: "практическое занятие" },
      { en: "assignment", ru: "задание" },
      { en: "to hand in", ru: "сдавать (работу)" },
      { en: "deadline", ru: "срок сдачи" },
      { en: "to sit an exam", ru: "сдавать экзамен" },
      { en: "to pass with flying colours", ru: "сдать с блеском" },
      { en: "to fail an exam", ru: "провалить экзамен" },
      { en: "to resit", ru: "пересдавать" },
      { en: "to revise", ru: "повторять к экзамену" },
      { en: "to cram", ru: "зубрить в последний момент" },
      { en: "to take notes", ru: "делать заметки" },
      { en: "to keep up with", ru: "успевать за (программой)" },
      { en: "to fall behind", ru: "отставать" },
      { en: "demanding course", ru: "сложный курс" },
      { en: "to grasp a concept", ru: "уловить понятие" },
      { en: "to get the hang of", ru: "приноровиться к" },
      { en: "steep learning curve", ru: "крутая кривая обучения" },
      { en: "hands-on experience", ru: "практический опыт" },
      { en: "trial and error", ru: "метод проб и ошибок" },
      { en: "to broaden one's horizons", ru: "расширять кругозор" },
      { en: "lifelong learning", ru: "обучение длиною в жизнь" },
      { en: "to brush up on", ru: "освежить знания" },
      { en: "self-taught", ru: "самоучка" },
      { en: "to memorise", ru: "заучивать наизусть" },
      { en: "distance learning", ru: "дистанционное обучение" },
      { en: "mature student", ru: "взрослый студент" },
      { en: "to drop a subject", ru: "отказаться от предмета" },
      { en: "academic", ru: "академический / учёный" },
      { en: "qualification", ru: "квалификация / диплом" },
      { en: "to be well-read", ru: "быть начитанным" },
      { en: "knowledgeable", ru: "хорошо осведомлённый" },
      { en: "to motivate", ru: "мотивировать" },
      { en: "to procrastinate", ru: "откладывать на потом" },
      { en: "study skills", ru: "учебные навыки" },
      { en: "to attend classes", ru: "посещать занятия" },
      { en: "curriculum", ru: "учебная программа" },
      { en: "to specialise in", ru: "специализироваться в" },
      { en: "to retain information", ru: "удерживать информацию" },
      { en: "to apply knowledge", ru: "применять знания" },
      { en: "peer", ru: "сверстник / ровесник" },
      { en: "mentor", ru: "наставник" },
      { en: "to give a presentation", ru: "делать презентацию" },
      { en: "to do research", ru: "проводить исследование" },
      { en: "gap year", ru: "год перерыва перед учёбой" },
    ],
    "финансы": [
      { en: "to earn a living", ru: "зарабатывать на жизнь" },
      { en: "income", ru: "доход" },
      { en: "expenses", ru: "расходы" },
      { en: "to make ends meet", ru: "сводить концы с концами" },
      { en: "to be on a tight budget", ru: "быть в стеснённом бюджете" },
      { en: "to budget", ru: "планировать расходы" },
      { en: "to save up for", ru: "копить на" },
      { en: "savings", ru: "сбережения" },
      { en: "to put money aside", ru: "откладывать деньги" },
      { en: "to spend money on", ru: "тратить деньги на" },
      { en: "to splash out", ru: "потратиться (на дорогое)" },
      { en: "to be broke", ru: "быть на мели" },
      { en: "to be well off", ru: "быть обеспеченным" },
      { en: "to afford", ru: "позволить себе" },
      { en: "affordable", ru: "доступный по цене" },
      { en: "overpriced", ru: "завышенный по цене" },
      { en: "good value for money", ru: "выгодная покупка" },
      { en: "bargain", ru: "выгодная сделка / находка" },
      { en: "to be in debt", ru: "быть в долгах" },
      { en: "to owe money", ru: "быть должным деньги" },
      { en: "to pay off a loan", ru: "выплатить кредит" },
      { en: "to take out a loan", ru: "взять кредит" },
      { en: "mortgage", ru: "ипотека" },
      { en: "interest rate", ru: "процентная ставка" },
      { en: "to borrow", ru: "занимать (брать в долг)" },
      { en: "to lend", ru: "одалживать (давать в долг)" },
      { en: "to pay in instalments", ru: "платить в рассрочку" },
      { en: "bill", ru: "счёт (к оплате)" },
      { en: "to settle a bill", ru: "оплатить счёт" },
      { en: "to cut back on", ru: "сокращать траты на" },
      { en: "to live within one's means", ru: "жить по средствам" },
      { en: "to live beyond one's means", ru: "жить не по средствам" },
      { en: "disposable income", ru: "располагаемый доход" },
      { en: "financial security", ru: "финансовая стабильность" },
      { en: "to invest in", ru: "вкладывать в" },
      { en: "return on investment", ru: "доход от вложений" },
      { en: "to go bankrupt", ru: "обанкротиться" },
      { en: "pension", ru: "пенсия" },
      { en: "to retire", ru: "выходить на пенсию" },
      { en: "inheritance", ru: "наследство" },
      { en: "to inherit", ru: "наследовать" },
      { en: "to be ripped off", ru: "быть обманутым (переплатить)" },
      { en: "refund", ru: "возврат денег" },
      { en: "to get into debt", ru: "влезть в долги" },
      { en: "financially independent", ru: "финансово независимый" },
      { en: "to make a fortune", ru: "сколотить состояние" },
      { en: "to waste money", ru: "транжирить деньги" },
      { en: "thrifty", ru: "бережливый" },
      { en: "extravagant", ru: "расточительный" },
      { en: "to tighten one's belt", ru: "затянуть пояс" },
      { en: "nest egg", ru: "накопления на будущее" },
      { en: "to break the bank", ru: "сильно ударить по кошельку" },
      { en: "pocket money", ru: "карманные деньги" },
      { en: "cost of living", ru: "стоимость жизни" },
      { en: "to keep track of spending", ru: "следить за тратами" },
    ],
    "характер": [
      { en: "personality trait", ru: "черта характера" },
      { en: "outgoing", ru: "общительный" },
      { en: "reserved", ru: "сдержанный / замкнутый" },
      { en: "self-confident", ru: "уверенный в себе" },
      { en: "down-to-earth", ru: "приземлённый / простой" },
      { en: "easy-going", ru: "лёгкий в общении" },
      { en: "strong-willed", ru: "волевой" },
      { en: "stubborn", ru: "упрямый" },
      { en: "considerate", ru: "внимательный к другим" },
      { en: "thoughtful", ru: "заботливый / вдумчивый" },
      { en: "selfish", ru: "эгоистичный" },
      { en: "generous", ru: "щедрый" },
      { en: "ambitious", ru: "амбициозный" },
      { en: "laid-back", ru: "расслабленный / неторопливый" },
      { en: "sensitive", ru: "чувствительный" },
      { en: "moody", ru: "с переменчивым настроением" },
      { en: "short-tempered", ru: "вспыльчивый" },
      { en: "patient", ru: "терпеливый" },
      { en: "reliable", ru: "надёжный" },
      { en: "trustworthy", ru: "заслуживающий доверия" },
      { en: "to come across as", ru: "производить впечатление" },
      { en: "to take after", ru: "быть похожим (на родственника)" },
      { en: "to have a lot in common", ru: "иметь много общего" },
      { en: "to get on someone's nerves", ru: "действовать на нервы" },
      { en: "to be in a good mood", ru: "быть в хорошем настроении" },
      { en: "to be in a bad mood", ru: "быть в плохом настроении" },
      { en: "to cheer up", ru: "приободриться" },
      { en: "to calm down", ru: "успокоиться" },
      { en: "to lose one's temper", ru: "выйти из себя" },
      { en: "to be over the moon", ru: "быть на седьмом небе" },
      { en: "to be thrilled", ru: "быть в восторге" },
      { en: "to feel down", ru: "быть подавленным" },
      { en: "to be stressed out", ru: "быть в стрессе" },
      { en: "to be fed up with", ru: "быть сытым по горло" },
      { en: "to be scared stiff", ru: "сильно испугаться" },
      { en: "to be on edge", ru: "быть на взводе" },
      { en: "overwhelmed", ru: "перегруженный (эмоционально)" },
      { en: "content", ru: "довольный" },
      { en: "anxious", ru: "тревожный" },
      { en: "frustrated", ru: "раздражённый / разочарованный" },
      { en: "to bottle up feelings", ru: "держать чувства в себе" },
      { en: "to express emotions", ru: "выражать эмоции" },
      { en: "to put someone in a good mood", ru: "поднять кому-то настроение" },
      { en: "to take things personally", ru: "принимать всё на свой счёт" },
      { en: "self-aware", ru: "осознающий себя" },
      { en: "to have a sense of humour", ru: "иметь чувство юмора" },
      { en: "to bear a grudge", ru: "затаить обиду" },
      { en: "to be at ease", ru: "чувствовать себя свободно" },
      { en: "to feel under the weather", ru: "неважно себя чувствовать" },
      { en: "to be beside oneself", ru: "быть вне себя" },
      { en: "mixed feelings", ru: "смешанные чувства" },
      { en: "to get carried away", ru: "увлечься / перестараться" },
      { en: "to keep a cool head", ru: "сохранять холодную голову" },
      { en: "to be set in one's ways", ru: "быть консервативным в привычках" },
      { en: "upbeat", ru: "жизнерадостный" },
      { en: "witty", ru: "остроумный" },
    ],
    "отношения": [
      { en: "to get on well with", ru: "хорошо ладить с" },
      { en: "to build a relationship", ru: "выстраивать отношения" },
      { en: "close friend", ru: "близкий друг" },
      { en: "to make friends", ru: "заводить друзей" },
      { en: "to lose touch with", ru: "потерять связь с" },
      { en: "to keep in touch", ru: "поддерживать связь" },
      { en: "to have a falling-out", ru: "поссориться" },
      { en: "to make up", ru: "помириться" },
      { en: "to fall out with someone", ru: "рассориться с кем-то" },
      { en: "to take sides", ru: "принимать чью-то сторону" },
      { en: "to get along", ru: "уживаться" },
      { en: "mutual", ru: "взаимный" },
      { en: "to have something in common", ru: "иметь что-то общее" },
      { en: "acquaintance", ru: "знакомый" },
      { en: "to hit it off", ru: "сразу поладить" },
      { en: "to drift apart", ru: "отдалиться друг от друга" },
      { en: "to value someone", ru: "ценить кого-то" },
      { en: "to rely on", ru: "полагаться на" },
      { en: "to trust", ru: "доверять" },
      { en: "to let someone down", ru: "подвести кого-то" },
      { en: "to support", ru: "поддерживать" },
      { en: "to be there for someone", ru: "быть рядом в нужный момент" },
      { en: "to confide in", ru: "доверять секреты" },
      { en: "to look up to", ru: "брать пример с" },
      { en: "to take someone for granted", ru: "не ценить кого-то" },
      { en: "to compromise", ru: "идти на компромисс" },
      { en: "to resolve a conflict", ru: "разрешить конфликт" },
      { en: "misunderstanding", ru: "недопонимание" },
      { en: "to clear the air", ru: "прояснить отношения" },
      { en: "to apologise for", ru: "извиняться за" },
      { en: "to forgive", ru: "прощать" },
      { en: "to hold a grudge", ru: "держать обиду" },
      { en: "to get to know someone", ru: "узнать кого-то ближе" },
      { en: "to break up with", ru: "расстаться с" },
      { en: "to be in a relationship", ru: "быть в отношениях" },
      { en: "to settle down", ru: "остепениться" },
      { en: "to propose to someone", ru: "сделать предложение" },
      { en: "to be engaged", ru: "быть помолвленным" },
      { en: "to start a family", ru: "завести семью" },
      { en: "relative", ru: "родственник" },
      { en: "to bring up children", ru: "воспитывать детей" },
      { en: "to set a good example", ru: "подавать хороший пример" },
      { en: "to stay in touch", ru: "оставаться на связи" },
      { en: "to small talk", ru: "вести светскую беседу" },
      { en: "to break the ice", ru: "растопить лёд (в общении)" },
      { en: "to get a word in", ru: "вставить слово" },
      { en: "to talk things over", ru: "всё обсудить" },
      { en: "to see eye to eye", ru: "сходиться во взглядах" },
      { en: "to agree to disagree", ru: "остаться при своих мнениях" },
      { en: "sociable", ru: "общительный" },
      { en: "to socialise", ru: "общаться / вести социальную жизнь" },
      { en: "to gossip", ru: "сплетничать" },
      { en: "to interrupt", ru: "перебивать" },
      { en: "to come to an agreement", ru: "прийти к согласию" },
      { en: "to give someone a hand", ru: "помочь кому-то" },
      { en: "to fit in", ru: "влиться (в коллектив)" },
    ],
    "технологии": [
      { en: "device", ru: "устройство" },
      { en: "gadget", ru: "гаджет" },
      { en: "to download", ru: "скачивать" },
      { en: "to upload", ru: "загружать (в сеть)" },
      { en: "app", ru: "приложение" },
      { en: "to install", ru: "устанавливать" },
      { en: "to update", ru: "обновлять" },
      { en: "to charge a device", ru: "заряжать устройство" },
      { en: "battery life", ru: "время работы батареи" },
      { en: "screen time", ru: "экранное время" },
      { en: "to scroll", ru: "листать (ленту)" },
      { en: "social media", ru: "социальные сети" },
      { en: "to post", ru: "публиковать" },
      { en: "to share", ru: "делиться (контентом)" },
      { en: "to go viral", ru: "стать вирусным" },
      { en: "to follow", ru: "подписываться (на кого-то)" },
      { en: "follower", ru: "подписчик" },
      { en: "notification", ru: "уведомление" },
      { en: "to mute notifications", ru: "отключить уведомления" },
      { en: "to log in", ru: "входить в аккаунт" },
      { en: "to sign up", ru: "регистрироваться" },
      { en: "password", ru: "пароль" },
      { en: "to back up", ru: "делать резервную копию" },
      { en: "cloud", ru: "облако (хранилище)" },
      { en: "to stream", ru: "смотреть/слушать онлайн" },
      { en: "streaming service", ru: "стриминговый сервис" },
      { en: "to browse", ru: "просматривать (в сети)" },
      { en: "search engine", ru: "поисковик" },
      { en: "to google something", ru: "загуглить что-то" },
      { en: "online shopping", ru: "онлайн-покупки" },
      { en: "to add to cart", ru: "добавить в корзину" },
      { en: "user-friendly", ru: "удобный в использовании" },
      { en: "to crash", ru: "зависать / падать (о программе)" },
      { en: "to freeze", ru: "зависать (об экране)" },
      { en: "to reboot", ru: "перезагружать" },
      { en: "glitch", ru: "сбой / глюк" },
      { en: "Wi-Fi connection", ru: "подключение к Wi-Fi" },
      { en: "to be online", ru: "быть в сети" },
      { en: "to be offline", ru: "быть вне сети" },
      { en: "to text", ru: "писать смс / сообщения" },
      { en: "video call", ru: "видеозвонок" },
      { en: "voice message", ru: "голосовое сообщение" },
      { en: "to swipe", ru: "смахивать (по экрану)" },
      { en: "touchscreen", ru: "сенсорный экран" },
      { en: "to set up", ru: "настраивать (устройство)" },
      { en: "to sync", ru: "синхронизировать" },
      { en: "to be addicted to", ru: "быть зависимым от" },
      { en: "digital detox", ru: "цифровой детокс" },
      { en: "to spend hours online", ru: "проводить часы в сети" },
      { en: "to keep up with technology", ru: "успевать за технологиями" },
      { en: "out of date", ru: "устаревший" },
      { en: "cutting-edge", ru: "передовой" },
      { en: "to multitask", ru: "делать несколько дел сразу" },
      { en: "artificial intelligence", ru: "искусственный интеллект" },
      { en: "smart home", ru: "умный дом" },
      { en: "to rely on technology", ru: "полагаться на технологии" },
      { en: "data", ru: "данные" },
      { en: "privacy", ru: "конфиденциальность" },
    ],
    "путешествия": [
      { en: "to go abroad", ru: "ехать за границу" },
      { en: "destination", ru: "место назначения" },
      { en: "to book a flight", ru: "забронировать билет" },
      { en: "to pack", ru: "собирать вещи" },
      { en: "luggage", ru: "багаж" },
      { en: "hand luggage", ru: "ручная кладь" },
      { en: "to check in", ru: "зарегистрироваться (на рейс)" },
      { en: "boarding pass", ru: "посадочный талон" },
      { en: "to catch a flight", ru: "успеть на рейс" },
      { en: "to miss a flight", ru: "опоздать на рейс" },
      { en: "delay", ru: "задержка" },
      { en: "layover", ru: "пересадка с ожиданием" },
      { en: "jet lag", ru: "смена часовых поясов" },
      { en: "travel insurance", ru: "страховка путешественника" },
      { en: "itinerary", ru: "маршрут поездки" },
      { en: "sightseeing", ru: "осмотр достопримечательностей" },
      { en: "landmark", ru: "достопримечательность" },
      { en: "to explore", ru: "исследовать" },
      { en: "off the beaten track", ru: "вдали от туристических троп" },
      { en: "breathtaking", ru: "захватывающий дух" },
      { en: "to soak up the atmosphere", ru: "впитывать атмосферу" },
      { en: "local cuisine", ru: "местная кухня" },
      { en: "to try local food", ru: "пробовать местную еду" },
      { en: "souvenir", ru: "сувенир" },
      { en: "backpacking", ru: "путешествие с рюкзаком" },
      { en: "package holiday", ru: "тур «всё включено»" },
      { en: "to travel on a budget", ru: "путешествовать экономно" },
      { en: "all-inclusive", ru: "всё включено" },
      { en: "guided tour", ru: "экскурсия с гидом" },
      { en: "to get around", ru: "передвигаться (по городу)" },
      { en: "to lose one's way", ru: "заблудиться" },
      { en: "culture shock", ru: "культурный шок" },
      { en: "to adapt to", ru: "приспосабливаться к" },
      { en: "customs and traditions", ru: "обычаи и традиции" },
      { en: "cultural differences", ru: "культурные различия" },
      { en: "to broaden the mind", ru: "расширять кругозор" },
      { en: "homesick", ru: "тоскующий по дому" },
      { en: "to settle in", ru: "обживаться" },
      { en: "to immerse oneself in", ru: "погружаться в (культуру)" },
      { en: "language barrier", ru: "языковой барьер" },
      { en: "to pick up a language", ru: "нахвататься языка" },
      { en: "hospitality", ru: "гостеприимство" },
      { en: "tourist trap", ru: "туристическая ловушка" },
      { en: "peak season", ru: "высокий сезон" },
      { en: "off-season", ru: "низкий сезон" },
      { en: "to make a reservation", ru: "сделать бронь" },
      { en: "accommodation", ru: "жильё (для проживания)" },
      { en: "to hit the road", ru: "отправиться в путь" },
      { en: "travel light", ru: "путешествовать налегке" },
      { en: "to broaden one's perspective", ru: "расширять взгляды" },
      { en: "to venture out", ru: "выбираться (на вылазку)" },
      { en: "must-see", ru: "обязательное к посещению" },
      { en: "scenery", ru: "пейзаж" },
      { en: "vibrant", ru: "яркий / оживлённый" },
      { en: "to wander around", ru: "бродить вокруг" },
      { en: "to get a feel for", ru: "прочувствовать (место)" },
    ],
    "город": [
      { en: "to settle down", ru: "осесть / обосноваться" },
      { en: "to move house", ru: "переезжать" },
      { en: "to relocate", ru: "переезжать (в другой город/страну)" },
      { en: "suburb", ru: "пригород" },
      { en: "city centre", ru: "центр города" },
      { en: "neighbourhood", ru: "район (по соседству)" },
      { en: "neighbour", ru: "сосед" },
      { en: "residential area", ru: "жилой район" },
      { en: "to rent a flat", ru: "снимать квартиру" },
      { en: "landlord", ru: "арендодатель" },
      { en: "tenant", ru: "арендатор" },
      { en: "rent", ru: "арендная плата" },
      { en: "to own a property", ru: "владеть недвижимостью" },
      { en: "mortgage", ru: "ипотека" },
      { en: "to do up a place", ru: "делать ремонт" },
      { en: "spacious", ru: "просторный" },
      { en: "cramped", ru: "тесный" },
      { en: "cosy", ru: "уютный" },
      { en: "to commute", ru: "ездить на работу (издалека)" },
      { en: "rush hour", ru: "час пик" },
      { en: "public transport", ru: "общественный транспорт" },
      { en: "traffic jam", ru: "пробка" },
      { en: "congestion", ru: "перегруженность движения" },
      { en: "pedestrian", ru: "пешеход" },
      { en: "to get around on foot", ru: "передвигаться пешком" },
      { en: "amenities", ru: "удобства / инфраструктура" },
      { en: "within walking distance", ru: "в пешей доступности" },
      { en: "lively", ru: "оживлённый" },
      { en: "bustling", ru: "шумный и активный" },
      { en: "peaceful", ru: "спокойный / тихий" },
      { en: "overcrowded", ru: "перенаселённый" },
      { en: "cost of living", ru: "стоимость жизни" },
      { en: "standard of living", ru: "уровень жизни" },
      { en: "quality of life", ru: "качество жизни" },
      { en: "fast-paced", ru: "динамичный (о ритме)" },
      { en: "urban", ru: "городской" },
      { en: "rural", ru: "сельский" },
      { en: "the countryside", ru: "сельская местность" },
      { en: "green space", ru: "зелёная зона" },
      { en: "pollution", ru: "загрязнение" },
      { en: "noise pollution", ru: "шумовое загрязнение" },
      { en: "to put down roots", ru: "пустить корни" },
      { en: "local community", ru: "местное сообщество" },
      { en: "facilities", ru: "удобства / объекты" },
      { en: "high-rise", ru: "многоэтажка" },
      { en: "to be on the outskirts", ru: "быть на окраине" },
      { en: "convenient", ru: "удобно расположенный" },
      { en: "run-down", ru: "запущенный / обветшалый" },
      { en: "up-and-coming", ru: "перспективный (о районе)" },
      { en: "to get used to", ru: "привыкать к" },
      { en: "hustle and bustle", ru: "городская суета" },
      { en: "homeowner", ru: "домовладелец" },
      { en: "to share a flat", ru: "снимать квартиру вместе" },
      { en: "flatmate", ru: "сосед по квартире" },
      { en: "utilities", ru: "коммунальные услуги" },
    ],
    "здоровье": [
      { en: "to keep fit", ru: "поддерживать форму" },
      { en: "to work out", ru: "тренироваться" },
      { en: "to take up a sport", ru: "заняться спортом" },
      { en: "to go for a run", ru: "ходить на пробежку" },
      { en: "to stay in shape", ru: "оставаться в форме" },
      { en: "to be out of shape", ru: "быть не в форме" },
      { en: "sedentary lifestyle", ru: "сидячий образ жизни" },
      { en: "active lifestyle", ru: "активный образ жизни" },
      { en: "to lead a healthy life", ru: "вести здоровый образ жизни" },
      { en: "balanced diet", ru: "сбалансированное питание" },
      { en: "to cut down on", ru: "сокращать (потребление)" },
      { en: "to give up", ru: "бросать (привычку)" },
      { en: "to put on weight", ru: "набирать вес" },
      { en: "to lose weight", ru: "худеть" },
      { en: "to watch one's diet", ru: "следить за питанием" },
      { en: "junk food", ru: "вредная еда" },
      { en: "to crave", ru: "сильно хотеть (еды)" },
      { en: "to overeat", ru: "переедать" },
      { en: "portion", ru: "порция" },
      { en: "nutritious", ru: "питательный" },
      { en: "to skip a meal", ru: "пропускать приём пищи" },
      { en: "to stay hydrated", ru: "пить достаточно воды" },
      { en: "to get enough sleep", ru: "высыпаться" },
      { en: "sleep deprivation", ru: "недосып" },
      { en: "to feel refreshed", ru: "чувствовать себя отдохнувшим" },
      { en: "to be exhausted", ru: "быть измотанным" },
      { en: "to recharge", ru: "восстанавливать силы" },
      { en: "stress", ru: "стресс" },
      { en: "to relieve stress", ru: "снимать стресс" },
      { en: "to relax", ru: "расслабляться" },
      { en: "wellbeing", ru: "благополучие" },
      { en: "mental health", ru: "психическое здоровье" },
      { en: "to look after oneself", ru: "заботиться о себе" },
      { en: "to come down with", ru: "подхватить (болезнь)" },
      { en: "to catch a cold", ru: "простудиться" },
      { en: "symptom", ru: "симптом" },
      { en: "to recover from", ru: "выздоравливать от" },
      { en: "to be on the mend", ru: "идти на поправку" },
      { en: "immune system", ru: "иммунитет" },
      { en: "to boost immunity", ru: "укреплять иммунитет" },
      { en: "checkup", ru: "медосмотр" },
      { en: "to make an appointment", ru: "записаться на приём" },
      { en: "prescription", ru: "рецепт" },
      { en: "to take up a habit", ru: "завести привычку" },
      { en: "to break a habit", ru: "избавиться от привычки" },
      { en: "addiction", ru: "зависимость" },
      { en: "to be hooked on", ru: "подсесть на" },
      { en: "moderation", ru: "умеренность" },
      { en: "in moderation", ru: "в меру" },
      { en: "to burn calories", ru: "сжигать калории" },
      { en: "posture", ru: "осанка" },
      { en: "fatigue", ru: "усталость / утомление" },
      { en: "to pull a muscle", ru: "потянуть мышцу" },
      { en: "to warm up", ru: "разминаться" },
      { en: "to cool down", ru: "делать заминку" },
      { en: "to feel run down", ru: "чувствовать себя истощённым" },
    ],
    "мнения": [
      { en: "in my opinion", ru: "по моему мнению" },
      { en: "from my point of view", ru: "с моей точки зрения" },
      { en: "as far as I'm concerned", ru: "насколько я могу судить" },
      { en: "it seems to me that", ru: "мне кажется, что" },
      { en: "I'm convinced that", ru: "я убеждён, что" },
      { en: "I'd argue that", ru: "я бы возразил, что" },
      { en: "to be honest", ru: "честно говоря" },
      { en: "personally", ru: "лично я" },
      { en: "the way I see it", ru: "как я это вижу" },
      { en: "I reckon", ru: "я считаю (разг.)" },
      { en: "it goes without saying", ru: "само собой разумеется" },
      { en: "there's no doubt that", ru: "нет сомнений, что" },
      { en: "I strongly believe", ru: "я твёрдо убеждён" },
      { en: "to make a point", ru: "высказать мысль / довод" },
      { en: "to put it simply", ru: "проще говоря" },
      { en: "on the one hand", ru: "с одной стороны" },
      { en: "on the other hand", ru: "с другой стороны" },
      { en: "to weigh up", ru: "взвешивать (за и против)" },
      { en: "pros and cons", ru: "плюсы и минусы" },
      { en: "a compelling argument", ru: "убедительный аргумент" },
      { en: "to back up an argument", ru: "подкреплять довод" },
      { en: "to make a case for", ru: "приводить доводы в пользу" },
      { en: "to play devil's advocate", ru: "выступать оппонентом ради спора" },
      { en: "to have a point", ru: "быть в чём-то правым" },
      { en: "to see your point", ru: "понимать твою мысль" },
      { en: "I see what you mean", ru: "понимаю, о чём ты" },
      { en: "fair enough", ru: "справедливо / резонно" },
      { en: "to some extent", ru: "в какой-то мере" },
      { en: "that depends", ru: "смотря по ситуации" },
      { en: "it's debatable", ru: "это спорно" },
      { en: "I beg to differ", ru: "позволю себе не согласиться" },
      { en: "I'm afraid I disagree", ru: "боюсь, я не согласен" },
      { en: "to be against", ru: "быть против" },
      { en: "to be in favour of", ru: "быть за" },
      { en: "to take a stance", ru: "занять позицию" },
      { en: "to bring up a point", ru: "поднять вопрос" },
      { en: "to get the point across", ru: "донести мысль" },
      { en: "to misunderstand", ru: "неправильно понять" },
      { en: "to clarify", ru: "прояснять" },
      { en: "to sum up", ru: "подводя итог" },
      { en: "to put it another way", ru: "иначе говоря" },
      { en: "to give an example", ru: "привести пример" },
      { en: "for instance", ru: "например" },
      { en: "needless to say", ru: "излишне говорить" },
      { en: "to be biased", ru: "быть предвзятым" },
      { en: "objective", ru: "объективный" },
      { en: "subjective", ru: "субъективный" },
      { en: "to jump to conclusions", ru: "делать поспешные выводы" },
      { en: "to have second thoughts", ru: "засомневаться" },
      { en: "to change one's mind", ru: "передумать" },
      { en: "to stand one's ground", ru: "стоять на своём" },
      { en: "to come to terms with", ru: "смириться с" },
      { en: "controversial", ru: "спорный" },
      { en: "to spark debate", ru: "вызывать споры" },
      { en: "broadly speaking", ru: "в общем говоря" },
      { en: "to bear in mind", ru: "иметь в виду" },
    ],
    "маркетинг": [
      { en: "positioning", ru: "позиционирование" },
      { en: "value proposition", ru: "ценностное предложение" },
      { en: "messaging", ru: "то, как мы говорим о продукте" },
      { en: "brand voice", ru: "голос бренда, тон коммуникации" },
      { en: "tone of voice", ru: "тональность" },
      { en: "go-to-market (GTM)", ru: "план вывода на рынок" },
      { en: "funnel", ru: "воронка" },
      { en: "top of funnel", ru: "верх воронки" },
      { en: "bottom of funnel", ru: "низ воронки, ближе к покупке" },
      { en: "drop-off", ru: "отвал, точка, где люди уходят" },
      { en: "bounce rate", ru: "показатель отказов" },
      { en: "acquisition", ru: "привлечение" },
      { en: "retention", ru: "удержание" },
      { en: "churn", ru: "отток клиентов" },
      { en: "customer acquisition cost (CAC)", ru: "стоимость привлечения клиента" },
      { en: "lifetime value (LTV)", ru: "сколько клиент приносит за всё время" },
      { en: "return on ad spend (ROAS)", ru: "окупаемость рекламных расходов" },
      { en: "attribution", ru: "атрибуция, кому засчитываем результат" },
      { en: "benchmark", ru: "ориентир, с чем сравниваем" },
      { en: "baseline", ru: "базовый уровень до изменений" },
      { en: "uplift", ru: "прирост относительно базы" },
      { en: "A/B test", ru: "A/B-тест" },
      { en: "control group", ru: "контрольная группа" },
      { en: "retargeting", ru: "ретаргетинг" },
      { en: "lookalike audience", ru: "похожая аудитория" },
      { en: "frequency cap", ru: "ограничение частоты показов" },
      { en: "nurture leads", ru: "прогревать лидов" },
      { en: "pipeline", ru: "воронка сделок" },
      { en: "forecast", ru: "прогноз" },
      { en: "scale", ru: "масштабировать" },
      { en: "iterate", ru: "дорабатывать по шагам" },
      { en: "roll out", ru: "раскатывать, выкатывать поэтапно" },
      { en: "ship", ru: "выпустить, выкатить" },
      { en: "ramp up", ru: "наращивать обороты" },
      { en: "pull the plug on smth", ru: "свернуть, отключить" },
      { en: "double down on smth", ru: "вложиться сильнее в то, что работает" },
      { en: "move the needle", ru: "дать заметный результат" },
      { en: "low-hanging fruit", ru: "то, что даёт быстрый эффект малой ценой" },
      { en: "trade-off", ru: "компромисс, чем приходится жертвовать" },
      { en: "rule of thumb", ru: "практическое правило" },
      { en: "ballpark figure", ru: "примерная цифра" },
      { en: "underperform", ru: "не дотягивать до плана" },
      { en: "outperform", ru: "обгонять план" },
      { en: "burn budget", ru: "сжигать бюджет" },
      { en: "own smth", ru: "отвечать за направление" },
      { en: "align on smth", ru: "договориться, синхронизироваться" },
      { en: "push back", ru: "возразить, не согласиться" },
      { en: "loop smb in", ru: "подключить человека к вопросу" },
      { en: "circle back", ru: "вернуться к теме позже" },
      { en: "bandwidth", ru: "свободный ресурс времени и сил" },
      { en: "heads-up", ru: "предупреждение заранее" },
      { en: "takeaway", ru: "главный вывод" },
    ],
  },
};

// --- Третий блок: деловой английский (business English), объединено из
// отдельного корпуса по уровням A1-C1, темы с приставкой деловой_ — чтобы
// не конфликтовать с уже существующими общими темами вроде 'переговоры'. ---
const SEED_SHARED_LIBRARY_BIZ_A1 = {
  difficulty: "A1",
  topics: {
    "деловой_компания": [
      { en: "department", ru: "отдел" },
      { en: "colleague", ru: "сотрудник" },
      { en: "employee", ru: "сотрудник" },
      { en: "employer", ru: "работодатель" },
    ],
    "деловой_карьера": [
      { en: "experience", ru: "опыт" },
      { en: "hire", ru: "нанять на работу\\нанимать" },
      { en: "job", ru: "работа" },
      { en: "position", ru: "должность" },
      { en: "role", ru: "роль" },
      { en: "skill", ru: "навык" },
    ],
    "деловой_задачи": [
      { en: "task", ru: "задача" },
    ],
    "деловой_переписка": [
      { en: "report", ru: "отчет" },
    ],
    "деловой_встречи": [
      { en: "meeting", ru: "встреча" },
    ],
    "деловой_маркетинг": [
      { en: "customer", ru: "покупатель\\завсегдатай" },
      { en: "market", ru: "рынок" },
      { en: "order", ru: "заказ" },
      { en: "client", ru: "клиент" },
    ],
    "деловой_финансы": [
      { en: "bank", ru: "банк" },
      { en: "account", ru: "счет" },
    ],
    "деловой_глаголы": [
      { en: "join", ru: "присоединиться" },
      { en: "money", ru: "деньги" },
      { en: "pay", ru: "выплата\\зарплата\\жалованье" },
      { en: "product", ru: "продукт\\товар" },
      { en: "service", ru: "услуга\\услуги" },
      { en: "work", ru: "работать" },
    ],
  },
};

const SEED_SHARED_LIBRARY_BIZ_A2 = {
  difficulty: "A2",
  topics: {
    "деловой_компания": [
      { en: "accounting department", ru: "бухгалтерия" },
      { en: "advertising department", ru: "отдел рекламы" },
      { en: "finance department", ru: "финансовый отдел" },
      { en: "legal department", ru: "юридический отдел" },
      { en: "marketing department", ru: "отдел маркетинга" },
      { en: "production department", ru: "производственный отдел" },
      { en: "purchasing department", ru: "отдел закупок" },
    ],
    "деловой_карьера": [
      { en: "promotion", ru: "продвижение (по службе)\\продвижение (карьерное)" },
      { en: "salary", ru: "зарплата (ежемесячная)\\заработная плата\\зарплата" },
      { en: "vacancy", ru: "вакансия" },
      { en: "wage", ru: "заработная плата (еженедельная)" },
      { en: "interview", ru: "собеседование" },
      { en: "retire", ru: "уйти на пенсию" },
    ],
    "деловой_задачи": [
      { en: "leave", ru: "уходить" },
      { en: "schedule", ru: "расписание" },
    ],
    "деловой_переписка": [
      { en: "attachment", ru: "приложение (к договору)" },
      { en: "bug report", ru: "баг-репорт" },
      { en: "discuss", ru: "обсуждать" },
      { en: "explain", ru: "объяснять" },
      { en: "feedback", ru: "обратная связь" },
      { en: "message", ru: "сообщение\\донесение\\извещение\\письмо" },
    ],
    "деловой_встречи": [
      { en: "conference", ru: "конференция" },
      { en: "attendee", ru: "участник" },
    ],
    "деловой_проекты": [
      { en: "deploy", ru: "развернуть (= не фразовый\\но рядом)\\деплой" },
      { en: "release", ru: "релиз" },
      { en: "risk", ru: "риск" },
    ],
    "деловой_маркетинг": [
      { en: "advertising (ads)", ru: "реклама" },
      { en: "after-sales service", ru: "служба послепродажного\\гарантийного обслуживания\\послепродажное обслуживание" },
      { en: "brand", ru: "торговая марка\\бренд" },
      { en: "content", ru: "содержание" },
      { en: "customer service", ru: "клиентская служба\\обслуживание потребителей" },
      { en: "deal", ru: "сделка" },
      { en: "demand", ru: "спрос" },
      { en: "discount", ru: "скидка\\дисконт" },
      { en: "marketing", ru: "маркетинг" },
      { en: "marketing research", ru: "изучение рынка" },
      { en: "proposal", ru: "предложение" },
      { en: "sale", ru: "распродажа" },
      { en: "campaign", ru: "компания (рекламная)" },
      { en: "prospect", ru: "потенциальный" },
      { en: "quote", ru: "назначенная цена" },
    ],
    "деловой_финансы": [
      { en: "budget", ru: "бюджет" },
      { en: "cash", ru: "наличные\\наличная валюта" },
      { en: "debt", ru: "долг" },
      { en: "fee", ru: "гонорар\\вознаграждение\\цена услуг" },
      { en: "income", ru: "доход\\прибыль" },
      { en: "loan", ru: "заем" },
      { en: "profit", ru: "выгода" },
      { en: "share", ru: "акция\\делиться" },
      { en: "tax", ru: "налог" },
      { en: "equity", ru: "капитал\\акция\\доля в бизнесе" },
      { en: "insurance", ru: "страховка" },
      { en: "loss", ru: "потеря" },
      { en: "payment", ru: "оплата" },
      { en: "revenue", ru: "оборот" },
      { en: "stock", ru: "фонд\\биржа" },
      { en: "yield", ru: "уступать\\выход\\результат\\прибыль" },
    ],
    "деловой_поставки": [
      { en: "delivery", ru: "доставка" },
      { en: "logistics", ru: "логистика" },
      { en: "production", ru: "производство\\продакшн" },
      { en: "supplier", ru: "поставщик" },
      { en: "supply", ru: "поставка" },
      { en: "warehouse", ru: "склад" },
    ],
    "деловой_право": [
      { en: "agreement", ru: "договор\\соглашение" },
      { en: "contract", ru: "контракт\\договор" },
      { en: "legal tender", ru: "законное платежное средство" },
      { en: "clause", ru: "пункт\\условие" },
      { en: "legal", ru: "юридический отдел" },
      { en: "policy", ru: "страховой полис" },
    ],
    "деловой_переговоры": [
      { en: "compromise", ru: "компромисс\\идти на копромисс" },
      { en: "goal", ru: "цель" },
      { en: "negotiate", ru: "вести переговоры" },
      { en: "objective", ru: "цель\\задача" },
      { en: "ownership", ru: "владение" },
      { en: "scale", ru: "масштабировать" },
      { en: "strategy", ru: "стратегия" },
      { en: "decision", ru: "решение" },
    ],
    "деловой_глаголы": [
      { en: "accept", ru: "принять (предложение)" },
      { en: "achieve", ru: "достичь" },
      { en: "action", ru: "действие" },
      { en: "administration", ru: "администрация" },
      { en: "afford", ru: "позволять" },
      { en: "any ideas?", ru: "есть идеи?" },
      { en: "application", ru: "заявление" },
      { en: "apply", ru: "подавать заявку" },
      { en: "approach", ru: "подход" },
      { en: "assembly shop", ru: "сборочный цех" },
      { en: "be broke", ru: "быть на мели\\не иметь денег" },
      { en: "because", ru: "потому что" },
      { en: "benefit", ru: "польза\\выгода" },
      { en: "billboard", ru: "рекламный щит" },
      { en: "borrow", ru: "занимать\\одалживать\\одалживать у кого-то" },
      { en: "brief", ru: "резюмировать\\краткое письменное изложение дела" },
      { en: "bring", ru: "приносить" },
      { en: "cashier", ru: "касса\\кассир" },
      { en: "charge for", ru: "взимать плату" },
      { en: "choose", ru: "выбирать" },
      { en: "clear", ru: "понятный\\ясный" },
      { en: "coin", ru: "монета" },
      { en: "commercial", ru: "коммерческий\\торговый (прил.)\\реклама на радио или tv (сущ.)\\реклама (рекламный ролик) на телевидении или радио" },
      { en: "commission", ru: "комиссионный сбор\\комиссия" },
      { en: "commitment", ru: "обязательство" },
      { en: "competition", ru: "конкуренция" },
      { en: "condition", ru: "условие" },
      { en: "confirm", ru: "подтверждать" },
      { en: "confirmation", ru: "подтверждение" },
      { en: "consumption", ru: "потребление" },
      { en: "counter-offer", ru: "встречное предложение\\ответное предложение" },
      { en: "coverage", ru: "покрытие" },
      { en: "curious", ru: "любознательный" },
      { en: "currency", ru: "валюта" },
      { en: "currently", ru: "сейчас (формально)" },
      { en: "database", ru: "бд" },
      { en: "deliver", ru: "выдавать" },
      { en: "deposit", ru: "депозит\\вклад" },
      { en: "develop", ru: "разрабатывать" },
      { en: "dispatch service", ru: "экспедиция\\служба рассылки" },
      { en: "distribution", ru: "дистрибуция\\сбыт" },
      { en: "diversify", ru: "разнообразить" },
      { en: "donate", ru: "пожертвовать\\давать на благотворительность\\дарить" },
      { en: "edge case", ru: "эдж-кейс" },
      { en: "endpoint", ru: "эндпоинт" },
      { en: "enjoy", ru: "получать удовольствие" },
      { en: "environment", ru: "окружение" },
      { en: "event", ru: "событие" },
      { en: "exchange rate", ru: "обменный курс\\курс обмена\\валютный курс" },
      { en: "factory", ru: "фабрика\\завод" },
      { en: "feature", ru: "фича" },
      { en: "fire", ru: "уволить с работы (гл.)" },
      { en: "fit", ru: "подходить" },
      { en: "flexible", ru: "гибкий" },
      { en: "flow", ru: "флоу\\процесс" },
      { en: "focus", ru: "фокусироваться" },
      { en: "for example..", ru: "например.." },
      { en: "framework", ru: "фреймворк" },
      { en: "goods", ru: "товары\\товар" },
      { en: "half", ru: "половина" },
      { en: "hands-on", ru: "практический" },
      { en: "honest", ru: "честный" },
      { en: "however", ru: "однако" },
      { en: "i disagree", ru: "я не согласен" },
      { en: "i think..", ru: "я думаю.." },
      { en: "impact", ru: "влияние\\эффект" },
      { en: "improve", ru: "улучшать" },
      { en: "in short..", ru: "короче говоря.." },
      { en: "in summary,…", ru: "в итоге…" },
      { en: "increase", ru: "увеличить" },
      { en: "inflation", ru: "инфляция" },
      { en: "integration", ru: "интеграция" },
      { en: "interest", ru: "проценты\\процентная ставка\\процент" },
      { en: "invest", ru: "инвестировать\\вкладывать" },
      { en: "issue", ru: "проблема\\выпуск\\издание (печатной продукции)" },
      { en: "key factor", ru: "ключевой показатель" },
      { en: "labour", ru: "труд" },
      { en: "launch", ru: "выпускать\\запускать (новые товары)\\запуск\\начало" },
      { en: "layout", ru: "схема\\планировка" },
      { en: "lend", ru: "давать взаймы\\одалживать\\одалживать кому-то" },
      { en: "load", ru: "нагрузка" },
      { en: "log", ru: "лог" },
      { en: "match", ru: "подходить" },
      { en: "mentor", ru: "ментор" },
      { en: "merge", ru: "мёрж" },
      { en: "microservice", ru: "микросервис" },
      { en: "mock", ru: "мок" },
      { en: "most", ru: "большинство" },
      { en: "move", ru: "двигаться\\переехать" },
      { en: "notice period", ru: "срок отработки" },
      { en: "offer", ru: "оффер" },
      { en: "onboard", ru: "онбордить" },
      { en: "open", ru: "открытый" },
      { en: "orders", ru: "отдел заказов" },
      { en: "owe", ru: "быть должным" },
      { en: "own", ru: "владеть" },
      { en: "pension benefit", ru: "пенсионное пособие" },
      { en: "percent", ru: "процент" },
      { en: "permission", ru: "разрешение" },
      { en: "pipeline", ru: "пайплайн" },
      { en: "possibility", ru: "возможность" },
      { en: "previously", ru: "раньше" },
      { en: "proactive", ru: "проактивный" },
      { en: "public relations", ru: "связи с общественностью" },
      { en: "pull request", ru: "пул-реквест" },
      { en: "purchase", ru: "покупка" },
      { en: "query", ru: "запрос (sql)" },
      { en: "receipt", ru: "чек\\квитанция\\чек об оплате" },
      { en: "recently", ru: "недавно" },
      { en: "reduce", ru: "сократить" },
      { en: "refund", ru: "возврат\\возвращать\\возмещать\\возмещение\\компенсация" },
      { en: "regression", ru: "регрессия" },
      { en: "reliable", ru: "надёжный" },
      { en: "relocate", ru: "релоцироваться" },
      { en: "remote", ru: "удалённо" },
      { en: "reproduce", ru: "воспроизводить" },
      { en: "request", ru: "запрос" },
      { en: "response", ru: "ответ" },
      { en: "responsibility", ru: "ответственность" },
      { en: "result", ru: "результат" },
      { en: "review", ru: "обзор\\обозрение\\ревью" },
      { en: "rise", ru: "рост" },
      { en: "save", ru: "экономить" },
      { en: "scenario", ru: "сценарий" },
      { en: "security", ru: "охрана" },
      { en: "serial number", ru: "серийный номер" },
      { en: "severity", ru: "серьёзность" },
      { en: "smoke test", ru: "смоук-тест" },
      { en: "speed up", ru: "ускорять" },
      { en: "staging", ru: "стейджинг" },
      { en: "strong", ru: "сильный" },
      { en: "suggest", ru: "предлагать" },
      { en: "summary", ru: "краткое изложение\\сводка" },
      { en: "support", ru: "поддержка" },
      { en: "target", ru: "цель" },
      { en: "tender", ru: "письменное предложение\\заявка\\тендер" },
      { en: "test case", ru: "тест-кейс" },
      { en: "trade", ru: "торговля" },
      { en: "trademark", ru: "торговая марка" },
      { en: "training", ru: "обучение" },
      { en: "trigger", ru: "триггер" },
      { en: "unit test", ru: "юнит-тест" },
      { en: "we could..", ru: "мы могли бы.." },
      { en: "we should..", ru: "нам следует…" },
      { en: "withdraw", ru: "снимать средства со счета\\извлекать\\снимать деньги с счета" },
      { en: "workplace", ru: "рабочее место" },
      { en: "accident", ru: "происшествие" },
      { en: "accuse", ru: "обвинять" },
      { en: "actuary", ru: "регистратор\\оценщик риска" },
      { en: "adjuster", ru: "установщик" },
      { en: "agent", ru: "агент\\представитель" },
      { en: "allege", ru: "утверждать\\заявлять" },
      { en: "announce", ru: "объявлять\\сообщать\\анонсировать\\оповещать\\извещать\\заявлять\\давать знать" },
      { en: "annuity", ru: "рента" },
      { en: "appeal", ru: "призыв\\обращение\\воззвание (к кому-л.)" },
      { en: "appendix", ru: "приложение" },
      { en: "applicant", ru: "кандидат" },
      { en: "appraisal", ru: "оценка работы" },
      { en: "article", ru: "пункт\\параграф" },
      { en: "assembly", ru: "сборка" },
      { en: "assessor", ru: "оценщик" },
      { en: "asset", ru: "актив" },
      { en: "bailiff", ru: "судебный исполнитель" },
      { en: "ballot", ru: "голосование" },
      { en: "ban", ru: "запрет" },
      { en: "banner", ru: "баннер" },
      { en: "bargain", ru: "торговаться\\выгодная покупка" },
      { en: "barrel", ru: "баррель" },
      { en: "bid", ru: "предлагаемая цена" },
      { en: "bitcoin", ru: "цифровая валюта" },
      { en: "bond", ru: "облигация" },
      { en: "bonus", ru: "бонус\\поощрение" },
      { en: "brochures", ru: "брошюры" },
      { en: "buyer", ru: "покупатель" },
      { en: "capital", ru: "капитал" },
      { en: "carriage", ru: "перевозка" },
      { en: "carrier", ru: "перевозчик" },
      { en: "case", ru: "дело" },
      { en: "catchy", ru: "навязчивый" },
      { en: "change", ru: "сдача" },
      { en: "charges", ru: "официальные обвинения" },
      { en: "claim", ru: "требовать" },
      { en: "clearance", ru: "разрешение" },
      { en: "clever", ru: "умный" },
      { en: "close", ru: "подписание сделки" },
      { en: "commuter", ru: "лицо\\совершающее регулярные поездки (в пределах населённого пункта или района)" },
      { en: "complaint", ru: "жалоба" },
      { en: "comply", ru: "соглашаться\\уступать" },
      { en: "condemn", ru: "приговаривать\\осуждать" },
      { en: "confront", ru: "противостоять" },
      { en: "consignee", ru: "грузополучатель" },
      { en: "consumer", ru: "потребитель" },
      { en: "container", ru: "контейнер" },
      { en: "convict", ru: "осужденный" },
      { en: "cordially", ru: "вежливо\\обходительно" },
      { en: "coupon", ru: "купон" },
      { en: "covenant", ru: "пакт" },
      { en: "cover", ru: "покрывать" },
      { en: "creative", ru: "творческий" },
      { en: "custody", ru: "заключение\\арест" },
      { en: "customs", ru: "таможня" },
      { en: "deadlock", ru: "тупик" },
      { en: "deck", ru: "палуба" },
      { en: "defect", ru: "брак" },
      { en: "defendant", ru: "подзащитный" },
      { en: "demands", ru: "требования" },
      { en: "departure", ru: "отправление" },
      { en: "dispute", ru: "спор\\конфликт" },
      { en: "dividend", ru: "дивиденд" },
      { en: "dock", ru: "док" },
      { en: "dumping", ru: "демпинг\\продажа товаров по искусственно заниженным ценам" },
      { en: "duty", ru: "сбор" },
      { en: "earn", ru: "зарабатывать" },
      { en: "editor", ru: "редактор" },
      { en: "effective", ru: "эффективный" },
      { en: "elaborate", ru: "тщательно разработанный" },
      { en: "enact", ru: "предписывать" },
      { en: "equities", ru: "акции" },
      { en: "estimate", ru: "приблизительная цена" },
      { en: "evidence", ru: "доказательства\\улики" },
      { en: "exotic", ru: "экзотичный" },
      { en: "exports", ru: "экспорт" },
      { en: "extranet", ru: "экстрасеть" },
      { en: "feasible", ru: "реализуемый\\возможный\\выполнимый" },
      { en: "features", ru: "характеристики\\черты\\особенности" },
      { en: "felony", ru: "тяжкое уголовное преступление" },
      { en: "fine", ru: "штраф" },
      { en: "fiver", ru: "пятёрик" },
      { en: "flexitime", ru: "гибкий график" },
      { en: "franchise", ru: "франшиза" },
      { en: "freelance", ru: "фрилансер\\самозанятый" },
      { en: "freight", ru: "груз" },
      { en: "fulfil", ru: "выполнять" },
      { en: "funny", ru: "забавный" },
      { en: "futures", ru: "фьючерсы\\сделки на срок" },
      { en: "guarantee", ru: "гарантия" },
      { en: "guilty", ru: "виновен" },
      { en: "haggle", ru: "торговаться" },
      { en: "handbills", ru: "раздаточный материал" },
      { en: "handouts", ru: "раздаточный материал" },
      { en: "hearing", ru: "слушание" },
      { en: "herein", ru: "здесь\\при этом" },
      { en: "hereto", ru: "к этому" },
      { en: "higgle", ru: "торговаться" },
      { en: "humorous", ru: "смешной" },
      { en: "hype", ru: "усиленная реклама" },
      { en: "imports", ru: "импорт" },
      { en: "imprison", ru: "тюремное заключение" },
      { en: "indemnity", ru: "возмещение" },
      { en: "indict", ru: "обвинять" },
      { en: "infringe", ru: "нарушать" },
      { en: "injury", ru: "травма" },
      { en: "innocent", ru: "невиновен" },
      { en: "input", ru: "вклад" },
      { en: "insider", ru: "инсайдер\\свой человек" },
      { en: "investor", ru: "инвестор" },
      { en: "ipo", ru: "первичное публичное размещение" },
      { en: "item", ru: "пункт\\новость\\сообщение в газете" },
      { en: "jingle", ru: "легкий для запоминания рингтон" },
      { en: "judge", ru: "судья" },
      { en: "jury", ru: "присяжные" },
      { en: "justice", ru: "правосудие" },
      { en: "leaflets", ru: "листовки" },
      { en: "liaise", ru: "договариваться" },
      { en: "magazine", ru: "журнал" },
      { en: "monopoly", ru: "монополия" },
      { en: "moorage", ru: "причал" },
      { en: "morale", ru: "мотивация" },
      { en: "mortgage", ru: "ипотека" },
      { en: "motto", ru: "девиз" },
      { en: "mutual", ru: "обоюдный" },
      { en: "newspaper", ru: "газета" },
      { en: "objection", ru: "препятствие\\преграда\\трудность" },
      { en: "option", ru: "вариант" },
      { en: "original", ru: "оригинальный" },
      { en: "outdoors", ru: "внешняя реклама" },
      { en: "outlet", ru: "магазин\\точка продаж" },
      { en: "output", ru: "результат" },
      { en: "overcome", ru: "преодолеть" },
      { en: "overheads", ru: "накладные расходы" },
      { en: "overload", ru: "перегруженность" },
      { en: "overrule", ru: "отклонить" },
      { en: "packaging", ru: "упаковка" },
      { en: "party", ru: "сторона" },
      { en: "payee", ru: "получатель платежа\\выгооприобретатель" },
      { en: "payload", ru: "полезная нагрузка" },
      { en: "payroll", ru: "начисление заработной платы" },
      { en: "pension", ru: "пенсия" },
      { en: "plaintiff", ru: "обвинитель" },
      { en: "plant", ru: "завод" },
      { en: "plead", ru: "ходатайствовать" },
      { en: "pop-up", ru: "всплывающее окно (на компьютере)" },
      { en: "porterage", ru: "переноска груза" },
      { en: "portfolio", ru: "портфель" },
      { en: "poster", ru: "плакат" },
      { en: "powerful", ru: "мощный" },
      { en: "probate", ru: "утверждение завещания" },
      { en: "prosecute", ru: "преследовать в судебном порядке" },
      { en: "prospects", ru: "перспективы" },
      { en: "range", ru: "ассортимент" },
      { en: "rebate", ru: "скидка" },
      { en: "receptive", ru: "открытый\\восприимчивый" },
      { en: "recession", ru: "рецессия" },
      { en: "recipient", ru: "получатель" },
      { en: "resolve", ru: "разрешать" },
      { en: "retail", ru: "розничная продажа" },
      { en: "revocable", ru: "отзывный" },
      { en: "romantic", ru: "романтичный" },
      { en: "round-up", ru: "сводка новостей в газете\\по радио" },
      { en: "sample", ru: "образец" },
      { en: "sender", ru: "отправитель" },
      { en: "sentence", ru: "приговор" },
      { en: "shipment", ru: "перевозка" },
      { en: "slogan", ru: "слоган" },
      { en: "solicitor", ru: "юрисконсульт" },
      { en: "speculate", ru: "спекулировать" },
      { en: "statement", ru: "выписка" },
      { en: "stipulate", ru: "ставить условием" },
      { en: "subsidy", ru: "дотация" },
      { en: "sue", ru: "предъявлять иск" },
      { en: "surcharge", ru: "доплата" },
      { en: "tactics", ru: "тактика" },
      { en: "tagline", ru: "девиз" },
      { en: "tare", ru: "тара" },
      { en: "tenant", ru: "арендатор" },
      { en: "tenner", ru: "червонец" },
      { en: "tension", ru: "напряжение" },
      { en: "tester", ru: "тестер" },
      { en: "testify", ru: "свидетельствовать" },
      { en: "tip", ru: "чаевые" },
      { en: "toll-free", ru: "беспошлинный" },
      { en: "trader", ru: "торговец" },
      { en: "trainee", ru: "тренируемый" },
      { en: "trainer", ru: "тренер" },
      { en: "trial", ru: "судебное разбирательство" },
      { en: "turnover", ru: "оборот" },
      { en: "ultimatum", ru: "ультиматум" },
      { en: "unpack", ru: "распаковать" },
      { en: "unpaid", ru: "неоплаченный" },
      { en: "verdict", ru: "вердикт" },
      { en: "victory", ru: "победа" },
      { en: "vote", ru: "голосовать" },
      { en: "wages", ru: "заработная плата" },
      { en: "warrant", ru: "гарантировать" },
      { en: "waste", ru: "отходы" },
      { en: "weight", ru: "вес" },
      { en: "whereas", ru: "тогда как" },
      { en: "wholesale", ru: "оптовая продажа" },
      { en: "witness", ru: "свидетель" },
      { en: "witty", ru: "остроумный" },
    ],
  },
};

const SEED_SHARED_LIBRARY_BIZ_B1 = {
  difficulty: "B1",
  topics: {
    "деловой_компания": [
      { en: "cae (chief audit executive)", ru: "директор по аудиту" },
      { en: "ceo (chief executive officer)", ru: "генеральный директор\\главное должностное лицо компании" },
      { en: "ctl (country team leader)", ru: "заведующий территориальным отделом (в международных организациях)" },
      { en: "eam (external asset manager)", ru: "независимый распорядитель активами" },
      { en: "ed (executive director)", ru: "исполнительный директор" },
      { en: "let's get down to business", ru: "давайте приступим к делу" },
      { en: "sales & distribution department", ru: "отдел сбыта" },
      { en: "tl (team leader)", ru: "заведующий отделом\\руководитель проекта" },
      { en: "department heads", ru: "главы отделов" },
      { en: "department store", ru: "универсальный магазин" },
      { en: "exchange office / bureau de change", ru: "обменный пункт" },
      { en: "executive management", ru: "исполнительное руководство" },
      { en: "i am a team player", ru: "я командный игрок" },
      { en: "permanent staff", ru: "постоянные сотрудники" },
      { en: "personnel, staff", ru: "персонал" },
      { en: "typical departments of a company", ru: "наименование отделов компании" },
    ],
    "деловой_карьера": [
      { en: "a full-time job", ru: "полная занятость" },
      { en: "a part-time job", ru: "частичная занятость" },
      { en: "basic salary", ru: "базовая\\основная заработная плата" },
      { en: "curriculum vitae (cv), resume", ru: "резюме" },
      { en: "hire, employ, take on", ru: "нанимать на работу" },
      { en: "in my experience… / i find that…", ru: "по моему опыту…\\я считаю\\что…" },
      { en: "interview smb", ru: "брать интервью у кого-либо" },
      { en: "job evaluation", ru: "оценка работы" },
      { en: "job profile", ru: "профиль\\описание работы\\занимаемой должности" },
      { en: "job satisfaction", ru: "удовлетворенность работой" },
      { en: "job security", ru: "гарантии занятости" },
      { en: "resign, quit", ru: "увольняться по собственному желанию" },
      { en: "to apply for a job", ru: "подать документы на работу" },
      { en: "to fill a vacancy", ru: "заполнить вакансию" },
    ],
    "деловой_задачи": [
      { en: "deadline", ru: "срок\\конечный срок\\крайний срок исполнения\\крайний срок\\дедлайн" },
      { en: "priority", ru: "приоритет" },
      { en: "thank you for your time", ru: "спасибо за уделенное время" },
      { en: "we're behind schedule", ru: "мы отстаем от графика" },
      { en: "a daily political commentary", ru: "ежедневный политический комментарий" },
      { en: "actually, if you could just let me finish…", ru: "если вы дадите мне закончить\\то…" },
      { en: "day shift", ru: "дневная смена" },
      { en: "full-time employment", ru: "полная занятость" },
      { en: "just-in-time", ru: "своевременный" },
      { en: "maternity leave", ru: "декретный отпуск" },
      { en: "part-time employment", ru: "неполная занятость" },
      { en: "please let him finish what he was saying", ru: "пожалуйста\\дайте ему закончить" },
      { en: "put off, postpone (meeting)", ru: "отложить" },
      { en: "sick leave", ru: "отсутствовать по болезни" },
      { en: "to be on sick leave", ru: "отсутствие по болезни" },
      { en: "weekly magazine", ru: "еженедельный журнал" },
    ],
    "деловой_переписка": [
      { en: "could you clarify that?", ru: "не могли бы вы прояснить (объяснить) это?" },
      { en: "direct report", ru: "подчиненный" },
      { en: "happy to jump on a call", ru: "готов позвонить" },
      { en: "i'll give you a call", ru: "я вам позвоню" },
      { en: "i'll keep you posted", ru: "буду держать в курсе" },
      { en: "i'll send you an e-mail", ru: "я пошлю вам электронное письмо" },
      { en: "incident report", ru: "отчет об инциденте" },
      { en: "let's keep in touch by e-mail", ru: "будем держать связь по электронной почте" },
      { en: "loop in", ru: "включить в переписку" },
      { en: "on-call", ru: "дежурство" },
      { en: "poc (point of contact)", ru: "ответственный" },
      { en: "reach out", ru: "связаться" },
      { en: "we need to discuss..", ru: "нам нужно обсудить.." },
      { en: "call off, cancel (meeting)", ru: "отменить" },
      { en: "call to action", ru: "призыв к действию" },
      { en: "email marketing", ru: "email-маркетинг" },
      { en: "follow up", ru: "завершать\\последовать\\уточнить" },
      { en: "i'd like to get your feedback on…", ru: "я хотел бы узнать ваше мнение о…" },
      { en: "in reply to your request, …", ru: "в ответ на ваш запрос\\…" },
      { en: "key message", ru: "ключевое сообщение" },
      { en: "report on", ru: "оповещать о…" },
      { en: "to follow up on my previous email..", ru: "по поводу предыдущего письма.." },
      { en: "to inform of", ru: "сообщать о" },
    ],
    "деловой_встречи": [
      { en: "agenda", ru: "повестка дня" },
      { en: "i really enjoyed meeting you", ru: "я был очень рад нашей встрече" },
      { en: "minutes", ru: "протокол совещания\\протокол" },
      { en: "our next meeting will be…", ru: "следующее совещание состоится…" },
      { en: "retrospective / retro", ru: "ретроспектива" },
      { en: "stand-up", ru: "ежедневный статус\\стендап" },
      { en: "this is out of the question", ru: "об этом не может быть и речи" },
      { en: "this question is off the point", ru: "этот вопрос не по существу" },
      { en: "what's next on the agenda?", ru: "что у нас далее на повестке дня?" },
      { en: "a comment on the international situation", ru: "комментарий по поводу международной ситуации" },
      { en: "a disputable question", ru: "спорный вопрос" },
      { en: "adjourn (meeting)", ru: "временно прервать" },
      { en: "annual general meeting (a.g.m.)", ru: "годовое общее собрание" },
      { en: "attend (meeting)", ru: "посещать" },
      { en: "bring forward", ru: "перенести (meeting) на более раннюю дату" },
      { en: "chair, lead (meeting)", ru: "вести" },
      { en: "chairman chairperson; chair", ru: "председатель совещания" },
      { en: "circulate (agenda)", ru: "передавать" },
      { en: "i've called this meeting in order to…", ru: "я созвал это совещание\\чтобы…" },
      { en: "interrupt (meeting)", ru: "прервать\\перебить" },
      { en: "set up (meeting)", ru: "созвать" },
      { en: "skip (meeting)", ru: "пропустить\\прогулять" },
    ],
    "деловой_проекты": [
      { en: "backlog", ru: "очередь задач" },
      { en: "bottleneck", ru: "узкое место" },
      { en: "capacity", ru: "мощность" },
      { en: "cqo (chief quality officer)", ru: "начальник отк" },
      { en: "crmo (chief risk management officer)", ru: "директор по управлению рисками" },
      { en: "deliverable", ru: "результат\\выход" },
      { en: "how is the project coming along?", ru: "как обстоят дела с проектом?" },
      { en: "i take ownership of quality", ru: "я беру ответственность за качество" },
      { en: "kpi", ru: "ключевой показатель" },
      { en: "milestone", ru: "контрольная точка" },
      { en: "scope", ru: "объем\\границы" },
      { en: "scope creep", ru: "неконтролируемое расширение" },
      { en: "sprint", ru: "спринт (agile)\\спринт" },
      { en: "timeline", ru: "график\\план" },
      { en: "full capacity", ru: "полная мощность" },
      { en: "owner's risk", ru: "риск владельца" },
      { en: "production process", ru: "производственный процесс" },
      { en: "spare capacity", ru: "резервная мощность" },
      { en: "to issue/release a statement", ru: "опубликовать заявление" },
    ],
    "деловой_маркетинг": [
      { en: "brand awareness", ru: "уровень узнаваемости бренда\\узнаваемость бренда" },
      { en: "client / customer", ru: "клиент" },
      { en: "lead", ru: "лид\\ответственный" },
      { en: "advertisement (ad, advert)", ru: "реклама" },
      { en: "at a discount", ru: "по скидке" },
      { en: "banner ads", ru: "баннерная реклама" },
      { en: "be out of order", ru: "быть неисправным\\не работать" },
      { en: "bear market", ru: "рынок с понижательной тенденцией" },
      { en: "black market", ru: "теневой рынок" },
      { en: "brand lift", ru: "рост метрик бренда" },
      { en: "bull market", ru: "рынок\\характеризующийся тенденцией роста цен" },
      { en: "cash market", ru: "наличный рынок" },
      { en: "content strategy", ru: "контент-стратегия" },
      { en: "conversion", ru: "конверсия" },
      { en: "cost per acquisition", ru: "стоимость привлечения" },
      { en: "direct sales", ru: "прямые продажи" },
      { en: "door-to-door sales", ru: "прямые продажи" },
      { en: "forward market", ru: "срочный рынок" },
      { en: "in-app content", ru: "контент внутри приложения" },
      { en: "influencer marketing", ru: "маркетинг влияния" },
      { en: "market share", ru: "доля рынка" },
      { en: "paid ads", ru: "платная реклама" },
      { en: "payment order", ru: "платежное поручение" },
      { en: "performance ads", ru: "перформанс-реклама" },
      { en: "run a campaign", ru: "запустить кампанию" },
      { en: "social media", ru: "социальные сети" },
      { en: "target audience", ru: "целевая аудитория" },
      { en: "trial order", ru: "пробный заказ" },
      { en: "video content", ru: "видеоконтент" },
    ],
    "деловой_финансы": [
      { en: "bank note / bill", ru: "банкнота" },
      { en: "can i share an idea?", ru: "могу я поделиться идеей?" },
      { en: "cfo (chief financial officer)", ru: "финансовый директор" },
      { en: "cfs (credit file supervisor)", ru: "старший кредитный инспектор" },
      { en: "cost-effective", ru: "экономично эффективный" },
      { en: "roi", ru: "окупаемость" },
      { en: "account overdraft", ru: "задолженность банку" },
      { en: "bank account", ru: "банковский счет" },
      { en: "bank charges", ru: "банковская комиссия" },
      { en: "bank clearance", ru: "банковское оформление" },
      { en: "bargain price", ru: "цена с уступкой" },
      { en: "bedrock price", ru: "наименьшая возможная цена" },
      { en: "budget deficit", ru: "дефицит бюджета" },
      { en: "budget surplus", ru: "бюджетный избыток" },
      { en: "capital gain, loss", ru: "капитальная прибыль\\убыль" },
      { en: "cash machine / dispenser (uk)", ru: "банкомат" },
      { en: "commercial bank", ru: "коммерческий банк" },
      { en: "consular invoice", ru: "консульский счет" },
      { en: "current account (gb), checking account (us)", ru: "текущий счет" },
      { en: "income tax", ru: "подоходный налог" },
      { en: "merchant bank", ru: "торгово-финансовый банк" },
      { en: "mutual fund", ru: "взаимный\\общий фонд" },
      { en: "petty cash", ru: "деньги на мелкие расходы" },
      { en: "price fixing", ru: "фиксация цен" },
      { en: "price list", ru: "наименование цен" },
      { en: "price tag", ru: "ценник" },
      { en: "redundancy payment", ru: "пособие по увольнению\\безработице" },
      { en: "to bank", ru: "класть в банк" },
      { en: "to cash a cheque", ru: "обналичить чек" },
      { en: "to grant a loan", ru: "предоставить кредит" },
      { en: "to refund for a loss", ru: "компенсация\\возмещение потери" },
    ],
    "деловой_поставки": [
      { en: "vendor", ru: "вендор" },
      { en: "chain of production", ru: "производственная цепь" },
      { en: "large scale production", ru: "крупномасштабное производство" },
      { en: "lean production", ru: "бережное (безотходное) производство" },
      { en: "maintenance", ru: "обслуживание" },
      { en: "operations or production", ru: "операции и производство" },
      { en: "store, warehouse", ru: "склад" },
    ],
    "деловой_право": [
      { en: "clo (chief legal officer)", ru: "руководитель юридического отдела" },
      { en: "nda", ru: "соглашение о неразглашке" },
      { en: "bilateral agreement", ru: "двухстороннее соглашение" },
      { en: "come to terms with", ru: "примириться" },
      { en: "conditions, terms", ru: "условия" },
      { en: "fiscal policy", ru: "финансово-бюджетная политика" },
      { en: "implied terms", ru: "подразумеваемые условия" },
    ],
    "деловой_переговоры": [
      { en: "accountability", ru: "ответственность" },
      { en: "alignment", ru: "согласованность" },
      { en: "consensus", ru: "консенсус\\согласие\\общее\\совместное соглашение" },
      { en: "cspo (chief strategic planning officer)", ru: "директор по стратегическому развитию" },
      { en: "our main goal today is to…", ru: "наша главная цель сегодня…" },
      { en: "trade-off", ru: "компромисс\\взаимные уступки" },
      { en: "board of directors", ru: "совет директоров" },
    ],
    "деловой_глаголы": [
      { en: "action item", ru: "задача для выполнения" },
      { en: "actually, i've nearly finished", ru: "я почти закончил" },
      { en: "all-hands", ru: "общее собрание" },
      { en: "as discussed", ru: "как обсуждалось" },
      { en: "asap", ru: "как можно быстрее" },
      { en: "bandwidth", ru: "нагрузка\\возможность" },
      { en: "briefing", ru: "информирование" },
      { en: "buy-in", ru: "поддержка" },
      { en: "can i raise a point here?", ru: "могу я высказать свое мнение?" },
      { en: "can we sync on this?", ru: "можем обсудить?" },
      { en: "cc / copy in", ru: "поставить в копию" },
      { en: "cdo (chief data officer)", ru: "директор по обработке и анализу данных" },
      { en: "cheque / check / bill", ru: "чек" },
      { en: "chro (chief human resources officer)", ru: "руководитель отдела подбора персонала" },
      { en: "cio (chief information officer)", ru: "директор ит-отдела" },
      { en: "circle back", ru: "вернуться к вопросу" },
      { en: "ciso", ru: "директор инф. безопасности" },
      { en: "cko (chief knowledge officer)", ru: "директор по управлению интеллектуальными ресурсами" },
      { en: "coo (chief operating officer)", ru: "исполнительный директор\\главный инженер (на предприятии)" },
      { en: "could i add something here?", ru: "могу я кое-что добавить?" },
      { en: "could you repeat, please?", ru: "повторите\\пожалуйста" },
      { en: "cpa (certified public accountant)", ru: "дипломированный бухгалтер-аудитор" },
      { en: "cpc (chief professional consultant)", ru: "главный специалист-консультант" },
      { en: "critical", ru: "критический" },
      { en: "cro (chief research officer)", ru: "директор по научным исследованиям\\научный руководитель" },
      { en: "cross-functional", ru: "межфункциональный" },
      { en: "csa (chief software architect)", ru: "главный архитектор программного обеспечения" },
      { en: "cso (chief security officer)", ru: "директор по обеспечению безопасности\\начальник службы безопасности" },
      { en: "cto", ru: "технический директор" },
      { en: "cto (chief technical officer)", ru: "главный инженер\\технический директор" },
      { en: "debrief", ru: "разбор после инцидента" },
      { en: "do you have any suggestions?", ru: "у вас есть предложения?" },
      { en: "does anyone have any comments?", ru: "у кого-нибудь есть комментарии?" },
      { en: "does everyone agree on that?", ru: "все с этим согласны?" },
      { en: "downtime", ru: "простой" },
      { en: "eod", ru: "к концу дня" },
      { en: "escalate", ru: "эскалировать" },
      { en: "eta", ru: "примерное время" },
      { en: "first... second... third..", ru: "во-первых... во-вторых.." },
      { en: "follow-up", ru: "последующий шаг" },
      { en: "from my point of view…", ru: "с моей точки зрения…" },
      { en: "fyi", ru: "для сведения" },
      { en: "go ahead", ru: "продолжайте\\продолжать\\приступать" },
      { en: "going forward", ru: "в дальнейшем" },
      { en: "good point!", ru: "хорошо сказано!" },
      { en: "greenlight", ru: "дать добро" },
      { en: "hand-off", ru: "передача" },
      { en: "headcount", ru: "штатная численность" },
      { en: "heads-up", ru: "предупреждение" },
      { en: "how do you say... in english?", ru: "как сказать... по-английски?" },
      { en: "human resources (hr)", ru: "отдел персонала" },
      { en: "i agree", ru: "я согласен" },
      { en: "i am a hands-on engineer", ru: "я практический инженер" },
      { en: "i am flexible with the format", ru: "я гибкий по формату" },
      { en: "i built a framework from zero", ru: "я построил фреймворк с нуля" },
      { en: "i don't mean to interrupt, but…", ru: "не хотелось бы прерывать\\но…" },
      { en: "i enjoy hard problems", ru: "мне нравятся трудные задачи" },
      { en: "i have no objection to that", ru: "у меня нет возражений против этого" },
      { en: "i mentored junior engineers", ru: "я менторил джуниоров" },
      { en: "i recommend that..", ru: "я рекомендую.." },
      { en: "i strongly believe that…", ru: "я твердо уверен\\что…" },
      { en: "i suggest that..", ru: "я предлагаю.." },
      { en: "i tend to think that…", ru: "я склонен думать\\что…" },
      { en: "i think that's a good idea", ru: "думаю\\это хорошая идея" },
      { en: "i want to grow in fintech", ru: "я хочу расти в финтехе" },
      { en: "i wanted to flag..", ru: "хотел обратить внимание на.." },
      { en: "i would like to introduce…", ru: "я хотел бы представить…" },
      { en: "i would like to propose that..", ru: "я хотел бы предложить.." },
      { en: "i'll circle back by eod", ru: "вернусь к этому к концу дня" },
      { en: "i'll defer to you on that", ru: "в этом полагаюсь на тебя" },
      { en: "i'll take it from here", ru: "дальше занимаюсь я" },
      { en: "i'm convinced that…", ru: "я убежден\\что…" },
      { en: "i'm positive that…", ru: "я уверен\\что…" },
      { en: "i'm sorry, but i completely disagree", ru: "простите\\но я совершенно не согласен" },
      { en: "in-house", ru: "своими силами" },
      { en: "information technology (it)", ru: "отдел информационных технологий" },
      { en: "it seems to me that…", ru: "мне кажется\\что…" },
      { en: "it's a pleasure to welcome…", ru: "рад приветствовать…" },
      { en: "it's been nice talking to you", ru: "было приятно с вами пообщаться" },
      { en: "it's possible that…", ru: "возможно\\что…" },
      { en: "just to confirm..", ru: "хочу подтвердить.." },
      { en: "kick-off", ru: "стартовое совещание" },
      { en: "lessons learned", ru: "выводы\\уроки" },
      { en: "let me loop you in", ru: "включу тебя в переписку" },
      { en: "let's get started", ru: "давайте начнем" },
      { en: "let's get to the point", ru: "давайте перейдем к сути" },
      { en: "managed service", ru: "управляемый сервис" },
      { en: "ofs (operations file supervisor)", ru: "кредитный инспектор" },
      { en: "okr", ru: "цели и результаты" },
      { en: "ol (operation leader)", ru: "руководитель проектной группы" },
      { en: "on the same page", ru: "понимать одинаково" },
      { en: "onboarding", ru: "ввод" },
      { en: "one moment, please", ru: "минутку" },
      { en: "one-on-one / 1:1", ru: "индивидуальная встреча" },
      { en: "outsource", ru: "отдать на аутсорсинг" },
      { en: "overhead", ru: "накладные расходы" },
      { en: "owner", ru: "ответственный" },
      { en: "p0 / p1 / p2", ru: "уровень приоритета" },
      { en: "per (your request)", ru: "согласно" },
      { en: "performance review", ru: "оценка эффективности" },
      { en: "ping", ru: "написать\\сообщить" },
      { en: "please find attached..", ru: "во вложении.." },
      { en: "please join me in welcoming…", ru: "давайте поприветствуем…" },
      { en: "post-mortem", ru: "разбор после инцидента" },
      { en: "public relations (pr)", ru: "отдел связей с общественностью" },
      { en: "pushback", ru: "отпор\\несогласие" },
      { en: "research & development (r&d)", ru: "научно-исследовательский отдел" },
      { en: "rfp", ru: "запрос предложений" },
      { en: "root cause", ru: "первопричина" },
      { en: "rpo", ru: "целевая точка восстановления" },
      { en: "rto", ru: "целевое время восстановления" },
      { en: "sign-off", ru: "одобрение" },
      { en: "sla", ru: "соглашение об уровне" },
      { en: "so, we've decided to…", ru: "итак\\мы решили.." },
      { en: "so, what you are saying is…", ru: "итак\\вы хотите сказать\\что…" },
      { en: "sorry, could you repeat that please?", ru: "извините\\не могли бы вы повторить\\пожалуйста?" },
      { en: "sorry. i don't agree with you", ru: "извините\\я не согласен с вами" },
      { en: "sow", ru: "техническое задание" },
      { en: "stakeholder", ru: "заинтересованная сторона" },
      { en: "svp (senior vice-president)", ru: "первый вице-президент" },
      { en: "sync", ru: "обсудить\\согласовать" },
      { en: "take offline", ru: "обсудить отдельно" },
      { en: "tbd", ru: "еще не решено" },
      { en: "thank you for your participation", ru: "спасибо за ваше участие" },
      { en: "that covers my main points", ru: "это основное от меня" },
      { en: "that will be all for today", ru: "на сегодня это все" },
      { en: "that's a fair point", ru: "разумное замечание" },
      { en: "that's exactly how i see it", ru: "именно так я это и вижу" },
      { en: "the conclusion is…", ru: "вывод таков…" },
      { en: "third party", ru: "третья сторона" },
      { en: "to sum up…", ru: "подводя итоги…" },
      { en: "touch base", ru: "связаться\\обменяться" },
      { en: "unfortunately, i see it differently", ru: "к сожалению\\я вижу это по-другому" },
      { en: "uptime", ru: "время работы" },
      { en: "vp (vice president)", ru: "вице-президент" },
      { en: "wait a minute. we haven't discussed…", ru: "подождите\\мы еще не обсудили.." },
      { en: "walkthrough", ru: "пошаговый разбор" },
      { en: "war room", ru: "оперативный штаб" },
      { en: "we'll be in touch", ru: "мы будем на связи" },
      { en: "we're going to…", ru: "мы собираемся.." },
      { en: "we're on track", ru: "мы идем по плану" },
      { en: "what are your thoughts about… ?", ru: "что вы думаете о…?" },
      { en: "what are your views on… ?", ru: "каковы ваши взгляды на… ?" },
      { en: "what does everyone think about…?", ru: "что все думают о…?" },
      { en: "what needs to be done?", ru: "что необходимо сделать?" },
      { en: "what should we do about it?", ru: "как нам следует с этим поступить?" },
      { en: "what's the status on x?", ru: "как дела с x?" },
      { en: "workaround", ru: "обходное решение" },
      { en: "you're absolutely right", ru: "вы абсолютно правы" },
      { en: "a leading article", ru: "передовая статья" },
      { en: "a tass statement", ru: "заявление тасс" },
      { en: "ab initio (ab init)", ru: "сначала" },
      { en: "absenteeism", ru: "отсутствие на работе" },
      { en: "accident at work", ru: "происшествие на работе" },
      { en: "actually, while we are on the subject of…", ru: "вообще-то\\раз уж мы затронули тему…" },
      { en: "ad recall", ru: "запоминаемость рекламы" },
      { en: "agribusiness", ru: "агробизнес" },
      { en: "alternatives", ru: "альтернатива" },
      { en: "an article on jazz music", ru: "статья о джазовой музыке" },
      { en: "an economic/political article", ru: "экономическая\\политическая статья" },
      { en: "an editorial", ru: "передовая статья" },
      { en: "announcement", ru: "объявление\\сообщение\\извещение\\уведомление" },
      { en: "antitrust law", ru: "антитрестовский закон" },
      { en: "application form", ru: "аппликационная форма" },
      { en: "apply for", ru: "подать документы на" },
      { en: "apprenticeship", ru: "ученичество\\курс подмастерья" },
      { en: "arbitration", ru: "арбитраж" },
      { en: "article on", ru: "статья о…" },
      { en: "assess a damage", ru: "оценка повреждения" },
      { en: "assessment", ru: "оценка" },
      { en: "assessment of applicants", ru: "оценка кандидатов" },
      { en: "at 30 days after sight", ru: "в течение 30 дней после предъявления" },
      { en: "at par", ru: "по номиналу" },
      { en: "at sight", ru: "по востребованию" },
      { en: "attention-grabbing", ru: "захватывающий внимание" },
      { en: "attorney, lawyer, barrister", ru: "адвокат" },
      { en: "automated teller machine (a.t.m.)", ru: "банкомат" },
      { en: "automation", ru: "автоматизация" },
      { en: "back down", ru: "отступаться" },
      { en: "back up", ru: "сделать резервную копию\\поддержать" },
      { en: "background", ru: "прошлое (обучение\\опыт)" },
      { en: "balance of payments", ru: "платежный баланс" },
      { en: "balance of trade", ru: "торговый баланс" },
      { en: "banknote (gb), bill (us)", ru: "банкнота" },
      { en: "banknote, bill", ru: "банкнота" },
      { en: "bar code", ru: "штрих код" },
      { en: "batch number", ru: "серийный номер" },
      { en: "be absent", ru: "отсутствовать" },
      { en: "beforehand, in advance", ru: "заблаговременно" },
      { en: "bill of entry", ru: "ввозная таможенная декларация" },
      { en: "billboard (us)", ru: "билборд" },
      { en: "bona fide", ru: "по-настоящему\\подлинно" },
      { en: "bona vacantia", ru: "брошенное имущество" },
      { en: "bond holder", ru: "держатель облигаций" },
      { en: "boot up", ru: "запустить систему" },
      { en: "borrowing rate", ru: "ссудный процент" },
      { en: "bottom-line", ru: "наименьший желаемый минимум" },
      { en: "break down", ru: "разбить на части\\проанализировать" },
      { en: "bring in", ru: "привлечь (специалиста)\\вводить" },
      { en: "brokerage service", ru: "брокерское обслуживание" },
      { en: "build up", ru: "накапливать\\наращивать" },
      { en: "bulk cargo", ru: "насыпной груз" },
      { en: "by mail, by post", ru: "почтой" },
      { en: "capital punishment", ru: "высшая мера наказания" },
      { en: "cardboard box", ru: "картонная коробка" },
      { en: "cargo, load", ru: "груз" },
      { en: "carry on", ru: "продолжать" },
      { en: "catch up", ru: "наверстать\\быть в курсе" },
      { en: "caveat emptor", ru: "пусть покупатель будет бдителен" },
      { en: "certificate of origin", ru: "сертификат происхождения" },
      { en: "chain store", ru: "сеть магазинов" },
      { en: "cheque (gb), check (us)", ru: "чек" },
      { en: "cheque, check", ru: "чек" },
      { en: "circulation", ru: "тираж" },
      { en: "classified", ru: "объявления в газете или журнале" },
      { en: "clear up", ru: "разъяснить\\устранить" },
      { en: "clearance duty", ru: "стоимость разрешения (сбор)" },
      { en: "click-through rate", ru: "кликабельность" },
      { en: "cold calling", ru: "телефонные продажи" },
      { en: "come across", ru: "производить впечатление" },
      { en: "come into", ru: "вступать в силу\\получать" },
      { en: "come into force", ru: "вступить в силу" },
      { en: "come up", ru: "возникнуть (проблема)" },
      { en: "come up with", ru: "придумать" },
      { en: "commentary on", ru: "комментарий по поводу чего-либо" },
      { en: "commit a crime", ru: "совершить преступление" },
      { en: "commodities", ru: "предмет потребления" },
      { en: "communique", ru: "официальное сообщение\\коммюнике" },
      { en: "compensate", ru: "компенсировать" },
      { en: "concession", ru: "уступка" },
      { en: "configure", ru: "настроить" },
      { en: "consideration", ru: "рассмотрение" },
      { en: "constructive dismissal", ru: "конструктивная причина для увольнения" },
      { en: "convenience store", ru: "круглосуточный магазин" },
      { en: "convertible", ru: "конвертируемый" },
      { en: "counter-productive", ru: "приводящий к обратным результатам" },
      { en: "country-wide paper", ru: "газета\\циркулирующая по всей стране" },
      { en: "court, courtroom", ru: "суд" },
      { en: "cover up", ru: "замалчивать" },
      { en: "cut off", ru: "отрезать доступ" },
      { en: "de facto", ru: "фактически\\в реальности" },
      { en: "de jure", ru: "юридический\\законный" },
      { en: "de minimis", ru: "малозначительным" },
      { en: "de novo", ru: "снова\\вновь" },
      { en: "dear mr (ms)…", ru: "уважаемый(ая) мистер (мисс) …" },
      { en: "dear sir/madam", ru: "обращение в случае\\если вы не знаете имени и пола адресата" },
      { en: "declaration", ru: "декларация\\объявление\\заявление" },
      { en: "declared value", ru: "заявленная ценность" },
      { en: "defective, faulty", ru: "бракованный" },
      { en: "deliver to/at", ru: "доставлять" },
      { en: "depression", ru: "спад\\застой\\депрессия" },
      { en: "destination", ru: "пункт назначения" },
      { en: "developments", ru: "события" },
      { en: "devote to", ru: "посвящать\\уделять внимание" },
      { en: "direct mail", ru: "почтовая рассылка" },
      { en: "disciplinary measure", ru: "дисциплинарная мера\\взыскание" },
      { en: "discrimination", ru: "дискриминация" },
      { en: "dismiss, fire", ru: "увольнять" },
      { en: "display advertising", ru: "дисплейная реклама" },
      { en: "domiciled bill", ru: "домицилированный вексель" },
      { en: "draw up", ru: "составить (план\\документ)" },
      { en: "easily remembered", ru: "легко запоминающийся" },
      { en: "economic growth", ru: "экономический рост" },
      { en: "engagement rate", ru: "уровень вовлечённости" },
      { en: "ex parte", ru: "в пользу одной стороны" },
      { en: "ex post facto", ru: "имеющий обратную силу" },
      { en: "exclusion clauses", ru: "исключения" },
      { en: "exempli gratia (eg)", ru: "например" },
      { en: "exit permit", ru: "разрешение на выезд" },
      { en: "expiration", ru: "истечение" },
      { en: "expiry date", ru: "дата истечения срока действия" },
      { en: "extended guarantee", ru: "продленная гарантия" },
      { en: "external affairs", ru: "события зарубежом" },
      { en: "eye-catching", ru: "захватывающий внимание" },
      { en: "face up to", ru: "признать (проблему)" },
      { en: "facilities", ru: "оборудование" },
      { en: "failure, damage", ru: "повреждение" },
      { en: "fall behind", ru: "отставать" },
      { en: "fall through", ru: "сорваться (план)" },
      { en: "fast-moving consumer goods (fmcg)", ru: "товары повседневного спроса" },
      { en: "faulty, flawed", ru: "брак" },
      { en: "feasibility", ru: "осуществимость\\реализуемость" },
      { en: "figure out", ru: "найти решение\\разобраться\\понять" },
      { en: "find out", ru: "выяснить" },
      { en: "first, i'd like to welcome you all", ru: "прежде всего хотел бы всех поприветствовать" },
      { en: "flag up", ru: "отметить\\указать на" },
      { en: "force majeure", ru: "форс мажор" },
      { en: "foreign currency", ru: "иностранная валюта" },
      { en: "free trade", ru: "свободная торговля" },
      { en: "fringe benefits, perquisites (perks)", ru: "дополнительные к зарплате бонусы и поощрения" },
      { en: "fundamentals", ru: "основы" },
      { en: "get across", ru: "донести (мысль)" },
      { en: "get around", ru: "обойти (ограничение)" },
      { en: "get back to", ru: "вернуться с ответом" },
      { en: "get through", ru: "донести (сообщение)\\справиться" },
      { en: "go back on", ru: "нарушить (обещание)" },
      { en: "go into", ru: "углубляться\\обсуждать подробно" },
      { en: "go on strike", ru: "бастовать" },
      { en: "go over", ru: "пересмотреть\\пройтись по" },
      { en: "go with", ru: "остановиться на" },
      { en: "going concern", ru: "непрерывность\\действующее предприятие" },
      { en: "golden handshake", ru: "значительное финансовое вознаграждение при увольнении" },
      { en: "goods in transit", ru: "товар в пути" },
      { en: "gross domestic product", ru: "валовый внутренний продукт" },
      { en: "gross weight", ru: "вес брутто" },
      { en: "grow into", ru: "вырасти до" },
      { en: "hand over", ru: "передать" },
      { en: "hard currency", ru: "устойчивая валюта" },
      { en: "head line/heading", ru: "газетный заголовок" },
      { en: "heavy traffic", ru: "интенсивное движение" },
      { en: "hello, everyone. thank you for coming today", ru: "приветствую всех. спасибо\\что пришли сегодня" },
      { en: "hereinafter", ru: "в дальнейшем" },
      { en: "heretofore", ru: "ранее\\до этого" },
      { en: "hoarding (uk)", ru: "билборд" },
      { en: "hold back", ru: "сдерживаться\\не раскрывать" },
      { en: "hold off", ru: "отложить\\воздержаться" },
      { en: "human resources", ru: "трудовые ресурсы" },
      { en: "i agree with you in principle, but…", ru: "я в целом согласен с вами\\но…" },
      { en: "i am afraid i didn't quite catch that", ru: "боюсь\\я не совсем понял" },
      { en: "i am good at multitasking", ru: "я хорошо работаю в условиях многозадачности" },
      { en: "i handle stress easily", ru: "я легко справляюсь со стрессом" },
      { en: "i'm sorry but i don't agree with that", ru: "простите\\но я с этим не согласен" },
      { en: "i'm very attentive to detail", ru: "я уделяю много внимания деталям" },
      { en: "id est (ie)", ru: "то есть" },
      { en: "impressions", ru: "показы" },
      { en: "in behalf of", ru: "от лица" },
      { en: "in bond", ru: "в ожидании разрешения" },
      { en: "in bulk", ru: "оптом" },
      { en: "in conclusion/to conclude, we have decided to…", ru: "подводя итоги\\мы решили\\что…" },
      { en: "in the black", ru: "в плюсе" },
      { en: "in the red", ru: "в долгу" },
      { en: "in transit", ru: "транзитом" },
      { en: "information on", ru: "информация о" },
      { en: "information technology", ru: "информационные технологии" },
      { en: "informative", ru: "информативный" },
      { en: "injunction", ru: "предписание\\судебное постановление" },
      { en: "innovation", ru: "инновация" },
      { en: "insider dealing, trading", ru: "инсайдерские сделки" },
      { en: "insolvency", ru: "неплатежеспособность" },
      { en: "inspirational", ru: "вдохновляющий" },
      { en: "instantly recognizable", ru: "легко узнаваемый" },
      { en: "interest accrual", ru: "начисление процентов" },
      { en: "interesting", ru: "интересный" },
      { en: "internal regulations", ru: "внутренний правила компании" },
      { en: "internship", ru: "интернатура" },
      { en: "intriguing", ru: "интригующий" },
      { en: "iron out", ru: "устранить (недоразумения)" },
      { en: "irrevocable", ru: "безвозвратный" },
      { en: "issue, matter", ru: "вопрос\\проблема" },
      { en: "it is reported that", ru: "сообщают\\что" },
      { en: "it is stated that", ru: "утверждают что" },
      { en: "junk bond", ru: "бросовые облигации" },
      { en: "key-note/the main idea", ru: "главная идея" },
      { en: "labor force", ru: "рабочая сила" },
      { en: "laboratory", ru: "лаборатория" },
      { en: "laissez-faire", ru: "невмешательство" },
      { en: "launch a product", ru: "запустить продукт" },
      { en: "lay off", ru: "увольнение" },
      { en: "let down", ru: "подвести" },
      { en: "liabilities", ru: "обязательства" },
      { en: "local paper", ru: "местная газета" },
      { en: "local/home news", ru: "новости в стране" },
      { en: "lock out", ru: "заблокировать доступ" },
      { en: "log in / out", ru: "войти\\выйти из системы" },
      { en: "look down on", ru: "смотреть свысока" },
      { en: "look into", ru: "расследовать\\изучить" },
      { en: "lorry (gb), truck (us)", ru: "грузовик" },
      { en: "luggage (gb), baggage (us)", ru: "багаж" },
      { en: "main point", ru: "основной пункт" },
      { en: "manufacturer", ru: "производитель" },
      { en: "manufacturing facility", ru: "производственное оборудование" },
      { en: "merchandise", ru: "товар" },
      { en: "misdemeanor", ru: "проступок\\преступление" },
      { en: "misrepresentation", ru: "искажение\\введение в заблуждение" },
      { en: "money laundering", ru: "отмывка денег" },
      { en: "motivating", ru: "мотивирующий" },
      { en: "move on", ru: "двигаться дальше" },
      { en: "move up", ru: "продвигаться по карьерной лестнице" },
      { en: "narrow down", ru: "сузить (список)" },
      { en: "national paper", ru: "газета (распространяется в одной стране)" },
      { en: "negligence", ru: "халатность" },
      { en: "negotiable", ru: "договорной" },
      { en: "net weight", ru: "чистый вес" },
      { en: "null and void", ru: "недействительный" },
      { en: "occupation", ru: "позиция" },
      { en: "ok, let's summarize/sum up. we have agreed to…", ru: "хорошо\\давайте подытожим. мы договорились\\что…" },
      { en: "on arrival", ru: "по прибытию" },
      { en: "on deck", ru: "на палубе" },
      { en: "on deposit", ru: "на депозит" },
      { en: "operational management", ru: "операционное управление" },
      { en: "opt for", ru: "выбрать" },
      { en: "opt out (of)", ru: "отказаться" },
      { en: "organic reach", ru: "органический охват" },
      { en: "overtime work", ru: "работа сверхурочно" },
      { en: "own up (to)", ru: "признаться" },
      { en: "par value", ru: "номинальная стоимость" },
      { en: "pass on", ru: "передать (информацию)" },
      { en: "pay slip", ru: "выписка из платежной ведомости на выдачу зарплаты" },
      { en: "payable at sight", ru: "оплачивается по востребованию" },
      { en: "performance-related pay", ru: "оплата по производительности" },
      { en: "periodical", ru: "периодическое издание" },
      { en: "persuasive", ru: "убедительный" },
      { en: "pick up on", ru: "заметить\\уловить" },
      { en: "point out", ru: "выделить\\отметить\\указать" },
      { en: "power up / down", ru: "включить\\выключить питание" },
      { en: "preliminary inspection", ru: "предварительный осмотр" },
      { en: "president and vice presidents", ru: "президент и вице-президенты" },
      { en: "press round-up", ru: "обзор печати" },
      { en: "privatization", ru: "приватизация" },
      { en: "product line", ru: "линия продукции" },
      { en: "product range", ru: "ассортимент товара" },
      { en: "product-led / oriented", ru: "ведомый\\ориентированный на продукт" },
      { en: "productivity", ru: "продуктивность" },
      { en: "professional qualifications", ru: "профессиональные качества" },
      { en: "professional training", ru: "профессиональный тренинг" },
      { en: "prosecutor", ru: "прокурор" },
      { en: "protectionism", ru: "протекционизм\\покровительство" },
      { en: "public relation", ru: "связь с общественностью" },
      { en: "publish, carry", ru: "публиковать" },
      { en: "purchase intent", ru: "намерение купить" },
      { en: "purchasing", ru: "закупки" },
      { en: "put across", ru: "донести (взгляд)" },
      { en: "put forward", ru: "предложить (plan\\idea)" },
      { en: "put in", ru: "вложить (усилия\\время)" },
      { en: "put together", ru: "собрать\\подготовить" },
      { en: "ratification", ru: "разрешение" },
      { en: "re-employment", ru: "повторное трудоустройство" },
      { en: "reach", ru: "охват" },
      { en: "reboot / restart", ru: "перезагрузить" },
      { en: "receivership", ru: "банкротство" },
      { en: "refresher course", ru: "курсы повышения квалификации" },
      { en: "remuneration", ru: "вознаграждение" },
      { en: "representative", ru: "представитель" },
      { en: "research and development", ru: "исследования и разработки" },
      { en: "research and development (r&d)", ru: "исследование и разработка" },
      { en: "resentment", ru: "негодование" },
      { en: "resistance", ru: "сопротивление" },
      { en: "reverse engineering", ru: "обратная разработка" },
      { en: "roadside signs", ru: "придорожная реклама" },
      { en: "roll back", ru: "откатить изменения" },
      { en: "roll out", ru: "развернуть постепенно" },
      { en: "rule out", ru: "исключить" },
      { en: "run into", ru: "столкнуться с (проблемой)" },
      { en: "run through", ru: "быстро пройтись" },
      { en: "search volume", ru: "объём поиска" },
      { en: "securities", ru: "ценные бумаги" },
      { en: "securities and exchange commission (sec)", ru: "комиссия по ценным бумагам и биржам" },
      { en: "senior management", ru: "старшее руководство" },
      { en: "severance pack", ru: "пакет по выходному пособию" },
      { en: "severance pay", ru: "выходное пособие" },
      { en: "severance pay, dismissal pay", ru: "выходное пособие" },
      { en: "shopping centre", ru: "торговый центр" },
      { en: "shut down", ru: "выключить (систему)" },
      { en: "sign off on", ru: "одобрить" },
      { en: "since everyone is here, let's get started", ru: "поскольку все собрались\\давайте начнем" },
      { en: "soft currency", ru: "нестабильная валюта" },
      { en: "sophisticated", ru: "утонченный" },
      { en: "speculator", ru: "биржевик" },
      { en: "stagflation", ru: "стагфляция" },
      { en: "stand by", ru: "придерживаться" },
      { en: "stand up for", ru: "защищать" },
      { en: "standard of living", ru: "уровень жизни" },
      { en: "step down", ru: "покинуть пост" },
      { en: "step up", ru: "повысить\\взять на себя" },
      { en: "subscription", ru: "подписка" },
      { en: "substandard", ru: "ниже установленного стандарта" },
      { en: "supervisor", ru: "наблюдатель\\прямой менеджер" },
      { en: "supplement", ru: "дополнение\\приложение" },
      { en: "suretyship", ru: "поручительство" },
      { en: "switch on / off", ru: "включить\\выключить (переключатель)" },
      { en: "take down", ru: "вывести из строя\\остановить" },
      { en: "take over", ru: "перехватить\\принять управление" },
      { en: "talk over", ru: "обсудить (принять решение)" },
      { en: "talk through", ru: "обсудить детально" },
      { en: "thank you for contacting us", ru: "спасибо\\что вы с нами связались" },
      { en: "the article reports on new films", ru: "в статье идет речь о новых фильмах" },
      { en: "the events at home/abroad", ru: "события в стране и зарубежом" },
      { en: "the latest events (developments)", ru: "последние события" },
      { en: "to appoint a person", ru: "назначить человека" },
      { en: "to ask for a rise", ru: "просить о повышении зарабjтной платы" },
      { en: "to be addressed to", ru: "адресовать кому-либо" },
      { en: "to bear all risks", ru: "нести риски" },
      { en: "to buy back", ru: "выкупать" },
      { en: "to declare", ru: "заявлять\\объявлять" },
      { en: "to edit", ru: "редактировать" },
      { en: "to feature", ru: "описывать" },
      { en: "to follow the events", ru: "следить за событиями" },
      { en: "to handle with care", ru: "обращаться осторожно" },
      { en: "to issue, come out", ru: "выходить\\выпускать (журнал\\газета)" },
      { en: "to make redundant", ru: "сократить" },
      { en: "to picture", ru: "описывать" },
      { en: "to print", ru: "печатать" },
      { en: "to refuse to settle a claim", ru: "отказ в урегулировании иска" },
      { en: "to state", ru: "заявлять" },
      { en: "to store", ru: "для хранения" },
      { en: "to subscribe to", ru: "подписатся на" },
      { en: "to work in shifts", ru: "сменная работа" },
      { en: "to work overtime", ru: "работа сверхурочно" },
      { en: "touch on", ru: "коснуться (темы)" },
      { en: "touch upon", ru: "затрагивать" },
      { en: "trade deficit", ru: "внешнеторговый дефицит" },
      { en: "trade fair", ru: "торговая ярмарка" },
      { en: "trade surplus", ru: "активный торговый баланс" },
      { en: "trade union", ru: "профсоюз" },
      { en: "trading session", ru: "торговая сессия" },
      { en: "transaction", ru: "транзакции" },
      { en: "transferable", ru: "переводный" },
      { en: "treasury securities", ru: "казначейские ценные бумаги" },
      { en: "trial period", ru: "испытательный срок" },
      { en: "turn on / off", ru: "включить\\выключить" },
      { en: "u.s.p. - unique selling points", ru: "утп - уникальное торговое предложение" },
      { en: "uberrima fides", ru: "наивысшая добросовестность" },
      { en: "underestimate", ru: "недооценивать\\занижать" },
      { en: "underproductive", ru: "малопродуктивный" },
      { en: "underwriter", ru: "гарант" },
      { en: "unemployment", ru: "безработица" },
      { en: "unfair dismissal", ru: "несправедливое увольнение" },
      { en: "venture capital", ru: "венчурный капитал\\вложение капитала с риском" },
      { en: "warm up to", ru: "проникнуться симпатией" },
      { en: "wipe out", ru: "уничтожить полностью" },
      { en: "with reference to your letter …", ru: "относительно вашего письма…" },
      { en: "without prejudice", ru: "без ущерба\\предубеждения" },
      { en: "work around", ru: "найти обходной путь" },
      { en: "work on", ru: "работать над" },
      { en: "working conditions", ru: "рабочие условия" },
      { en: "workstation", ru: "рабочее место" },
      { en: "write up", ru: "подготовить (документ)" },
      { en: "yours faithfully …", ru: "с уважением … (в том случае\\если вам неизвестно имя адресата)" },
      { en: "yours sincerely …", ru: "с уважением …" },
      { en: "zero in on", ru: "сосредоточиться на" },
    ],
  },
};

const SEED_SHARED_LIBRARY_BIZ_B2 = {
  difficulty: "B2",
  topics: {
    "деловой_компания": [
      { en: "adapt leadership style to team needs", ru: "адаптировать стиль управления под потребности команды" },
      { en: "align team efforts with customer needs", ru: "направлять работу команды на удовлетворение потребностей клиента" },
      { en: "align technical and business priorities", ru: "согласовывать технические и бизнес-приоритеты" },
      { en: "celebrate team achievements", ru: "отмечать достижения команды" },
      { en: "create a psychologically safe team environment", ru: "создавать атмосферу психологической безопасности в команде" },
      { en: "ensure alignment with business goals", ru: "обеспечивать соответствие проекта целям бизнеса" },
      { en: "facilitate effective team communication", ru: "выстраивать эффективную коммуникацию внутри команды" },
      { en: "inspire team ownership and accountability", ru: "вдохновлять команду на ответственность за результат" },
      { en: "keep team motivated during crunch time", ru: "поддерживать мотивацию команды в период повышенной нагрузки" },
      { en: "keep the team informed and engaged", ru: "поддерживать информированность и вовлечённость команды" },
      { en: "mentor junior team members", ru: "менторить младших специалистов" },
      { en: "monitor team's sprint velocity", ru: "отслеживать динамику скорости команды" },
      { en: "prioritize tasks based on business impact", ru: "расставлять приоритеты задач с учётом влияния на бизнес" },
      { en: "provide constructive feedback to team members", ru: "давать команде конструктивную обратную связь" },
      { en: "reduce context switching for the team", ru: "снижать количество переключений контекста внутри команды" },
      { en: "resolve conflicts within the team", ru: "урегулировать конфликты внутри команды" },
      { en: "speak both tech and business languages", ru: "одинаково уверенно общаться на языке технологий и бизнеса" },
      { en: "track team workload and capacity", ru: "отслеживать загрузку команды и её ресурсную доступность" },
      { en: "translate business needs into technical requirements", ru: "переводить бизнес-потребности в технические требования" },
      { en: "act as a liaison between business and tech teams", ru: "быть связующим звеном между бизнес-командой и разработкой" },
      { en: "cbo / cbdo (chief business officer / chief business development officer)", ru: "директор по развитию бизнеса" },
      { en: "cross-functional team", ru: "кросс-функциональная команда" },
      { en: "let me give you my business card", ru: "позвольте оставить вам свою визитку" },
    ],
    "деловой_карьера": [
      { en: "support work-life balance", ru: "поддерживать здоровый баланс между работой и личной жизнью" },
      { en: "i have … years' experience in the field", ru: "у меня … лет опыта работы в этой сфере" },
      { en: "i have 6 years of experience in qa", ru: "у меня 6 лет опыта в qa" },
      { en: "i want to further my career in …", ru: "я хочу развивать свою карьеру в сфере …" },
    ],
    "деловой_задачи": [
      { en: "ensure qa involvement from the start", ru: "привлекать qa на ранних этапах проекта" },
      { en: "facilitate daily stand-ups and retrospectives", ru: "проводить ежедневные стендапы и ретроспективы" },
      { en: "deliver projects on time and within budget", ru: "сдавать проекты в срок и в рамках бюджета" },
      { en: "i manage my time well by planning out …", ru: "я умею хорошо распределять время\\планируя …" },
      { en: "i'll have my secretary schedule an appointment", ru: "я попрошу своего секретаря назначить время встречи" },
      { en: "i'm afraid i have to leave now", ru: "боюсь\\я вынужден уйти" },
      { en: "perception shift", ru: "изменение восприятия" },
      { en: "use jira for task and sprint management", ru: "использовать jira для управления задачами и спринтами" },
      { en: "when do you want me to start?", ru: "когда мне начинать?" },
    ],
    "деловой_переписка": [
      { en: "clarify roles and responsibilities", ru: "уточнять роли и зоны ответственности участников команды" },
      { en: "collect and process feedback", ru: "собирать и обрабатывать обратную связь" },
      { en: "manage performance and feedback loops", ru: "управлять результативностью команды и системой обратной связи" },
      { en: "call me if you have any questions", ru: "позвоните мне\\если возникнут какие-либо вопросы" },
      { en: "i am writing to inform you that …", ru: "я пишу\\чтобы уведомить вас …" },
      { en: "we regret to inform you that …", ru: "мы с сожалением сообщаем …" },
    ],
    "деловой_встречи": [
      { en: "present project updates to executives", ru: "представлять обновления по проекту руководству" },
      { en: "as you can see from the agenda, we'll be talking about…", ru: "как вы видите из повестки дня\\мы будем говорить о…" },
      { en: "i'll let you know the date of our next meeting", ru: "я сообщу вам о дате следующего совещания" },
      { en: "the first item on the agenda is…", ru: "первый пункт повестки дня…" },
      { en: "the next item on the agenda is..", ru: "следующий пункт повестки дня…" },
    ],
    "деловой_проекты": [
      { en: "address scope creep proactively", ru: "проактивно управлять расширением объёма работ" },
      { en: "balance speed and quality", ru: "поддерживать баланс скорости и качества" },
      { en: "conduct post-implementation reviews", ru: "проводить анализ результатов после внедрения проекта" },
      { en: "conduct risk assessment workshops", ru: "проводить воркшопы по оценке рисков" },
      { en: "define project scope and objectives", ru: "определять границы и цели проекта" },
      { en: "develop detailed project plans and timelines", ru: "разрабатывать детализированные проектные планы и графики" },
      { en: "enforce code freeze before release", ru: "вводить режим code-freeze перед релизом" },
      { en: "ensure customer satisfaction throughout the project", ru: "поддерживать высокий уровень удовлетворённости клиента на протяжении всего проекта" },
      { en: "generate gantt charts in ms project", ru: "строить диаграммы ганта в ms project" },
      { en: "handle hotfixes without disrupting roadmap", ru: "устранять критические ошибки без нарушения дорожной карты" },
      { en: "identify and manage project risks", ru: "выявлять и управлять рисками проекта" },
      { en: "identify project bottlenecks early", ru: "выявлять узкие места проекта на ранних этапах" },
      { en: "maintain backlog grooming discipline", ru: "поддерживать регулярную проработку и приоритизацию бэклога" },
      { en: "maintain quality standards", ru: "поддерживать стандарты качества" },
      { en: "manage project scope creep", ru: "управлять неконтролируемым расширением объёма проекта" },
      { en: "monitor post-release bugs", ru: "отслеживать баги после релиза" },
      { en: "perform quality gates at key phases", ru: "проводить контрольные точки качества на ключевых этапах проекта" },
      { en: "track kpis and project milestones", ru: "отслеживать kpi и ключевые проектные этапы" },
      { en: "track project kpis in confluence dashboards", ru: "отслеживать kpi проекта в дашбордах confluence" },
      { en: "track risk indicators and mitigation plans", ru: "отслеживать рисковые индикаторы и планы их минимизации" },
      { en: "use agile, scrum, or waterfall methodologies", ru: "применять методологии agile\\scrum или waterfall" },
      { en: "validate deployment and release plans", ru: "проверять и согласовывать планы релиза и развёртывания" },
      { en: "ensure project documentation is up to date", ru: "поддерживать актуальность проектной документации" },
      { en: "reputational risk", ru: "репутационный риск" },
      { en: "set up sprint goals and velocity tracking", ru: "формулировать цели спринта и отслеживать скорость команды" },
      { en: "what are your feelings about this project?", ru: "что вы думаете по поводу этого проекта?" },
    ],
    "деловой_маркетинг": [
      { en: "adapt communication style to audience", ru: "адаптировать стиль коммуникации под аудиторию" },
      { en: "lead by example", ru: "подавать личный пример" },
      { en: "lead cross-functional teams", ru: "управлять кросс-функциональными командами" },
      { en: "track and reduce churn rate", ru: "отслеживать и снижать уровень оттока пользователей\\клиентов" },
      { en: "audience skepticism", ru: "скептицизм аудитории" },
      { en: "brand architecture", ru: "архитектура бренда" },
      { en: "brand equity", ru: "капитал бренда" },
      { en: "brand favorability", ru: "благосклонность к бренду" },
      { en: "brand lift study", ru: "исследование роста бренда" },
      { en: "brand narrative", ru: "бренд-нарратив" },
      { en: "brand positioning", ru: "позиционирование бренда" },
      { en: "brand trust score", ru: "показатель доверия к бренду" },
      { en: "campaign execution", ru: "реализация кампании" },
      { en: "campaign flight", ru: "период активности кампании" },
      { en: "deal with", ru: "справиться\\заниматься\\разбираться с" },
      { en: "localized content", ru: "локализованный контент" },
      { en: "lower funnel", ru: "нижняя часть воронки" },
      { en: "market penetration", ru: "проникновение на рынок" },
      { en: "media buying", ru: "закупка медиа" },
      { en: "media mix", ru: "медиамикс" },
      { en: "sales and marketing", ru: "продажи и маркетинг" },
      { en: "upper funnel", ru: "верхняя часть воронки" },
    ],
    "деловой_финансы": [
      { en: "minimize technical debt", ru: "снижать объём технического долга" },
      { en: "actual yield", ru: "фактическое состояние\\доходность" },
      { en: "capital stock", ru: "основной капитал" },
      { en: "casualty insurance", ru: "страхование от несчастных случаев" },
      { en: "financial or accounting", ru: "финансы и бухгалтерия" },
      { en: "gross yield", ru: "валовый доход" },
      { en: "industrial accident insurance", ru: "промышленное страхование от несчастных случаев" },
      { en: "investment", ru: "инвестиция" },
      { en: "life insurance", ru: "страхование жизни" },
      { en: "malpractice insurance", ru: "страхование от случаев халатности" },
      { en: "obligatory insurance", ru: "обязательное страхование" },
      { en: "penny stock", ru: "мелкие акции" },
      { en: "share certificate", ru: "акционерный сертификат" },
      { en: "share of voice", ru: "доля голоса в рынке" },
    ],
    "деловой_поставки": [
      { en: "use retrospectives to improve delivery", ru: "использовать ретроспективы для повышения эффективности процессов доставки продукта" },
      { en: "cpo (chief procurement officer / chief product officer)", ru: "директор по закупкам\\директор отдела контроля производства" },
      { en: "post-production", ru: "пост-продакшен" },
      { en: "production brief", ru: "продакшен-бриф" },
      { en: "production efficiency", ru: "эффективность производства" },
    ],
    "деловой_право": [
      { en: "agreement, contract", ru: "договор\\контракт" },
      { en: "breach of contract", ru: "нарушение контракта\\нарушить контракт" },
      { en: "employment contract, labour contract", ru: "рабочий контракт" },
      { en: "latin in legal terms", ru: "латынь в юридическом английском" },
      { en: "lawsuit, legal action", ru: "судебный процесс" },
    ],
    "деловой_переговоры": [
      { en: "build a culture of accountability", ru: "формировать культуру ответственности и осознанности" },
      { en: "foster innovation and initiative", ru: "поддерживать инициативность и инновационное мышление" },
      { en: "flighting strategy", ru: "стратегия запуска волнами" },
      { en: "stakeholder alignment", ru: "согласование со стейкхолдерами" },
    ],
    "деловой_глаголы": [
      { en: "align stakeholder expectations with reality", ru: "согласовывать ожидания стейкхолдеров с реальными возможностями и ограничениями" },
      { en: "analyze burndown and velocity charts", ru: "анализировать диаграммы burndown и velocity" },
      { en: "automate routine tasks where possible", ru: "автоматизировать рутинные процессы\\где это возможно" },
      { en: "collaborate in slack or microsoft teams", ru: "сотрудничать и обмениваться информацией в slack или microsoft teams" },
      { en: "communicate timelines and expectations clearly", ru: "чётко доносить сроки и ожидания" },
      { en: "conduct regular 1-on-1s", ru: "проводить регулярные личные встречи с членами команды" },
      { en: "conduct uat (user acceptance testing)", ru: "проводить пользовательское приёмочное тестирование" },
      { en: "configure issue types and workflows", ru: "настраивать типы задач и рабочие процессы" },
      { en: "coordinate with stakeholders and vendors", ru: "координировать взаимодействие со стейкхолдерами и подрядчиками" },
      { en: "drive continuous improvement", ru: "продвигать культуру постоянного улучшения" },
      { en: "encourage knowledge sharing", ru: "поощрять обмен знаниями внутри команды" },
      { en: "encourage professional development", ru: "поощрять профессиональное развитие сотрудников" },
      { en: "ensure documentation is test-ready", ru: "обеспечивать готовность документации к тестированию" },
      { en: "escalate critical blockers", ru: "эскалировать критические блокеры" },
      { en: "escalate issues when necessary", ru: "эскалировать проблемы при необходимости" },
      { en: "handle change requests effectively", ru: "эффективно обрабатывать запросы на изменения" },
      { en: "implement ci/cd best practices", ru: "внедрять лучшие практики ci\\cd" },
      { en: "integrate tools for seamless collaboration", ru: "интегрировать инструменты для бесшовного взаимодействия команд" },
      { en: "maintain transparency across all stakeholders", ru: "обеспечивать прозрачность для всех стейкхолдеров" },
      { en: "manage multiple projects simultaneously", ru: "вести несколько проектов одновременно" },
      { en: "manage resources using clickup or asana", ru: "управлять ресурсами в clickup или asana" },
      { en: "monitor progress and adjust as needed", ru: "отслеживать прогресс и при необходимости вносить корректировки" },
      { en: "perform root cause analysis for delays", ru: "проводить анализ корневых причин задержек" },
      { en: "promote autonomy and trust", ru: "развивать автономность команды и культуру доверия" },
      { en: "provide regular status updates to stakeholders", ru: "предоставлять стейкхолдерам регулярные обновления по статусу проекта" },
      { en: "reflect and evolve as a leader", ru: "развиваться как лидер через регулярную саморефлексию" },
      { en: "resolve interpersonal conflicts", ru: "урегулировать межличностные конфликты" },
      { en: "review and approve technical specs", ru: "проверять и утверждать технические спецификации" },
      { en: "run efficient and focused meetings", ru: "проводить продуктивные и сфокусированные встречи" },
      { en: "set clear communication channels", ru: "формировать понятные и устойчивые каналы коммуникации" },
      { en: "set clear performance expectations", ru: "формировать чёткие ожидания по результатам работы" },
      { en: "set realistic deadlines and buffer times", ru: "устанавливать реалистичные сроки с учётом буферов" },
      { en: "transparency", ru: "прозрачность" },
      { en: "use version control tools like git", ru: "использовать системы контроля версий\\такие как git" },
      { en: "after careful consideration we have decided …", ru: "после тщательной оценки мы приняли решение …" },
      { en: "agency briefing", ru: "брифинг агентства" },
      { en: "aida(s) - attention, interest, desire, action, (satisfaction)", ru: "аида(с) - внимание\\интерес\\желание\\действие\\удовлетворение" },
      { en: "always-on", ru: "постоянное присутствие в медиа" },
      { en: "art direction", ru: "арт-дирекшен" },
      { en: "authenticity", ru: "аутентичность" },
      { en: "before we close, let me just summarize the main points", ru: "прежде чем мы закончим\\позвольте мне подвести итоги" },
      { en: "break down complex initiatives into actionable steps", ru: "структурировать сложные инициативы на понятные и реализуемые шаги" },
      { en: "bring up", ru: "поднять (вопрос)\\поднять (тему)\\воспитывать" },
      { en: "build trust with internal and external partners", ru: "выстраивать доверительные отношения с внутренними и внешними партнёрами" },
      { en: "can you expand on that? what exactly did you have in mind?", ru: "не могли бы вы пояснить? что именно вы имели в виду?" },
      { en: "cao (chief administrative officer / chief analytics officer)", ru: "директор административного отдела\\главный аналитик" },
      { en: "carry out", ru: "выполнять\\выполнять (задачу)" },
      { en: "competitive differentiation", ru: "конкурентное отличие" },
      { en: "continue on", ru: "«продолжай»" },
      { en: "could you be a little more/a bit more precise, please?", ru: "не могли бы вы быть немного более точным\\пожалуйста?" },
      { en: "could you possibly tell us / let us have …", ru: "не могли бы вы сообщить нам…" },
      { en: "count on", ru: "полагаться\\рассчитывать на" },
      { en: "creative brief", ru: "креативный бриф" },
      { en: "creative concept", ru: "креативная концепция" },
      { en: "creative consistency", ru: "креативная последовательность" },
      { en: "creative platform", ru: "креативная платформа" },
      { en: "credibility gap", ru: "разрыв в доверии\\репутации" },
      { en: "cut down on", ru: "сокращать (потребление)" },
      { en: "cut out", ru: "полностью исключить" },
      { en: "end up", ru: "в итоге оказаться" },
      { en: "fall out (with)", ru: "поссориться\\поссориться с" },
      { en: "gain generate get give go grant grow guarantee", ru: "получать генерировать получать давать идти наделять расти гарантировать" },
      { en: "get on (with)", ru: "ладить (с кем-то)\\ладить с" },
      { en: "give up", ru: "бросать (привычку)" },
      { en: "hand in", ru: "сдавать (работу)" },
      { en: "i agree with you up to a point, but…", ru: "я согласен с вами в определенной степени\\но…" },
      { en: "i am confident that i will be able to use my skills in … in the advertised post", ru: "я уверен\\что смогу применить мои навыки на этой должности" },
      { en: "i am interested in (obtaining / receiving) …", ru: "я хотел бы получить …" },
      { en: "i am not sure i follow your point about…?", ru: "я не уверен\\что понял вашу мысль о…?" },
      { en: "i am open to relocate to dubai", ru: "я открыт к переезду в дубай" },
      { en: "i am sorry, could you repeat that please?", ru: "прошу прощения\\вы могли бы повторить это еще раз?" },
      { en: "i am writing to enquire about …", ru: "я пишу\\чтобы узнать о …" },
      { en: "i graduated from … university (college) in …", ru: "я окончил … университет (училище) в …" },
      { en: "i increased coverage from 40 to 75 percent", ru: "я увеличил покрытие с 40 до 75%" },
      { en: "i look forward to hearing from you", ru: "жду вашего ответа" },
      { en: "i should be hired because i'm …", ru: "я подхожу на эту должность\\потому что …" },
      { en: "i think it would be better if..", ru: "думаю\\было бы лучше\\если бы.." },
      { en: "i will go over the main points, shall i?", ru: "я пройдусь по основным пунктам\\хорошо?" },
      { en: "i work with api, ui, and mobile testing", ru: "я работаю с api\\ui и мобильным тестированием" },
      { en: "i would appreciate your immediate attention to this matter", ru: "я был бы очень признателен за ваше неотложное внимание к этому делу" },
      { en: "i'm afraid i can't agree with you on that", ru: "боюсь\\я не могу согласиться с вами в этом" },
      { en: "i'm afraid it would not be possible to …", ru: "боюсь\\это невозможно …" },
      { en: "i'm excited about this opportunity because …", ru: "я очень рад получить эту возможность\\поскольку …" },
      { en: "i'm sorry, but i have to go now", ru: "простите\\но мне уже пора" },
      { en: "if no one has anything else to add, then i think we'll wrap this up", ru: "если никто больше ничего не хочет добавить\\то я думаю\\мы на этом закончим" },
      { en: "internal tender", ru: "внутренний тендер" },
      { en: "just a moment. i'll come back to you in a minute", ru: "одну минуту. я вернусь к вам через минуту" },
      { en: "key visual", ru: "ключевой визуал" },
      { en: "learn from past mistakes and apply insights", ru: "извлекать уроки из прошлых ошибок и применять полученные инсайты на практике" },
      { en: "look up to", ru: "уважать\\брать пример" },
      { en: "point of view", ru: "точка зрения бренда" },
      { en: "prepare reports using excel or google sheets", ru: "готовить отчёты в excel или google sheets" },
      { en: "put off", ru: "откладывать" },
      { en: "put up with", ru: "терпеть\\мириться с" },
      { en: "region-specific casting", ru: "локальный кастинг" },
      { en: "retargeting", ru: "ретаргетинг" },
      { en: "set up", ru: "настроить\\развернуть\\организовать\\наладить" },
      { en: "set up workflows in trello or monday.com", ru: "настраивать рабочие процессы в trello или monday.com" },
      { en: "shareholder", ru: "акционер" },
      { en: "sort out", ru: "разобраться\\устранить\\улаживать\\решать" },
      { en: "stay up to date with industry trends", ru: "оставаться в курсе тенденций и изменений в отрасли" },
      { en: "stockholder", ru: "акционер\\держатель акций" },
      { en: "tabby is a great match for me", ru: "tabby отлично мне подходит" },
      { en: "take on", ru: "браться за (задачу\\ответственность)\\брать (обязанность\\проект)" },
      { en: "take up", ru: "начать заниматься\\занимать место" },
      { en: "the article reviews the latest event abroad", ru: "в статье идет обзор последних новостей за рубежом" },
      { en: "to be on probation, to be on trial", ru: "быть на испытательном сроке" },
      { en: "to give / hand in one's resignation notice", ru: "подать заявление на увольнение" },
      { en: "to give a full/wide coverage of/to an event", ru: "широко освещать в печати какое-либо событие" },
      { en: "to give full attention to some event", ru: "приделить много внимания какому-либо событию" },
      { en: "to know out", ru: "«выяснить»" },
      { en: "trust gap", ru: "разрыв в доверии" },
      { en: "turn off it", ru: "«выключи его» (местоим.)" },
      { en: "universal creative framework", ru: "универсальный креативный фреймворк" },
      { en: "value proposition", ru: "ценностное предложение" },
      { en: "visual identity", ru: "визуальная идентичность" },
      { en: "we are pleased to announce that …", ru: "мы с удовольствием сообщаем\\что …" },
      { en: "we'll send out that information right away", ru: "мы немедленно вышлем эту информацию" },
      { en: "work out", ru: "считать\\рассчитывать\\находить решение\\тренироваться\\разрешаться" },
    ],
  },
};

const SEED_SHARED_LIBRARY_BIZ_C1 = {
  difficulty: "C1",
  topics: {
    "деловой_карьера": [
      { en: "rather than making claims audiences no longer believe, we invited them to experience the product firsthand", ru: "вместо того чтобы делать заявления\\которым аудитория больше не верит\\мы предложили ей лично познакомиться с продуктом" },
    ],
    "деловой_задачи": [
      { en: "we needed to shift audience perception from scepticism to active consideration within a single campaign cycle", ru: "нам нужно было изменить восприятие аудитории от скептицизма к активному рассмотрению в рамках одного цикла кампании" },
    ],
    "деловой_проекты": [
      { en: "the challenge was to neutralise reputational risk without overpromising on product capabilities", ru: "задача состояла в том\\чтобы нейтрализовать репутационный риск\\не давая завышенных обещаний о возможностях продукта" },
    ],
    "деловой_маркетинг": [
      { en: "brand favorability improved across all campaign markets, with the strongest gains in indonesia", ru: "благосклонность к бренду выросла на всех рынках кампании\\с наибольшим приростом в индонезии" },
      { en: "in a commoditised market, a strong brand is the only sustainable differentiator", ru: "на однородном рынке сильный бренд — единственный устойчивый источник дифференциации" },
      { en: "operating without a local licence creates a trust deficit that only brand investment can offset", ru: "работа без местной лицензии создаёт дефицит доверия\\который может компенсировать только инвестиция в бренд" },
      { en: "the campaign delivered measurable impact across all key brand metrics", ru: "кампания обеспечила измеримый результат по всем ключевым метрикам бренда" },
      { en: "the creative platform gives us flexibility across formats while maintaining a consistent brand voice", ru: "креативная платформа даёт нам гибкость в форматах при сохранении последовательного голоса бренда" },
      { en: "to overcome the trust gap, we moved from brand promises to brand proof", ru: "чтобы преодолеть разрыв в доверии\\мы перешли от обещаний бренда к доказательствам бренда" },
    ],
    "деловой_финансы": [
      { en: "appear, prove, constitute, account for, stand for", ru: "публицистика" },
    ],
    "деловой_право": [
      { en: "due diligence", ru: "надлежащая проверка\\должная осмотрительность\\экспертная проверка юридической безопасности" },
      { en: "cco (chief commercial officer / chief compliance officer)", ru: "коммерческий директор\\главный управляющий по контролю за соблюдением законодательства" },
      { en: "liability", ru: "обязательство\\ответственность" },
    ],
    "деловой_глаголы": [
      { en: "grow", ru: "расти\\постепенно\\часто негативно или возраст" },
      { en: "a steep learning curve", ru: "тяжелый старт обучения" },
      { en: "appear", ru: "более формальный\\часто — внешняя видимость\\которая может обманывать" },
      { en: "be on the same page", ru: "понимать одинаково" },
      { en: "be over the moon", ru: "быть на седьмом небе" },
      { en: "come", ru: "результат процесса — итог" },
      { en: "come across as", ru: "производить впечатление" },
      { en: "cut corners", ru: "халтурить\\экономить на качестве" },
      { en: "fall", ru: "непреднамеренно\\часто негативно" },
      { en: "feel under the weather", ru: "неважно себя чувствовать" },
      { en: "get", ru: "разговорный\\процесс" },
      { en: "get on like a house on fire", ru: "отлично ладить" },
      { en: "get the ball rolling", ru: "запустить дело" },
      { en: "get, go, turn, end up, come across as, turn out", ru: "разговорная речь" },
      { en: "go", ru: "часто негативные изменения — плохое направление" },
      { en: "have a lot on one's plate", ru: "быть перегруженным" },
      { en: "i'd strongly advise…", ru: "твердо" },
      { en: "i'd suggest / i'd recommend…", ru: "нейтрально" },
      { en: "it would be beneficial to…", ru: "мягко" },
      { en: "keep", ru: "разговорный\\часто с -ing" },
      { en: "lie, stand, nestle, fall silent, strike as, grow", ru: "художественный текст" },
      { en: "look", ru: "зрительное впечатление" },
      { en: "prove to be, turn out to be, remain, appear", ru: "деловая переписка" },
      { en: "put things into perspective", ru: "взглянуть трезво" },
      { en: "remain", ru: "формальный" },
      { en: "remain, constitute, represent, appear, prove to be", ru: "академический текст" },
      { en: "run", ru: "исчерпание\\дефицит" },
      { en: "seem", ru: "общее впечатление\\нейтральный" },
      { en: "stay", ru: "нейтральный\\разговорный" },
      { en: "the results exceeded our reach targets by 17%, delivering 557 million impressions", ru: "результаты превысили целевые показатели охвата на 17%\\обеспечив 557 миллионов показов" },
      { en: "think outside the box", ru: "мыслить нестандартно" },
      { en: "turn", ru: "резкая смена\\особенно цвет\\состояние" },
      { en: "we prioritised organic reach through influencer seeding to expand beyond our retargeting pool", ru: "мы сделали ставку на органический охват через посев у инфлюенсеров\\чтобы выйти за пределы ретаргетинговой аудитории" },
      { en: "we saw significant uplift in branded search volume among exposed users", ru: "мы зафиксировали значительный рост объёма брендового поиска среди охваченной аудитории" },
      { en: "why don't we…? / how about…?", ru: "неформально" },
    ],
  },
};

const SEED_SHARED_LIBRARY_PHRASES = {
  difficulty: "B1",
  topics: {
    "разговорные_фразы": [
      { en: "Bored to death", ru: "До смерти скучно / Умираю со скуки" },
      { en: "You've got to be kidding", ru: "Ты, наверное, шутишь!" },
      { en: "Sick and tired", ru: "Меня это достало / Надоело" },
      { en: "Call it a day", ru: "Заканчивать работу / Закругляться" },
      { en: "Get on one's nerves", ru: "Действовать на нервы" },
      { en: "Couch potato", ru: "Как овощ / Как комнатное растение" },
      { en: "Read one's mind", ru: "Читать / угадать чьи-то мысли" },
      { en: "Feel blue", ru: "Мне грустно / уныло / тоскливо" },
      { en: "Fender bender", ru: "Небольшое ДТП / Немного помял машину" },
      { en: "Get foot in the door", ru: "Сделать первый шаг" },
      { en: "Chicken", ru: "Бояться / быть трусишкой" },
      { en: "Give somebody a hard time", ru: "Устроить кому-то проблемы / трудные времена" },
      { en: "Make up one's mind", ru: "Принять решение / определиться" },
      { en: "Go Dutch", ru: "Платить пополам / вскладчину / каждый за себя" },
      { en: "Throw in the towel", ru: "Сдаваться" },
      { en: "Goose bumps", ru: "Мурашки по коже" },
      { en: "Stay in touch", ru: "Быть на связи / Поддерживать связь" },
      { en: "Have the guts", ru: "Иметь смелость" },
      { en: "Rain or shine", ru: "В любую погоду / Не смотря ни на что" },
      { en: "I'm beat", ru: "Я валюсь с ног от усталости." },
      { en: "Easier said than done", ru: "Легче сказать, чем сделать / Не всё так просто" },
      { en: "It's about time", ru: "Наконец-то / Пришло время / Пора (это сделать)" },
      { en: "Jump to conclusions", ru: "Спешить с выводами" },
      { en: "Keep an eye on", ru: "Следить / наблюдать / приглядывать" },
      { en: "Out of the blue", ru: "Неожиданно / Из ниоткуда" },
      { en: "Know something inside out", ru: "Вдоль и поперек / на зубок / как свои 5 пальцев" },
      { en: "Give someone a hand", ru: "Помочь / Протянуть руку помощи" },
      { en: "Every now and then", ru: "Иногда / Время от времени" },
      { en: "Nuke - Microwave", ru: "Готовить в микроволновке" },
      { en: "On the dot", ru: "Ровно в это время / Минута в минуту" },
      { en: "Keeping my fingers crossed", ru: "Держать кулаки на удачу / Скрестить пальцы на удачу" },
      { en: "Out of this world", ru: "Потрясающе / Невероятно / Будто, не из этого мира" },
      { en: "Over one's head", ru: "Вне (моего) понимания" },
      { en: "Pain in the ass", ru: "Заноза в заднице / Достало / Испытание на прочность" },
      { en: "Piece of cake", ru: "Проще простого / проще пареной репы / легче легкого" },
      { en: "Sooner or later", ru: "Рано или поздно" },
      { en: "Pull someone's leg", ru: "Морочить голову / Разыгрывать / Обманывать" },
      { en: "Put oneself in one's place", ru: "Поставить себя на чье-то место" },
      { en: "(I'm so hungry) I can eat a horse", ru: "Я голодный, как волк / Умираю с голоду" },
      { en: "Read between the lines", ru: "Читать между строк / Понимать подтекст" },
      { en: "Rings a bell", ru: "Что-то знакомое / Всплывает в памяти" },
      { en: "Bug", ru: "Раздражает / Нервирует" },
      { en: "Sleep on it", ru: "Утро вечера мудренее / \"Переспать\" с этой мыслью" },
      { en: "Play it by ear", ru: "Действовать по обстоятельствам / Импровизировать" },
      { en: "Don't sweat it", ru: "Не парься" },
      { en: "Speak of the devil", ru: "Помяни чёрта (и он появится) / Легок на помине / О волке помолвка, а волк и тут." },
      { en: "Grab a bite", ru: "Перекусить" },
      { en: "Take it easy", ru: "Расслабься / Успокойся" },
      { en: "Go with the flow", ru: "Плыть по течению / двигаться в потоке / делать, как все" },
      { en: "Twenty-four seven", ru: "Постоянно / 24 часа в сутки 7 дней в неделю" },
      { en: "Under the weather", ru: "Нездоровится / плохо себя чувствовать" },
      { en: "You can say that again", ru: "Полностью согласен / Это точно!" },
      { en: "Broke", ru: "На мели" },
      { en: "Beats me", ru: "Ума не приложу / Не понимаю / Не знаю" },
      { en: "I don't buy it", ru: "Я не верю / Не согласен / Не куплюсь на это" },
      { en: "Keep your cool", ru: "Успокойся / Держи себя под контролем" },
      { en: "Sort of", ru: "Как бы / вроде бы" },
      { en: "Good for you", ru: "Молодец / Поздравляю" },
      { en: "Good luck", ru: "Успехов / Удачи / Надеюсь, все будет хорошо" },
      { en: "Shotgun", ru: "Тот, кто сидит спереди в машине" },
      { en: "Who cares", ru: "Какая разница / Кому какое дело / Неважно" },
      { en: "Big deal", ru: "Важное дело / Трудное дело / Тоже мне дело (с сарказмом) No big deal - Не важно / Не страшно" },
      { en: "What a small world", ru: "Как тесен мир" },
      { en: "What's going on?", ru: "Что стряслось? / Что тут происходит?" },
      { en: "Now You're Talking", ru: "Мне нравится эта идея / Наконец-то хорошая мысль" },
      { en: "Over my dead body", ru: "Только через мой труп" },
      { en: "Coming right up", ru: "Сейчас будет сделано / Будет готово через минуту" },
      { en: "Good thinking", ru: "Правильная мысль / Хорошо, что ты подумал об этом / Вовремя исправился" },
      { en: "Shoot", ru: "Черт! / Блин!" },
      { en: "Nothing Matters", ru: "Все остальное не важно / Это самое важное" },
      { en: "Come on", ru: "Ну же! / Давай! / Да ладно" },
      { en: "Never mind", ru: "Не важно / Не нужно / Не думай об этом" },
      { en: "If you insist", ru: "Если вы настаиваете" },
      { en: "Stop it!", ru: "Прекрати! / Перестань!" },
      { en: "It's nothing", ru: "Это ерунда / Без проблем / Это не составит труда" },
      { en: "What gives?", ru: "Что случилось? / В чем дело?" },
      { en: "Fair enough", ru: "Справедливо" },
      { en: "Cat got your tongue", ru: "Воды в рот набрал / Язык проглотил" },
      { en: "My pleasure", ru: "С удовольствием / Приятно (это сделать)" },
      { en: "It totally slipped my mind", ru: "Это вылетело у меня из головы / Я совершенно забыл (что должен был это сделать)" },
      { en: "Give it to me straight", ru: "Скажи прямо / Скажи, как есть" },
      { en: "It's written all over your face", ru: "У тебя на лице написано" },
      { en: "Go for it", ru: "Иди к своей цели / Не отступай / Действуй" },
      { en: "It's a deal", ru: "Договорились" },
      { en: "Don't be a stranger", ru: "Не пропадай / Напоминай о себе" },
      { en: "Let's go fifty- fifty", ru: "Давайте разделим счет пополам" },
      { en: "Good for nothing", ru: "Ни к чему не пригодный / Никчемный / Ленивый" },
      { en: "You're telling me", ru: "И говорить нечего / Конечно / Еще бы" },
      { en: "Get a life", ru: "Отвали / Отстать/ Найди себе занятие (и перестать ко мне приставать)" },
      { en: "Don't joke with me", ru: "Это не смешно / Не шути так" },
      { en: "I can't thank you enough", ru: "Не знаю, как вас благодарить" },
      { en: "My two cents", ru: "Мое мнение" },
      { en: "Just name it", ru: "Только скажи (и я готов)" },
      { en: "No worries", ru: "Не волнуйся / Ничего страшного / Все в порядке" },
      { en: "Why so blue?", ru: "Чего такой грустный?" },
      { en: "Nature calls", ru: "Природа зовет / Нужно сходить в туалет / Нужно справить нужду" },
      { en: "What's eating you?", ru: "Что тебя гложет? / Что тебя беспокоит?" },
      { en: "Shame on you", ru: "Как тебе не стыдно? / Тебе должно быть стыдно" },
      { en: "Hang in there", ru: "Потерпи / Держись" },
      { en: "I owe you", ru: "Я буду тебе должен / Я могу у тебя одолжить?" },
      { en: "Take a hike", ru: "Иди куда подальше / Оставь меня в покое" },
      { en: "Give it a shot", ru: "Дать шанс / Сделать попытку" },
      { en: "I'm on my way", ru: "Я уже еду / Я уже в пути" },
      { en: "I'm hosed", ru: "Мне крышка / Я попал / Не повезло" },
      { en: "It's a long story", ru: "Долго рассказывать / Потом расскажу" },
      { en: "Since when", ru: "С каких пор" },
      { en: "Got it", ru: "Понятно / Ясно" },
      { en: "You wish", ru: "И не мечтай!" },
      { en: "You're dressed to kill", ru: "Выглядишь сногсшибательно" },
      { en: "Behave yourself", ru: "Веди себя хорошо / Следи за своим поведением" },
      { en: "That figures", ru: "Это логично / Ничего удивительного" },
      { en: "Do tell", ru: "Рассказывай (все, что знаешь)" },
      { en: "No sweat", ru: "Без проблем" },
      { en: "I blew it", ru: "Я все испортил" },
      { en: "Maddening", ru: "Это сводит с ума" },
      { en: "I messed up", ru: "Я облажался / Я сглупил / Я сделал ошибку" },
      { en: "I beg to differ", ru: "Я позволю себе не согласиться." },
      { en: "Rise and shine", ru: "Пора вставать / Проснись и пой" },
      { en: "You bet", ru: "Конечно" },
      { en: "Pie in the sky", ru: "Несбыточная мечта / Что-то недостижимое" },
      { en: "No strings attached", ru: "Без скрытых условий / От вас больше ничего не требуется" },
      { en: "Sleep tight", ru: "Спи крепко" },
      { en: "It can't hurt", ru: "Хуже не будет / Это не повредит" },
      { en: "I couldn't agree with you more", ru: "Целиком и полностью согласен с вами" },
      { en: "Thank goodness", ru: "Слава Богу" },
      { en: "You made it", ru: "У тебя получилось / Ты смог добраться (до места)" },
      { en: "Whatever", ru: "Не важно / Пусть будет так / С трудом верится / Что бы ты не говорил (я не верю)" },
      { en: "I'm sick of it", ru: "Меня это достало / Я устал от этого" },
      { en: "Get out of here", ru: "Да иди ты! / Шутишь? / Не гони!" },
      { en: "You made it big", ru: "Ты хорошо раскрутился / Ты хорошо преуспел / Ты многого достиг" },
      { en: "In your dreams", ru: "Только в мечтах (Этого никогда не случится)" },
      { en: "Hold on a sec", ru: "Постой / Подожди-ка" },
      { en: "Creepy", ru: "Доводящий до мурашек / Странный / Ненормальный" },
      { en: "You never know", ru: "Мало ли / Всякое бывает / Кто знает" },
      { en: "Back to the grind", ru: "Назад к работе / За работу" },
      { en: "It serves you right", ru: "Ты получил по заслугам" },
      { en: "I can't wait", ru: "Жду не дождусь / Жду с нетерпением / Не могу дождаться" },
      { en: "Lighten up", ru: "Расслабься / Взбодрись / Не расстраивайся" },
      { en: "Good point", ru: "Хорошая мысль (идея)" },
      { en: "Just my luck", ru: "Мне всегда не везет" },
      { en: "It's up to you", ru: "Решать тебе" },
      { en: "Hop in", ru: "Запрыгивай в машину" },
      { en: "I told you so", ru: "Я же говорил" },
      { en: "You know better than that", ru: "Но ты и так догадываешься (что поступил неправильно)" },
      { en: "Has been burned / got burned", ru: "Обжегся на этом / Погорел / Надули / Лоханулся" },
      { en: "Keep me in the loop", ru: "Держать в курсе" },
      { en: "I'll be down", ru: "Я с вами" },
      { en: "Get to the point", ru: "Ближе к сути / Говори по сути" },
      { en: "Down to earth", ru: "Разумный человек / Реалист" },
      { en: "Sure thing", ru: "Конечно / Без проблем" },
    ],
  },
};

async function seedSharedLibraryOnce() {
  let addedTopics = 0;
  let addedWords = 0;
  const allLevels = [
    SEED_SHARED_LIBRARY_A1,
    SEED_SHARED_LIBRARY_A2,
    SEED_SHARED_LIBRARY_B1,
    SEED_SHARED_LIBRARY_B2,
    SEED_SHARED_LIBRARY_C1,
    SEED_SHARED_LIBRARY_BIZ_A1,
    SEED_SHARED_LIBRARY_BIZ_A2,
    SEED_SHARED_LIBRARY_BIZ_B1,
    SEED_SHARED_LIBRARY_BIZ_B2,
    SEED_SHARED_LIBRARY_BIZ_C1,
    SEED_SHARED_LIBRARY_PHRASES,
  ];
  for (const level of allLevels) {
    for (const [topic, pairs] of Object.entries(level.topics)) {
      const { added } = await addSharedWords(level.difficulty, topic, pairs);
      if (added > 0) addedTopics += 1;
      addedWords += added;
    }
  }
  return { addedTopics, addedWords };
}

// в пару {en, ru}. Делит по языку, а не по конкретному символу — так надёжнее
// на разношёрстных заметках с уроков.
//
// Важно: соседние куски ОДНОГО языка склеиваются обратно с исходным разделителем
// между ними (а не одним пробелом) — иначе "Sing - sang - sung" превратилось бы
// в "Sing sang sung" (потеряли дефисы) и не совпало бы с уже сохранённой записью
// при повторном добавлении того же слова.
function parseVocabLine(raw) {
  let line = raw.trim();
  if (!line) return null;
  line = line.replace(/^[-*•\u2022\d]+[.)]?\s*/, "").trim(); // убрать буллиты/нумерацию
  if (!line) return null;

  const SEP_RE = /(\s+(?:->|—|–|→|=|\.|-)\s+)/;
  const parts = line.split(SEP_RE);
  if (parts.length < 3) return null; // нет ни одного разделителя

  const runs = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i].trim();
    if (!text) continue;
    // Кусок в /слэшах/ обычно фонетическая транскрипция ("Signature
    // /сигначэ/", "Now /naʊ/") — она может быть написана кириллицей и
    // сбивать определение языка (весь кусок выглядел бы "русским" из-за
    // неё). Для определения языка её не учитываем, но сохраняем как есть.
    const withoutPhonetic = text.replace(/\/[^/]*\//g, " ").trim();
    const langCheckText = withoutPhonetic || text;
    const isRu = CYR.test(langCheckText);
    const isEn = LAT.test(langCheckText) && !isRu;
    const lang = isRu ? "ru" : isEn ? "en" : null;
    const sepBefore = i > 0 ? parts[i - 1].trim() : "";
    const last = runs[runs.length - 1];
    if (last && last.lang === lang && lang !== null) {
      last.text += ` ${sepBefore} ${text}`;
    } else {
      runs.push({ lang, text });
    }
  }

  const enRuns = runs.filter((r) => r.lang === "en").map((r) => r.text.trim());
  const ruRuns = runs.filter((r) => r.lang === "ru").map((r) => r.text.trim());
  if (!enRuns.length || !ruRuns.length) return null;
  return { en: enRuns.join(" ").trim(), ru: ruRuns.join(", ").trim() };
}

// Добавляет распарсенные пары в словарь, пропуская дубли (по english, без учёта регистра).
// Устойчиво к гонкам: если словарь параллельно поменяли (например, ты добавляешь
// слова, а кто-то в этот же момент отвечает на вопрос и т.п.), просто повторяем попытку.
async function addWords(chatId, pairs) {
  let added = 0;
  let total = 0;
  await withOptimisticUpdate(
    wordsStore(),
    `words:${chatId}`,
    () => [],
    (vocab) => {
      const next = [...vocab];
      const seen = new Set(next.map((w) => w.en.toLowerCase()));
      added = 0;
      for (const p of pairs) {
        const key = p.en.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(p);
        added += 1;
      }
      total = next.length;
      return next;
    }
  );
  return { added, total };
}

async function deleteWord(chatId, term) {
  let removed = false;
  let total = 0;
  await withOptimisticUpdate(
    wordsStore(),
    `words:${chatId}`,
    () => [],
    (vocab) => {
      const before = vocab.length;
      const next = vocab.filter((w) => w.en.toLowerCase() !== term);
      removed = next.length !== before;
      total = next.length;
      return next;
    }
  );
  return { removed, total };
}

// Из строки вида "English. перевод" / "English . перевод" / просто "English"
// достаёт именно английскую часть — для удаления не важен точный формат
// разделителя, только по какому слову искать.
function extractEnForDelete(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const idxSpaceDot = trimmed.indexOf(" . ");
  if (idxSpaceDot > 0) return trimmed.slice(0, idxSpaceDot).trim();
  const idxDot = trimmed.indexOf(". ");
  if (idxDot > 0) return trimmed.slice(0, idxDot).trim();
  return trimmed;
}

// Удаляет сразу несколько слов (по одному на строку, в любом из форматов
// выше) одной атомарной операцией.
async function deleteWords(chatId, terms) {
  const termSet = new Set(terms.map((t) => t.toLowerCase()));
  let removedCount = 0;
  let total = 0;
  await withOptimisticUpdate(
    wordsStore(),
    `words:${chatId}`,
    () => [],
    (vocab) => {
      const before = vocab.length;
      const next = vocab.filter((w) => !termSet.has(w.en.toLowerCase()));
      removedCount = before - next.length;
      total = next.length;
      return next;
    }
  );
  return { removedCount, total };
}

async function tg(method, payload) {
  // Пауза, чтобы не слать больше ~1 сообщения в секунду в один и тот же чат
  // (см. комментарий у MIN_MS_BETWEEN_MESSAGES) — применяется ко всем
  // sendMessage/sendAudio-вызовам автоматически, не только к вопросам.
  if ((method === "sendMessage" || method === "sendAudio") && payload && payload.chat_id != null) {
    await waitForRateLimit(payload.chat_id);
  }

  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    await log(`[tg:${method}] FAILED status=${res.status}`, JSON.stringify(data), "payload:", JSON.stringify(payload));
  } else {
    await log(`[tg:${method}] ok`);
    if ((method === "sendMessage" || method === "sendAudio") && payload && payload.chat_id != null) {
      await markMessageSent(payload.chat_id);
    }
  }
  return data;
}

// На случай если в словаре попадутся символы Markdown (*, _, [, `) —
// чтобы бот не падал с ошибкой форматирования у Telegram.
function mdEscape(s) {
  return String(s).replace(/([_*`[])/g, "\\$1");
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ===================== Режим "Грамматика" =====================
// В отличие от лексики (готовый список слов), упражнения генерируются на
// лету из набора подлежащих и глаголов — вариантов получается очень много,
// так что осмысленно "закончить" этот режим невозможно.
//
// Четыре формата вместо одного общего — каждый целится в конкретную
// типичную ошибку:
//  - tenses: общая тренировка на все времена/утверждение-отрицание сразу
//  - negation: don't / doesn't / didn't — самая частая путаница
//  - tobe: когда нужен to be (am/is/are/was/were), а когда — обычный
//    глагол ("She tired" вместо "She is tired", или наоборot "She is
//    play" вместо "She plays")
//  - v2vs: V2 (прошедшее) vs Vs (3-е лицо наст. времени) — "goes" vs
//    "went", с явным маркером времени (every day / yesterday), чтобы
//    ошибка была видна конкретно

const GRAMMAR_EXERCISE_TYPES = {
  tenses: "🔀 Времена (общее)",
  negation: "❌ Отрицания: don't / doesn't / didn't",
  tobe: "🔵 To be vs. обычный глагол",
  v2vs: "🔁 V2 vs Vs (прошедшее / настоящее)",
  vsV1: "🔤 Vs vs V1 (He/She vs We, только настоящее)",
  psVsPrPs: "🆕 Past Simple vs Present Perfect (для начинающих)",
  gerundInfinitive: "🎯 V-ing или to-V1 (enjoy doing / want to do)",
  trapWords: "🪤 Слова-ловушки (mean/present/fine...)",
  collocations: "🤝 give / get / take / have",
  modalMeaning: "🧭 Модальные — по смыслу",
  modalTo: "🔧 Модальные — нужна ли to",
  futureInPast: "⏳ Future in the Past vs Future Simple",
  someAnyNo: "🔸 Some / any / no (something, someone, somewhere…)",
  mix: "🎲 Микс всех форматов",
};
const GRAMMAR_REAL_EXERCISE_TYPES = [
  "tenses",
  "negation",
  "tobe",
  "v2vs",
  "vsV1",
  "psVsPrPs",
  "gerundInfinitive",
  "trapWords",
  "collocations",
  "modalMeaning",
  "modalTo",
  "futureInPast",
  "someAnyNo",
];

const TRAP_WORDS = [
  {
    base: "mean", past: "meant", participle: "meant",
    ruInf: "означать", ru3sg: "означает", ru1pl: "означаем", ru3pl: "означают",
    ruPastM: "означал", ruPastF: "означала", ruPastPl: "означали",
    contextEn: "trouble", contextRu: "проблемы",
    adjNomM: "подлый", adjNomF: "подлая", adjNomPl: "подлые",
    adjInstrM: "подлым", adjInstrF: "подлой", adjInstrPl: "подлыми",
  },
  {
    base: "present", past: "presented", participle: "presented",
    ruInf: "представлять", ru3sg: "представляет", ru1pl: "представляем", ru3pl: "представляют",
    ruPastM: "представлял", ruPastF: "представляла", ruPastPl: "представляли",
    contextEn: "the results", contextRu: "результаты",
    adjNomM: "присутствующий", adjNomF: "присутствующая", adjNomPl: "присутствующие",
    adjInstrM: "присутствующим", adjInstrF: "присутствующей", adjInstrPl: "присутствующими",
  },
  {
    base: "fine", past: "fined", participle: "fined",
    ruInf: "штрафовать", ru3sg: "штрафует", ru1pl: "штрафуем", ru3pl: "штрафуют",
    ruPastM: "штрафовал", ruPastF: "штрафовала", ruPastPl: "штрафовали",
    contextEn: "the driver", contextRu: "водителя",
    adjNomM: "прекрасный", adjNomF: "прекрасная", adjNomPl: "прекрасные",
    adjInstrM: "прекрасным", adjInstrF: "прекрасной", adjInstrPl: "прекрасными",
  },
  {
    base: "right", past: "righted", participle: "righted",
    ruInf: "исправлять", ru3sg: "исправляет", ru1pl: "исправляем", ru3pl: "исправляют",
    ruPastM: "исправлял", ruPastF: "исправляла", ruPastPl: "исправляли",
    contextEn: "the situation", contextRu: "ситуацию",
    adjNomM: "правильный", adjNomF: "правильная", adjNomPl: "правильные",
    adjInstrM: "правильным", adjInstrF: "правильной", adjInstrPl: "правильными",
  },
  {
    base: "close", past: "closed", participle: "closed",
    ruInf: "закрывать", ru3sg: "закрывает", ru1pl: "закрываем", ru3pl: "закрывают",
    ruPastM: "закрывал", ruPastF: "закрывала", ruPastPl: "закрывали",
    contextEn: "the shop", contextRu: "магазин",
    adjNomM: "близкий", adjNomF: "близкая", adjNomPl: "близкие",
    adjInstrM: "близким", adjInstrF: "близкой", adjInstrPl: "близкими",
  },
  {
    base: "light", past: "lit", participle: "lit",
    ruInf: "зажигать", ru3sg: "зажигает", ru1pl: "зажигаем", ru3pl: "зажигают",
    ruPastM: "зажигал", ruPastF: "зажигала", ruPastPl: "зажигали",
    contextEn: "the candle", contextRu: "свечу",
    adjNomM: "лёгкий", adjNomF: "лёгкая", adjNomPl: "лёгкие",
    adjInstrM: "лёгким", adjInstrF: "лёгкой", adjInstrPl: "лёгкими",
  },
];

const GRAMMAR_VERBS = [
  { base: "go", participle: "gone", past: "went", ru: "идти / ходить", contextEn: "to school", contextRu: "в школу",
    ruInf: "идти", ru3sg: "идёт", ru1pl: "идём", ru3pl: "идут", ruPastM: "шёл", ruPastF: "шла", ruPastPl: "шли" },
  { base: "go", participle: "gone", past: "went", ru: "идти / ходить", contextEn: "to the cinema", contextRu: "в кино",
    ruInf: "идти", ru3sg: "идёт", ru1pl: "идём", ru3pl: "идут", ruPastM: "шёл", ruPastF: "шла", ruPastPl: "шли" },
  { base: "play", participle: "played", past: "played", ru: "играть", contextEn: "football", contextRu: "в футбол",
    ruInf: "играть", ru3sg: "играет", ru1pl: "играем", ru3pl: "играют", ruPastM: "играл", ruPastF: "играла", ruPastPl: "играли" },
  { base: "play", participle: "played", past: "played", ru: "играть", contextEn: "the guitar", contextRu: "на гитаре",
    ruInf: "играть", ru3sg: "играет", ru1pl: "играем", ru3pl: "играют", ruPastM: "играл", ruPastF: "играла", ruPastPl: "играли" },
  { base: "watch", participle: "watched", past: "watched", ru: "смотреть", contextEn: "a film", contextRu: "фильм",
    ruInf: "смотреть", ru3sg: "смотрит", ru1pl: "смотрим", ru3pl: "смотрят", ruPastM: "смотрел", ruPastF: "смотрела", ruPastPl: "смотрели" },
  { base: "work", participle: "worked", past: "worked", ru: "работать", contextEn: "at home", contextRu: "дома",
    ruInf: "работать", ru3sg: "работает", ru1pl: "работаем", ru3pl: "работают", ruPastM: "работал", ruPastF: "работала", ruPastPl: "работали" },
  { base: "study", participle: "studied", past: "studied", ru: "учить", contextEn: "English", contextRu: "английский",
    ruInf: "учить", ru3sg: "учит", ru1pl: "учим", ru3pl: "учат", ruPastM: "учил", ruPastF: "учила", ruPastPl: "учили" },
  { base: "eat", participle: "eaten", past: "ate", ru: "есть (кушать)", contextEn: "breakfast", contextRu: "завтрак",
    ruInf: "есть", ru3sg: "ест", ru1pl: "едим", ru3pl: "едят", ruPastM: "ел", ruPastF: "ела", ruPastPl: "ели" },
  { base: "drink", participle: "drunk", past: "drank", ru: "пить", contextEn: "coffee", contextRu: "кофе",
    ruInf: "пить", ru3sg: "пьёт", ru1pl: "пьём", ru3pl: "пьют", ruPastM: "пил", ruPastF: "пила", ruPastPl: "пили" },
  { base: "read", participle: "read", past: "read", ru: "читать", contextEn: "a book", contextRu: "книгу",
    ruInf: "читать", ru3sg: "читает", ru1pl: "читаем", ru3pl: "читают", ruPastM: "читал", ruPastF: "читала", ruPastPl: "читали" },
  { base: "write", participle: "written", past: "wrote", ru: "писать", contextEn: "a letter", contextRu: "письмо",
    ruInf: "писать", ru3sg: "пишет", ru1pl: "пишем", ru3pl: "пишут", ruPastM: "писал", ruPastF: "писала", ruPastPl: "писали" },
  { base: "speak", participle: "spoken", past: "spoke", ru: "говорить", contextEn: "English", contextRu: "по-английски",
    ruInf: "говорить", ru3sg: "говорит", ru1pl: "говорим", ru3pl: "говорят", ruPastM: "говорил", ruPastF: "говорила", ruPastPl: "говорили" },
  { base: "come", participle: "come", past: "came", ru: "приходить", contextEn: "home late", contextRu: "домой поздно",
    ruInf: "приходить", ru3sg: "приходит", ru1pl: "приходим", ru3pl: "приходят", ruPastM: "приходил", ruPastF: "приходила", ruPastPl: "приходили" },
  { base: "see", participle: "seen", past: "saw", ru: "видеть", contextEn: "my friends", contextRu: "своих друзей",
    ruInf: "видеть", ru3sg: "видит", ru1pl: "видим", ru3pl: "видят", ruPastM: "видел", ruPastF: "видела", ruPastPl: "видели" },
  { base: "make", participle: "made", past: "made", ru: "делать (создавать)", contextEn: "dinner", contextRu: "ужин",
    ruInf: "делать", ru3sg: "делает", ru1pl: "делаем", ru3pl: "делают", ruPastM: "делал", ruPastF: "делала", ruPastPl: "делали" },
  { base: "take", participle: "taken", past: "took", ru: "брать", contextEn: "a taxi", contextRu: "такси",
    ruInf: "брать", ru3sg: "берёт", ru1pl: "берём", ru3pl: "берут", ruPastM: "брал", ruPastF: "брала", ruPastPl: "брали" },
  { base: "do", participle: "done", past: "did", ru: "делать", irregular3rd: "does", contextEn: "my homework", contextRu: "домашнюю работу",
    ruInf: "делать", ru3sg: "делает", ru1pl: "делаем", ru3pl: "делают", ruPastM: "делал", ruPastF: "делала", ruPastPl: "делали" },
  { base: "help", participle: "helped", past: "helped", ru: "помогать", contextEn: "my mother", contextRu: "маме",
    ruInf: "помогать", ru3sg: "помогает", ru1pl: "помогаем", ru3pl: "помогают", ruPastM: "помогал", ruPastF: "помогала", ruPastPl: "помогали" },
  { base: "call", participle: "called", past: "called", ru: "звонить", contextEn: "my friend", contextRu: "другу",
    ruInf: "звонить", ru3sg: "звонит", ru1pl: "звоним", ru3pl: "звонят", ruPastM: "звонил", ruPastF: "звонила", ruPastPl: "звонили" },
  { base: "clean", participle: "cleaned", past: "cleaned", ru: "убирать", contextEn: "the house", contextRu: "дом",
    ruInf: "убирать", ru3sg: "убирает", ru1pl: "убираем", ru3pl: "убирают", ruPastM: "убирал", ruPastF: "убирала", ruPastPl: "убирали" },
  // --- Расширение по просьбе Margy (02.10.2026): раньше тренажёр по временам
  // (pr.s/p.s/f.s) звучал слишком однотипно — всего ~19 глаголов и 2
  // временных маркера на время давали маленькое комбинаторное пространство.
  // Лексика ниже взята из её личной базы "English Grammar Sentence Bank" в
  // Notion (реальные проверенные предложения из Everyday Life A1 и Business
  // A1 — именно там сосредоточены разделы Present/Past/Future Simple) —
  // глагол+контекст извлечены из настоящих предложений базы, а не
  // придуманы с нуля, то есть материал "подходящий" в её терминологии.
  { base: "know", participle: "known", past: "knew", ru: "знать", contextEn: "the answer", contextRu: "ответ",
    ruInf: "знать", ru3sg: "знает", ru1pl: "знаем", ru3pl: "знают", ruPastM: "знал", ruPastF: "знала", ruPastPl: "знали" },
  { base: "buy", participle: "bought", past: "bought", ru: "покупать", contextEn: "a present", contextRu: "подарок",
    ruInf: "покупать", ru3sg: "покупает", ru1pl: "покупаем", ru3pl: "покупают", ruPastM: "покупал", ruPastF: "покупала", ruPastPl: "покупали" },
  { base: "update", participle: "updated", past: "updated", ru: "обновлять", contextEn: "the website", contextRu: "сайт",
    ruInf: "обновлять", ru3sg: "обновляет", ru1pl: "обновляем", ru3pl: "обновляют", ruPastM: "обновлял", ruPastF: "обновляла", ruPastPl: "обновляли" },
  { base: "publish", participle: "published", past: "published", ru: "публиковать", contextEn: "an article", contextRu: "статью",
    ruInf: "публиковать", ru3sg: "публикует", ru1pl: "публикуем", ru3pl: "публикуют", ruPastM: "публиковал", ruPastF: "публиковала", ruPastPl: "публиковали" },
  { base: "go", participle: "gone", past: "went", ru: "идти / ходить", contextEn: "shopping", contextRu: "по магазинам",
    ruInf: "идти", ru3sg: "идёт", ru1pl: "идём", ru3pl: "идут", ruPastM: "шёл", ruPastF: "шла", ruPastPl: "шли" },
  { base: "bring", participle: "brought", past: "brought", ru: "приносить", contextEn: "flowers", contextRu: "цветы",
    ruInf: "приносить", ru3sg: "приносит", ru1pl: "приносим", ru3pl: "приносят", ruPastM: "приносил", ruPastF: "приносила", ruPastPl: "приносили" },
  { base: "achieve", participle: "achieved", past: "achieved", ru: "достигать", contextEn: "the goal", contextRu: "цели",
    ruInf: "достигать", ru3sg: "достигает", ru1pl: "достигаем", ru3pl: "достигают", ruPastM: "достигал", ruPastF: "достигала", ruPastPl: "достигали" },
  { base: "give", participle: "given", past: "gave", ru: "давать", contextEn: "advice", contextRu: "советы",
    ruInf: "давать", ru3sg: "даёт", ru1pl: "даём", ru3pl: "дают", ruPastM: "давал", ruPastF: "давала", ruPastPl: "давали" },
  { base: "make", participle: "made", past: "made", ru: "принимать", contextEn: "a decision", contextRu: "решение",
    ruInf: "принимать", ru3sg: "принимает", ru1pl: "принимаем", ru3pl: "принимают", ruPastM: "принимал", ruPastF: "принимала", ruPastPl: "принимали" },
  { base: "meet", participle: "met", past: "met", ru: "встречать", contextEn: "a client", contextRu: "клиента",
    ruInf: "встречать", ru3sg: "встречает", ru1pl: "встречаем", ru3pl: "встречают", ruPastM: "встречал", ruPastF: "встречала", ruPastPl: "встречали" },
  { base: "have", participle: "had", past: "had", ru: "проводить", irregular3rd: "has", contextEn: "a meeting", contextRu: "встречу",
    ruInf: "проводить", ru3sg: "проводит", ru1pl: "проводим", ru3pl: "проводят", ruPastM: "проводил", ruPastF: "проводила", ruPastPl: "проводили" },
  { base: "check", participle: "checked", past: "checked", ru: "проверять", contextEn: "the report", contextRu: "отчёт",
    ruInf: "проверять", ru3sg: "проверяет", ru1pl: "проверяем", ru3pl: "проверяют", ruPastM: "проверял", ruPastF: "проверяла", ruPastPl: "проверяли" },
  { base: "send", participle: "sent", past: "sent", ru: "отправлять", contextEn: "an email", contextRu: "письмо",
    ruInf: "отправлять", ru3sg: "отправляет", ru1pl: "отправляем", ru3pl: "отправляют", ruPastM: "отправлял", ruPastF: "отправляла", ruPastPl: "отправляли" },
  { base: "pay", participle: "paid", past: "paid", ru: "платить", contextEn: "the bill", contextRu: "по счёту",
    ruInf: "платить", ru3sg: "платит", ru1pl: "платим", ru3pl: "платят", ruPastM: "платил", ruPastF: "платила", ruPastPl: "платили" },
  { base: "open", participle: "opened", past: "opened", ru: "открывать", contextEn: "the shop", contextRu: "магазин",
    ruInf: "открывать", ru3sg: "открывает", ru1pl: "открываем", ru3pl: "открывают", ruPastM: "открывал", ruPastF: "открывала", ruPastPl: "открывали" },
  { base: "close", participle: "closed", past: "closed", ru: "закрывать", contextEn: "the office", contextRu: "офис",
    ruInf: "закрывать", ru3sg: "закрывает", ru1pl: "закрываем", ru3pl: "закрывают", ruPastM: "закрывал", ruPastF: "закрывала", ruPastPl: "закрывали" },
  { base: "finish", participle: "finished", past: "finished", ru: "заканчивать", contextEn: "the project", contextRu: "проект",
    ruInf: "заканчивать", ru3sg: "заканчивает", ru1pl: "заканчиваем", ru3pl: "заканчивают", ruPastM: "заканчивал", ruPastF: "заканчивала", ruPastPl: "заканчивали" },
  { base: "start", participle: "started", past: "started", ru: "начинать", contextEn: "a new job", contextRu: "новую работу",
    ruInf: "начинать", ru3sg: "начинает", ru1pl: "начинаем", ru3pl: "начинают", ruPastM: "начинал", ruPastF: "начинала", ruPastPl: "начинали" },
  { base: "visit", participle: "visited", past: "visited", ru: "посещать", contextEn: "the museum", contextRu: "музей",
    ruInf: "посещать", ru3sg: "посещает", ru1pl: "посещаем", ru3pl: "посещают", ruPastM: "посещал", ruPastF: "посещала", ruPastPl: "посещали" },
  { base: "answer", participle: "answered", past: "answered", ru: "отвечать на", contextEn: "the question", contextRu: "вопрос",
    ruInf: "отвечать на", ru3sg: "отвечает на", ru1pl: "отвечаем на", ru3pl: "отвечают на", ruPastM: "отвечал на", ruPastF: "отвечала на", ruPastPl: "отвечали на" },
  { base: "ask", participle: "asked", past: "asked", ru: "задавать", contextEn: "a question", contextRu: "вопрос",
    ruInf: "задавать", ru3sg: "задаёт", ru1pl: "задаём", ru3pl: "задают", ruPastM: "задавал", ruPastF: "задавала", ruPastPl: "задавали" },
  { base: "need", participle: "needed", past: "needed", ru: "нуждаться в", contextEn: "more time", contextRu: "дополнительном времени",
    ruInf: "нуждаться в", ru3sg: "нуждается в", ru1pl: "нуждаемся в", ru3pl: "нуждаются в", ruPastM: "нуждался в", ruPastF: "нуждалась в", ruPastPl: "нуждались в" },
  { base: "like", participle: "liked", past: "liked", ru: "любить", contextEn: "this idea", contextRu: "эту идею",
    ruInf: "любить", ru3sg: "любит", ru1pl: "любим", ru3pl: "любят", ruPastM: "любил", ruPastF: "любила", ruPastPl: "любили" },
  { base: "use", participle: "used", past: "used", ru: "использовать", contextEn: "a new system", contextRu: "новую систему",
    ruInf: "использовать", ru3sg: "использует", ru1pl: "используем", ru3pl: "используют", ruPastM: "использовал", ruPastF: "использовала", ruPastPl: "использовали" },
  { base: "offer", participle: "offered", past: "offered", ru: "предлагать", contextEn: "a discount", contextRu: "скидку",
    ruInf: "предлагать", ru3sg: "предлагает", ru1pl: "предлагаем", ru3pl: "предлагают", ruPastM: "предлагал", ruPastF: "предлагала", ruPastPl: "предлагали" },
  { base: "sign", participle: "signed", past: "signed", ru: "подписывать", contextEn: "the contract", contextRu: "контракт",
    ruInf: "подписывать", ru3sg: "подписывает", ru1pl: "подписываем", ru3pl: "подписывают", ruPastM: "подписывал", ruPastF: "подписывала", ruPastPl: "подписывали" },
  ...TRAP_WORDS.map((w) => ({
    base: w.base, participle: w.participle, past: w.past, ru: w.ruInf, contextEn: w.contextEn, contextRu: w.contextRu,
    ruInf: w.ruInf, ru3sg: w.ru3sg, ru1pl: w.ru1pl, ru3pl: w.ru3pl, ruPastM: w.ruPastM, ruPastF: w.ruPastF, ruPastPl: w.ruPastPl,
  })),
];

const GRAMMAR_SUBJECTS = [
  { pron: "I", ru: "я", is3rd: false, poss: "my" },
  { pron: "You", ru: "ты", is3rd: false, poss: "your" },
  { pron: "He", ru: "он", is3rd: true, poss: "his" },
  { pron: "She", ru: "она", is3rd: true, poss: "her" },
  { pron: "We", ru: "мы", is3rd: false, poss: "our" },
  { pron: "They", ru: "они", is3rd: false, poss: "their" },
];

// Только для формата "tenses" (натуральные русские предложения): без "I"/
// "You" — у них в прошедшем времени по-русски нужен род говорящего
// (шёл/шла), а мы его не знаем. He/She однозначны по роду, We/They не
// требуют рода вовсе (мн. число).
// ruDative — дательный падеж подлежащего ("мне"/"ему"/"моему другу"...),
// нужен для модальных конструкций вроде "мне нужно"/"ему следует" (формат
// "modalMeaning"/"modalTo"). actsAsWe — подлежащее грамматически ведёт
// себя как "мы" (составное "X и я"/"мы с X"): и по-русски спрягается как
// 1-е лицо мн. числа (играем, не играют), и will-будущее берёт "будем", а
// не "будут" — это НЕ то же самое, что просто "isPlural" (обычное 3-е лицо
// мн. числа — They/My colleagues — спрягается иначе: играют/будут).
const RU_SENTENCE_SUBJECTS = [
  { pron: "He", ru: "он", ruDative: "ему", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "She", ru: "она", ruDative: "ей", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "We", ru: "мы", ruDative: "нам", is3rd: false, poss: "our", gender: null, isPlural: true, actsAsWe: true },
  { pron: "They", ru: "они", ruDative: "им", is3rd: false, poss: "their", gender: null, isPlural: true },
  // --- Расширение по просьбе Margy (02.10.2026): формат "v2vs" (и другие
  // форматы, которые берут подлежащее из этого же общего пула) звучали
  // однотипно — всего 2 варианта подлежащего на 3-е лицо (He/She). Ниже —
  // ещё 3-е лицо ед. числа ("He/She"-подобные, is3rd: true), чтобы
  // увеличить разнообразие, не трогая русское согласование по роду/числу
  // (оно уже обрабатывается через gender/isPlural везде, где используется).
  { pron: "My friend", ru: "мой друг", ruDative: "моему другу", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "My sister", ru: "моя сестра", ruDative: "моей сестре", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "My brother", ru: "мой брат", ruDative: "моему брату", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "My mother", ru: "моя мама", ruDative: "моей маме", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "My father", ru: "мой папа", ruDative: "моему папе", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "My colleague", ru: "мой коллега", ruDative: "моему коллеге", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "The teacher", ru: "учитель", ruDative: "учителю", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "My neighbour", ru: "мой сосед", ruDative: "моему соседу", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "My parents", ru: "мои родители", ruDative: "моим родителям", is3rd: false, poss: "their", gender: null, isPlural: true },
  { pron: "My friends", ru: "мои друзья", ruDative: "моим друзьям", is3rd: false, poss: "their", gender: null, isPlural: true },
  // --- Расширение по просьбе Margy (02.10.2026, второй заход): "добавь
  // имён в подлежащие" — настоящие имена (не только родственники) и
  // составные подлежащие с "и я" ("Kate and I" = "мы с Кейт" — по-русски
  // так естественнее, чем дословное "Кейт и я").
  { pron: "Kate", ru: "Кейт", ruDative: "Кейт", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Tom", ru: "Том", ruDative: "Тому", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "My husband", ru: "мой муж", ruDative: "моему мужу", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "My colleagues", ru: "мои коллеги", ruDative: "моим коллегам", is3rd: false, poss: "their", gender: null, isPlural: true },
  { pron: "Kate and I", ru: "мы с Кейт", ruDative: "нам с Кейт", is3rd: false, poss: "our", gender: null, isPlural: true, actsAsWe: true },
  { pron: "My friend and I", ru: "мы с другом", ruDative: "нам с другом", is3rd: false, poss: "our", gender: null, isPlural: true, actsAsWe: true },
  { pron: "My colleague and I", ru: "мы с коллегой", ruDative: "нам с коллегой", is3rd: false, poss: "our", gender: null, isPlural: true, actsAsWe: true },
  // --- Расширение по просьбе Margy (02.10.2026, третий заход): топ-25
  // мужских + топ-25 женских имён из её списка (Top Boys/Girls Names).
  // "Lucas" в её списке встретился дважды (#13 и #19) — добавлен один раз.
  // Все имена — 3-е лицо ед. числа (is3rd: true), чтобы пополнить пул для
  // v2vs/tenses/modal-форматов. ru — её собственный перевод из списка;
  // ruDative — дательный падеж для модальных конструкций ("Ною нужно...").
  { pron: "Noah", ru: "Ной", ruDative: "Ною", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Oliver", ru: "Оливер", ruDative: "Оливеру", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Liam", ru: "Лиам", ruDative: "Лиаму", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "George", ru: "Джордж", ruDative: "Джорджу", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Arthur", ru: "Артур", ruDative: "Артуру", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Muhammad", ru: "Мухаммад", ruDative: "Мухаммаду", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Leo", ru: "Лео", ruDative: "Лео", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Harry", ru: "Гарри", ruDative: "Гарри", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Jack", ru: "Джек", ruDative: "Джеку", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Henry", ru: "Генри", ruDative: "Генри", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Oscar", ru: "Оскар", ruDative: "Оскару", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Archie", ru: "Арчи", ruDative: "Арчи", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Lucas", ru: "Лукас", ruDative: "Лукасу", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Ethan", ru: "Итан", ruDative: "Итану", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Mason", ru: "Мейсон", ruDative: "Мейсону", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Elijah", ru: "Элайджа", ruDative: "Элайдже", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "James", ru: "Джеймс", ruDative: "Джеймсу", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Benjamin", ru: "Бенджамин", ruDative: "Бенджамину", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Alexander", ru: "Александер", ruDative: "Александеру", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Sebastian", ru: "Себастьян", ruDative: "Себастьяну", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Daniel", ru: "Дэниел", ruDative: "Дэниелу", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Logan", ru: "Логан", ruDative: "Логану", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Jackson", ru: "Джексон", ruDative: "Джексону", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Samuel", ru: "Самуэль", ruDative: "Самуэлю", is3rd: true, poss: "his", gender: "m", isPlural: false },
  { pron: "Olivia", ru: "Оливия", ruDative: "Оливии", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Amelia", ru: "Амелия", ruDative: "Амелии", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Isla", ru: "Айла", ruDative: "Айле", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Ava", ru: "Ава", ruDative: "Аве", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Ivy", ru: "Айви", ruDative: "Айви", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Freya", ru: "Фрейя", ruDative: "Фрейе", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Lily", ru: "Лили", ruDative: "Лили", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Florence", ru: "Флоренс", ruDative: "Флоренс", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Mia", ru: "Миа", ruDative: "Мие", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Willow", ru: "Уиллоу", ruDative: "Уиллоу", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Emily", ru: "Эмили", ruDative: "Эмили", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Sophia", ru: "София", ruDative: "Софии", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Isabella", ru: "Изабелла", ruDative: "Изабелле", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Ella", ru: "Элла", ruDative: "Элле", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Grace", ru: "Грейс", ruDative: "Грейс", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Charlotte", ru: "Шарлотт", ruDative: "Шарлотт", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Harper", ru: "Харпер", ruDative: "Харпер", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Evelyn", ru: "Эвелин", ruDative: "Эвелин", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Scarlett", ru: "Скарлетт", ruDative: "Скарлетт", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Aria", ru: "Арья", ruDative: "Арье", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Luna", ru: "Луна", ruDative: "Луне", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Chloe", ru: "Хлои", ruDative: "Хлои", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Penelope", ru: "Пенелопа", ruDative: "Пенелопе", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Mila", ru: "Мила", ruDative: "Миле", is3rd: true, poss: "her", gender: "f", isPlural: false },
  { pron: "Elizabeth", ru: "Элизабет", ruDative: "Элизабет", is3rd: true, poss: "her", gender: "f", isPlural: false },
];

// Явные показатели времени по-русски — делают время однозначным, не
// оставляя простора для "а может, это другое время". "недавно" и "совсем
// скоро" убраны по просьбе Margy (02.10.2026) — это "ложные маркеры",
// которые не однозначно указывают на одно время (могут звучать и в
// Present Perfect / near future другими способами), заменены на более
// надёжные.
const RU_TIME_MARKERS = {
  present: ["каждый день", "обычно", "часто", "иногда", "каждую неделю", "по утрам"],
  past: ["вчера", "на прошлой неделе", "позавчера", "два дня назад", "в прошлом месяце", "в прошлом году"],
  future: ["завтра", "на следующей неделе", "послезавтра", "через два дня", "в следующем месяце", "через месяц"],
};

// Спрягает русский глагол под подлежащее/время/полярность — используется
// только для натуральных предложений в формате "tenses".
function ruConjugate(verb, subject, tense) {
  let form;
  if (tense === "present") {
    form = subject.isPlural ? (subject.actsAsWe ? verb.ru1pl : verb.ru3pl) : verb.ru3sg;
  } else if (tense === "past") {
    form = subject.isPlural ? verb.ruPastPl : subject.gender === "m" ? verb.ruPastM : verb.ruPastF;
  } else {
    const aux = subject.actsAsWe ? "будем" : subject.isPlural ? "будут" : "будет";
    form = `${aux} ${verb.ruInf}`;
  }
  return form;
}

function buildRuSentence(subject, verb, tense, polarity, marker) {
  const verbForm = ruConjugate(verb, subject, tense);
  const negPrefix = polarity === "negative" ? "не " : "";
  const sentence = `${subject.ru} ${negPrefix}${verbForm} ${verb.contextRu} ${marker}`.replace(/\s+/g, " ").trim();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const TENSE_POLARITY_COMBOS = [
  { tense: "present", polarity: "affirmative", label: "Present Simple, утверждение" },
  { tense: "present", polarity: "negative", label: "Present Simple, отрицание" },
  { tense: "past", polarity: "affirmative", label: "Past Simple, утверждение" },
  { tense: "past", polarity: "negative", label: "Past Simple, отрицание" },
  { tense: "future", polarity: "affirmative", label: "Future Simple, утверждение" },
  { tense: "future", polarity: "negative", label: "Future Simple, отрицание" },
];

function thirdPersonForm(verb) {
  if (verb.irregular3rd) return verb.irregular3rd;
  const b = verb.base;
  if (/[sxz]$/.test(b) || /(ch|sh)$/.test(b) || /o$/.test(b)) return b + "es";
  if (/[^aeiou]y$/.test(b)) return b.slice(0, -1) + "ies";
  return b + "s";
}

// Для -ing-дистракторов: отбрасываем немую "e" на конце (write -> writing,
// make -> making), не трогаем случаи вроде "see"/"agree", где "e"
// произносится (двойная "ee").
function ingForm(verb) {
  const b = verb.base;
  if (/[^aeiou]e$/.test(b)) return b.slice(0, -1) + "ing";
  return b + "ing";
}

function conjugate(subject, verb, tense, polarity) {
  const is3rd = subject.is3rd;
  if (tense === "present") {
    if (polarity === "affirmative") return is3rd ? thirdPersonForm(verb) : verb.base;
    return (is3rd ? "doesn't " : "don't ") + verb.base;
  }
  if (tense === "past") {
    if (polarity === "affirmative") return verb.past;
    return "didn't " + verb.base;
  }
  // future
  if (polarity === "affirmative") return "will " + verb.base;
  return "won't " + verb.base;
}

function contextFor(subject, verb) {
  return verb.contextEn.replace(/\bmy\b/, subject.poss);
}

// --- Формат "tenses": общая тренировка на все времена/утверждение-отрицание ---
function buildTensesQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const targetIdx = Math.floor(Math.random() * TENSE_POLARITY_COMBOS.length);
    const target = TENSE_POLARITY_COMBOS[targetIdx];
    const markers = RU_TIME_MARKERS[target.tense];
    const marker = markers[Math.floor(Math.random() * markers.length)];

    const context = contextFor(subject, verb);
    const sentences = TENSE_POLARITY_COMBOS.map((c) => `${subject.pron} ${conjugate(subject, verb, c.tense, c.polarity)} ${context}`);
    const uniqueSentences = new Set(sentences.map((s) => s.toLowerCase()));
    if (uniqueSentences.size !== sentences.length) continue;

    const correctText = sentences[targetIdx];
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const order = shuffle(TENSE_POLARITY_COMBOS.map((_, i) => i));
    const correctPos = order.indexOf(targetIdx);
    const options = order.map((i) => sentences[i]);

    return {
      correctText,
      questionLabel: buildRuSentence(subject, verb, target.tense, target.polarity, marker),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "negation": don't / doesn't / didn't ---
// Даём подлежащее + глагол + время (present/past — future сюда не
// затрагиваем, это отдельная путаница). Варианты — все 3 вспомогательных
// глагола (правильный + 2 неверных), плюс типичные ошибки: забытый
// вспомогательный глагол ("not play" вместо "doesn't play") и правильный
// вспомогательный, но неверная форма смыслового глагола ("doesn't played").
function buildNegationQuestion(forbiddenText) {
  const AUX = { present3rd: "doesn't", presentOther: "don't", past: "didn't" };
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const tense = Math.random() < 0.5 ? "present" : "past";
    if (verb.base.toLowerCase() === verb.past.toLowerCase()) continue; // избегаем "read"-подобных совпадений форм
    const context = contextFor(subject, verb);
    const markers = RU_TIME_MARKERS[tense];
    const marker = markers[Math.floor(Math.random() * markers.length)];

    const correctAux = tense === "present" ? (subject.is3rd ? AUX.present3rd : AUX.presentOther) : AUX.past;
    const otherAuxes = [AUX.present3rd, AUX.presentOther, AUX.past].filter((a) => a !== correctAux);

    const correctText = `${subject.pron} ${correctAux} ${verb.base} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const candidates = [
      correctText,
      `${subject.pron} ${otherAuxes[0]} ${verb.base} ${context}`,
      `${subject.pron} ${otherAuxes[1]} ${verb.base} ${context}`,
      `${subject.pron} not ${verb.base} ${context}`, // забыли вспомогательный глагол
      `${subject.pron} ${correctAux} ${verb.past} ${context}`, // верный aux, неверная форма глагола
      `${subject.pron} ${otherAuxes[0]} ${verb.past} ${context}`,
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== candidates.length) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause = ruConjugate(verb, subject, tense);
    const ruSentence = `${subject.ru} не ${ruClause} ${verb.contextRu} ${marker}`;

    return {
      correctText,
      questionLabel: ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "tobe": to be vs обычный глагол ---
// Половина вопросов — описание состояния/качества (нужен to be: is/am/
// are/was/were), половина — действие (нужен обычный глагол). Среди
// неверных вариантов — как раз путаница между двумя типами конструкций.
const STATE_ADJECTIVES = [
  { adjSg: "tired", adjPl: "tired", nomM: "уставший", nomF: "уставшая", nomPl: "уставшие", instrM: "уставшим", instrF: "уставшей", instrPl: "уставшими" },
  { adjSg: "happy", adjPl: "happy", nomM: "счастливый", nomF: "счастливая", nomPl: "счастливые", instrM: "счастливым", instrF: "счастливой", instrPl: "счастливыми" },
  { adjSg: "hungry", adjPl: "hungry", nomM: "голодный", nomF: "голодная", nomPl: "голодные", instrM: "голодным", instrF: "голодной", instrPl: "голодными" },
  { adjSg: "late", adjPl: "late", nomM: "опаздывающий", nomF: "опаздывающая", nomPl: "опаздывающие", instrM: "опаздывающим", instrF: "опаздывающей", instrPl: "опаздывающими" },
  { adjSg: "busy", adjPl: "busy", nomM: "занятый", nomF: "занятая", nomPl: "занятые", instrM: "занятым", instrF: "занятой", instrPl: "занятыми" },
  { adjSg: "ready", adjPl: "ready", nomM: "готовый", nomF: "готовая", nomPl: "готовые", instrM: "готовым", instrF: "готовой", instrPl: "готовыми" },
  { adjSg: "sad", adjPl: "sad", nomM: "грустный", nomF: "грустная", nomPl: "грустные", instrM: "грустным", instrF: "грустной", instrPl: "грустными" },
  { adjSg: "angry", adjPl: "angry", nomM: "злой", nomF: "злая", nomPl: "злые", instrM: "злым", instrF: "злой", instrPl: "злыми" },
  { adjSg: "at home", adjPl: "at home", nomM: "дома", nomF: "дома", nomPl: "дома", instrM: "дома", instrF: "дома", instrPl: "дома" },
  { adjSg: "at work", adjPl: "at work", nomM: "на работе", nomF: "на работе", nomPl: "на работе", instrM: "на работе", instrF: "на работе", instrPl: "на работе" },
  { adjSg: "a doctor", adjPl: "doctors", nomM: "врач", nomF: "врач", nomPl: "врачи", instrM: "врачом", instrF: "врачом", instrPl: "врачами" },
  { adjSg: "a teacher", adjPl: "teachers", nomM: "учитель", nomF: "учительница", nomPl: "учителя", instrM: "учителем", instrF: "учительницей", instrPl: "учителями" },
  ...TRAP_WORDS.map((w) => ({
    adjSg: w.base, adjPl: w.base,
    nomM: w.adjNomM, nomF: w.adjNomF, nomPl: w.adjNomPl,
    instrM: w.adjInstrM, instrF: w.adjInstrF, instrPl: w.adjInstrPl,
  })),
];

function stateAdjEn(state, subject) {
  return subject.isPlural ? state.adjPl : state.adjSg;
}

// По-русски "был/была/были + прилагательное/существительное" по норме
// требует творительного падежа ("была учительницей", не "была
// учительница") — именительный годится только для настоящего времени
// (там связки "быть" вообще нет: "она учительница").
function stateAdjRu(state, subject, tense) {
  const forms = tense === "past" ? { m: state.instrM, f: state.instrF, pl: state.instrPl } : { m: state.nomM, f: state.nomF, pl: state.nomPl };
  if (subject.isPlural) return forms.pl;
  return subject.gender === "f" ? forms.f : forms.m;
}

function beForm(subject, tense) {
  if (tense === "present") {
    if (subject.pron === "I") return "am";
    return subject.is3rd ? "is" : "are";
  }
  return subject.is3rd || subject.pron === "I" ? "was" : "were";
}

function buildBeVsVerbQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const tense = Math.random() < 0.5 ? "present" : "past";
    const wantState = Math.random() < 0.5;
    const markers = RU_TIME_MARKERS[tense];
    const marker = markers[Math.floor(Math.random() * markers.length)];

    let correctText;
    let ruSentence;
    let candidates;

    if (wantState) {
      const state = STATE_ADJECTIVES[Math.floor(Math.random() * STATE_ADJECTIVES.length)];
      const be = beForm(subject, tense);
      correctText = `${subject.pron} ${be} ${stateAdjEn(state, subject)}`;
      const beRu = tense === "present" ? (subject.isPlural ? "" : "") : subject.isPlural ? "были" : subject.gender === "f" ? "была" : "был";
      ruSentence = tense === "present" ? `${subject.ru} ${stateAdjRu(state, subject, tense)} ${marker}` : `${subject.ru} ${beRu} ${stateAdjRu(state, subject, tense)} ${marker}`;

      const verb1 = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
      const verb2 = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
      const otherBe = tense === "present" ? beForm(subject, "past") : beForm(subject, "present");
      candidates = [
        correctText,
        `${subject.pron} ${otherBe} ${stateAdjEn(state, subject)}`, // верная конструкция, неверное время
        `${subject.pron} ${conjugate(subject, verb1, tense, "affirmative")} ${stateAdjEn(state, subject)}`, // обычный глагол вместо to be — частая ошибка
        `${subject.pron} ${be} ${conjugate(subject, verb2, tense, "affirmative")}`, // to be + обычный глагол вместе — тоже частая ошибка
        `${subject.pron} ${conjugate(subject, verb1, tense, "negative")} ${stateAdjEn(state, subject)}`,
        `${subject.pron} not ${be} ${stateAdjEn(state, subject)}`, // неверный порядок отрицания
      ];
    } else {
      const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
      const context = contextFor(subject, verb);
      correctText = `${subject.pron} ${conjugate(subject, verb, tense, "affirmative")} ${context}`;
      const ruClause = ruConjugate(verb, subject, tense);
      ruSentence = `${subject.ru} ${ruClause} ${verb.contextRu} ${marker}`;

      const be = beForm(subject, tense);
      const otherBe = tense === "present" ? beForm(subject, "past") : beForm(subject, "present");
      const state = STATE_ADJECTIVES[Math.floor(Math.random() * STATE_ADJECTIVES.length)];
      candidates = [
        correctText,
        `${subject.pron} ${be} ${conjugate(subject, verb, tense, "affirmative")} ${context}`, // лишний to be перед глаголом — частая ошибка
        `${subject.pron} ${be} ${ingForm(verb)} ${context}`, // подмена Present Simple на -ing-форму с to be
        `${subject.pron} ${conjugate(subject, verb, tense === "present" ? "past" : "present", "affirmative")} ${context}`, // не то время
        `${subject.pron} ${be} ${stateAdjEn(state, subject)}`, // to be с прилагательным вместо действия
        `${subject.pron} ${otherBe} ${ingForm(verb)} ${context}`,
      ];
    }

    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== candidates.length) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);
    const questionLabel = ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1);

    return { correctText, questionLabel, options, correctPos };
  }
  return null;
}

function trapWordAdjRu(word, subject, tense) {
  const nom = subject.isPlural ? word.adjNomPl : subject.gender === "f" ? word.adjNomF : word.adjNomM;
  const instr = subject.isPlural ? word.adjInstrPl : subject.gender === "f" ? word.adjInstrF : word.adjInstrM;
  return tense === "past" ? instr : nom;
}

function buildTrapWordsQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const word = TRAP_WORDS[Math.floor(Math.random() * TRAP_WORDS.length)];
    const tense = Math.random() < 0.5 ? "present" : "past";
    const wantVerb = Math.random() < 0.5;
    const context = contextFor(subject, word);
    const be = beForm(subject, tense);
    const otherBe = tense === "present" ? beForm(subject, "past") : beForm(subject, "present");
    const markers = RU_TIME_MARKERS[tense];
    const marker = markers[Math.floor(Math.random() * markers.length)];
    const verbForm = conjugate(subject, word, tense, "affirmative");
    const adjEn = word.base;

    let correctText;
    let ruSentence;
    if (wantVerb) {
      correctText = `${subject.pron} ${verbForm} ${context}`;
      ruSentence = buildRuSentence(subject, word, tense, "affirmative", marker);
    } else {
      correctText = `${subject.pron} ${be} ${adjEn}`;
      const adjRu = trapWordAdjRu(word, subject, tense);
      const beRu = tense === "past" ? (subject.isPlural ? "были " : subject.gender === "f" ? "была " : "был ") : "";
      const sentence = `${subject.ru} ${beRu}${adjRu} ${marker}`.replace(/\s+/g, " ").trim();
      ruSentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
    }
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const candidates = [
      correctText,
      wantVerb ? `${subject.pron} ${be} ${adjEn}` : `${subject.pron} ${verbForm} ${context}`,
      `${subject.pron} ${otherBe} ${adjEn}`,
      `${subject.pron} ${conjugate(subject, word, tense === "present" ? "past" : "present", "affirmative")} ${context}`,
      `${subject.pron} ${be} ${verbForm} ${context}`,
      `${subject.pron} ${ingForm(word)} ${context}`,
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    return { correctText, questionLabel: ruSentence, options, correctPos };
  }
  return null;
}

// --- Формат "v2vs": V2 (прошедшее) vs Vs (3-е лицо наст. времени) ---
// Только He/She/It — именно тут визуально путаются "-s" и форма
// прошедшего времени. Явный маркер времени (every day / yesterday) прямо
// указывает, какая форма нужна.
// Расширено по просьбе Margy (02.10.2026): было всего по 2 маркера на
// время — отсюда "слишком однотипно". Список приведён в соответствие с
// RU_TIME_MARKERS.present/past (те же самые надёжные, однозначные маркеры).
const TIME_MARKERS_PRESENT = [
  { en: "every day", ru: "каждый день" },
  { en: "usually", ru: "обычно" },
  { en: "often", ru: "часто" },
  { en: "sometimes", ru: "иногда" },
  { en: "every week", ru: "каждую неделю" },
  { en: "in the morning", ru: "по утрам" },
];
const TIME_MARKERS_PAST = [
  { en: "yesterday", ru: "вчера" },
  { en: "last week", ru: "на прошлой неделе" },
  { en: "the day before yesterday", ru: "позавчера" },
  { en: "two days ago", ru: "два дня назад" },
  { en: "last month", ru: "в прошлом месяце" },
  { en: "last year", ru: "в прошлом году" },
];

function buildV2VsQuestion(forbiddenText) {
  const thirdPersonSubjects = RU_SENTENCE_SUBJECTS.filter((s) => s.is3rd);
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = thirdPersonSubjects[Math.floor(Math.random() * thirdPersonSubjects.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    if (verb.base.toLowerCase() === verb.past.toLowerCase()) continue;
    const context = contextFor(subject, verb);
    const wantPresent = Math.random() < 0.5;
    const marker = wantPresent
      ? TIME_MARKERS_PRESENT[Math.floor(Math.random() * TIME_MARKERS_PRESENT.length)]
      : TIME_MARKERS_PAST[Math.floor(Math.random() * TIME_MARKERS_PAST.length)];

    const vs = thirdPersonForm(verb);
    const v2 = verb.past;
    const correctForm = wantPresent ? vs : v2;
    const correctText = `${subject.pron} ${correctForm} ${context} ${marker.en}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const candidates = [
      correctText,
      `${subject.pron} ${wantPresent ? v2 : vs} ${context} ${marker.en}`, // главная путаница: V2 вместо Vs или наоборот
      `${subject.pron} ${verb.base} ${context} ${marker.en}`, // забыли -s (или использовали базовую форму вместо прошедшего)
      `${subject.pron} ${ingForm(verb)} ${context} ${marker.en}`,
      `${subject.pron} doesn't ${verb.base} ${context} ${marker.en}`,
      `${subject.pron} didn't ${verb.base} ${context} ${marker.en}`,
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== candidates.length) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause = ruConjugate(verb, subject, wantPresent ? "present" : "past");
    const ruSentence = `${subject.ru} ${ruClause} ${verb.contextRu} ${marker.ru}`;

    return {
      correctText,
      questionLabel: ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "vsV1": Vs vs V1, только внутри Present Simple ---
// В отличие от v2vs (там путаница между настоящим и прошедшим), здесь
// сравнение — внутри ОДНОГО времени: нужна ли -s или нет. Специально
// упрощено до минимальной пары подлежащих — He/She (нужна -s) против We
// (нужна голая базовая форма, без -s) — чтобы сфокусироваться именно на
// этом различии, не отвлекаясь на остальные лица.
const VS_V1_SUBJECTS = RU_SENTENCE_SUBJECTS.filter((s) => s.pron === "He" || s.pron === "She" || s.pron === "We");

function buildVsV1Question(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = VS_V1_SUBJECTS[Math.floor(Math.random() * VS_V1_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const context = contextFor(subject, verb);
    const marker = RU_TIME_MARKERS.present[Math.floor(Math.random() * RU_TIME_MARKERS.present.length)];

    const vs = thirdPersonForm(verb);
    const v1 = verb.base;
    const correctForm = subject.is3rd ? vs : v1;
    const correctText = `${subject.pron} ${correctForm} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const wrongForm = subject.is3rd ? v1 : vs; // главная путаница: Vs вместо V1 или наоборот
    const candidates = [
      correctText,
      `${subject.pron} ${wrongForm} ${context}`,
      `${subject.pron} ${verb.past} ${context}`, // прошедшее вместо настоящего
      `${subject.pron} ${ingForm(verb)} ${context}`, // -ing вместо простого настоящего
      `${subject.pron} doesn't ${verb.base} ${context}`,
      `${subject.pron} don't ${verb.base} ${context}`,
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause = ruConjugate(verb, subject, "present");
    const ruSentence = `${subject.ru} ${ruClause} ${verb.contextRu} ${marker}`;

    return {
      correctText,
      questionLabel: ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "psVsPrPs": Past Simple vs Present Perfect (для начинающих) ---
// Самое частое затруднение у русскоговорящих — в русском нет
// грамматической разницы между "я сделал" и "я уже сделал (сделал к
// настоящему моменту)", а в английском это два разных времени. Упрощаем
// правило до уровня новичка: есть конкретное время в прошлом (вчера, два
// дня назад) — Past Simple; есть "уже"/"только что" без конкретного
// времени — Present Perfect (have/has + V3).
const PS_PRPS_MARKERS_PAST = ["вчера", "на прошлой неделе", "два дня назад", "в прошлом году"];
const PS_PRPS_MARKERS_PERFECT = ["уже", "только что"];

function buildPsVsPrPsQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    if (verb.base.toLowerCase() === verb.past.toLowerCase() || verb.past.toLowerCase() === verb.participle.toLowerCase()) continue;
    const context = contextFor(subject, verb);
    const wantPerfect = Math.random() < 0.5;
    const haveForm = subject.is3rd && !subject.isPlural ? "has" : "have";
    const wrongHaveForm = haveForm === "has" ? "have" : "has";

    const correctForm = wantPerfect ? `${haveForm} ${verb.participle}` : verb.past;
    const marker = wantPerfect
      ? PS_PRPS_MARKERS_PERFECT[Math.floor(Math.random() * PS_PRPS_MARKERS_PERFECT.length)]
      : PS_PRPS_MARKERS_PAST[Math.floor(Math.random() * PS_PRPS_MARKERS_PAST.length)];

    const correctText = `${subject.pron} ${correctForm} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const wrongTenseForm = wantPerfect ? verb.past : `${haveForm} ${verb.participle}`; // главная путаница
    const candidates = [
      correctText,
      `${subject.pron} ${wrongTenseForm} ${context}`,
      `${subject.pron} ${haveForm} ${verb.past} ${context}`, // have/has + V2 вместо V3
      `${subject.pron} ${verb.participle} ${context}`, // забыли have/has
      `${subject.pron} ${verb.base} ${context}`, // забыли прошедшее вообще
      `${subject.pron} ${wrongHaveForm} ${verb.participle} ${context}`, // неверное согласование have/has
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause2 = ruConjugate(verb, subject, "past");
    const ruSentence2 = `${subject.ru} ${ruClause2} ${verb.contextRu} ${marker}`;

    return {
      correctText,
      questionLabel: ruSentence2.charAt(0).toUpperCase() + ruSentence2.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "gerundInfinitive": глаголы, после которых идёт V-ing или to-V1 ---
// Переделано по прямому требованию Margy: раньше это было упражнение
// "собери правильное предложение из 6 вариантов" на ~24 придуманных
// глаголах — она это забраковала. Теперь: (1) слова — ПОЛНЫЕ списки из
// первоисточников (см. ниже), а не отобранная вручную подборка; (2) формат —
// прямая 3-вариантная классификация глагола: показываем сам глагол (например
// "enjoy"), ученик выбирает один из ТРЁХ фиксированных вариантов: "V1"
// (to-инфинитив), "Ving" (герундий) или "оба" (обе формы допустимы).
//
// Источники (по явному указанию Margy — "должны быть все слова из ссылок"):
//  - https://enginform.com/article/infinitive-verbs — таблица "Verbs Not
//    Requiring an Object" (47 глаголов, только простой to-инфинитив без
//    промежуточного дополнения — глаголы из второй таблицы, "Requiring an
//    Object" типа "want SOMEONE to do", сюда не включены: это другая
//    конструкция, не относящаяся к вопросу V1 vs Ving).
//  - https://enginform.com/article/verbs-followed-by-gerund — таблица
//    глаголов (и глагольно-предложных сочетаний) с герундием (96 позиций).
// Глагол, буквально встретившийся в ОБОИХ списках без изменения формы
// (begin/continue/forget/mean/neglect/prefer/propose/regret/remember/
// start/stop/try), вынесен в категорию "both" — источники сами подтверждают,
// что после него работают обе формы (иногда с изменением смысла — например
// remember to do = не забыть сделать, remember doing = помнить, что делал;
// объяснение самого нюанса даётся не в этом упражнении, а в теории по
// ссылке, здесь тренируется только сам факт "какая форма возможна").
//
// Исключение: "finish" в таблице enginform значится с to-инфинитивом
// (пример "We finished to paint the fence"), но это не соответствует
// нормативному английскому — finish употребляется только с герундием
// (finish painting). Похоже на опечатку/ошибку источника, поэтому finish
// сознательно отнесён к "только Ving", а не к "both" — если Margy сочтёт
// иначе, это единственное расхождение с буквальным текстом источника.
//
// "care" (V1-список, обычно в отрицании/вопросе: "I don't care to argue")
// и "care about" (Ving-список, другой предлог и смысл: "заботиться о") —
// разные конструкции с разным предлогом, поэтому НЕ объединены в "both",
// а идут отдельными пунктами. Аналогично "plan" (V1) и "plan on" (Ving).
const GERUND_INFINITIVE_VERBS = [
  // ===== Только to-инфинитив (V1) — 34 =====
  { phrase: "agree", ru: "соглашаться", pattern: "infinitive" },
  { phrase: "aim", ru: "стремиться, ставить целью", pattern: "infinitive" },
  { phrase: "appear", ru: "казаться, по-видимому", pattern: "infinitive" },
  { phrase: "arrange", ru: "договариваться, организовывать", pattern: "infinitive" },
  { phrase: "ask", ru: "просить (разрешения)", pattern: "infinitive" },
  { phrase: "attempt", ru: "пытаться", pattern: "infinitive" },
  { phrase: "be able", ru: "быть способным, мочь", pattern: "infinitive" },
  { phrase: "care", ru: "хотеть (обычно в отриц./вопросе: не прочь)", pattern: "infinitive" },
  { phrase: "choose", ru: "решать, предпочитать", pattern: "infinitive" },
  { phrase: "condescend", ru: "снисходить (до того, чтобы)", pattern: "infinitive" },
  { phrase: "consent", ru: "соглашаться, давать согласие", pattern: "infinitive" },
  { phrase: "dare", ru: "осмеливаться", pattern: "infinitive" },
  { phrase: "decide", ru: "решать", pattern: "infinitive" },
  { phrase: "deserve", ru: "заслуживать", pattern: "infinitive" },
  { phrase: "expect", ru: "ожидать, рассчитывать", pattern: "infinitive" },
  { phrase: "fail", ru: "не суметь, не сделать", pattern: "infinitive" },
  { phrase: "happen", ru: "случайно оказаться, случаться", pattern: "infinitive" },
  { phrase: "hesitate", ru: "колебаться, не решаться", pattern: "infinitive" },
  { phrase: "hope", ru: "надеяться", pattern: "infinitive" },
  { phrase: "hurry", ru: "торопиться", pattern: "infinitive" },
  { phrase: "intend", ru: "намереваться", pattern: "infinitive" },
  { phrase: "offer", ru: "предлагать", pattern: "infinitive" },
  { phrase: "ought", ru: "следует, должен", pattern: "infinitive" },
  { phrase: "plan", ru: "планировать", pattern: "infinitive" },
  { phrase: "prepare", ru: "готовиться", pattern: "infinitive" },
  { phrase: "proceed", ru: "приступать, продолжать (далее)", pattern: "infinitive" },
  { phrase: "promise", ru: "обещать", pattern: "infinitive" },
  { phrase: "refuse", ru: "отказываться", pattern: "infinitive" },
  { phrase: "strive", ru: "стремиться, стараться", pattern: "infinitive" },
  { phrase: "swear", ru: "клясться", pattern: "infinitive" },
  { phrase: "threaten", ru: "угрожать", pattern: "infinitive" },
  { phrase: "wait", ru: "ждать", pattern: "infinitive" },
  { phrase: "want", ru: "хотеть", pattern: "infinitive" },
  { phrase: "wish", ru: "желать", pattern: "infinitive" },
  // ===== Только герундий (Ving) — 84 =====
  { phrase: "acknowledge", ru: "признавать", pattern: "gerund" },
  { phrase: "admit to", ru: "признаваться в", pattern: "gerund" },
  { phrase: "advise", ru: "советовать", pattern: "gerund" },
  { phrase: "approve of", ru: "одобрять", pattern: "gerund" },
  { phrase: "allow", ru: "разрешать", pattern: "gerund" },
  { phrase: "anticipate", ru: "предвкушать, предвидеть", pattern: "gerund" },
  { phrase: "appreciate", ru: "ценить, быть благодарным за", pattern: "gerund" },
  { phrase: "argue into", ru: "уговаривать (сделать)", pattern: "gerund" },
  { phrase: "avoid", ru: "избегать", pattern: "gerund" },
  { phrase: "be worth", ru: "стоить (того, чтобы)", pattern: "gerund" },
  { phrase: "believe in", ru: "верить в", pattern: "gerund" },
  { phrase: "can't help", ru: "не мочь удержаться от", pattern: "gerund" },
  { phrase: "can't stand", ru: "терпеть не мочь", pattern: "gerund" },
  { phrase: "care about", ru: "заботиться о, переживать за", pattern: "gerund" },
  { phrase: "cease", ru: "прекращать", pattern: "gerund" },
  { phrase: "celebrate", ru: "праздновать, отмечать", pattern: "gerund" },
  { phrase: "complete", ru: "заканчивать, завершать", pattern: "gerund" },
  { phrase: "confess to", ru: "признаваться в", pattern: "gerund" },
  { phrase: "consider", ru: "рассматривать, обдумывать", pattern: "gerund" },
  { phrase: "concentrate on", ru: "сосредотачиваться на", pattern: "gerund" },
  { phrase: "complain about", ru: "жаловаться на", pattern: "gerund" },
  { phrase: "delay", ru: "откладывать, задерживать", pattern: "gerund" },
  { phrase: "deny", ru: "отрицать", pattern: "gerund" },
  { phrase: "depend on", ru: "зависеть от", pattern: "gerund" },
  { phrase: "despise", ru: "презирать", pattern: "gerund" },
  { phrase: "detest", ru: "ненавидеть, презирать", pattern: "gerund" },
  { phrase: "disapprove", ru: "не одобрять", pattern: "gerund" },
  { phrase: "discuss", ru: "обсуждать", pattern: "gerund" },
  { phrase: "discourage from", ru: "отговаривать от", pattern: "gerund" },
  { phrase: "dislike", ru: "не любить", pattern: "gerund" },
  { phrase: "dispute", ru: "оспаривать", pattern: "gerund" },
  { phrase: "don't mind", ru: "не быть против", pattern: "gerund" },
  { phrase: "dread", ru: "бояться, страшиться", pattern: "gerund" },
  { phrase: "dream about", ru: "мечтать о", pattern: "gerund" },
  { phrase: "endure", ru: "терпеть, выносить", pattern: "gerund" },
  { phrase: "encourage", ru: "поощрять, побуждать", pattern: "gerund" },
  { phrase: "enjoy", ru: "любить, наслаждаться (чем-то)", pattern: "gerund" },
  { phrase: "escape", ru: "избегать, ускользать от", pattern: "gerund" },
  { phrase: "evade", ru: "уклоняться от", pattern: "gerund" },
  { phrase: "excuse for", ru: "извинять за", pattern: "gerund" },
  { phrase: "explain", ru: "объяснять", pattern: "gerund" },
  { phrase: "fancy", ru: "хотеть, представлять себе", pattern: "gerund" },
  { phrase: "feel like", ru: "хотеться (разг.)", pattern: "gerund" },
  { phrase: "finish", ru: "заканчивать", pattern: "gerund" },
  { phrase: "forbid", ru: "запрещать", pattern: "gerund" },
  { phrase: "forget about", ru: "забывать о (=не помнить, что делал)", pattern: "gerund" },
  { phrase: "forgive for", ru: "прощать за", pattern: "gerund" },
  { phrase: "give up", ru: "бросать, отказываться от", pattern: "gerund" },
  { phrase: "hate", ru: "ненавидеть", pattern: "gerund" },
  { phrase: "imagine", ru: "представлять себе", pattern: "gerund" },
  { phrase: "insist on", ru: "настаивать на", pattern: "gerund" },
  { phrase: "involve", ru: "включать в себя, предполагать", pattern: "gerund" },
  { phrase: "justify", ru: "оправдывать", pattern: "gerund" },
  { phrase: "keep", ru: "продолжать (постоянно делать)", pattern: "gerund" },
  { phrase: "like", ru: "нравиться", pattern: "gerund" },
  { phrase: "love", ru: "любить (получать удовольствие от процесса)", pattern: "gerund" },
  { phrase: "mention", ru: "упоминать", pattern: "gerund" },
  { phrase: "mind", ru: "возражать против", pattern: "gerund" },
  { phrase: "miss", ru: "скучать по, упускать", pattern: "gerund" },
  { phrase: "need", ru: "нуждаться (в том, чтобы было сделано)", pattern: "gerund" },
  { phrase: "object to", ru: "возражать против", pattern: "gerund" },
  { phrase: "permit", ru: "позволять, разрешать", pattern: "gerund" },
  { phrase: "picture", ru: "представлять себе", pattern: "gerund" },
  { phrase: "plan on", ru: "планировать, рассчитывать на", pattern: "gerund" },
  { phrase: "postpone", ru: "откладывать", pattern: "gerund" },
  { phrase: "practise", ru: "практиковать(ся), тренировать(ся)", pattern: "gerund" },
  { phrase: "prevent from", ru: "препятствовать, не давать", pattern: "gerund" },
  { phrase: "prohibit from", ru: "запрещать", pattern: "gerund" },
  { phrase: "quit", ru: "бросать, прекращать", pattern: "gerund" },
  { phrase: "recall", ru: "вспоминать", pattern: "gerund" },
  { phrase: "recollect", ru: "вспоминать", pattern: "gerund" },
  { phrase: "recommend", ru: "рекомендовать", pattern: "gerund" },
  { phrase: "refrain from", ru: "воздерживаться от", pattern: "gerund" },
  { phrase: "resent", ru: "возмущаться, обижаться на", pattern: "gerund" },
  { phrase: "resist", ru: "сопротивляться, удерживаться от", pattern: "gerund" },
  { phrase: "resume", ru: "возобновлять", pattern: "gerund" },
  { phrase: "risk", ru: "рисковать", pattern: "gerund" },
  { phrase: "succeed in", ru: "преуспевать в", pattern: "gerund" },
  { phrase: "suggest", ru: "предлагать", pattern: "gerund" },
  { phrase: "support", ru: "поддерживать", pattern: "gerund" },
  { phrase: "talk about", ru: "говорить о", pattern: "gerund" },
  { phrase: "think about", ru: "думать о", pattern: "gerund" },
  { phrase: "tolerate", ru: "терпеть, мириться с", pattern: "gerund" },
  { phrase: "urge", ru: "настоятельно советовать, побуждать", pattern: "gerund" },
  { phrase: "worry about", ru: "беспокоиться о", pattern: "gerund" },
  // ===== Обе формы допустимы (V1 и Ving) — 12 =====
  { phrase: "begin", ru: "начинать", pattern: "both" },
  { phrase: "continue", ru: "продолжать", pattern: "both" },
  { phrase: "forget", ru: "забывать (to do = не забыть сделать / doing = забыть, что делал)", pattern: "both" },
  { phrase: "mean", ru: "означать / намереваться (to do = намереваться / doing = означать, влечь за собой)", pattern: "both" },
  { phrase: "neglect", ru: "пренебрегать, не делать", pattern: "both" },
  { phrase: "prefer", ru: "предпочитать", pattern: "both" },
  { phrase: "propose", ru: "предлагать", pattern: "both" },
  { phrase: "regret", ru: "сожалеть (to do = вынужден сообщить / doing = сожалеть о сделанном)", pattern: "both" },
  { phrase: "remember", ru: "помнить (to do = не забыть сделать / doing = помнить, что делал)", pattern: "both" },
  { phrase: "start", ru: "начинать", pattern: "both" },
  { phrase: "stop", ru: "останавливаться (to do = остановиться, чтобы / doing = прекратить делать)", pattern: "both" },
  { phrase: "try", ru: "пытаться / пробовать (to do = прилагать усилие / doing = попробовать в качестве эксперимента)", pattern: "both" },
];

const GERUND_INFINITIVE_ANSWER_OPTIONS = ["V1", "Ving", "оба"];

function buildGerundInfinitiveQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const item = GERUND_INFINITIVE_VERBS[Math.floor(Math.random() * GERUND_INFINITIVE_VERBS.length)];
    const correctPos = item.pattern === "infinitive" ? 0 : item.pattern === "gerund" ? 1 : 2;
    const answerLabel = GERUND_INFINITIVE_ANSWER_OPTIONS[correctPos];
    const correctText = `${item.phrase} → ${answerLabel}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    return {
      correctText,
      questionLabel: `${item.phrase} — ${item.ru}`,
      options: GERUND_INFINITIVE_ANSWER_OPTIONS,
      correctPos,
    };
  }
  return null;
}

// --- Формат "someAnyNo": some / any / no и их производные ---
// Новая тема по просьбе Margy (02.10.2026). Теория и примеры — из двух
// страниц её личной базы знаний в Notion: базовое правило (some —
// утверждение, any — отрицание/вопрос, no — отрицание с одним "не") и
// более тонкие случаи уровня B1 (some в вежливых просьбах/предложениях,
// any = "любой" в утверждении, прилагательное ПОСЛЕ
// something/anyone/nothing, no + сущ. эмоциональнее not any). Формат —
// заполнение пропуска: показываем английское предложение с "___",
// ученик выбирает одно из ТРЁХ слов одного семейства (например
// some/any/no, или something/anything/nothing). Каждое задание размечено
// явно (а не выведено по формуле "утверждение→some"), потому что именно
// в этих "неправильных по формуле" случаях и есть вся соль уровня B1
// (вежливая просьба — это вопрос, но ответ "some", а не "any").
const SOME_ANY_NO_ITEMS = [
  // --- some / any / no (перед существительным) ---
  { template: "I have ___ money.", options: ["some", "any", "no"], correctIdx: 0 },
  { template: "I don't have ___ money.", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "Do you have ___ money?", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "Would you like ___ tea?", options: ["some", "any", "no"], correctIdx: 0 },
  { template: "Could I have ___ water, please?", options: ["some", "any", "no"], correctIdx: 0 },
  { template: "Is there ___ milk in the fridge?", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "There isn't ___ food in the fridge.", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "There is ___ food in the fridge!", options: ["some", "any", "no"], correctIdx: 2 },
  { template: "You can take ___ book you like.", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "Do you have ___ brothers or sisters?", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "Can you give me ___ help with my bag?", options: ["some", "any", "no"], correctIdx: 0 },
  { template: "We don't have ___ bread.", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "She has ___ friends here.", options: ["some", "any", "no"], correctIdx: 2 },
  { template: "Did you see ___ nice clothes in the shop?", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "Can I borrow ___ money?", options: ["some", "any", "no"], correctIdx: 0 },
  { template: "Have you got ___ pets?", options: ["some", "any", "no"], correctIdx: 1 },
  { template: "Would you like ___ more cake?", options: ["some", "any", "no"], correctIdx: 0 },
  // --- something / anything / nothing ---
  { template: "There is ___ in the basket.", options: ["something", "anything", "nothing"], correctIdx: 0 },
  { template: "Is there ___ in the basket?", options: ["something", "anything", "nothing"], correctIdx: 1 },
  { template: "I don't see ___ on the table.", options: ["something", "anything", "nothing"], correctIdx: 1 },
  { template: "I know ___ about it.", options: ["something", "anything", "nothing"], correctIdx: 2 },
  { template: "I want ___ cold to drink.", options: ["something", "anything", "nothing"], correctIdx: 0 },
  { template: "Is there ___ interesting on TV?", options: ["something", "anything", "nothing"], correctIdx: 1 },
  { template: "___ new today.", options: ["Something", "Anything", "Nothing"], correctIdx: 2 },
  { template: "I have ___ to tell you.", options: ["something", "anything", "nothing"], correctIdx: 0 },
  { template: "Is there ___ to eat?", options: ["something", "anything", "nothing"], correctIdx: 1 },
  { template: "I have ___ to do today.", options: ["something", "anything", "nothing"], correctIdx: 2 },
  { template: "I'll eat ___ — I'm hungry!", options: ["something", "anything", "nothing"], correctIdx: 1 },
  { template: "Anna has ___ important to say to you.", options: ["something", "anything", "nothing"], correctIdx: 0 },
  { template: "We have ___ to wear for the party!", options: ["something", "anything", "nothing"], correctIdx: 2 },
  { template: "Let's go somewhere — I want to watch ___ fun.", options: ["something", "anything", "nothing"], correctIdx: 0 },
  // --- someone/somebody / anyone/anybody / no one/nobody ---
  { template: "I see ___ near the gate.", options: ["somebody", "anybody", "nobody"], correctIdx: 0 },
  { template: "I don't see ___ there.", options: ["somebody", "anybody", "nobody"], correctIdx: 1 },
  { template: "___ is calling you.", options: ["Somebody", "Anybody", "Nobody"], correctIdx: 0 },
  { template: "Has ___ come?", options: ["someone", "anyone", "no one"], correctIdx: 1 },
  { template: "___ has come.", options: ["Someone", "Anyone", "No one"], correctIdx: 2 },
  { template: "___ can learn English.", options: ["Someone", "Anyone", "No one"], correctIdx: 1 },
  { template: "___ funny called.", options: ["Someone", "Anyone", "No one"], correctIdx: 0 },
  { template: "There is ___ important here.", options: ["someone", "anyone", "no one"], correctIdx: 2 },
  { template: "Bella has ___ to talk to.", options: ["someone", "anyone", "no one"], correctIdx: 2 },
  { template: "If ___ calls, tell them I'm out.", options: ["someone", "anyone", "no one"], correctIdx: 0 },
  { template: "___ likes when their ideas are ignored.", options: ["Someone", "Anyone", "No one"], correctIdx: 2 },
  { template: "Did ___ come to your birthday party?", options: ["somebody", "anybody", "nobody"], correctIdx: 1 },
  { template: "I need ___ to help me with this bag.", options: ["someone", "anyone", "no one"], correctIdx: 0 },
  // --- somewhere / anywhere / nowhere ---
  { template: "Are you going ___?", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 1 },
  { template: "He works ___.", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 2 },
  { template: "Does he work ___?", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 1 },
  { template: "You can sit ___ you want.", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 1 },
  { template: "Let's go ___ quiet.", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 0 },
  { template: "We need ___ to sit.", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 0 },
  { template: "There's ___ to park!", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 2 },
  { template: "I need ___ quiet to work.", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 0 },
  { template: "Max can't find his keys ___.", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 1 },
  { template: "She will go ___ for a good cup of coffee.", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 1 },
  { template: "I live ___ near the city centre.", options: ["somewhere", "anywhere", "nowhere"], correctIdx: 0 },
];

function buildSomeAnyNoQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const item = SOME_ANY_NO_ITEMS[Math.floor(Math.random() * SOME_ANY_NO_ITEMS.length)];
    const correctText = item.template.replace("___", item.options[item.correctIdx]);
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const order = shuffle(item.options.map((_, i) => i));
    const correctPos = order.indexOf(item.correctIdx);
    const options = order.map((i) => item.options[i]);

    return {
      correctText,
      questionLabel: item.template,
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "collocations": give / get / take / have ---
// Это не про времена, а про то, какой из четырёх глаголов идёт с
// конкретным выражением (give advice, get married, take a photo, have
// breakfast). Специально отобраны только те сочетания, где среди этих
// четырёх глаголов верен ровно один — без "have a shower vs take a
// shower"-подобной двусмысленности между британским и американским
// вариантами.
const COLLOCATIONS = [
  { verb: "give", obj: "advice", ru: "давать совет" },
  { verb: "give", obj: "a presentation", ru: "делать презентацию" },
  { verb: "give", obj: "a hand", ru: "помочь" },
  { verb: "give", obj: "a call", ru: "позвонить" },
  { verb: "give", obj: "a hug", ru: "обнять" },
  { verb: "give", obj: "an example", ru: "привести пример" },
  { verb: "give", obj: "a speech", ru: "произнести речь" },
  { verb: "give", obj: "permission", ru: "дать разрешение" },
  { verb: "get", obj: "a job", ru: "получить работу" },
  { verb: "get", obj: "married", ru: "жениться / выйти замуж" },
  { verb: "get", obj: "home", ru: "добраться домой" },
  { verb: "get", obj: "ready", ru: "приготовиться" },
  { verb: "get", obj: "an idea", ru: "прийти в голову (об идее)" },
  { verb: "get", obj: "angry", ru: "разозлиться" },
  { verb: "get", obj: "lost", ru: "заблудиться" },
  { verb: "get", obj: "divorced", ru: "развестись" },
  { verb: "take", obj: "a photo", ru: "сделать фото" },
  { verb: "take", obj: "a taxi", ru: "взять такси" },
  { verb: "take", obj: "a break", ru: "сделать перерыв" },
  { verb: "take", obj: "a seat", ru: "сесть, занять место" },
  { verb: "take", obj: "medicine", ru: "принять лекарство" },
  { verb: "take", obj: "a risk", ru: "рискнуть" },
  { verb: "take", obj: "notes", ru: "делать записи" },
  { verb: "take", obj: "an exam", ru: "сдавать экзамен" },
  { verb: "have", obj: "breakfast", ru: "позавтракать" },
  { verb: "have", obj: "a party", ru: "устроить вечеринку" },
  { verb: "have", obj: "a baby", ru: "родить ребёнка" },
  { verb: "have", obj: "a dream", ru: "видеть сон" },
  { verb: "have", obj: "fun", ru: "веселиться" },
  { verb: "have", obj: "a chat", ru: "поболтать" },
  { verb: "have", obj: "an argument", ru: "поспорить" },
  { verb: "have", obj: "a headache", ru: "болеть (о голове)" },
];
const COLLOCATION_VERBS = ["give", "get", "take", "have"];

// --- Форматы "modalMeaning" и "modalTo": модальные глаголы ---
// must / have to / should / ought to / need to / can (+ прошедшее время
// там, где оно у модального глагола вообще есть — must/should/ought to
// своей "простой" формы прошедшего времени в этом же значении не имеют,
// поэтому прошедшее даём только для have to → had to, need to → needed
// to, can → could).
const MODAL_VERBS = [
  { key: "must", base: "must", thirdSg: "must", past: null, needsTo: false },
  { key: "haveTo", base: "have to", thirdSg: "has to", past: "had to", needsTo: true },
  { key: "should", base: "should", thirdSg: "should", past: null, needsTo: false },
  { key: "oughtTo", base: "ought to", thirdSg: "ought to", past: null, needsTo: true },
  { key: "needTo", base: "need to", thirdSg: "needs to", past: "needed to", needsTo: true },
  { key: "can", base: "can", thirdSg: "can", past: "could", needsTo: false },
];

// Примечание (02.10.2026): раньше тут были словари RU_DATIVE/RU_NOM,
// жёстко привязанные к 6 исходным местоимениям (I/You/He/She/We/They) —
// при добавлении новых подлежащих (My friend, Kate and I и т.д.) лукап по
// ним возвращал undefined. Теперь используем готовые subject.ru
// (именительный) и subject.ruDative (дательный) — они есть у каждого
// подлежащего в RU_SENTENCE_SUBJECTS.

// Русские формы "должен" (must — своя убеждённость говорящего) и
// "вынужден" (have to — вынуждают обстоятельства/правила) — НАРОЧНО разные
// глаголы, а не один и тот же "должен" на оба модальных: так путаница
// снимается самим выбором слова, без искусственных пояснений в скобках.
function mustFormRu(subject) {
  if (subject.isPlural) return "должны";
  return subject.gender === "f" ? "должна" : "должен";
}

function haveToFormRu(subject, tense) {
  const form = subject.isPlural ? "вынуждены" : subject.gender === "f" ? "вынуждена" : "вынужден";
  if (tense !== "past") return form;
  const beRu = subject.isPlural ? "были" : subject.gender === "f" ? "была" : "был";
  return `${form} ${beRu}`;
}

// "мочь" спрягается по лицам, а не просто ед./мн. число — "мы можем", но
// "они могут" (раньше тут была ошибка: обеим формам ставилось "могут").
function canFormRu(subject, tense) {
  if (tense === "past") {
    if (subject.isPlural) return "могли";
    return subject.gender === "f" ? "могла" : "мог";
  }
  if (subject.isPlural) return subject.actsAsWe ? "можем" : "могут";
  return "может";
}

function needToRuPrefix(subject, tense) {
  return tense === "past" ? `${subject.ruDative} нужно было` : `${subject.ruDative} нужно`;
}

function ruModalSentence(subject, modal, verb, tense) {
  let prefix;
  if (modal.key === "must") {
    prefix = `${subject.ru} ${mustFormRu(subject)}`;
  } else if (modal.key === "haveTo") {
    prefix = `${subject.ru} ${haveToFormRu(subject, tense)}`;
  } else if (modal.key === "can") {
    prefix = `${subject.ru} ${canFormRu(subject, tense)}`;
  } else if (modal.key === "should") {
    prefix = `${subject.ruDative} следует`;
  } else if (modal.key === "oughtTo") {
    prefix = `${subject.ruDative} полагается`;
  } else {
    prefix = needToRuPrefix(subject, tense);
  }
  const sentence = `${prefix} ${verb.ruInf} ${verb.contextRu}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// Формат "по смыслу": даётся ситуация по-русски (с явной подсказкой,
// какой оттенок смысла нужен — иначе "должен" из русского одинаково
// подходит и под must, и под have to), и все 6 модальных глаголов с тем
// же подлежащим и глаголом — как варианты ответа.
function buildModalMeaningQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const targetModal = MODAL_VERBS[Math.floor(Math.random() * MODAL_VERBS.length)];
    const usePast = !!targetModal.past && Math.random() < 0.5;
    const context = contextFor(subject, verb);

    const phraseFor = (modal) => {
      let form;
      if (usePast && modal.past) form = modal.past;
      else form = subject.is3rd && !subject.isPlural ? modal.thirdSg : modal.base;
      return `${subject.pron} ${form} ${verb.base} ${context}`;
    };

    const correctText = phraseFor(targetModal);
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const candidates = MODAL_VERBS.map(phraseFor);
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== candidates.length) continue;

    const targetIdx = MODAL_VERBS.indexOf(targetModal);
    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(targetIdx);
    const options = order.map((i) => candidates[i]);

    return {
      correctText,
      questionLabel: ruModalSentence(subject, targetModal, verb, usePast ? "past" : "present"),
      options,
      correctPos,
    };
  }
  return null;
}

// Формат "нужна ли to": фиксируем модальный глагол и глагол действия,
// главный дистрактор — та же форма модального глагола, но с "to", где
// его быть не должно (must to go), или без "to", где оно обязательно
// (has go вместо has to go). Плюс формы других модальных глаголов для
// разнообразия.
function buildModalToQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const modal = MODAL_VERBS[Math.floor(Math.random() * MODAL_VERBS.length)];
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const context = contextFor(subject, verb);
    const usePast = !!modal.past && Math.random() < 0.5;

    const modalForm = usePast ? modal.past : subject.is3rd ? modal.thirdSg : modal.base;
    const correctText = `${subject.pron} ${modalForm} ${verb.base} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const toggledForm = modal.needsTo ? modalForm.replace(/\s*to$/, "").trim() : `${modalForm} to`;
    const toggledText = `${subject.pron} ${toggledForm} ${verb.base} ${context}`;

    const otherModals = shuffle(MODAL_VERBS.filter((m) => m.key !== modal.key)).slice(0, 4);
    const otherTexts = otherModals.map((m) => {
      const f = subject.is3rd ? m.thirdSg : m.base;
      return `${subject.pron} ${f} ${verb.base} ${context}`;
    });

    const candidates = [correctText, toggledText, ...otherTexts];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    return {
      correctText,
      questionLabel: ruModalSentence(subject, modal, verb, usePast ? "past" : "present"),
      options,
      correctPos,
    };
  }
  return null;
}

// --- Формат "futureInPast": Future in the Past vs Future Simple ---
// Ключевое отличие — от какого момента "будущее": если рамка (думает/
// говорит/уверен...) в настоящем времени, это обычное будущее (will);
// если рамка сама в прошедшем (думал/сказал/была уверена...), то это
// будущее-в-прошедшем (would) — классический разбор косвенной речи.
// Русское предложение внутри "что..." по-русски звучит одинаково в обоих
// случаях (будущее время глагола не меняется от контекста рамки) — именно
// поэтому по-русски это не путается, а в английском нужно верно выбрать
// will или would, ориентируясь на время самой рамки.
const FUTURE_IN_PAST_FRAMES = [
  { ru: "Он думает, что", useWould: false },
  { ru: "Он думал, что", useWould: true },
  { ru: "Она говорит, что", useWould: false },
  { ru: "Она сказала, что", useWould: true },
  { ru: "Они уверены, что", useWould: false },
  { ru: "Они были уверены, что", useWould: true },
  { ru: "Мы знаем, что", useWould: false },
  { ru: "Мы знали, что", useWould: true },
];

function buildFutureInPastQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const frame = FUTURE_IN_PAST_FRAMES[Math.floor(Math.random() * FUTURE_IN_PAST_FRAMES.length)];
    const subject = RU_SENTENCE_SUBJECTS[Math.floor(Math.random() * RU_SENTENCE_SUBJECTS.length)];
    const verb = GRAMMAR_VERBS[Math.floor(Math.random() * GRAMMAR_VERBS.length)];
    const context = contextFor(subject, verb);

    const correctModal = frame.useWould ? "would" : "will";
    const correctText = `${subject.pron} ${correctModal} ${verb.base} ${context}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const wrongModal = frame.useWould ? "will" : "would";
    const candidates = [
      correctText,
      `${subject.pron} ${wrongModal} ${verb.base} ${context}`, // главная путаница: will vs would
      `${subject.pron} ${correctModal} ${verb.past} ${context}`, // верный модальный, но неверная форма глагола
      `${subject.pron} ${verb.base} ${context}`, // модальный вообще пропущен
      `${subject.pron} ${verb.past} ${context}`, // тоже пропущен, но со "случайным" прошедшим
      `${subject.pron} ${wrongModal} ${verb.past} ${context}`, // и то, и другое неверно
    ];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const ruClause = ruConjugate(verb, subject, "future");
    const ruSentence = `${frame.ru} ${subject.ru} ${ruClause} ${verb.contextRu}`;

    return {
      correctText,
      questionLabel: ruSentence.charAt(0).toUpperCase() + ruSentence.slice(1),
      options,
      correctPos,
    };
  }
  return null;
}

function buildCollocationQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const item = COLLOCATIONS[Math.floor(Math.random() * COLLOCATIONS.length)];
    const correctText = `${item.verb} ${item.obj}`;
    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const options = shuffle(COLLOCATION_VERBS.map((v) => `${v} ${item.obj}`));
    const correctPos = options.indexOf(correctText);

    return {
      correctText,
      questionLabel: `«${item.ru}» — какой глагол?`,
      options,
      correctPos,
    };
  }
  return null;
}

function buildGrammarQuestion(forbiddenText, exerciseType) {
  const requestedType = exerciseType || "tenses";
  for (let attempt = 0; attempt < 5; attempt++) {
    const type = requestedType === "mix" ? GRAMMAR_REAL_EXERCISE_TYPES[Math.floor(Math.random() * GRAMMAR_REAL_EXERCISE_TYPES.length)] : requestedType;
    let q;
    if (type === "negation") q = buildNegationQuestion(forbiddenText);
    else if (type === "tobe") q = buildBeVsVerbQuestion(forbiddenText);
    else if (type === "v2vs") q = buildV2VsQuestion(forbiddenText);
    else if (type === "vsV1") q = buildVsV1Question(forbiddenText);
    else if (type === "trapWords") q = buildTrapWordsQuestion(forbiddenText);
    else if (type === "psVsPrPs") q = buildPsVsPrPsQuestion(forbiddenText);
    else if (type === "gerundInfinitive") q = buildGerundInfinitiveQuestion(forbiddenText);
    else if (type === "collocations") q = buildCollocationQuestion(forbiddenText);
    else if (type === "someAnyNo") q = buildSomeAnyNoQuestion(forbiddenText);
    else if (type === "modalMeaning") q = buildModalMeaningQuestion(forbiddenText);
    else if (type === "modalTo") q = buildModalToQuestion(forbiddenText);
    else if (type === "futureInPast") q = buildFutureInPastQuestion(forbiddenText);
    else q = buildTensesQuestion(forbiddenText);
    if (q) return q;
  }
  return null;
}

function buildGrammarPicked(prefix, forbiddenText, exerciseType) {
  const q = buildGrammarQuestion(forbiddenText, exerciseType);
  const keyboard = q.options.map((textOpt, i) => [{ text: textOpt, callback_data: `a:${i}` }]);
  const questionText = `🎯 ${mdEscape(q.questionLabel)}\nВыбери верную форму:`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;
  return {
    correct: { en: q.correctText, ru: q.questionLabel },
    correctPos: q.correctPos,
    keyboard,
    text,
    mode: "grammar",
    exerciseType: exerciseType || "tenses",
  };
}
// =================== Конец режима "Грамматика" ===================

// ================ Режим "Неправильные глаголы" ================
// Показывает базовую форму глагола, просит выбрать верную пару
// Past Simple — Past Participle из 6 вариантов (сама верная пара + пары от
// 5 других случайных неправильных глаголов — это как раз и тренирует
// запоминание, какая форма к какому глаголу относится).

const IRREGULAR_VERBS = [
  // A1-A2 — самые базовые, встречаются с первых уроков
  { base: "go", past: "went", participle: "gone", ru: "идти / ходить", level: "a" },
  { base: "have", past: "had", participle: "had", ru: "иметь", level: "a" },
  { base: "do", past: "did", participle: "done", ru: "делать", level: "a" },
  { base: "see", past: "saw", participle: "seen", ru: "видеть", level: "a" },
  { base: "come", past: "came", participle: "come", ru: "приходить", level: "a" },
  { base: "take", past: "took", participle: "taken", ru: "брать", level: "a" },
  { base: "make", past: "made", participle: "made", ru: "делать (создавать)", level: "a" },
  { base: "know", past: "knew", participle: "known", ru: "знать", level: "a" },
  { base: "get", past: "got", participle: "gotten", ru: "получать", level: "a" },
  { base: "give", past: "gave", participle: "given", ru: "давать", level: "a" },
  { base: "eat", past: "ate", participle: "eaten", ru: "есть (кушать)", level: "a" },
  { base: "drink", past: "drank", participle: "drunk", ru: "пить", level: "a" },
  { base: "write", past: "wrote", participle: "written", ru: "писать", level: "a" },
  { base: "read", past: "read", participle: "read", ru: "читать", level: "a" },
  { base: "buy", past: "bought", participle: "bought", ru: "покупать", level: "a" },
  { base: "run", past: "ran", participle: "run", ru: "бегать", level: "a" },
  { base: "sit", past: "sat", participle: "sat", ru: "сидеть", level: "a" },
  // B1-B2 — средний уровень
  { base: "stand", past: "stood", participle: "stood", ru: "стоять", level: "b" },
  { base: "find", past: "found", participle: "found", ru: "находить", level: "b" },
  { base: "think", past: "thought", participle: "thought", ru: "думать", level: "b" },
  { base: "tell", past: "told", participle: "told", ru: "говорить (рассказывать)", level: "b" },
  { base: "feel", past: "felt", participle: "felt", ru: "чувствовать", level: "b" },
  { base: "leave", past: "left", participle: "left", ru: "уходить / оставлять", level: "b" },
  { base: "speak", past: "spoke", participle: "spoken", ru: "говорить", level: "b" },
  { base: "meet", past: "met", participle: "met", ru: "встречать", level: "b" },
  { base: "win", past: "won", participle: "won", ru: "выигрывать", level: "b" },
  { base: "pay", past: "paid", participle: "paid", ru: "платить", level: "b" },
  { base: "wear", past: "wore", participle: "worn", ru: "носить (одежду)", level: "b" },
  { base: "hold", past: "held", participle: "held", ru: "держать", level: "b" },
  { base: "sing", past: "sang", participle: "sung", ru: "петь", level: "b" },
  { base: "become", past: "became", participle: "become", ru: "становиться", level: "b" },
  { base: "understand", past: "understood", participle: "understood", ru: "понимать", level: "b" },
  { base: "lose", past: "lost", participle: "lost", ru: "терять", level: "b" },
  { base: "begin", past: "began", participle: "begun", ru: "начинать", level: "b" },
  // B2+ — более редкие/продвинутые
  { base: "forget", past: "forgot", participle: "forgotten", ru: "забывать", level: "c" },
  { base: "bring", past: "brought", participle: "brought", ru: "приносить", level: "c" },
  { base: "choose", past: "chose", participle: "chosen", ru: "выбирать", level: "c" },
  { base: "sell", past: "sold", participle: "sold", ru: "продавать", level: "c" },
  { base: "send", past: "sent", participle: "sent", ru: "отправлять", level: "c" },
  { base: "build", past: "built", participle: "built", ru: "строить", level: "c" },
  { base: "grow", past: "grew", participle: "grown", ru: "расти", level: "c" },
  { base: "draw", past: "drew", participle: "drawn", ru: "рисовать", level: "c" },
  { base: "drive", past: "drove", participle: "driven", ru: "водить (машину)", level: "c" },
  { base: "ride", past: "rode", participle: "ridden", ru: "ездить верхом", level: "c" },
  { base: "fly", past: "flew", participle: "flown", ru: "летать", level: "c" },
  { base: "teach", past: "taught", participle: "taught", ru: "учить (преподавать)", level: "c" },
  { base: "fight", past: "fought", participle: "fought", ru: "драться / бороться", level: "c" },
  { base: "catch", past: "caught", participle: "caught", ru: "ловить", level: "c" },
  { base: "throw", past: "threw", participle: "thrown", ru: "бросать", level: "c" },
  { base: "break", past: "broke", participle: "broken", ru: "ломать", level: "c" },
];

const IRREGULAR_LEVEL_LABELS = { a: "A1–A2", b: "B1–B2", c: "B2+" };

const IRREGULAR_EXERCISE_TYPES = {
  triplet: "🔺 Все 3 формы",
  pastonly: "① Только Past Simple",
  particonly: "② Только Past Participle",
  ru2en: "🇷🇺→🇬🇧 Перевод → глагол",
  form2base: "🔍 Угадай глагол по форме",
  mix: "🎲 Микс всех форматов",
};

// "Настоящие" форматы, из которых Микс выбирает случайный на каждый вопрос
// (сам "mix" не формат вопроса, а режим выбора формата).
const IRREGULAR_REAL_EXERCISE_TYPES = ["triplet", "pastonly", "particonly", "ru2en", "form2base"];

// Возвращает count случайных индексов из pool, отличных от excludeIdx и
// друг от друга (и от alsoExclude, если передан).
function pickOtherIndices(pool, excludeIdx, count, alsoExclude) {
  const excluded = new Set([excludeIdx, ...((alsoExclude && alsoExclude) || [])]);
  const result = [];
  let guard = 0;
  while (result.length < count && guard < 500) {
    guard++;
    const j = Math.floor(Math.random() * pool.length);
    if (excluded.has(j) || result.includes(j)) continue;
    result.push(j);
  }
  return result;
}

// Пять РАЗНЫХ по формату упражнений на неправильные глаголы:
//  - triplet: даём перевод, просим узнать/вспомнить все 3 формы целиком
//    (самый полный и самый сложный формат)
//  - pastonly / particonly: только ОДНА конкретная форма — но среди
//    вариантов специально есть "ловушка": форма-двойник ЭТОГО ЖЕ глагола
//    (например, при вопросе про Past Simple один из неверных вариантов —
//    Past Participle этого самого глагола), чтобы нельзя было угадать
//    просто по знакомому виду слова
//  - ru2en: только перевод, без английской подсказки вообще — просит
//    вспомнить сам базовый глагол по-английски
//  - form2base: показывает готовую форму (Past Simple ИЛИ Participle,
//    без подписи какая) и просит определить, от какого глагола она —
//    тренирует узнавание "в тексте", а не заучивание таблицы
function buildIrregularQuestion(forbiddenText, level, exerciseType) {
  const pool = level ? IRREGULAR_VERBS.filter((v) => v.level === level) : IRREGULAR_VERBS;
  const requestedType = exerciseType || "triplet";

  for (let attempt = 0; attempt < 25; attempt++) {
    // При "mix" на КАЖДУЮ попытку берём случайный настоящий формат — так
    // разнообразие сохраняется, даже если конкретная попытка не удалась и
    // потребовался повтор цикла.
    const type =
      requestedType === "mix" ? IRREGULAR_REAL_EXERCISE_TYPES[Math.floor(Math.random() * IRREGULAR_REAL_EXERCISE_TYPES.length)] : requestedType;
    const idx = Math.floor(Math.random() * pool.length);
    const verb = pool[idx];
    const samePastAndParticiple = verb.past.toLowerCase() === verb.participle.toLowerCase();

    let correctText;
    let questionLabel;
    let distractorTexts;

    if (type === "pastonly") {
      correctText = verb.past;
      questionLabel = `${verb.base.toUpperCase()} (${verb.ru}) — Past Simple?`;
      const others = pickOtherIndices(pool, idx, samePastAndParticiple ? 5 : 4);
      distractorTexts = others.map((j) => pool[j].past);
      if (!samePastAndParticiple) distractorTexts.push(verb.participle); // ловушка: спутать с Participle
    } else if (type === "particonly") {
      correctText = verb.participle;
      questionLabel = `${verb.base.toUpperCase()} (${verb.ru}) — Past Participle?`;
      const others = pickOtherIndices(pool, idx, samePastAndParticiple ? 5 : 4);
      distractorTexts = others.map((j) => pool[j].participle);
      if (!samePastAndParticiple) distractorTexts.push(verb.past); // ловушка: спутать с Past Simple
    } else if (type === "ru2en") {
      correctText = verb.base;
      questionLabel = `Как будет по-английски: «${verb.ru}»?`;
      const others = pickOtherIndices(pool, idx, 5);
      distractorTexts = others.map((j) => pool[j].base);
    } else if (type === "form2base") {
      const useParticiple = !samePastAndParticiple && Math.random() < 0.5;
      const shownForm = useParticiple ? verb.participle : verb.past;
      correctText = verb.base;
      questionLabel = `Какой это глагол — «${shownForm}»?`;
      const others = pickOtherIndices(pool, idx, 5);
      distractorTexts = others.map((j) => pool[j].base);
    } else {
      // triplet
      correctText = `${verb.base} - ${verb.past} - ${verb.participle}`;
      questionLabel = `Вспомни все 3 формы: «${verb.ru}»`;
      const others = pickOtherIndices(pool, idx, 5);
      distractorTexts = others.map((j) => `${pool[j].base} - ${pool[j].past} - ${pool[j].participle}`);
    }

    if (forbiddenText && correctText.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const allOptions = [correctText, ...distractorTexts];
    const uniqueOptions = new Set(allOptions.map((o) => o.toLowerCase()));
    if (uniqueOptions.size !== allOptions.length) continue; // редкое совпадение форм — пробуем другой набор

    const order = shuffle(allOptions.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => allOptions[i]);

    return { correctText, questionLabel, options, correctPos };
  }
  return null; // практически недостижимо при таком размере списка
}

function buildIrregularPicked(prefix, forbiddenText, level, exerciseType) {
  const q = buildIrregularQuestion(forbiddenText, level, exerciseType);
  const keyboard = q.options.map((textOpt, i) => [{ text: textOpt, callback_data: `a:${i}` }]);
  const levelLabel = level ? ` [${IRREGULAR_LEVEL_LABELS[level] || level}]` : "";
  const questionText = `🎯${levelLabel} ${mdEscape(q.questionLabel)}`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;
  return {
    correct: { en: q.correctText, ru: q.questionLabel },
    correctPos: q.correctPos,
    keyboard,
    text,
    mode: "irregular",
    level,
    exerciseType: exerciseType || "triplet",
  };
}
// ============== Конец режима "Неправильные глаголы" ==============

// Подбирает несколько неверных вариантов, у которых и перевод, и слово
// отличаются от правильного и друг от друга (чтобы не было двух одинаковых кнопок).
// Грубое определение "это глагол или нет" — точного разбора частей речи у
// нас нет (слова добавляются свободным текстом), так что ориентируемся на
// приметы: тире в форме глагола ("Write - wrote - written", "Make - made"),
// явный английский инфинитив ("to run"), или характерное для русского
// инфинитива окончание перевода (-ть/-ти/-чь — играть, идти, мочь).
function looksLikeVerb(word) {
  const en = (word.en || "").trim();
  if (/^\S.*\s-\s\S/.test(en)) return true; // "Write - wrote - written", "Make - made"
  if (/^to\s+\S/i.test(en)) return true; // "to run"
  const ruFirstWord = (word.ru || "")
    .trim()
    .toLowerCase()
    .split(/[\s,/(]/)[0];
  return /(ть|ти|чь)$/.test(ruFirstWord);
}

// Подбирает неверные варианты — по возможности той же "части речи" (если
// правильный ответ похож на глагол, стараемся давать в качестве
// дистракторов тоже глаголы, а не вперемешку с существительными и
// прилагательными — иначе можно угадать правильный ответ просто по виду
// слова, не зная перевода). Если в словаре не хватает слов той же
// категории — достаём недостающие дистракторы из остальных слов, чтобы
// вариантов всегда было ровно нужное количество.
function pickDistractors(vocab, correctWord, count) {
  const usedRu = new Set([correctWord.ru.toLowerCase().trim()]);
  const usedEn = new Set([correctWord.en.toLowerCase().trim()]);
  const chosen = [];

  const wantVerb = looksLikeVerb(correctWord);
  const pool = vocab.filter((w) => {
    const ru = w.ru.toLowerCase().trim();
    const en = w.en.toLowerCase().trim();
    return !usedEn.has(en) && !usedRu.has(ru);
  });
  const samePos = pool.filter((w) => looksLikeVerb(w) === wantVerb);
  const otherPos = pool.filter((w) => looksLikeVerb(w) !== wantVerb);

  function pickFrom(list) {
    let attempts = 0;
    while (chosen.length < count && list.length && attempts < 300) {
      attempts++;
      const w = list[Math.floor(Math.random() * list.length)];
      const ru = w.ru.toLowerCase().trim();
      const en = w.en.toLowerCase().trim();
      if (usedEn.has(en) || usedRu.has(ru)) continue;
      usedRu.add(ru);
      usedEn.add(en);
      chosen.push(w);
    }
  }

  pickFrom(samePos);
  if (chosen.length < count) pickFrom(otherPos); // не хватает своей категории — добираем остальными

  return chosen;
}

// Слова, в которых человек недавно ошибался, чаще попадаются повторно —
// но не среди последних 50 показанных слов (excludeSet), чтобы одно и то же
// слово не всплывало слишком часто, а разнообразие ощущалось на большом окне.
// Используется только на "случайном" этапе (когда новых непройденных слов
// больше нет) — см. pickQuestionWord ниже.
function pickRandomQuestionWord(vocab, wrongMap, excludeSet) {
  const pool = excludeSet && excludeSet.size ? vocab.filter((v) => !excludeSet.has(v.en)) : vocab;
  const candidates = pool.length ? pool : vocab;

  const wrongWords = Object.keys(wrongMap || {}).filter((w) => !excludeSet || !excludeSet.has(w));
  if (wrongWords.length && Math.random() < 0.35) {
    const enKey = wrongWords[Math.floor(Math.random() * wrongWords.length)];
    const w = candidates.find((v) => v.en === enKey);
    if (w) return w;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Выбор слова для вопроса, в два этапа:
//  1) Пока есть слова, которые этот пользователь ЕЩЁ НИ РАЗУ не видел —
//     показываем их первыми, начиная с добавленных САМЫМИ ПОСЛЕДНИМИ, и по
//     возможности не из последних 50 показанных (excludeSet).
//  2) Когда пользователь прошёл весь словарь хотя бы по разу — начинается
//     "перемешанный" круг: случайный выбор, но каждое слово в пределах
//     круга не повторяется, пока не пройдут все остальные. По завершении
//     круга (seenEn сбрасывается) начинается заново.
// seenEnSet передаётся явно (не из общего хранилища счёта) — см. комментарий
// у buildQuestion ниже про то, откуда он теперь берётся.
function pickQuestionWord(vocab, wrongMap, seenEnSet, excludeSet) {
  const unseen = vocab.filter((v) => !seenEnSet.has(v.en));
  const unseenAndNotRecent = excludeSet && excludeSet.size ? unseen.filter((v) => !excludeSet.has(v.en)) : unseen;

  if (unseenAndNotRecent.length) {
    return { word: unseenAndNotRecent[unseenAndNotRecent.length - 1], resetCycle: false };
  }

  if (unseen.length) {
    return { word: unseen[unseen.length - 1], resetCycle: false };
  }

  return { word: pickRandomQuestionWord(vocab, wrongMap, excludeSet), resetCycle: true };
}

const RECENT_HISTORY_SIZE = 50;
const OPTIONS_COUNT = 6; // 1 правильный + 5 неверных вариантов

// Чистая функция: выбирает следующее слово и собирает текст/клавиатуру
// вопроса, ничего не читая и не записывая в хранилище.
//
// ВАЖНО (архитектурное решение после долгой отладки): историю "какие слова
// уже показаны" (seenEnList/recentTailList) мы теперь передаём СНАРУЖИ, а не
// читаем из общего хранилища счёта (stats). Общее хранилище счёта — это
// один и тот же ключ, в который постоянно пишут при каждом ответе, и на
// практике запись туда иногда не успевала долететь до следующего чтения
// (несмотря на "строгую" консистентность) — из-за этого слово могло
// "забыть", что его уже показывали, и вылезти повторно раньше, чем через
// 50 вопросов. У записи текущего вопроса (pendingStore) такой проблемы не
// наблюдалось за всё время отладки — она проще (одна перезапись, не
// read-modify-write под конкуренцией), поэтому историю теперь тоже носим
// вместе с pending, из рук в руки: каждый новый вопрос сохраняет свою
// версию истории, а следующий её просто забирает оттуда, без отдельного
// похода в другое хранилище.
function buildQuestion(vocab, wrongMap, prefix, forbiddenEn, seenEnList, recentTailList) {
  const seenEnSet = new Set(Array.isArray(seenEnList) ? seenEnList : []);
  const tail = Array.isArray(recentTailList) ? recentTailList : [];
  // Ограничиваем окно исключения так, чтобы оно не могло охватить ВЕСЬ
  // словарь (иначе, при маленьком словаре, единственным вариантом снова
  // стало бы то же самое только что показанное слово).
  const maxExclude = Math.max(0, vocab.length - 1);
  const excludeSet = new Set(tail.slice(-maxExclude));
  if (forbiddenEn) excludeSet.add(forbiddenEn);

  let { word: correct, resetCycle } = pickQuestionWord(vocab, wrongMap, seenEnSet, excludeSet);

  // Железная гарантия, не зависящая от хранилища: forbiddenEn — это слово,
  // которое только что отвечали, мы его знаем напрямую из текущего запроса.
  // Если по любой причине выбор всё равно совпал — принудительно берём
  // любое другое слово, лишь бы не повторить его сразу.
  if (forbiddenEn && correct.en === forbiddenEn && vocab.length > 1) {
    const alternatives = vocab.filter((w) => w.en !== forbiddenEn);
    correct = alternatives[Math.floor(Math.random() * alternatives.length)];
  }

  const distractors = pickDistractors(vocab, correct, Math.min(OPTIONS_COUNT - 1, vocab.length - 1));
  const options = shuffle([correct, ...distractors]);
  const correctPos = options.indexOf(correct);
  const keyboard = options.map((o, i) => [{ text: o.ru, callback_data: `a:${i}` }]);
  const questionText = `🎯 Как переводится: *${mdEscape(correct.en)}*?`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;

  const newSeenEn = resetCycle ? [correct.en] : seenEnSet.has(correct.en) ? seenEnList || [] : [...(seenEnList || []), correct.en];
  const newTail = [...tail, correct.en].slice(-RECENT_HISTORY_SIZE);

  return { correct, correctPos, keyboard, text, resetCycle, newSeenEn, newTail };
}

// Отправляет уже выбранный вопрос и запоминает pending — используется и из
// sendQuestion (одиночный вызов), и из handleCallback (после совмещённого
// обновления счёта+истории). История (newSeenEn/newTail) уходит в саму
// запись pending — см. комментарий у buildQuestion.
async function deliverQuestion(chatId, picked) {
  const result = await tg("sendMessage", {
    chat_id: chatId,
    text: picked.text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: picked.keyboard },
  });

  // Запоминаем, к какому конкретно сообщению относится вопрос — если позже
  // придёт нажатие на кнопку СТАРОГО сообщения (пользователь проскроллил
  // историю и ткнул в прошлый вопрос), мы это заметим и не засчитаем его
  // как ответ на текущий вопрос.
  const messageId = result && result.result ? result.result.message_id : undefined;
  await log(`[deliverQuestion] new question="${picked.correct.en}" messageId=${messageId} sendMessage.ok=${result && result.ok}`);

  await verifiedSet(pendingStore(), String(chatId), {
    correctEn: picked.correct.en,
    correctRu: picked.correct.ru,
    correctPos: picked.correctPos,
    consumed: false,
    messageId,
    seenEn: picked.newSeenEn || [],
    recentTail: picked.newTail || [],
    mode: picked.mode || "vocab",
    level: picked.level || null,
    exerciseType: picked.exerciseType || null,
    topic: picked.topic !== undefined ? picked.topic : null,
    shared: picked.shared !== undefined ? picked.shared : null,
  });
}

// Одиночная отправка вопроса (без одновременного обновления счёта) — для
// /start и /play. Историю берём из предыдущего pending, если он есть
// (надёжно, без похода в общее хранилище счёта).
// Слово без темы попадает в условную "общую" корзину. null/undefined в
// качестве topic означает "все темы вместе", без фильтрации.
const GENERAL_TOPIC = "__general__";

function getDistinctTopics(vocab) {
  return [...new Set(vocab.map((w) => w.topic || GENERAL_TOPIC))];
}

function filterByTopic(vocab, topic) {
  if (!topic) return vocab;
  if (topic === GENERAL_TOPIC) return vocab.filter((w) => !w.topic);
  return vocab.filter((w) => w.topic === topic);
}

function topicLabel(topic) {
  if (!topic || topic === GENERAL_TOPIC) return "Общие слова";
  return topic;
}

async function sendQuestion(chatId, stats, prefix, modeOverride, levelOverride, exerciseTypeOverride, topicOverride, sharedOverride) {
  const prevPending = await pendingStore().get(String(chatId), { type: "json" });
  const currentMode = prevPending && prevPending.mode ? prevPending.mode : "vocab";
  const mode = modeOverride || currentMode;

  if (mode !== "dialogue" && mode !== "idiomtranslate") {
    const trialIdentity = await identityStore().get(String(chatId), { type: "json" });
    if (trialIdentity && trialIdentity.phrasesAccess && !trialIdentity.approved && !(await isAdmin(chatId)) && isTrialExpired(trialIdentity)) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Пробный период на 5 дней закончился. «150 американских фраз» остаются доступны бесплатно — а чтобы открыть всё остальное, напиши своему преподавателю.",
      });
      return;
    }
  }

  if (mode === "grammar") {
    const exerciseType = exerciseTypeOverride || (prevPending && prevPending.mode === "grammar" && prevPending.exerciseType) || "tenses";
    const picked = buildGrammarPicked(prefix, null, exerciseType);
    await deliverQuestion(chatId, picked);
    return;
  }

  if (mode === "irregular") {
    const level = levelOverride || (prevPending && prevPending.level) || "a";
    const exerciseType = exerciseTypeOverride || (prevPending && prevPending.exerciseType) || "triplet";
    const picked = buildIrregularPicked(prefix, null, level, exerciseType);
    await deliverQuestion(chatId, picked);
    return;
  }

  if (mode === "dialogue") {
    const picked = buildDialoguePicked(prefix, null);
    if (picked) await deliverQuestion(chatId, picked);
    return;
  }

  if (mode === "idiomtranslate") {
    const picked = buildIdiomTranslatePicked(prefix, null);
    if (picked) await deliverQuestion(chatId, picked);
    return;
  }

  const shared = sharedOverride !== undefined ? sharedOverride : (prevPending && prevPending.shared) || null;

  let fullVocab;
  let vocab;
  let topic;
  if (shared) {
    fullVocab = await getSharedVocab(shared.difficulty, shared.topic);
    vocab = fullVocab;
    topic = null;
  } else {
    fullVocab = await getVocab(chatId);
    topic = topicOverride !== undefined ? topicOverride : prevPending && prevPending.topic ? prevPending.topic : null;
    vocab = filterByTopic(fullVocab, topic);
  }

  if (!vocab.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: shared
        ? "В этой теме общей библиотеки пока нет слов."
        : fullVocab.length
        ? `В теме «${topicLabel(topic)}» пока нет слов.`
        : "Словарь сейчас пуст. Вставь сюда слова в формате «English . перевод», и я начну спрашивать.",
    });
    return;
  }

  const seenEnList = prevPending && Array.isArray(prevPending.seenEn) ? prevPending.seenEn : [];
  const recentTailList = prevPending && Array.isArray(prevPending.recentTail) ? prevPending.recentTail : [];

  const picked = buildQuestion(vocab, stats.wrong, prefix, null, seenEnList, recentTailList);
  picked.topic = topic;
  picked.shared = shared;
  await deliverQuestion(chatId, picked);
}

function statsLine(practicedCount, totalCount) {
  return `📚 ${practicedCount}/${totalCount} слов отработано`;
}

// Постоянное меню снизу экрана (не привязано к конкретному сообщению, как
// inline-кнопки, а всегда под рукой). Кнопки просто отправляют свой текст
// как обычное сообщение — дальше это обрабатывается как любая команда.
const BTN_VOCAB = "📚 Лексика";
const BTN_IRREGULAR = "🔄 Неправильные глаголы";
const BTN_GRAMMAR = "📝 Грамматика";
const BTN_HIDE = "🔽 Скрыть меню";

async function mainReplyKeyboard(chatId) {
  const admin = await isAdmin(chatId);
  const rows = [
    [BTN_VOCAB, BTN_IRREGULAR, BTN_GRAMMAR],
    ["/start", BTN_HIDE],
  ];
  if (admin) rows.push(["/students"]);
  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function handleStart(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "Привет! Это тренажёр 🎓\n\n" +
      "Показываю слово, фразу или упражнение — выбираешь верный вариант из вариантов. " +
      "То, в чём ошибаешься, будет попадаться чаще.\n\n" +
      "Чтобы добавить новые слова — просто вставь сюда строки вида «English . перевод» " +
      "(можно сразу много строк за раз), я сама их разберу.\n\n" +
      "Команды: /mode, /play, /score, /count, /delete <слово>, /reset, /help",
    reply_markup: await mainReplyKeyboard(chatId),
  });
  await handleMode(chatId);
}

// Показывает выбор режима тренировки — кнопками, а не текстом, чтобы не
// нужно было ничего печатать.
const DIALOGUE_PHRASES = [
  { setupEn: "How was the meeting?", setupRu: "Как прошла встреча?", en: "It was so boring, I was bored to death.", ru: "До смерти скучно / Умираю со скуки", category: "boredom_tiredness" },
  { setupEn: "Are you okay with your job lately?", setupRu: "У тебя всё в порядке с работой в последнее время?", en: "Honestly, I'm sick and tired of it.", ru: "Меня это достало / Надоело", category: "boredom_tiredness" },
  { setupEn: "How did you know I was thinking about pizza?", setupRu: "Как ты узнал, что я думал о пицце?", en: "I don't know, I guess I can read your mind.", ru: "Читать / угадать чьи-то мысли", category: "opinion_meaning" },
  { setupEn: "What did you do all weekend?", setupRu: "Что ты делал все выходные?", en: "Nothing, I was just a couch potato.", ru: "Как овощ / Как комнатное растение", category: "boredom_tiredness" },
  { setupEn: "You look exhausted, are you alright?", setupRu: "Ты выглядишь измотанным, всё нормально?", en: "Yeah, I'm just beat after that workout.", ru: "Я валюсь с ног от усталости.", category: "boredom_tiredness" },
  { setupEn: "Why do you want to quit this project?", setupRu: "Почему ты хочешь бросить этот проект?", en: "I'm sick of it, honestly.", ru: "Меня это достало / Я устал от этого", category: "boredom_tiredness" },
  { setupEn: "I got the highest score in the class.", setupRu: "У меня самый высокий балл в классе.", en: "You've got to be kidding!", ru: "Ты, наверное, шутишь!", category: "disbelief_surprise" },
  { setupEn: "How was the concert last night?", setupRu: "Как прошёл вчерашний концерт?", en: "It was out of this world!", ru: "Потрясающе / Невероятно / Будто, не из этого мира", category: "disbelief_surprise" },
  { setupEn: "I ran into my old classmate in Tokyo.", setupRu: "Я столкнулся со своим старым одноклассником в Токио.", en: "What a small world!", ru: "Как тесен мир", category: "disbelief_surprise" },
  { setupEn: "The meeting starts at 9am tomorrow.", setupRu: "Встреча завтра в 9 утра.", en: "Got it, thanks for letting me know.", ru: "Понятно / Ясно", category: "disbelief_surprise" },
  { setupEn: "Have you ever heard of a place called Millbrook?", setupRu: "Ты когда-нибудь слышал о месте под названием Миллбрук?", en: "That rings a bell, actually.", ru: "Что-то знакомое / Всплывает в памяти", category: "disbelief_surprise" },
  { setupEn: "This traffic is absolutely terrible today.", setupRu: "Сегодня просто ужасные пробки.", en: "You can say that again!", ru: "Полностью согласен / Это точно!", category: "agreement_response" },
  { setupEn: "I finally finished my thesis last night.", setupRu: "Я наконец закончил свою диссертацию вчера ночью.", en: "Good for you!", ru: "Молодец / Поздравляю", category: "agreement_response" },
  { setupEn: "I think we should postpone the launch.", setupRu: "Думаю, нам стоит отложить запуск.", en: "I couldn't agree with you more.", ru: "Целиком и полностью согласен с вами", category: "agreement_response" },
  { setupEn: "Are you coming to the party tonight?", setupRu: "Ты придёшь на вечеринку сегодня?", en: "You bet!", ru: "Конечно", category: "agreement_response" },
  { setupEn: "I'd rather stay home tonight instead.", setupRu: "Я лучше останусь сегодня дома.", en: "Fair enough.", ru: "Справедливо", category: "agreement_response" },
  { setupEn: "Maybe we should try a different approach.", setupRu: "Может, стоит попробовать другой подход.", en: "Good point.", ru: "Хорошая мысль (идея)", category: "agreement_response" },
  { setupEn: "I'm really sorry, I broke your mug.", setupRu: "Мне очень жаль, я разбил твою кружку.", en: "No worries at all!", ru: "Не волнуйся / Ничего страшного / Все в порядке", category: "reassurance_dismissal" },
  { setupEn: "Thank you so much for fixing my laptop.", setupRu: "Огромное спасибо, что починил мой ноутбук.", en: "It's nothing, really.", ru: "Это ерунда / Без проблем / Это не составит труда", category: "reassurance_dismissal" },
  { setupEn: "Sorry I couldn't come to your show.", setupRu: "Извини, что не смог прийти на твоё выступление.", en: "No sweat, don't worry about it.", ru: "Без проблем", category: "reassurance_dismissal" },
  { setupEn: "I'm really stressed about the exam.", setupRu: "Я очень переживаю из-за экзамена.", en: "Don't sweat it, you'll do great.", ru: "Не парься", category: "reassurance_dismissal" },
  { setupEn: "You seem really anxious about this presentation.", setupRu: "Ты выглядишь очень взволнованным из-за этой презентации.", en: "I know, I just need to take it easy.", ru: "Расслабься / Успокойся", category: "reassurance_dismissal" },
  { setupEn: "My little brother keeps borrowing my clothes.", setupRu: "Мой младший брат постоянно берёт мою одежду.", en: "It really gets on my nerves.", ru: "Действовать на нервы", category: "annoyance_irritation" },
  { setupEn: "How's your relationship with your new roommate?", setupRu: "Как твои отношения с новым соседом по квартире?", en: "Honestly, he's a pain in the ass.", ru: "Заноза в заднице / Достало / Испытание на прочность", category: "annoyance_irritation" },
  { setupEn: "What's wrong, you seem upset?", setupRu: "Что не так, ты выглядишь расстроенным?", en: "That noise outside is really starting to bug me.", ru: "Раздражает / Нервирует", category: "annoyance_irritation" },
  { setupEn: "How do you feel about all this paperwork?", setupRu: "Как ты относишься ко всей этой бумажной работе?", en: "It's absolutely maddening.", ru: "Это сводит с ума", category: "annoyance_irritation" },
  { setupEn: "Have you chosen a university yet?", setupRu: "Ты уже выбрал университет?", en: "Not yet, I still need to make up my mind.", ru: "Принять решение / определиться", category: "decision_effort" },
  { setupEn: "Are you going to keep trying to fix it?", setupRu: "Ты собираешься продолжать пытаться это починить?", en: "No, I'm ready to throw in the towel.", ru: "Сдаваться", category: "decision_effort" },
  { setupEn: "Do you think you'll apply for that job?", setupRu: "Думаешь, ты подашь заявку на эту работу?", en: "Sure, I'll give it a shot.", ru: "Дать шанс / Сделать попытку", category: "decision_effort" },
  { setupEn: "You've always wanted to open your own business.", setupRu: "Ты всегда хотел открыть свой бизнес.", en: "I know, I should just go for it.", ru: "Иди к своей цели / Не отступай / Действуй", category: "decision_effort" },
  { setupEn: "Do you have an answer for me right now?", setupRu: "У тебя есть ответ для меня прямо сейчас?", en: "Let me sleep on it first.", ru: "Утро вечера мудренее / \"Переспать\" с этой мыслью", category: "decision_effort" },
  { setupEn: "Could you help me carry these boxes?", setupRu: "Не мог бы ты помочь мне занести эти коробки?", en: "Sure, my pleasure.", ru: "С удовольствием / Приятно (это сделать)", category: "politeness_thanks" },
  { setupEn: "I stayed up all night helping you move.", setupRu: "Я не спал всю ночь, помогая тебе переезжать.", en: "I can't thank you enough for that.", ru: "Не знаю, как вас благодарить", category: "politeness_thanks" },
  { setupEn: "The doctor said the surgery went well.", setupRu: "Врач сказал, что операция прошла хорошо.", en: "Thank goodness!", ru: "Слава Богу", category: "politeness_thanks" },
  { setupEn: "I think this is definitely the right decision.", setupRu: "Думаю, это определённо правильное решение.", en: "I beg to differ, actually.", ru: "Я позволю себе не согласиться.", category: "disagreement_doubt" },
  { setupEn: "He said he'll finish the report by tonight.", setupRu: "Он сказал, что закончит отчёт к вечеру.", en: "I don't buy it, honestly.", ru: "Я не верю / Не согласен / Не куплюсь на это", category: "disagreement_doubt" },
  { setupEn: "He forgot about the meeting again.", setupRu: "Он снова забыл о встрече.", en: "That figures, he always does that.", ru: "Это логично / Ничего удивительного", category: "disagreement_doubt" },
  { setupEn: "It's already 9pm, should we keep working?", setupRu: "Уже 9 вечера, продолжим работать?", en: "No, let's call it a day.", ru: "Заканчивать работу / Закругляться", category: "farewell_departure" },
  { setupEn: "We probably won't see each other for a while.", setupRu: "Мы, наверное, не увидимся какое-то время.", en: "Let's stay in touch, okay?", ru: "Быть на связи / Поддерживать связь", category: "farewell_departure" },
  { setupEn: "It was great catching up with you today.", setupRu: "Было здорово повидаться с тобой сегодня.", en: "You too, don't be a stranger!", ru: "Не пропадай / Напоминай о себе", category: "farewell_departure" },
  { setupEn: "I'll be traveling for the next few weeks.", setupRu: "Я буду путешествовать следующие пару недель.", en: "Please keep me in the loop.", ru: "Держать в курсе", category: "farewell_departure" },
  { setupEn: "I bet you won't finish the marathon.", setupRu: "Спорим, ты не пробежишь марафон.", en: "Over my dead body I won't!", ru: "Только через мой труп", category: "warning_threat" },
  { setupEn: "I heard you're getting a raise soon.", setupRu: "Слышал, тебе скоро повысят зарплату.", en: "You wish!", ru: "И не мечтай!", category: "warning_threat" },
  { setupEn: "Do you think you'll ever meet your favorite celebrity?", setupRu: "Думаешь, ты когда-нибудь встретишь свою любимую знаменитость?", en: "In your dreams.", ru: "Только в мечтах (Этого никогда не случится)", category: "warning_threat" },
  { setupEn: "You seem quiet today, what's up?", setupRu: "Ты сегодня тихий, что случилось?", en: "I don't know, I just feel blue.", ru: "Мне грустно / уныло / тоскливо", category: "state_feeling" },
  { setupEn: "Why weren't you at work yesterday?", setupRu: "Почему тебя вчера не было на работе?", en: "I was feeling a bit under the weather.", ru: "Нездоровится / плохо себя чувствовать", category: "state_feeling" },
  { setupEn: "You've barely said a word all morning.", setupRu: "Ты почти не сказал ни слова всё утро.", en: "Why so blue? Is something wrong?", ru: "Чего такой грустный?", category: "state_feeling" },
  { setupEn: "Do you visit your parents often?", setupRu: "Ты часто навещаешь родителей?", en: "Every now and then, yes.", ru: "Иногда / Время от времени", category: "time_frequency" },
  { setupEn: "What time does the train usually arrive?", setupRu: "Во сколько обычно прибывает поезд?", en: "It arrives at 9am, right on the dot.", ru: "Ровно в это время / Минута в минуту", category: "time_frequency" },
  { setupEn: "Do you think he'll apologize?", setupRu: "Думаешь, он извинится?", en: "Sooner or later, I'm sure of it.", ru: "Рано или поздно", category: "time_frequency" },
  { setupEn: "How often do you check your phone?", setupRu: "Как часто ты проверяешь телефон?", en: "Pretty much twenty-four seven.", ru: "Постоянно / 24 часа в сутки 7 дней в неделю", category: "time_frequency" },
  { setupEn: "Will the game still happen if it rains?", setupRu: "Игра всё равно состоится, если пойдёт дождь?", en: "Yes, rain or shine.", ru: "В любую погоду / Не смотря ни на что", category: "time_frequency" },
  { setupEn: "It's already 7am, time to get up.", setupRu: "Уже 7 утра, пора вставать.", en: "Alright, rise and shine!", ru: "Пора вставать / Проснись и пой", category: "excitement_readiness" },
  { setupEn: "The concert is next week, are you excited?", setupRu: "Концерт на следующей неделе, ты рад?", en: "Yes, I can't wait!", ru: "Жду не дождусь / Жду с нетерпением / Не могу дождаться", category: "excitement_readiness" },
  { setupEn: "What if we tried a completely different design?", setupRu: "Что если попробовать совершенно другой дизайн?", en: "Now you're talking!", ru: "Мне нравится эта идея / Наконец-то хорошая мысль", category: "excitement_readiness" },
  { setupEn: "Could you give me a hand with this table?", setupRu: "Не поможешь мне с этим столом?", en: "Sure, give someone a hand is what friends do.", ru: "Помочь / Протянуть руку помощи", category: "request_offer" },
  { setupEn: "Can I get a coffee, please?", setupRu: "Можно мне кофе, пожалуйста?", en: "Coming right up!", ru: "Сейчас будет сделано / Будет готово через минуту", category: "request_offer" },
  { setupEn: "Just tell me honestly what you think.", setupRu: "Просто скажи мне честно, что ты думаешь.", en: "Okay, give it to me straight then.", ru: "Скажи прямо / Скажи, как есть", category: "request_offer" },
  { setupEn: "The car is ready, we're leaving now.", setupRu: "Машина готова, мы уезжаем.", en: "Alright, hop in!", ru: "Запрыгивай в машину", category: "request_offer" },
  { setupEn: "What do you think about the new policy?", setupRu: "Что ты думаешь о новой политике?", en: "Well, my two cents is that it's too strict.", ru: "Мое мнение", category: "opinion_meaning" },
  { setupEn: "He said everything was 'fine' at dinner.", setupRu: "Он сказал, что за ужином всё было «нормально».", en: "You need to read between the lines there.", ru: "Читать между строк / Понимать подтекст", category: "opinion_meaning" },
  { setupEn: "Do you understand this physics homework?", setupRu: "Ты понимаешь это домашнее задание по физике?", en: "No, it's completely over my head.", ru: "Вне (моего) понимания", category: "opinion_meaning" },
  { setupEn: "What happened to your car door?", setupRu: "Что случилось с дверью твоей машины?", en: "Just a small fender bender in the parking lot.", ru: "Небольшое ДТП / Немного помял машину", category: "misc_situations" },
  { setupEn: "How did you land such a big client?", setupRu: "Как ты заполучил такого крупного клиента?", en: "It took a while to get my foot in the door.", ru: "Сделать первый шаг", category: "misc_situations" },
  { setupEn: "Why won't you go on the roller coaster?", setupRu: "Почему ты не хочешь на американские горки?", en: "I'm just too chicken.", ru: "Бояться / быть трусишкой", category: "misc_situations" },
  { setupEn: "The teacher assigned way too much homework.", setupRu: "Учитель задал слишком много домашней работы.", en: "Yeah, she really gave us a hard time.", ru: "Устроить кому-то проблемы / трудные времена", category: "misc_situations" },
  { setupEn: "Should I pay for both of our dinners?", setupRu: "Мне заплатить за оба наших ужина?", en: "No, let's just go Dutch.", ru: "Платить пополам / вскладчину / каждый за себя", category: "misc_situations" },
  { setupEn: "That horror movie was really scary.", setupRu: "Этот фильм ужасов был по-настоящему страшным.", en: "I know, I still have goose bumps.", ru: "Мурашки по коже", category: "misc_situations" },
  { setupEn: "Do you think you could quit your job and travel?", setupRu: "Думаешь, ты смог бы бросить работу и путешествовать?", en: "I don't have the guts to do that.", ru: "Иметь смелость", category: "misc_situations" },
  { setupEn: "Losing weight seems really simple.", setupRu: "Похудеть кажется довольно простым делом.", en: "It's easier said than done.", ru: "Легче сказать, чем сделать / Не всё так просто", category: "misc_situations" },
  { setupEn: "The bus finally showed up.", setupRu: "Автобус наконец приехал.", en: "It's about time!", ru: "Наконец-то / Пришло время / Пора (это сделать)", category: "misc_situations" },
  { setupEn: "He didn't answer, so I assumed he was mad.", setupRu: "Он не ответил, поэтому я решил, что он злится.", en: "You shouldn't jump to conclusions like that.", ru: "Спешить с выводами", category: "misc_situations" },
  { setupEn: "Could you watch my bag for a second?", setupRu: "Не мог бы ты присмотреть за моей сумкой секунду?", en: "Sure, I'll keep an eye on it.", ru: "Следить / наблюдать / приглядывать", category: "misc_situations" },
  { setupEn: "Why did he suddenly quit his job?", setupRu: "Почему он вдруг уволился с работы?", en: "It happened completely out of the blue.", ru: "Неожиданно / Из ниоткуда", category: "misc_situations" },
  { setupEn: "Does she really understand this software well?", setupRu: "Она действительно хорошо разбирается в этой программе?", en: "Yeah, she knows it inside out.", ru: "Вдоль и поперек / на зубок / как свои 5 пальцев", category: "misc_situations" },
  { setupEn: "How should I heat up this soup?", setupRu: "Как мне разогреть этот суп?", en: "Just nuke it in the microwave.", ru: "Готовить в микроволновке", category: "misc_situations" },
  { setupEn: "Do you think we'll win the game tomorrow?", setupRu: "Думаешь, мы выиграем игру завтра?", en: "I'm keeping my fingers crossed.", ru: "Держать кулаки на удачу / Скрестить пальцы на удачу", category: "misc_situations" },
  { setupEn: "Was the exam difficult for you?", setupRu: "Экзамен был для тебя сложным?", en: "Not at all, it was a piece of cake.", ru: "Проще простого / проще пареной репы / легче легкого", category: "misc_situations" },
  { setupEn: "Are you serious about moving to Canada?", setupRu: "Ты серьёзно насчёт переезда в Канаду?", en: "No, I was just pulling your leg.", ru: "Морочить голову / Разыгрывать / Обманывать", category: "misc_situations" },
  { setupEn: "You're too hard on him about this mistake.", setupRu: "Ты слишком строг к нему из-за этой ошибки.", en: "Try to put yourself in his place.", ru: "Поставить себя на чье-то место", category: "misc_situations" },
  { setupEn: "Do you want to grab lunch now?", setupRu: "Хочешь пообедать прямо сейчас?", en: "Yes, please, I can eat a horse.", ru: "Я голодный, как волк / Умираю с голоду", category: "misc_situations" },
  { setupEn: "What's your plan for the weekend?", setupRu: "Какие у тебя планы на выходные?", en: "I'll just play it by ear.", ru: "Действовать по обстоятельствам / Импровизировать", category: "misc_situations" },
  { setupEn: "I was just talking about you, and here you are!", setupRu: "Я как раз говорил о тебе, а вот и ты!", en: "Speak of the devil!", ru: "Помяни чёрта (и он появится) / Легок на помине / О волке помолвка, а волк и тут.", category: "misc_situations" },
  { setupEn: "I'm starving, want to get something quick?", setupRu: "Я умираю с голоду, хочешь перекусить по-быстрому?", en: "Sure, let's grab a bite.", ru: "Перекусить", category: "misc_situations" },
  { setupEn: "Do you have a fixed plan for the trip?", setupRu: "У тебя есть чёткий план поездки?", en: "Not really, I like to go with the flow.", ru: "Плыть по течению / двигаться в потоке / делать, как все", category: "misc_situations" },
  { setupEn: "Can you lend me some money this week?", setupRu: "Можешь одолжить мне немного денег на этой неделе?", en: "Sorry, I'm completely broke right now.", ru: "На мели", category: "misc_situations" },
  { setupEn: "Why did the printer suddenly stop working?", setupRu: "Почему принтер вдруг перестал работать?", en: "Beats me, I have no idea.", ru: "Ума не приложу / Не понимаю / Не знаю", category: "misc_situations" },
  { setupEn: "Everyone in the room is panicking.", setupRu: "Все в комнате паникуют.", en: "Just keep your cool, everyone.", ru: "Успокойся / Держи себя под контролем", category: "misc_situations" },
  { setupEn: "Are you excited about the new job?", setupRu: "Ты рад новой работе?", en: "Sort of, but I'm also nervous.", ru: "Как бы / вроде бы", category: "misc_situations" },
  { setupEn: "I have my driving test tomorrow.", setupRu: "У меня завтра экзамен по вождению.", en: "Good luck, you'll do fine!", ru: "Успехов / Удачи / Надеюсь, все будет хорошо", category: "misc_situations" },
  { setupEn: "Who gets to sit in the front seat?", setupRu: "Кто сядет на переднее сиденье?", en: "I called shotgun first!", ru: "Тот, кто сидит спереди в машине", category: "misc_situations" },
  { setupEn: "Did you hear they changed the schedule again?", setupRu: "Слышал, они снова поменяли расписание?", en: "Who cares, honestly.", ru: "Какая разница / Кому какое дело / Неважно", category: "misc_situations" },
  { setupEn: "I got a small scratch on my new phone.", setupRu: "У меня маленькая царапина на новом телефоне.", en: "That's not a big deal.", ru: "Важное дело / Трудное дело / Тоже мне дело (с сарказмом) No big deal - Не важно / Не страшно", category: "misc_situations" },
  { setupEn: "Everyone is running around the office nervously.", setupRu: "Все в офисе бегают нервно туда-сюда.", en: "What's going on here?", ru: "Что стряслось? / Что тут происходит?", category: "misc_situations" },
  { setupEn: "I decided to double-check the numbers before sending.", setupRu: "Я решил перепроверить цифры перед отправкой.", en: "Good thinking, that's smart.", ru: "Правильная мысль / Хорошо, что ты подумал об этом / Вовремя исправился", category: "misc_situations" },
  { setupEn: "I just spilled coffee all over my laptop!", setupRu: "Я только что пролил кофе на ноутбук!", en: "Shoot, that's terrible.", ru: "Черт! / Блин!", category: "misc_situations" },
  { setupEn: "Does it matter which color we choose?", setupRu: "Важно, какой цвет мы выберем?", en: "Not really, nothing matters as long as it works.", ru: "Все остальное не важно / Это самое важное", category: "misc_situations" },
  { setupEn: "I'm not sure I can do this.", setupRu: "Я не уверен, что смогу это сделать.", en: "Come on, you can do it!", ru: "Ну же! / Давай! / Да ладно", category: "misc_situations" },
  { setupEn: "I forgot to bring the documents again.", setupRu: "Я снова забыл принести документы.", en: "Never mind, we can send them later.", ru: "Не важно / Не нужно / Не думай об этом", category: "misc_situations" },
  { setupEn: "Let me pay for dinner tonight, please.", setupRu: "Позволь мне заплатить за ужин сегодня.", en: "Well, if you insist.", ru: "Если вы настаиваете", category: "misc_situations" },
  { setupEn: "He keeps tapping his pen on the desk.", setupRu: "Он постоянно стучит ручкой по столу.", en: "Stop it, that's so annoying!", ru: "Прекрати! / Перестань!", category: "misc_situations" },
  { setupEn: "Everyone suddenly went quiet in the room.", setupRu: "Все в комнате вдруг замолчали.", en: "What gives? Did something happen?", ru: "Что случилось? / В чем дело?", category: "misc_situations" },
  { setupEn: "Why aren't you answering my question?", setupRu: "Почему ты не отвечаешь на мой вопрос?", en: "What, cat got your tongue?", ru: "Воды в рот набрал / Язык проглотил", category: "misc_situations" },
  { setupEn: "You seem really nervous about something.", setupRu: "Ты выглядишь очень нервным из-за чего-то.", en: "It's written all over your face, isn't it?", ru: "У тебя на лице написано", category: "misc_situations" },
  { setupEn: "I'll finish the project by Friday for you.", setupRu: "Я закончу проект к пятнице для тебя.", en: "Great, it's a deal.", ru: "Договорились", category: "misc_situations" },
  { setupEn: "How should we split the bill at the restaurant?", setupRu: "Как нам разделить счёт в ресторане?", en: "Let's go fifty-fifty.", ru: "Давайте разделим счет пополам", category: "misc_situations" },
  { setupEn: "Why did they fire that manager?", setupRu: "Почему они уволили того менеджера?", en: "He was pretty good for nothing, honestly.", ru: "Ни к чему не пригодный / Никчемный / Ленивый", category: "misc_situations" },
  { setupEn: "This weather is absolutely freezing today.", setupRu: "Сегодня просто ужасно холодно.", en: "You're telling me, I can't feel my hands.", ru: "И говорить нечего / Конечно / Еще бы", category: "misc_situations" },
  { setupEn: "Stop calling me every single day.", setupRu: "Перестань звонить мне каждый день.", en: "Get a life, seriously.", ru: "Отвали / Отстать/ Найди себе занятие (и перестать ко мне приставать)", category: "misc_situations" },
  { setupEn: "I'm going to fail this class for sure.", setupRu: "Я точно провалю этот предмет.", en: "Don't joke with me like that.", ru: "Это не смешно / Не шути так", category: "misc_situations" },
  { setupEn: "I need help moving this weekend, can you come?", setupRu: "Мне нужна помощь с переездом в эти выходные, придёшь?", en: "Just name it, I'll be there.", ru: "Только скажи (и я готов)", category: "misc_situations" },
  { setupEn: "I've been in a really bad mood all week.", setupRu: "Я всю неделю в плохом настроении.", en: "What's eating you? You can tell me.", ru: "Что тебя гложет? / Что тебя беспокоит?", category: "misc_situations" },
  { setupEn: "I forgot your birthday completely.", setupRu: "Я совсем забыл про твой день рождения.", en: "Shame on you, honestly.", ru: "Как тебе не стыдно? / Тебе должно быть стыдно", category: "misc_situations" },
  { setupEn: "This project is really difficult right now.", setupRu: "Этот проект сейчас правда сложный.", en: "Just hang in there, it'll get easier.", ru: "Потерпи / Держись", category: "misc_situations" },
  { setupEn: "Can you lend me twenty dollars?", setupRu: "Можешь одолжить мне двадцать долларов?", en: "Sure, now I owe you one.", ru: "Я буду тебе должен / Я могу у тебя одолжить?", category: "misc_situations" },
  { setupEn: "I don't want to see you here again.", setupRu: "Я не хочу больше видеть тебя здесь.", en: "Fine, take a hike then.", ru: "Иди куда подальше / Оставь меня в покое", category: "misc_situations" },
  { setupEn: "Where are you right now?", setupRu: "Где ты сейчас?", en: "I'm on my way, be there in five.", ru: "Я уже еду / Я уже в пути", category: "misc_situations" },
  { setupEn: "Did you finish the report on time?", setupRu: "Ты закончил отчёт вовремя?", en: "No, I'm totally hosed.", ru: "Мне крышка / Я попал / Не повезло", category: "misc_situations" },
  { setupEn: "How did you end up living in Berlin?", setupRu: "Как ты в итоге оказался живёшь в Берлине?", en: "It's a long story, honestly.", ru: "Долго рассказывать / Потом расскажу", category: "misc_situations" },
  { setupEn: "I've become a vegetarian, you know.", setupRu: "Я, между прочим, стал вегетарианцем.", en: "Since when? You had a burger yesterday!", ru: "С каких пор", category: "misc_situations" },
  { setupEn: "Wow, you look amazing tonight!", setupRu: "Ого, ты сегодня потрясающе выглядишь!", en: "Thanks, I'm dressed to kill for the party.", ru: "Выглядишь сногсшибательно", category: "misc_situations" },
  { setupEn: "The kids are running wild in the store.", setupRu: "Дети бегают как угорелые в магазине.", en: "Tell them to behave themselves.", ru: "Веди себя хорошо / Следи за своим поведением", category: "misc_situations" },
  { setupEn: "I have a huge secret to tell you.", setupRu: "У меня есть огромный секрет, чтобы тебе рассказать.", en: "Do tell, I'm listening.", ru: "Рассказывай (все, что знаешь)", category: "misc_situations" },
  { setupEn: "You forgot to send the invoice again.", setupRu: "Ты снова забыл отправить счёт.", en: "I know, I blew it this time.", ru: "Я все испортил", category: "misc_situations" },
  { setupEn: "You look upset about something you did.", setupRu: "Ты выглядишь расстроенным из-за чего-то, что сделал.", en: "Yeah, I messed up badly.", ru: "Я облажался / Я сглупил / Я сделал ошибку", category: "misc_situations" },
  { setupEn: "I want to become a famous actor someday.", setupRu: "Я хочу однажды стать знаменитым актёром.", en: "That sounds like pie in the sky to me.", ru: "Несбыточная мечта / Что-то недостижимое", category: "misc_situations" },
  { setupEn: "Is there a catch to this offer?", setupRu: "В этом предложении есть подвох?", en: "No, no strings attached.", ru: "Без скрытых условий / От вас больше ничего не требуется", category: "misc_situations" },
  { setupEn: "I'm heading to bed now, goodnight.", setupRu: "Я иду спать, спокойной ночи.", en: "Goodnight, sleep tight!", ru: "Спи крепко", category: "misc_situations" },
  { setupEn: "Should I bring an umbrella just in case?", setupRu: "Взять зонт на всякий случай?", en: "Sure, it can't hurt.", ru: "Хуже не будет / Это не повредит", category: "misc_situations" },
  { setupEn: "I finally passed my driving test!", setupRu: "Я наконец сдал экзамен по вождению!", en: "You made it, congratulations!", ru: "У тебя получилось / Ты смог добраться (до места)", category: "misc_situations" },
  { setupEn: "I heard he's the best in the whole company.", setupRu: "Слышал, он лучший во всей компании.", en: "Whatever, I don't really believe that.", ru: "Не важно / Пусть будет так / С трудом верится / Что бы ты не говорил (я не верю)", category: "misc_situations" },
  { setupEn: "I just won the lottery!", setupRu: "Я только что выиграл в лотерею!", en: "Get out of here, seriously?", ru: "Да иди ты! / Шутишь? / Не гони!", category: "misc_situations" },
  { setupEn: "His new business is doing incredibly well.", setupRu: "Его новый бизнес идёт невероятно хорошо.", en: "Yeah, he really made it big.", ru: "Ты хорошо раскрутился / Ты хорошо преуспел / Ты многого достиг", category: "misc_situations" },
  { setupEn: "Can I ask you something important?", setupRu: "Могу я спросить тебя кое-что важное?", en: "Sure, hold on a sec, let me finish this.", ru: "Постой / Подожди-ка", category: "misc_situations" },
  { setupEn: "That old abandoned house down the street is scary.", setupRu: "Тот старый заброшенный дом на улице пугает.", en: "Yeah, it's really creepy at night.", ru: "Доводящий до мурашек / Странный / Ненормальный", category: "misc_situations" },
  { setupEn: "He'll probably never call you back.", setupRu: "Он, наверное, никогда тебе не перезвонит.", en: "You never know, maybe he will.", ru: "Мало ли / Всякое бывает / Кто знает", category: "misc_situations" },
  { setupEn: "The weekend is over, back to work tomorrow.", setupRu: "Выходные закончились, завтра снова на работу.", en: "Yeah, back to the grind.", ru: "Назад к работе / За работу", category: "misc_situations" },
  { setupEn: "He lied to everyone and now no one trusts him.", setupRu: "Он всем соврал, и теперь никто ему не доверяет.", en: "It serves him right, honestly.", ru: "Ты получил по заслугам", category: "misc_situations" },
  { setupEn: "I failed the interview, I feel terrible.", setupRu: "Я провалил собеседование, мне ужасно.", en: "Lighten up, there will be other chances.", ru: "Расслабься / Взбодрись / Не расстраивайся", category: "misc_situations" },
  { setupEn: "You missed the bus by literally two seconds.", setupRu: "Ты опоздал на автобус буквально на две секунды.", en: "That's just my luck, honestly.", ru: "Мне всегда не везет", category: "misc_situations" },
  { setupEn: "Should we go to the beach or the mountains?", setupRu: "Поехать на пляж или в горы?", en: "It's up to you, I'm fine either way.", ru: "Решать тебе", category: "misc_situations" },
  { setupEn: "I knew this plan wouldn't work from the start.", setupRu: "Я знал, что этот план не сработает с самого начала.", en: "I told you so.", ru: "Я же говорил", category: "misc_situations" },
  { setupEn: "I really shouldn't have said that to her.", setupRu: "Мне правда не стоило говорить ей это.", en: "You know better than that.", ru: "Но ты и так догадываешься (что поступил неправильно)", category: "misc_situations" },
  { setupEn: "Why are you so careful with that investment?", setupRu: "Почему ты так осторожен с этой инвестицией?", en: "I've been burned before, so now I'm careful.", ru: "Обжегся на этом / Погорел / Надули / Лоханулся", category: "misc_situations" },
  { setupEn: "Are you joining us for the trip this weekend?", setupRu: "Ты присоединишься к нам в поездке в эти выходные?", en: "Yeah, I'll be down.", ru: "Я с вами", category: "misc_situations" },
  { setupEn: "Can you explain the whole story from the start?", setupRu: "Можешь объяснить всю историю с самого начала?", en: "Let me just get to the point instead.", ru: "Ближе к сути / Говори по сути", category: "misc_situations" },
  { setupEn: "He never brags about his success.", setupRu: "Он никогда не хвастается своим успехом.", en: "Yeah, he's really down to earth.", ru: "Разумный человек / Реалист", category: "misc_situations" },
  { setupEn: "Can you send me the file by tomorrow?", setupRu: "Можешь прислать мне файл к завтрашнему дню?", en: "Sure thing.", ru: "Конечно / Без проблем", category: "misc_situations" },
  { setupEn: "Did you remember to call the dentist?", setupRu: "Ты не забыл позвонить стоматологу?", en: "No, it totally slipped my mind.", ru: "Это вылетело у меня из головы / Я совершенно забыл (что должен был это сделать)", category: "misc_situations" },
  { setupEn: "Where are you going in such a hurry?", setupRu: "Куда ты так спешишь?", en: "Sorry, nature calls.", ru: "Природа зовет / Нужно сходить в туалет / Нужно справить нужду", category: "misc_situations" },
];

// --- Формат "Диалоги": выбрать подходящую ответную реплику ---
// Дистракторы берутся из ДРУГИХ категорий (не той, что у правильного
// ответа) — это настоящие, живые фразы-ответы, просто не подходящие
// именно к этой конкретной реплике. Так варианты выглядят правдоподобно,
// но не дают лёгкой подсказки по структуре/грамматике, как это было бы
// с искусственно "сломанными" неправильными вариантами.
function buildDialogueQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const target = DIALOGUE_PHRASES[Math.floor(Math.random() * DIALOGUE_PHRASES.length)];
    if (forbiddenText && target.en.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const others = DIALOGUE_PHRASES.filter((p) => p.category !== target.category && p.en.toLowerCase() !== target.en.toLowerCase());
    const shuffledOthers = shuffle([...others]);
    const distractors = shuffledOthers.slice(0, 5).map((p) => p.en);
    if (distractors.length < 5) continue;

    const candidates = [target.en, ...distractors];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    const questionLabel = `«${target.setupEn}»\n(${target.setupRu})\n\nВыбери подходящий ответ:`;

    return { correctText: target.en, correctRu: target.ru, questionLabel, options, correctPos };
  }
  return null;
}

function buildDialoguePicked(prefix, forbiddenText) {
  const q = buildDialogueQuestion(forbiddenText);
  if (!q) return null;
  const keyboard = q.options.map((textOpt, i) => [{ text: textOpt, callback_data: `a:${i}` }]);
  const questionText = `💬 ${q.questionLabel}`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;
  return {
    correct: { en: q.correctText, ru: q.correctRu },
    correctPos: q.correctPos,
    keyboard,
    text,
    mode: "dialogue",
  };
}

// --- Второй формат для тех же 150 идиом: обычный перевод с вариантами
// ответа (идиома — выбери верный перевод). Берём точные заголовки идиом
// из книги (SEED_SHARED_LIBRARY_PHRASES), а не сконструированные
// предложения из DIALOGUE_PHRASES — так вопрос точно совпадает с тем, что
// в тексте книги. Дистракторы — RU переводы ДРУГИХ идиом из этого же
// списка, не случайный мусор.
const IDIOM_TRANSLATE_PAIRS = SEED_SHARED_LIBRARY_PHRASES.topics["разговорные_фразы"];

function buildIdiomTranslateQuestion(forbiddenText) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const target = IDIOM_TRANSLATE_PAIRS[Math.floor(Math.random() * IDIOM_TRANSLATE_PAIRS.length)];
    if (forbiddenText && target.en.toLowerCase() === forbiddenText.toLowerCase()) continue;

    const others = shuffle(IDIOM_TRANSLATE_PAIRS.filter((p) => p.en.toLowerCase() !== target.en.toLowerCase()));
    const distractorRu = others.slice(0, 5).map((p) => p.ru);
    const candidates = [target.ru, ...distractorRu];
    const uniqueOptions = new Set(candidates.map((c) => c.toLowerCase()));
    if (uniqueOptions.size !== 6) continue;

    const order = shuffle(candidates.map((_, i) => i));
    const correctPos = order.indexOf(0);
    const options = order.map((i) => candidates[i]);

    return { correctEn: target.en, correctRu: target.ru, options, correctPos };
  }
  return null;
}

function buildIdiomTranslatePicked(prefix, forbiddenText) {
  const q = buildIdiomTranslateQuestion(forbiddenText);
  if (!q) return null;
  const keyboard = q.options.map((textOpt, i) => [{ text: textOpt, callback_data: `a:${i}` }]);
  const questionText = `🔤 Как переводится: *${mdEscape(q.correctEn)}*?`;
  const text = prefix ? `${prefix}\n\n${questionText}` : questionText;
  return {
    correct: { en: q.correctEn, ru: q.correctRu },
    correctPos: q.correctPos,
    keyboard,
    text,
    mode: "idiomtranslate",
  };
}

async function handleModeVocabPersonal(chatId) {
  const vocab = await getVocab(chatId);
  const topics = getDistinctTopics(vocab);
  if (topics.length <= 1) {
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, "📚 Режим: Лексика", "vocab", undefined, undefined, null, null);
    return;
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: "По какой теме?",
    reply_markup: {
      inline_keyboard: [
        ...topics.map((t, i) => [{ text: `📌 ${topicLabel(t)}`, callback_data: `vtopic:${i}` }]),
        [{ text: "🔀 Все темы вместе", callback_data: "vtopic:all" }],
      ],
    },
  });
}

async function handleModeVocab(chatId) {
  // "Диалоги" — постоянный вариант, так что теперь меню выбора источника
  // показываем всегда. "Общая библиотека" по-прежнему добавляется в
  // список только если в ней реально есть слова.
  const sharedEntries = await listSharedLibrary();
  const buttons = [[{ text: "📓 Мой словарь", callback_data: "vsource:personal" }]];
  if (sharedEntries.length) {
    buttons.push([{ text: "📖 Общая библиотека", callback_data: "vsource:shared" }]);
  }
  buttons.push([{ text: "💬 150 американских фраз", callback_data: "vsource:idioms" }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Лексика — откуда слова?",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handleModeGrammar(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Грамматика — какой формат?",
    reply_markup: {
      inline_keyboard: Object.entries(GRAMMAR_EXERCISE_TYPES).map(([key, label]) => [{ text: label, callback_data: `gtype:${key}` }]),
    },
  });
}

async function handleModeIrregular(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Неправильные глаголы — какой уровень?",
    reply_markup: {
      inline_keyboard: [
        [{ text: "A1–A2", callback_data: "ilevel:a" }],
        [{ text: "B1–B2", callback_data: "ilevel:b" }],
        [{ text: "B2+", callback_data: "ilevel:c" }],
      ],
    },
  });
}

async function handleMode(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Что тренируем?",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📚 Лексика", callback_data: "mode:vocab" }],
        [{ text: "📝 Грамматика (времена)", callback_data: "mode:grammar" }],
        [{ text: "🔄 Неправильные глаголы", callback_data: "mode:irregular" }],
      ],
    },
  });
}

async function handleHelp(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      "/mode — переключить лексика / грамматика\n" +
      "/play — новый вопрос\n" +
      "/score — статистика\n" +
      "/count — сколько слов в словаре\n" +
      "/delete <English> — удалить слово (можно сразу список, по одному на строку)\n" +
      "/reset — сбросить прогресс\n" +
      "/hidemenu (или кнопка «🔽 Скрыть меню») — убрать нижнее меню (если на телефоне не видно переписку)\n" +
      "/showmenu — вернуть его обратно\n\n" +
      "Чтобы добавить слова — просто пришли строки вида «English . перевод», " +
      "хоть одну, хоть весь список с урока сразу.\n\n" +
      "Папки: чтобы слова лежали отдельной группой, начни сообщение со строки с #названием, " +
      "например #школа, а ниже — слова. Тренировать потом можно каждую папку отдельно.",
    reply_markup: await mainReplyKeyboard(chatId),
  });
}

async function handleScore(chatId) {
  const stats = await getStats(chatId);
  const vocab = await getVocab(chatId);
  const pending = await pendingStore().get(String(chatId), { type: "json" });
  const practicedCount = pending && Array.isArray(pending.seenEn) ? pending.seenEn.length : 0;
  const missed = Object.entries(stats.wrong || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, c]) => `  • ${w} (${c})`)
    .join("\n");
  await tg("sendMessage", {
    chat_id: chatId,
    text: `📊 ${statsLine(practicedCount, vocab.length)}` + (missed ? `\n\nЧаще всего путаешь:\n${missed}` : ""),
    reply_markup: await mainReplyKeyboard(chatId),
  });
}

async function handleReset(chatId) {
  await withOptimisticUpdate(statsStore(), String(chatId), emptyStats, () => emptyStats());
  await tg("sendMessage", { chat_id: chatId, text: "Прогресс сброшен. /play — начать заново.", reply_markup: await mainReplyKeyboard(chatId) });
}

async function handleCount(chatId) {
  const vocab = await getVocab(chatId);
  await tg("sendMessage", { chat_id: chatId, text: `В словаре сейчас ${vocab.length} слов.`, reply_markup: await mainReplyKeyboard(chatId) });
}

// Убрать/вернуть нижнее меню — на маленьких экранах оно занимает много
// места и заслоняет переписку, поэтому можно временно спрятать.
async function handleHideMenu(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "Меню внизу скрыто. Все команды по-прежнему работают, если написать их текстом (/mode, /help и т.д.). Вернуть меню — /showmenu.",
    reply_markup: { remove_keyboard: true },
  });
}

async function handleShowMenu(chatId) {
  await tg("sendMessage", { chat_id: chatId, text: "Меню снова внизу.", reply_markup: await mainReplyKeyboard(chatId) });
}

// Разовая команда для перехода на приватные (по чату) словари: раньше был
// один общий словарь на всех, кто писал боту. Тот, кто хочет унаследовать
// прежний общий список как свой личный (обычно нужно только один раз, в
// одном конкретном чате), может явно об этом попросить командой /migrate.
// Ничего не делает, если старого общего словаря уже нет или у этого чата
// уже есть свой список.
async function handleMigrate(chatId) {
  const existing = await wordsStore().get(`words:${chatId}`, { type: "json" });
  if (Array.isArray(existing) && existing.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `У этого чата уже есть свой словарь (${existing.length} слов) — переносить нечего.`,
    });
    return;
  }

  const legacy = await wordsStore().get("words", { type: "json" });
  if (!Array.isArray(legacy) || !legacy.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Старого общего словаря не нашла — переносить нечего." });
    return;
  }

  await verifiedSet(wordsStore(), `words:${chatId}`, legacy);
  await tg("sendMessage", { chat_id: chatId, text: `Готово — перенесла ${legacy.length} слов из старого общего словаря в этот чат.` });
}

// Только для админов (см. /claimadmin): полностью очищает словарь ДРУГОГО
// чата по его chat_id (посмотреть можно в /students). После очистки у того
// человека при следующем вопросе словарь пересеется заново стандартным
// стартовым набором — это ожидаемо, не баг.
async function handleClearVocab(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const targetId = argText.trim();
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /clearvocab <chat_id> (посмотреть chat_id — в /students)" });
    return;
  }
  const before = await wordsStore().get(`words:${targetId}`, { type: "json" });
  const count = Array.isArray(before) ? before.length : 0;
  await verifiedSet(wordsStore(), `words:${targetId}`, []);
  await tg("sendMessage", { chat_id: chatId, text: `Готово — очистила словарь чата ${targetId} (было ${count} слов).` });
}

// Только для админов: убирает у КОНКРЕТНОГО другого чата именно слова из
// старого стартового списка (data/vocab.mjs, 379 слов) — на случай, если
// человек успел зарегистрироваться до того, как автозаполнение убрали.
// Всё, что человек добавил сам сверх этого списка, остаётся нетронутым.
async function handleRemoveDefault(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const targetRaw = argText.trim();
  if (!targetRaw) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /removedefault @username или chat_id" });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }

  const defaultEnSet = new Set(DEFAULT_VOCAB.map((w) => w.en.toLowerCase()));
  let removed = 0;
  let total = 0;
  await withOptimisticUpdate(wordsStore(), `words:${targetId}`, () => [], (vocab) => {
    const before = vocab.length;
    const next = vocab.filter((w) => !defaultEnSet.has(w.en.toLowerCase()));
    removed = before - next.length;
    total = next.length;
    return next;
  });
  await tg("sendMessage", {
    chat_id: chatId,
    text: `Готово — убрала у ${targetRaw} ${removed} слов из старого стартового списка. Осталось (добавлено самим человеком): ${total}.`,
  });
}

// Находит chat_id по @username (ищет среди всех известных личностей) или,
// если передали просто число, использует его как chat_id напрямую.
async function resolveTarget(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const username = trimmed.replace(/^@/, "").toLowerCase();
  if (!username) return null;
  const ids = await identityStore().list();
  const entries = ids && ids.blobs ? ids.blobs : [];
  for (const entry of entries) {
    const info = await identityStore().get(entry.key, { type: "json" });
    if (info && info.username && info.username.toLowerCase() === username) {
      return entry.key;
    }
  }
  return null;
}

// Только для админов: добавляет слова НЕ в свой словарь, а в словарь
// конкретного другого ученика. Первая строка — @username или chat_id
// получателя, дальше — слова в обычном формате «English . перевод», можно
// сразу много строк.
async function handleAddTo(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText.split(/\r?\n/);
  const firstLine = (lines[0] || "").trim();
  if (!firstLine) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/addto @username (или chat_id) [#тема]\nEnglish . перевод\n... (можно много строк)",
    });
    return;
  }
  // Первая строка — получатель, и через пробел — необязательная тема
  // (#медицина), которой будут помечены все добавляемые этим вызовом слова.
  const firstLineParts = firstLine.split(/\s+/);
  const targetRaw = firstLineParts[0];
  const topicRaw = firstLineParts.slice(1).join(" ").replace(/^#/, "").trim();
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }

  const pairs = [];
  for (const line of lines.slice(1)) {
    const parsed = parseVocabLine(line);
    if (parsed) {
      if (topicRaw) parsed.topic = topicRaw;
      pairs.push(parsed);
    }
  }
  if (!pairs.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одной пары «слово - перевод» после первой строки." });
    return;
  }

  const { added, total } = await addWords(targetId, pairs);
  const skippedDupes = pairs.length - added;
  let msg = `✅ Добавлено в словарь ${targetRaw}: ${added}. Всего у него в словаре: ${total}.`;
  if (topicRaw) msg += `\nТема: ${topicRaw}.`;
  if (skippedDupes) msg += `\nПропущено как дубли: ${skippedDupes}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

// Только для админов: помечает темой УЖЕ СУЩЕСТВУЮЩИЕ слова в чьём-то
// словаре (по точному совпадению английского термина) — чтобы можно было
// разложить по темам то, что уже добавлено, без пересоздания слов заново.
async function handleSetTopic(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText.split(/\r?\n/);
  const firstLine = (lines[0] || "").trim();
  const firstLineParts = firstLine.split(/\s+/).filter(Boolean);
  if (firstLineParts.length < 2) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/settopic @username (или chat_id) #тема\nEnglish term 1\nEnglish term 2\n...",
    });
    return;
  }
  const targetRaw = firstLineParts[0];
  const topic = firstLineParts.slice(1).join(" ").replace(/^#/, "").trim();
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }
  if (!topic) {
    await tg("sendMessage", { chat_id: chatId, text: "Не указана тема (напиши после получателя, например #медицина)." });
    return;
  }

  const terms = lines
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!terms.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одного термина после первой строки (по одному English-слову на строку)." });
    return;
  }
  const termSet = new Set(terms.map((t) => t.toLowerCase()));

  let tagged = 0;
  let notFound = [];
  await withOptimisticUpdate(wordsStore(), `words:${targetId}`, () => [], (vocab) => {
    tagged = 0;
    const foundSet = new Set();
    const next = vocab.map((w) => {
      if (termSet.has(w.en.toLowerCase())) {
        tagged += 1;
        foundSet.add(w.en.toLowerCase());
        return { ...w, topic };
      }
      return w;
    });
    notFound = terms.filter((t) => !foundSet.has(t.toLowerCase()));
    return next;
  });

  let msg = `✅ Пометила темой «${topic}» у ${targetRaw}: ${tagged} слов.`;
  if (notFound.length) msg += `\nНе нашла в словаре: ${notFound.length} (${notFound.slice(0, 10).join(", ")}${notFound.length > 10 ? "…" : ""}).`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

// Только для админов: то же самое, что /delete, но для словаря КОНКРЕТНОГО
// ДРУГОГО чата — первая строка после команды это @username или chat_id,
// дальше по одному English-термину на строку (как в /delete).
async function handleDeleteFrom(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const targetRaw = lines[0];
  if (!targetRaw) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/deletefrom @username (или chat_id)\nEnglish term 1\nEnglish term 2\n...",
    });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }
  const termLines = lines.slice(1);
  if (!termLines.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одного термина после первой строки." });
    return;
  }
  const terms = termLines.map(extractEnForDelete).filter(Boolean);
  const { removedCount, total } = await deleteWords(targetId, terms);
  const notFound = terms.length - removedCount;
  let msg = `🗑 Удалила у ${targetRaw}: ${removedCount}. Осталось у него в словаре: ${total}.`;
  if (notFound > 0) msg += `\nНе нашла: ${notFound}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

// Только для админов: общая библиотека (видна всем ученикам сразу,
// отдельно от их личного словаря). Первая строка после команды —
// "<сложность> #<тема>", например "A1-A2 #медицина".
function parseSharedHeaderLine(line) {
  const parts = line.trim().split(/\s+/);
  const hashIdx = parts.findIndex((p) => p.startsWith("#"));
  if (hashIdx === -1) return null;
  const difficulty = parts.slice(0, hashIdx).join(" ").trim();
  const topic = parts.slice(hashIdx).join(" ").replace(/^#/, "").trim();
  if (!difficulty || !topic) return null;
  return { difficulty, topic };
}

async function handleAddShared(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText.split(/\r?\n/);
  const header = parseSharedHeaderLine(lines[0] || "");
  if (!header) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/addshared A1-A2 #медицина\nEnglish . перевод\n... (можно много строк)",
    });
    return;
  }
  const pairs = lines
    .slice(1)
    .map(parseVocabLine)
    .filter(Boolean);
  if (!pairs.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одной пары «слово - перевод» после первой строки." });
    return;
  }
  const { added, total } = await addSharedWords(header.difficulty, header.topic, pairs);
  const skippedDupes = pairs.length - added;
  let msg = `✅ Добавлено в общую библиотеку (${header.difficulty} / ${header.topic}): ${added}. Всего там сейчас: ${total}.`;
  if (skippedDupes) msg += `\nПропущено как дубли: ${skippedDupes}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

async function handleDeleteShared(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const lines = argText.split(/\r?\n/);
  const header = parseSharedHeaderLine(lines[0] || "");
  if (!header) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат:\n/deleteshared A1-A2 #медицина\nEnglish term 1\nEnglish term 2\n...",
    });
    return;
  }
  const terms = lines
    .slice(1)
    .map(extractEnForDelete)
    .filter(Boolean);
  if (!terms.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Не нашла ни одного термина после первой строки." });
    return;
  }
  const { removedCount, total } = await deleteSharedWords(header.difficulty, header.topic, terms);
  const notFound = terms.length - removedCount;
  let msg = `🗑 Удалила из общей библиотеки (${header.difficulty} / ${header.topic}): ${removedCount}. Осталось там: ${total}.`;
  if (notFound > 0) msg += `\nНе нашла: ${notFound}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

async function handleSharedList(chatId) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const entries = await listSharedLibrary();
  if (!entries.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Общая библиотека пока пустая. Добавить: /addshared <сложность> #<тема>" });
    return;
  }
  const byDifficulty = new Map();
  for (const e of entries) {
    if (!byDifficulty.has(e.difficultySlug)) byDifficulty.set(e.difficultySlug, []);
    byDifficulty.get(e.difficultySlug).push(e);
  }
  const lines = ["📖 Общая библиотека:"];
  for (const [difficulty, topics] of byDifficulty) {
    lines.push(`\n${difficulty}:`);
    for (const t of topics) lines.push(`  • ${t.topicSlug} — ${t.count} слов`);
  }
  await tg("sendMessage", { chat_id: chatId, text: lines.join("\n") });
}

// Только для админов: показывает весь словарь конкретного другого чата —
// сгруппированный по темам (сначала общие слова, потом по каждой теме),
// разбитый на несколько сообщений, если не влезает в одно (лимит Telegram —
// 4096 символов на сообщение, берём запас поменьше).
async function handleViewVocab(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const targetRaw = argText.trim();
  if (!targetRaw) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /viewvocab @username (или chat_id)" });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /students).` });
    return;
  }
  const vocab = await getVocab(targetId);
  if (!vocab.length) {
    await tg("sendMessage", { chat_id: chatId, text: `У ${targetRaw} словарь сейчас пуст.` });
    return;
  }

  const byTopic = new Map();
  for (const w of vocab) {
    const key = w.topic || GENERAL_TOPIC;
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(w);
  }
  const orderedKeys = [...byTopic.keys()].sort((a) => (a === GENERAL_TOPIC ? -1 : 1));

  const lines = [`📖 Словарь ${targetRaw} — всего ${vocab.length} слов:`, ""];
  for (const key of orderedKeys) {
    const words = byTopic.get(key);
    lines.push(`— ${topicLabel(key)} (${words.length}) —`);
    for (const w of words) lines.push(`${w.en} . ${w.ru}`);
    lines.push("");
  }

  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > 3500) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await tg("sendMessage", { chat_id: chatId, text: chunk });
  }
}


async function handleDelete(chatId, argText) {
  const lines = argText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Формат: /delete English word (или вставь сразу несколько строк, каждую с новой строки).",
    });
    return;
  }

  if (lines.length === 1) {
    const term = extractEnForDelete(lines[0]).toLowerCase();
    const { removed, total } = await deleteWord(chatId, term);
    if (!removed) {
      await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${lines[0]}» в словаре.` });
      return;
    }
    await tg("sendMessage", { chat_id: chatId, text: `Удалила «${lines[0]}». Осталось ${total} слов.` });
    return;
  }

  const terms = lines.map(extractEnForDelete).filter(Boolean);
  const { removedCount, total } = await deleteWords(chatId, terms);
  const notFound = terms.length - removedCount;
  let msg = `🗑 Удалено слов: ${removedCount}. Осталось в словаре: ${total}.`;
  if (notFound > 0) msg += `\nНе нашла: ${notFound}.`;
  await tg("sendMessage", { chat_id: chatId, text: msg });
}

// Любой не-командный текст (или явный /add) пытаемся распарсить как одну
// или несколько пар "слово - перевод" и добавить в словарь.
async function handleBulkAdd(chatId, text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  const badLines = [];

  // Необязательная "папка": если первая непустая строка — это #тема (и не
  // пара "слово - перевод"), все слова из этого сообщения попадают в эту
  // тему. Так ученик сам делит свои слова на группы (например, слова с
  // урока и #школа), не обращаясь к админу. Слова без #темы идут в "Общие".
  let topic = null;
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx !== -1) {
    const first = lines[firstIdx].trim();
    if (first.startsWith("#") && !parseVocabLine(first)) {
      const name = first.replace(/^#+/, "").trim().slice(0, 40);
      if (name) {
        // Если у ученика уже есть тема с таким названием (без учёта
        // регистра) — берём её написание, чтобы не плодить "Школа"/"школа".
        const existing = await getVocab(chatId);
        const match = existing.map((w) => w.topic).find((t) => t && t.toLowerCase() === name.toLowerCase());
        topic = match || name;
      }
      lines.splice(firstIdx, 1);
    }
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseVocabLine(line);
    if (parsed) {
      if (topic) parsed.topic = topic;
      pairs.push(parsed);
    } else badLines.push(line.trim());
  }

  if (!pairs.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        "Не нашла ни одной пары «слово - перевод». Формат: English . перевод " +
        "(можно вставить сразу много строк).",
    });
    return;
  }

  const { added, total } = await addWords(chatId, pairs);
  const skippedDupes = pairs.length - added;
  let msg = `✅ Добавлено новых слов: ${added}. Всего в словаре: ${total}.`;
  if (topic) msg += `\n📁 Папка: ${topic}.`;
  if (skippedDupes) msg += `\nПропущено как дубли: ${skippedDupes}.`;
  if (badLines.length) {
    msg += `\nНе распознано строк: ${badLines.length}${badLines.length <= 5 ? " — " + badLines.join(" | ") : ""}.`;
  }
  await tg("sendMessage", { chat_id: chatId, text: msg, reply_markup: await mainReplyKeyboard(chatId) });
}
// запроса (например, из-за повторной доставки Telegram или очень быстрого
// повторного нажатия) придут почти одновременно, обработает его только тот,
// кто успеет записать consumed:true первым — второй получит null и не будет
// засчитывать ответ повторно.
//
// Также проверяет, что нажатие пришло именно с того сообщения, к которому
// относится текущий вопрос — если пользователь проскроллил историю и ткнул
// кнопку у старого (уже неактуального) вопроса, это не должно попасть в
// текущий счёт.
async function claimPending(chatId, messageId) {
  const store = pendingStore();
  const key = String(chatId);
  const existing = await store.getWithMetadata(key, { type: "json" });
  if (!existing || !existing.data || existing.data.consumed) return null;
  if (existing.data.messageId != null && existing.data.messageId !== messageId) return null;
  try {
    await store.setJSON(key, { ...existing.data, consumed: true }, { onlyIfMatch: existing.etag });
    return existing.data;
  } catch (err) {
    return null;
  }
}

async function handleCallback(callbackQuery) {
  // Отвечаем на нажатие СРАЗУ, первым делом — до любых обращений к Blobs и
  // Telegram API. Раньше это делалось в конце, и на холодном старте функции
  // вся цепочка (чтение/запись состояния, отправка сообщений) иногда не
  // укладывалась в то время, что Telegram ждёт ответ по кнопке — отсюда
  // бесконечные "часики" на первом нажатии (второе срабатывало, потому что
  // функция была уже "прогрета"). Информативный текст (✅/❌ и перевод) всё
  // равно приходит в отредактированном сообщении ниже, поэтому в самом тосте
  // текст не дублируем.
  await log("[callback] received", JSON.stringify({ id: callbackQuery.id, data: callbackQuery.data, hasMessage: !!callbackQuery.message }));
  await tg("answerCallbackQuery", { callback_query_id: callbackQuery.id });
  await log("[callback] step1: answerCallbackQuery done");

  if (!callbackQuery.message) {
    await log("[callback] no message on callback_query — stopping (old/inline message)");
    return;
  }

  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;

  const gateIdentity = await identityStore().get(String(chatId), { type: "json" });
  if (gateIdentity && gateIdentity.approved === false && !gateIdentity.phrasesAccess && !(await isAdmin(chatId))) {
    await log("[callback] blocked: chat not yet approved", chatId);
    return;
  }

  // Пробный доступ (phrasesAccess, но не approved): "150 американских
  // фраз" разрешены всегда, а после истечения TRIAL_DAYS всё остальное
  // (общая библиотека помимо фраз, личный словарь, грамматика,
  // неправильные глаголы) — блокируется этим списком колбэков.
  const TRIAL_GATED_CALLBACKS = ["mode:grammar", "mode:irregular", "vsource:personal", "vsource:shared"];
  if (
    gateIdentity &&
    gateIdentity.phrasesAccess &&
    !gateIdentity.approved &&
    !(await isAdmin(chatId)) &&
    TRIAL_GATED_CALLBACKS.includes(data) &&
    isTrialExpired(gateIdentity)
  ) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Пробный период на 5 дней закончился. «150 американских фраз» остаются доступны бесплатно — а чтобы открыть всё остальное, напиши своему преподавателю.",
    });
    return;
  }

  if (data.startsWith("dash:")) {
    await handleDashboardCallback(chatId, messageId, data);
    return;
  }

  if (data === "start") {
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats);
    return;
  }

  if (data === "mode:vocab") {
    await handleModeVocab(chatId);
    return;
  }

  if (data.startsWith("vtopic:")) {
    const sel = data.slice(7);
    const vocab = await getVocab(chatId);
    const topics = getDistinctTopics(vocab);
    const topic = sel === "all" ? null : topics[parseInt(sel, 10)] || null;
    const label = `📚 Режим: Лексика — ${topic ? topicLabel(topic) : "все темы"}`;
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, label, "vocab", undefined, undefined, topic, null);
    return;
  }

  if (data === "vsource:personal") {
    await handleModeVocabPersonal(chatId);
    return;
  }

  if (data === "vsource:idioms") {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "💬 150 американских фраз — какой формат?",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔤 Перевод", callback_data: "idiomformat:translate" }],
          [{ text: "💬 Диалог", callback_data: "idiomformat:dialogue" }],
        ],
      },
    });
    return;
  }

  if (data === "idiomformat:translate") {
    const picked = buildIdiomTranslatePicked("🔤 Режим: 150 американских фраз — перевод", null);
    if (picked) await deliverQuestion(chatId, picked);
    return;
  }

  if (data === "idiomformat:dialogue") {
    const picked = buildDialoguePicked("💬 Режим: 150 американских фраз — диалог", null);
    if (picked) await deliverQuestion(chatId, picked);
    return;
  }

  if (data === "vsource:shared") {
    const entries = await listSharedLibrary();
    const difficulties = [...new Set(entries.map((e) => e.difficultySlug))];
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Общая библиотека — какая сложность?",
      reply_markup: {
        inline_keyboard: difficulties.map((d, i) => [{ text: d, callback_data: `vshareddiff:${i}` }]),
      },
    });
    return;
  }

  if (data.startsWith("vshareddiff:")) {
    const diffIdx = parseInt(data.slice(12), 10);
    const entries = await listSharedLibrary();
    const difficulties = [...new Set(entries.map((e) => e.difficultySlug))];
    const difficulty = difficulties[diffIdx];
    if (!difficulty) return;
    const topicsForDifficulty = entries.filter((e) => e.difficultySlug === difficulty);
    await tg("sendMessage", {
      chat_id: chatId,
      text: `${difficulty} — какая тема?`,
      reply_markup: {
        inline_keyboard: topicsForDifficulty.map((t, i) => [{ text: `${t.topicSlug} (${t.count})`, callback_data: `vsharedtopic:${diffIdx}:${i}` }]),
      },
    });
    return;
  }

  if (data.startsWith("vsharedtopic:")) {
    const [, diffIdxStr, topicIdxStr] = data.split(":");
    const diffIdx = parseInt(diffIdxStr, 10);
    const topicIdx = parseInt(topicIdxStr, 10);
    const entries = await listSharedLibrary();
    const difficulties = [...new Set(entries.map((e) => e.difficultySlug))];
    const difficulty = difficulties[diffIdx];
    if (!difficulty) return;
    const topicsForDifficulty = entries.filter((e) => e.difficultySlug === difficulty);
    const chosen = topicsForDifficulty[topicIdx];
    if (!chosen) return;
    const label = `📖 Общая библиотека — ${difficulty} — ${chosen.topicSlug}`;
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, label, "vocab", undefined, undefined, null, {
      difficulty: chosen.difficultySlug,
      topic: chosen.topicSlug,
    });
    return;
  }

  if (data === "mode:grammar") {
    await handleModeGrammar(chatId);
    return;
  }

  if (data === "mode:irregular") {
    await handleModeIrregular(chatId);
    return;
  }

  if (data === "ilevel:a" || data === "ilevel:b" || data === "ilevel:c") {
    const level = data.slice(7);
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Уровень ${IRREGULAR_LEVEL_LABELS[level]} — какой формат тренировки?`,
      reply_markup: {
        inline_keyboard: Object.entries(IRREGULAR_EXERCISE_TYPES).map(([key, label]) => [
          { text: label, callback_data: `itype:${level}:${key}` },
        ]),
      },
    });
    return;
  }

  if (data.startsWith("itype:")) {
    const [, level, exerciseType] = data.split(":");
    const label = `🔄 Неправильные глаголы — ${IRREGULAR_LEVEL_LABELS[level]} — ${IRREGULAR_EXERCISE_TYPES[exerciseType] || exerciseType}`;
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, label, "irregular", level, exerciseType);
    return;
  }

  if (data.startsWith("gtype:")) {
    const exerciseType = data.slice(6);
    const label = `📝 Режим: Грамматика — ${GRAMMAR_EXERCISE_TYPES[exerciseType] || exerciseType}`;
    const stats = await getStats(chatId);
    await sendQuestion(chatId, stats, label, "grammar", undefined, exerciseType);
    return;
  }

  if (!data || !data.startsWith("a:")) {
    await log("[callback] unrecognized data, stopping:", data);
    return;
  }
  const chosenIdx = parseInt(data.slice(2), 10);

  const pending = await claimPending(chatId, messageId);
  await log("[callback] step2: claimPending result:", JSON.stringify(pending));
  if (!pending) {
    await log("[callback] could not claim pending (stale/duplicate) — stopping here");
    return;
  }

  const isCorrect = chosenIdx === pending.correctPos;
  await log(`[callback] step3: word="${pending.correctEn}" chosenIdx=${chosenIdx} correctPos=${pending.correctPos} isCorrect=${isCorrect}`);

  const mode = ["grammar", "irregular", "dialogue", "idiomtranslate"].includes(pending.mode) ? pending.mode : "vocab";

  if (mode !== "dialogue" && mode !== "idiomtranslate") {
    const trialIdentity = await identityStore().get(String(chatId), { type: "json" });
    if (trialIdentity && trialIdentity.phrasesAccess && !trialIdentity.approved && !(await isAdmin(chatId)) && isTrialExpired(trialIdentity)) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Пробный период на 5 дней закончился. «150 американских фраз» остаются доступны бесплатно — а чтобы открыть всё остальное, напиши своему преподавателю.",
      });
      return;
    }
  }

  const fullVocab =
    mode === "vocab" ? (pending.shared ? await getSharedVocab(pending.shared.difficulty, pending.shared.topic) : await getVocab(chatId)) : null;
  const vocab = mode === "vocab" ? (pending.shared ? fullVocab : filterByTopic(fullVocab, pending.topic || null)) : null;
  const seenEnList = Array.isArray(pending.seenEn) ? pending.seenEn : [];
  const recentTailList = Array.isArray(pending.recentTail) ? pending.recentTail : [];
  let picked = null;
  let statsAfter = null;

  await withOptimisticUpdate(statsStore(), String(chatId), emptyStats, (current) => {
    const s = { ...current, wrong: { ...current.wrong }, daily: { ...(current.daily || {}) } };
    s.answered += 1;
    const today = new Date().toISOString().slice(0, 10);
    s.daily[today] = (s.daily[today] || 0) + 1;
    // Храним только последние 30 дней — этого достаточно для "сегодня"/"за
    // неделю" в дашборде, а запись не растёт бесконечно.
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const day of Object.keys(s.daily)) {
      if (day < cutoff) delete s.daily[day];
    }
    if (isCorrect) {
      s.correct += 1;
      s.streak += 1;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      delete s.wrong[pending.correctEn];
    } else {
      s.streak = 0;
      s.wrong[pending.correctEn] = (s.wrong[pending.correctEn] || 0) + 1;
    }

    const statsSuffix = mode === "vocab" ? `\n\n${statsLine(seenEnList.length, vocab.length)}` : "";
    const resultText = `${isCorrect ? "✅" : "❌"} *${mdEscape(pending.correctEn)}* — ${mdEscape(pending.correctRu)}${statsSuffix}`;

    if (mode === "grammar") {
      picked = buildGrammarPicked(resultText, pending.correctEn, pending.exerciseType || "tenses");
    } else if (mode === "irregular") {
      picked = buildIrregularPicked(resultText, pending.correctEn, pending.level || "a", pending.exerciseType || "triplet");
    } else if (mode === "dialogue") {
      picked = buildDialoguePicked(resultText, pending.correctEn);
    } else if (mode === "idiomtranslate") {
      picked = buildIdiomTranslatePicked(resultText, pending.correctEn);
    } else if (vocab.length) {
      picked = buildQuestion(vocab, s.wrong, resultText, pending.correctEn, seenEnList, recentTailList);
      picked.topic = pending.topic || null;
      picked.shared = pending.shared || null;
    }

    statsAfter = s;
    return s;
  });
  await log("[callback] step4: stats+next-question picked in one transaction:", JSON.stringify(statsAfter));

  if (picked) {
    await deliverQuestion(chatId, picked);
  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Словарь сейчас пуст. Вставь сюда слова в формате «English . перевод», и я начну спрашивать.",
    });
  }
  await log("[callback] step5: question delivered — handling complete");
}

// Шлёт сообщение всем, кто сейчас является админом (см. /claimadmin) — на
// данный момент используется только для уведомлений о новых пользователях.
async function notifyAdmins(text) {
  try {
    const ids = await adminStore().list();
    const entries = ids && ids.blobs ? ids.blobs : [];
    for (const entry of entries) {
      await tg("sendMessage", { chat_id: entry.key, text });
    }
  } catch (err) {
    // не критично — отсутствие уведомления не должно ронять бота
  }
}

// Доступ по приглашению: новые чаты создаются с approved: false (см.
// rememberIdentity) — эти три команды дают админу управлять этим.
async function handleApprove(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const targetRaw = argText.trim();
  if (!targetRaw) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /approve @username (или chat_id) — см. /pending" });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}» — проверь @username или chat_id (см. /pending или /students).` });
    return;
  }
  await updateIdentity(targetId, (current) => ({ ...current, approved: true }));
  await tg("sendMessage", { chat_id: chatId, text: `✅ Доступ разрешён для ${targetRaw}.` });
  try {
    await tg("sendMessage", { chat_id: targetId, text: "✅ Тебе открыт доступ к боту! Нажми /start, чтобы начать." });
  } catch (err) {
    // не критично — если у бота нет возможности написать первым (человек ещё не открывал чат), ничего страшного
  }
}

async function handleRevoke(chatId, argText) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const targetRaw = argText.trim();
  if (!targetRaw) {
    await tg("sendMessage", { chat_id: chatId, text: "Формат: /revoke @username (или chat_id)" });
    return;
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    await tg("sendMessage", { chat_id: chatId, text: `Не нашла «${targetRaw}».` });
    return;
  }
  await updateIdentity(targetId, (current) => ({ ...current, approved: false }));
  await tg("sendMessage", { chat_id: chatId, text: `🚫 Доступ закрыт для ${targetRaw}.` });
}

async function handlePending(chatId) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
    return;
  }
  const list = await identityStore().list();
  const entries = list && list.blobs ? list.blobs : [];
  const pending = [];
  for (const entry of entries) {
    const info = await identityStore().get(entry.key, { type: "json" });
    if (info && info.approved === false) {
      const name = [info.firstName, info.lastName].filter(Boolean).join(" ") || "без имени";
      const uname = info.username ? ` (@${info.username})` : "";
      pending.push(`• ${name}${uname} — chat_id ${entry.key}`);
    }
  }
  if (!pending.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Никто не ждёт одобрения." });
    return;
  }
  await tg("sendMessage", { chat_id: chatId, text: `⏳ Ждут доступа:\n${pending.join("\n")}\n\nОдобрить: /approve @username (или chat_id)` });
}

async function buildActivityReport() {
  const list = await identityStore().list();
  const entries = list && list.blobs ? list.blobs : [];
  const rows = [];
  const today = new Date().toISOString().slice(0, 10);
  const last7Days = [];
  for (let i = 0; i < 7; i++) {
    last7Days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  for (const entry of entries) {
    const info = await identityStore().get(entry.key, { type: "json" });
    if (!info || info.approved === false) continue;
    const stats = await getStats(entry.key);
    const name = info.registeredName || [info.firstName, info.lastName].filter(Boolean).join(" ") || "без имени";
    const uname = info.username ? ` (@${info.username})` : "";
    const daysActive = Array.isArray(info.activeDays) ? info.activeDays.length : info.lastSeen ? 1 : 0;
    const lastSeenDate = info.lastSeen ? info.lastSeen.slice(0, 10) : "\u2014";
    const daily = stats.daily || {};
    const todayCount = daily[today] || 0;
    const weekCount = last7Days.reduce((sum, day) => sum + (daily[day] || 0), 0);
    rows.push({
      chatId: entry.key,
      name,
      uname,
      daysActive,
      answered: stats.answered || 0,
      todayCount,
      weekCount,
      lastSeenDate,
      lastSeenTs: info.lastSeen || "",
    });
  }
  rows.sort((a, b) => (a.lastSeenTs < b.lastSeenTs ? 1 : a.lastSeenTs > b.lastSeenTs ? -1 : 0));
  return rows;
}

function dashboardMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "\ud83d\udc65 \u0423\u0447\u0435\u043d\u0438\u043a\u0438", callback_data: "dash:students" },
        { text: "\ud83d\udcc8 \u0410\u043a\u0442\u0438\u0432\u043d\u043e\u0441\u0442\u044c", callback_data: "dash:activity" },
      ],
      [
        { text: "\ud83d\udcd6 \u041e\u0431\u0449\u0430\u044f \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0430", callback_data: "dash:library" },
        { text: "\ud83d\udcda \u041b\u0438\u0447\u043d\u044b\u0435 \u0441\u043b\u043e\u0432\u0430\u0440\u0438", callback_data: "dash:personal" },
      ],
    ],
  };
}

async function handleDashboard(chatId) {
  if (!(await isAdmin(chatId))) {
    await tg("sendMessage", { chat_id: chatId, text: "\u042d\u0442\u0430 \u043a\u043e\u043c\u0430\u043d\u0434\u0430 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430." });
    return;
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: "\ud83d\udcca \u041f\u0430\u043d\u0435\u043b\u044c \u0443\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u044f \u0431\u043e\u0442\u043e\u043c\n\n\u0412\u044b\u0431\u0435\u0440\u0438 \u0440\u0430\u0437\u0434\u0435\u043b:",
    reply_markup: dashboardMainKeyboard(),
  });
}

async function handleDashboardCallback(chatId, messageId, data) {
  if (!(await isAdmin(chatId))) return;

  if (data === "dash:main") {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "\ud83d\udcca \u041f\u0430\u043d\u0435\u043b\u044c \u0443\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u044f \u0431\u043e\u0442\u043e\u043c\n\n\u0412\u044b\u0431\u0435\u0440\u0438 \u0440\u0430\u0437\u0434\u0435\u043b:",
      reply_markup: dashboardMainKeyboard(),
    });
    return;
  }

  if (data === "dash:students") {
    const ids = await identityStore().list();
    const entries = ids && ids.blobs ? ids.blobs : [];
    const lines = [];
    for (const entry of entries) {
      const info = await identityStore().get(entry.key, { type: "json" });
      if (info && info.approved === false) continue;
      const vocab = await getVocab(entry.key);
      const name = (info && info.registeredName) || (info ? [info.firstName, info.lastName].filter(Boolean).join(" ") : "");
      const uname = info && info.username ? ` (@${info.username})` : "";
      lines.push(`\u2022 ${name || "\u0431\u0435\u0437 \u0438\u043c\u0435\u043d\u0438"}${uname} \u2014 ${vocab.length} \u0441\u043b\u043e\u0432`);
    }
    const text = lines.length ? `\ud83d\udc65 \u0423\u0447\u0435\u043d\u0438\u043a\u0438 (${lines.length}):\n\n${lines.join("\n")}` : "\u041f\u043e\u043a\u0430 \u043d\u0438\u043a\u0442\u043e \u043d\u0435 \u043f\u0438\u0441\u0430\u043b \u0431\u043e\u0442\u0443.";
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: {
        inline_keyboard: [[{ text: "\u23f3 \u0416\u0434\u0443\u0442 \u043e\u0434\u043e\u0431\u0440\u0435\u043d\u0438\u044f", callback_data: "dash:pending" }], [{ text: "\u25c0\ufe0f \u041d\u0430\u0437\u0430\u0434", callback_data: "dash:main" }]],
      },
    });
    return;
  }

  if (data === "dash:pending") {
    const list = await identityStore().list();
    const entries = list && list.blobs ? list.blobs : [];
    const pending = [];
    for (const entry of entries) {
      const info = await identityStore().get(entry.key, { type: "json" });
      if (info && info.approved === false) {
        const name = [info.firstName, info.lastName].filter(Boolean).join(" ") || "\u0431\u0435\u0437 \u0438\u043c\u0435\u043d\u0438";
        const uname = info.username ? ` (@${info.username})` : "";
        pending.push(`\u2022 ${name}${uname} \u2014 chat_id ${entry.key}`);
      }
    }
    const text = pending.length
      ? `\u23f3 \u0416\u0434\u0443\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0430:\n\n${pending.join("\n")}\n\n\u041e\u0434\u043e\u0431\u0440\u0438\u0442\u044c: /approve @username\n\u0417\u0430\u043a\u0440\u044b\u0442\u044c \u0434\u043e\u0441\u0442\u0443\u043f: /revoke @username`
      : "\u041d\u0438\u043a\u0442\u043e \u043d\u0435 \u0436\u0434\u0451\u0442 \u043e\u0434\u043e\u0431\u0440\u0435\u043d\u0438\u044f.";
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: [[{ text: "\u25c0\ufe0f \u041d\u0430\u0437\u0430\u0434", callback_data: "dash:students" }]] },
    });
    return;
  }

  if (data === "dash:activity") {
    const rows = await buildActivityReport();
    const lines = rows.map(
      (r) =>
        `• ${r.name}${r.uname} — сегодня: ${r.todayCount}, за неделю: ${r.weekCount}, всего: ${r.answered}, дней занятий: ${r.daysActive}, посл. раз: ${r.lastSeenDate}`
    );
    const text = lines.length ? `📈 Активность учеников:\n\n${lines.join("\n")}` : "Пока нет данных об активности.";
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: [[{ text: "◀️ Назад", callback_data: "dash:main" }]] },
    });
    return;
  }

  if (data === "dash:library") {
    const entries = await listSharedLibrary();
    let text;
    if (!entries.length) {
      text = "\ud83d\udcd6 \u041e\u0431\u0449\u0430\u044f \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0430 \u043f\u043e\u043a\u0430 \u043f\u0443\u0441\u0442\u0430\u044f.\n\n\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c: /addshared <\u0441\u043b\u043e\u0436\u043d\u043e\u0441\u0442\u044c> #<\u0442\u0435\u043c\u0430>";
    } else {
      const byDifficulty = new Map();
      for (const e of entries) {
        if (!byDifficulty.has(e.difficultySlug)) byDifficulty.set(e.difficultySlug, []);
        byDifficulty.get(e.difficultySlug).push(e);
      }
      const lines = ["\ud83d\udcd6 \u041e\u0431\u0449\u0430\u044f \u0431\u0438\u0431\u043b\u0438\u043e\u0442\u0435\u043a\u0430:"];
      for (const [difficulty, topics] of byDifficulty) {
        lines.push(`\n${difficulty}:`);
        for (const t of topics) lines.push(`  \u2022 ${t.topicSlug} \u2014 ${t.count} \u0441\u043b\u043e\u0432`);
      }
      lines.push("\n\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c: /addshared <\u0441\u043b\u043e\u0436\u043d\u043e\u0441\u0442\u044c> #<\u0442\u0435\u043c\u0430>\n\u0423\u0434\u0430\u043b\u0438\u0442\u044c: /deleteshared <\u0441\u043b\u043e\u0436\u043d\u043e\u0441\u0442\u044c> #<\u0442\u0435\u043c\u0430>");
      text = lines.join("\n");
    }
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: [[{ text: "\u25c0\ufe0f \u041d\u0430\u0437\u0430\u0434", callback_data: "dash:main" }]] },
    });
    return;
  }

  if (data === "dash:personal") {
    const text =
      "\ud83d\udcda \u041b\u0438\u0447\u043d\u044b\u0435 \u0441\u043b\u043e\u0432\u0430\u0440\u0438 \u0443\u0447\u0435\u043d\u0438\u043a\u043e\u0432 \u2014 \u043a\u043e\u043c\u0430\u043d\u0434\u044b:\n\n" +
      "/addto @user [#\u0442\u0435\u043c\u0430] + \u0441\u043b\u043e\u0432\u0430 \u2014 \u0434\u043e\u0431\u0430\u0432\u0438\u0442\u044c\n" +
      "/viewvocab @user \u2014 \u043f\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u0442\u044c \u0432\u0435\u0441\u044c \u0441\u043b\u043e\u0432\u0430\u0440\u044c\n" +
      "/deletefrom @user + \u0441\u043f\u0438\u0441\u043e\u043a \u0441\u043b\u043e\u0432 \u2014 \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u043a\u043e\u043d\u043a\u0440\u0435\u0442\u043d\u044b\u0435\n" +
      "/clearvocab <chat_id> \u2014 \u0441\u0442\u0435\u0440\u0435\u0442\u044c \u0432\u0441\u0451\n" +
      "/removedefault @user \u2014 \u0443\u0431\u0440\u0430\u0442\u044c \u0441\u0442\u0430\u0440\u044b\u0439 \u0441\u0442\u0430\u0440\u0442\u043e\u0432\u044b\u0439 \u0441\u043f\u0438\u0441\u043e\u043a";
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: [[{ text: "\u25c0\ufe0f \u041d\u0430\u0437\u0430\u0434", callback_data: "dash:main" }]] },
    });
    return;
  }
}

// Напоминания о практике: если человек не появлялся дольше REMIND_AFTER_MS
// (и мы не напоминали ему за последние REMIND_MIN_GAP_MS, чтобы не слать
// каждый день подряд одному и тому же), присылаем ему короткий пинг.
// Каждый может отключить это себе командой /reminders off.
const REMIND_AFTER_MS = 2 * 24 * 60 * 60 * 1000; // 2 дня без активности
const REMIND_MIN_GAP_MS = 3 * 24 * 60 * 60 * 1000; // не чаще раза в 3 дня

async function sendReminders() {
  const ids = await identityStore().list();
  const entries = ids && ids.blobs ? ids.blobs : [];
  const now = Date.now();
  let sentCount = 0;
  for (const entry of entries) {
    const info = await identityStore().get(entry.key, { type: "json" });
    if (!info) continue;
    if (info.remindersEnabled === false) continue;

    const lastSeenMs = info.lastSeen ? new Date(info.lastSeen).getTime() : 0;
    if (!lastSeenMs || now - lastSeenMs < REMIND_AFTER_MS) continue;

    const lastReminderMs = info.lastReminderSent ? new Date(info.lastReminderSent).getTime() : 0;
    if (lastReminderMs && now - lastReminderMs < REMIND_MIN_GAP_MS) continue;

    const chatId = entry.key;
    try {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "👋 Давно не виделись! Может, немного попрактикуемся? Жми /start или любую кнопку внизу.\n\n(Не хочешь получать напоминания — напиши /reminders off.)",
      });
      sentCount += 1;
      await updateIdentity(chatId, (current) => ({ ...current, lastReminderSent: new Date().toISOString() }));
    } catch (err) {
      // не критично — пропускаем этого человека (например, заблокировал бота) и идём дальше
    }
  }
  return sentCount;
}

async function handleReminders(chatId, argText) {
  const arg = argText.trim().toLowerCase();
  if (arg === "off") {
    await updateIdentity(chatId, (current) => ({ ...current, remindersEnabled: false }));
    await tg("sendMessage", { chat_id: chatId, text: "Хорошо, напоминания о практике отключены. Включить обратно — /reminders on." });
    return;
  }
  if (arg === "on") {
    await updateIdentity(chatId, (current) => ({ ...current, remindersEnabled: true }));
    await tg("sendMessage", { chat_id: chatId, text: "Готово, буду иногда напоминать о практике, если долго не будет активности." });
    return;
  }
  const identity = await identityStore().get(String(chatId), { type: "json" });
  const enabled = !identity || identity.remindersEnabled !== false;
  await tg("sendMessage", {
    chat_id: chatId,
    text: `Напоминания сейчас ${enabled ? "включены" : "выключены"}.\n/reminders on — включить\n/reminders off — выключить`,
  });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  const existingIdentity = await identityStore().get(String(chatId), { type: "json" });
  const isBrandNewChat = !existingIdentity;
  await rememberIdentity(chatId, message.from);

  if (isBrandNewChat) {
    const from = message.from || {};
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "без имени";
    const uname = from.username ? ` (@${from.username})` : "";
    await notifyAdmins(`👋 Новый пользователь бота: ${name}${uname}, chat_id ${chatId}`);
  }

  // Доступ по приглашению: новые чаты (approved === false) не пускаем
  // дальше ни к каким командам, кроме /whoami, /claimadmin и двух
  // пригласительных ссылок:
  // /start <INVITE_SECRET> — полный доступ сразу, как обычный ученик.
  // /start <PHRASES_INVITE_SECRET> — НЕ делает approved: true, а даёт
  // postoянный бесплатный доступ именно к "150 американских фраз" плюс
  // TRIAL_DAYS дней пробного доступа ко всему остальному (см.
  // isTrialExpired — используется в конкретных пунктах меню ниже).
  const gateIdentity = await identityStore().get(String(chatId), { type: "json" });
  const startInviteMatch = text.match(/^\/start\s+(\S+)/);
  if (startInviteMatch && startInviteMatch[1] === INVITE_SECRET) {
    await updateIdentity(chatId, (current) => ({ ...current, approved: true }));
  } else if (startInviteMatch && startInviteMatch[1] === PHRASES_INVITE_SECRET) {
    await updateIdentity(chatId, (current) => ({
      ...current,
      phrasesAccess: true,
      trialStartedAt: current.trialStartedAt || new Date().toISOString(),
    }));
  } else if (gateIdentity && gateIdentity.approved === false && !gateIdentity.phrasesAccess && !(await isAdmin(chatId))) {
    if (text === "/whoami") {
      await tg("sendMessage", { chat_id: chatId, text: `Твой chat_id: ${chatId}` });
      return;
    }
    if (/^\/claimadmin(@\w+)?\s*/i.test(text)) {
      // не блокируем — сама команда сама проверит секрет
    } else {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `Доступ к этому боту открывается только по приглашению. Отправь этот номер своему преподавателю: ${chatId}`,
      });
      return;
    }
  }

  // Если человек только что написал /register без текста — бот ждёт от
  // него имя следующим сообщением. Перехватываем это здесь, раньше любых
  // других команд/разбора слов.
  const identity = await identityStore().get(String(chatId), { type: "json" });
  if (identity && identity.awaitingRegisterName) {
    if (!text) {
      await tg("sendMessage", { chat_id: chatId, text: "Напиши, пожалуйста, своё имя текстом." });
      return;
    }
    await updateIdentity(chatId, (current) => ({ ...current, registeredName: text, awaitingRegisterName: false }));
    await tg("sendMessage", { chat_id: chatId, text: `Спасибо, ${text}! Записала.` });
    return;
  }

  if (text === "/start" || /^\/start\s+\S+/.test(text)) return handleStart(chatId);
  if (text === BTN_VOCAB) return handleModeVocab(chatId);
  if (text === BTN_IRREGULAR) return handleModeIrregular(chatId);
  if (text === BTN_GRAMMAR) return handleModeGrammar(chatId);
  if (text === "/mode") return handleMode(chatId);
  if (text === "/hidemenu" || text === BTN_HIDE) return handleHideMenu(chatId);
  if (text === "/showmenu") return handleShowMenu(chatId);
  if (text === "/whoami") {
    await tg("sendMessage", { chat_id: chatId, text: `Твой chat_id: ${chatId}` });
    return;
  }
  if (/^\/reminders(@\w+)?\s*/i.test(text)) {
    return handleReminders(chatId, text.replace(/^\/reminders(@\w+)?\s*/i, ""));
  }
  if (/^\/claimadmin(@\w+)?\s*/i.test(text)) {
    const provided = text.replace(/^\/claimadmin(@\w+)?\s*/i, "").trim();
    if (!provided || provided !== CLAIM_ADMIN_SECRET) {
      await tg("sendMessage", { chat_id: chatId, text: "Неверный секрет." });
      return;
    }
    await adminStore().setJSON(String(chatId), { grantedAt: new Date().toISOString() });
    await updateIdentity(chatId, (current) => ({ ...current, approved: true }));
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Готово — теперь тебе доступна команда /students.",
      reply_markup: await mainReplyKeyboard(chatId),
    });
    return;
  }
  if (/^\/register(@\w+)?\s*/i.test(text)) {
    const label = text.replace(/^\/register(@\w+)?\s*/i, "").trim();
    if (!label) {
      await updateIdentity(chatId, (current) => ({ ...current, awaitingRegisterName: true }));
      await tg("sendMessage", { chat_id: chatId, text: "Как тебя записать? Напиши своё имя следующим сообщением." });
      return;
    }
    await updateIdentity(chatId, (current) => ({ ...current, registeredName: label, awaitingRegisterName: false }));
    await tg("sendMessage", { chat_id: chatId, text: `Готово, записала: ${label}` });
    return;
  }
  if (/^\/approve(@\w+)?\s*/i.test(text)) {
    return handleApprove(chatId, text.replace(/^\/approve(@\w+)?\s*/i, ""));
  }
  if (/^\/revoke(@\w+)?\s*/i.test(text)) {
    return handleRevoke(chatId, text.replace(/^\/revoke(@\w+)?\s*/i, ""));
  }
  if (text === "/pending") return handlePending(chatId);
  if (text === "/dashboard" || text === "/admin") return handleDashboard(chatId);
  if (text === "/students") {
    if (!(await isAdmin(chatId))) {
      await tg("sendMessage", { chat_id: chatId, text: "Эта команда недоступна." });
      return;
    }
    const ids = await identityStore().list();
    const entries = ids && ids.blobs ? ids.blobs : [];
    const lines = [];
    let shownCount = 0;
    for (const entry of entries) {
      const info = await identityStore().get(entry.key, { type: "json" });
      if (info && info.approved === false) continue;
      const studentChatId = entry.key;
      const vocab = await getVocab(studentChatId);
      const name = (info && info.registeredName) || (info ? [info.firstName, info.lastName].filter(Boolean).join(" ") : "");
      const uname = info && info.username ? ` (@${info.username})` : "";
      lines.push(`• ${name || "без имени"}${uname} — ${vocab.length} слов, chat_id ${studentChatId}`);
      shownCount += 1;
    }
    if (!shownCount) {
      await tg("sendMessage", { chat_id: chatId, text: "Пока никто не писал боту." });
      return;
    }
    await tg("sendMessage", { chat_id: chatId, text: `Ученики (${shownCount}):\n${lines.join("\n")}` });
    return;
  }
  if (text === "/play" || text === "/next") {
    const stats = await getStats(chatId);
    return sendQuestion(chatId, stats);
  }
  if (text === "/score" || text === "/stats") return handleScore(chatId);
  if (text === "/reset") return handleReset(chatId);
  if (text === "/count") return handleCount(chatId);
  if (text === "/migrate") return handleMigrate(chatId);
  if (/^\/clearvocab(@\w+)?\s*/i.test(text)) {
    return handleClearVocab(chatId, text.replace(/^\/clearvocab(@\w+)?\s*/i, ""));
  }
  if (/^\/removedefault(@\w+)?\s*/i.test(text)) {
    return handleRemoveDefault(chatId, text.replace(/^\/removedefault(@\w+)?\s*/i, ""));
  }
  if (/^\/addto(@\w+)?\s*/i.test(text)) {
    return handleAddTo(chatId, text.replace(/^\/addto(@\w+)?\s*/i, ""));
  }
  if (/^\/settopic(@\w+)?\s*/i.test(text)) {
    return handleSetTopic(chatId, text.replace(/^\/settopic(@\w+)?\s*/i, ""));
  }
  if (/^\/deletefrom(@\w+)?\s*/i.test(text)) {
    return handleDeleteFrom(chatId, text.replace(/^\/deletefrom(@\w+)?\s*/i, ""));
  }
  if (/^\/addshared(@\w+)?\s*/i.test(text)) {
    return handleAddShared(chatId, text.replace(/^\/addshared(@\w+)?\s*/i, ""));
  }
  if (/^\/deleteshared(@\w+)?\s*/i.test(text)) {
    return handleDeleteShared(chatId, text.replace(/^\/deleteshared(@\w+)?\s*/i, ""));
  }
  if (text === "/sharedlist") return handleSharedList(chatId);
  if (/^\/viewvocab(@\w+)?\s*/i.test(text)) {
    return handleViewVocab(chatId, text.replace(/^\/viewvocab(@\w+)?\s*/i, ""));
  }
  if (text === "/help") return handleHelp(chatId);
  if (/^\/delete(@\w+)?\s*/i.test(text)) {
    return handleDelete(chatId, text.replace(/^\/delete(@\w+)?\s*/i, ""));
  }
  if (/^\/add(@\w+)?\s*/i.test(text)) {
    return handleBulkAdd(chatId, text.replace(/^\/add(@\w+)?\s*/i, ""));
  }
  if (text.startsWith("/")) {
    return tg("sendMessage", { chat_id: chatId, text: "Не знаю такую команду. /help — список команд." });
  }

  // любой обычный текст — пробуем разобрать как новые слова
  return handleBulkAdd(chatId, text);
}

const seenUpdatesStore = () => getStore("vocab-bot-seen-updates", { consistency: "strong" });

// Telegram может доставить один и тот же update дважды (например, если наш
// ответ пришёл чуть медленнее обычного). Помечаем update_id как обработанный
// атомарно (onlyIfNew) — если это уже второй раз, просто ничего не делаем
// повторно, вместо того чтобы второй раз слать вопрос/команду.
async function claimUpdateOnce(updateId) {
  if (updateId == null) return true; // нет update_id — не с чем сверяться, работаем как обычно
  try {
    await seenUpdatesStore().set(String(updateId), "1", { onlyIfNew: true });
    return true;
  } catch (err) {
    return false; // уже видели этот update — это повторная доставка
  }
}

// Обрабатывает запрос от /admin.html — тот же смысл, что у /addto в
// Telegram, но по HTTP и в JSON, чтобы страница могла вызвать это через
// fetch(). Проверка — тем же секретом, что и /claimadmin.
async function handleAdminApi(body) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (body.adminSecret !== CLAIM_ADMIN_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "Неверный секрет." }), { status: 403, headers });
  }

  const targetRaw = (body.target || "").trim();
  if (!targetRaw) {
    return new Response(JSON.stringify({ ok: false, error: "Не указан получатель." }), { status: 400, headers });
  }
  const targetId = await resolveTarget(targetRaw);
  if (!targetId) {
    return new Response(JSON.stringify({ ok: false, error: `Не нашла «${targetRaw}» — проверь @username или chat_id.` }), {
      status: 404,
      headers,
    });
  }

  const wordsText = body.words || "";
  const lines = wordsText.split(/\r?\n/);
  const pairs = [];
  for (const line of lines) {
    const parsed = parseVocabLine(line);
    if (parsed) pairs.push(parsed);
  }
  if (!pairs.length) {
    return new Response(JSON.stringify({ ok: false, error: "Не нашла ни одной пары «слово - перевод»." }), { status: 400, headers });
  }

  const { added, total } = await addWords(targetId, pairs);
  return new Response(
    JSON.stringify({ ok: true, added, total, skippedDupes: pairs.length - added, resolvedTarget: targetId }),
    { status: 200, headers }
  );
}

export default async (req) => {
  if (req.method !== "POST") {
    // GET ?debug=<секрет> — отдаёт последние записи собственного журнала
    // отладки, независимо от того, работает ли сейчас просмотр логов в
    // самой панели Netlify.
    if (req.method === "GET" && WEBHOOK_SECRET) {
      const url = new URL(req.url);
      if (url.searchParams.get("debug") === WEBHOOK_SECRET) {
        const entries = await debugStore().get("log", { type: "json" });
        return new Response(JSON.stringify(entries || [], null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      // GET ?remind=<секрет> — запускается по расписанию (см.
      // .github/workflows/remind.yml) раз в день, шлёт напоминания тем, кто
      // давно не появлялся.
      if (url.searchParams.get("remind") === WEBHOOK_SECRET) {
        const count = await sendReminders();
        return new Response(JSON.stringify({ ok: true, remindersSent: count }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      // GET ?seedshared=<секрет> — единоразовая автозагрузка стартового
      // набора общей библиотеки (см. SEED_SHARED_LIBRARY выше).
      // Срабатывает автоматически после деплоя (см.
      // .github/workflows/seed-shared-library.yml) — вручную вызывать не
      // нужно. Безопасно вызывать повторно: дубли просто пропускаются.
      if (url.searchParams.get("seedshared") === WEBHOOK_SECRET) {
        const result = await seedSharedLibraryOnce();
        return new Response(JSON.stringify({ ok: true, ...result }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      // GET ?export=<секрет>&target=<@username или chat_id> — отдаёт
      // словарь конкретного человека как JSON. Тот же секрет, что у
      // /claimadmin. Существует, чтобы можно было прислать эту ссылку
      // прямо в чат с Клодом — он получит данные без переписки через бота.
      if (url.searchParams.get("export") === CLAIM_ADMIN_SECRET) {
        const targetRaw = url.searchParams.get("target");
        if (!targetRaw) {
          return new Response(JSON.stringify({ ok: false, error: "Не указан target." }), {
            status: 400,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        const targetId = await resolveTarget(targetRaw);
        if (!targetId) {
          return new Response(JSON.stringify({ ok: false, error: `Не нашла «${targetRaw}».` }), {
            status: 404,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        const vocab = await getVocab(targetId);
        return new Response(JSON.stringify({ ok: true, target: targetRaw, chatId: targetId, count: vocab.length, vocab }, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }
    return new Response("ok", { status: 200 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Отдельный "административный" HTTP API — НЕ от Telegram, а от статической
  // страницы /admin.html: позволяет добавлять слова в чей-то словарь прямо
  // с сайта, без переписки в Telegram. Отличается от настоящих апдейтов
  // Telegram наличием поля adminSecret (у Telegram такого поля не бывает).
  if (body && body.adminSecret !== undefined) {
    return handleAdminApi(body);
  }

  if (WEBHOOK_SECRET) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
  }

  const isFirstTimeSeeingThisUpdate = await claimUpdateOnce(body.update_id);
  if (!isFirstTimeSeeingThisUpdate) {
    // Повторная доставка того же update — уже обработали, просто отвечаем ok.
    return new Response("ok", { status: 200 });
  }

  try {
    if (body.callback_query) {
      await handleCallback(body.callback_query);
    } else if (body.message) {
      await handleMessage(body.message);
    }
  } catch (err) {
    await log("[handler] UNCAUGHT ERROR:", String(err), err && err.stack);
  }

  // Telegram ждёт быстрый ответ 200 — иначе будет слать вебхук повторно
  return new Response("ok", { status: 200 });
};

export const config = { path: "/telegram-webhook" };
