// Пересборка контента из Notion без кода (Netlify background function, до 15 минут).
// Запускается из кабинета учителя (telegram-webhook → contentRebuild) и пишет результат в Blobs
// `vocab-bot-course`, откуда бот и приложение читают его вместо встроенного бандла.
//
// Режимы (body.mode):
//   course      — курс A0–C1 из страниц Notion. Уровни обрабатываются по одному за вызов
//                 (body.levels = очередь кодов), после уровня функция вызывает сама себя
//                 со следующим — так укладываемся в лимит времени. Ключи:
//                 course:level:<code>, course:topic:<id>, course:index, course:meta.
//   grammar     — задания at/in/on, условные, герундий из базы Notion → grammar:items.
//   seedGrammar — один раз создать эту базу в Notion под корневой страницей курса
//                 и залить в неё встроенные задания (чтобы не набирать руками) → grammar:dbId.
//
// Нужны переменные окружения: NOTION_TOKEN (интеграция Notion, которой расшарена страница курса),
// TELEGRAM_WEBHOOK_SECRET (защита от чужих вызовов). Необязательно: NOTION_COURSE_ROOT (id корневой
// страницы плана; по умолчанию «Твой путь в английский»), NOTION_GRAMMAR_DB (id базы заданий).
import { getStore } from "@netlify/blobs";
import { buildLevel, assembleIndex, parseLevelPage, blocksToMarkdown } from "../lib/course-builder.mjs";
import { PREP_ITEMS_A, PREP_ITEMS_B, COND_ITEMS, GERUND_PREP_ITEMS } from "../../data/grammar-extra.mjs";
import BUNDLED_INDEX from "../../data/course/index.mjs";

const store = () => getStore("vocab-bot-course", { consistency: "strong" });
const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const DEFAULT_ROOT = "34c2f2f8690d814e82e8fb81e078333e";
// Бизнес-версия плана («для работы») — отдельное дерево страниц, пишется в biz:* (переменная NOTION_BUSINESS_ROOT — необязательно)
const DEFAULT_BIZ_ROOT = "4022f2f8690d8143b223fce9744efecb";
const PFX = (track) => (track === "business" ? "biz" : "course");
export const GRAMMAR_TYPES = [
  ["prepA", "at/in/on — до B1", PREP_ITEMS_A],
  ["prepB", "at/in/on — B1+ и бизнес", PREP_ITEMS_B],
  ["condB1", "Условные — B1+", COND_ITEMS],
  ["gerundPrep", "Герундий и инфинитив — до B1", GERUND_PREP_ITEMS],
];
const STATUS_KEY = "rebuild:status";

// ---------- Notion API с ограничением скорости и повторами ----------
let lastCall = 0;
async function notion(path, { method = "GET", body } = {}, attempt = 0) {
  const gap = 340 - (Date.now() - lastCall); if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  lastCall = Date.now();
  const r = await fetch(NOTION + path, { method, headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": NOTION_VERSION, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 429 || r.status >= 500) {
    if (attempt >= 5) throw new Error(`Notion ${r.status} после 5 попыток: ${path}`);
    const wait = Number(r.headers.get("retry-after") || 0) * 1000 || 1500 * (attempt + 1);
    await new Promise((res) => setTimeout(res, wait));
    return notion(path, { method, body }, attempt + 1);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Notion ${r.status}: ${data.message || data.code || path}`);
  return data;
}
async function allChildren(blockId) {
  const out = []; let cursor;
  do {
    const d = await notion(`/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...(d.results || [])); cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return out;
}
// Дерево блоков страницы: во вложенные блоки спускаемся, в дочерние страницы/базы — нет.
async function blockTree(blockId, depth = 0) {
  const blocks = await allChildren(blockId);
  for (const b of blocks) {
    if (b.has_children && b.type !== "child_page" && b.type !== "child_database" && depth < 8) b.children = await blockTree(b.id, depth + 1);
  }
  return blocks;
}
function pageTitle(page) {
  const props = page.properties || {};
  const tp = Object.values(props).find((p) => p && p.type === "title");
  const title = tp && tp.title ? tp.title.map((r) => r.plain_text).join("") : "";
  const emoji = page.icon && page.icon.type === "emoji" ? page.icon.emoji : "";
  return { title: title.trim(), emoji };
}
const nid = (id) => String(id || "").replace(/-/g, "");

async function setStatus(patch) {
  const cur = (await store().get(STATUS_KEY, { type: "json" })) || {};
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await store().setJSON(STATUS_KEY, next);
  return next;
}
async function appendLog(line) {
  const cur = (await store().get(STATUS_KEY, { type: "json" })) || {};
  const log = [...(cur.log || []), `${new Date().toISOString().slice(11, 19)} ${line}`].slice(-60);
  await store().setJSON(STATUS_KEY, { ...cur, log, updatedAt: new Date().toISOString() });
}

// ---------- курс ----------
async function discoverLevels(rootId) {
  const blocks = await allChildren(rootId);
  const levels = [];
  for (const b of blocks) {
    if (b.type !== "child_page") continue;
    const title = (b.child_page && b.child_page.title) || "";
    const m = title.match(/^\s*([ABC][0-2])\s*[—–-]/);
    if (m) levels.push({ code: m[1], id: nid(b.id), title: title.trim() });
  }
  // fallback: ссылки link_to_page на страницы уровней
  if (!levels.length) for (const b of blocks) if (b.type === "link_to_page" && b.link_to_page.page_id) { const p = await notion(`/pages/${b.link_to_page.page_id}`); const { title } = pageTitle(p); const m = title.match(/^\s*([ABC][0-2])\s*[—–-]/); if (m) levels.push({ code: m[1], id: nid(p.id), title }); }
  const order = ["A0", "A1", "A2", "B1", "B2", "C1"];
  levels.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
  return levels;
}
async function rebuildLevel(levelRef) {
  const page = await notion(`/pages/${levelRef.id}`);
  const { title, emoji } = pageTitle(page);
  const tree = await blockTree(levelRef.id);
  // названия дочерних страниц — для ссылок в markdown
  const titles = new Map();
  const childPages = [];
  const walk = (bs) => { for (const b of bs) { if (b.type === "child_page") { titles.set(nid(b.id), { title: b.child_page.title, emoji: "" }); childPages.push({ id: nid(b.id), title: b.child_page.title }); } if (b.children) walk(b.children); } };
  walk(tree);
  const md = blocksToMarkdown(tree, titles);
  const parsed = parseLevelPage(md);
  const topics = parsed.topics;
  const known = new Set(topics.map((t) => t.id));
  // дочерние страницы уровня, не попавшие в нумерованный список: мосты и экзамены
  let n = topics.length;
  for (const cp of childPages) {
    if (known.has(cp.id)) continue;
    const t = cp.title || "";
    if (/Мост/i.test(t)) { n += 1; topics.push({ n, id: cp.id, emoji: "", title: t, description: "", contains: "", kind: "bridge" }); }
    else if (/Экзамен|чекпоинт|Checkpoint|\(1\)$/i.test(t)) { n += 1; topics.push({ n, id: cp.id, emoji: "", title: t, description: "", contains: "", kind: "other" }); }
    // прочие подстраницы (словарь, заметки) в курс не берём
  }
  const bodies = new Map();
  for (const t of topics) {
    if (/\(1\)$/.test(t.title)) continue; // скрытые дубликаты — не тратим запросы
    const p = await notion(`/pages/${t.id}`);
    const pt = pageTitle(p);
    if (pt.title) t.title = pt.title;
    if (pt.emoji) t.emoji = pt.emoji;
    const tTree = await blockTree(t.id);
    const tt = new Map(); const w2 = (bs) => { for (const b of bs) { if (b.type === "child_page") tt.set(nid(b.id), { title: b.child_page.title, emoji: "" }); if (b.children) w2(b.children); } }; w2(tTree);
    bodies.set(t.id, blocksToMarkdown(tTree, tt));
  }
  const lv = { code: levelRef.code, title: title || levelRef.title, emoji, intro: parsed.intro, checkpoint: parsed.checkpoint, topics };
  const built = buildLevel(lv, bodies);
  // качество: тема без разделов — подозрительно
  for (const [id, tp] of built.topics) if (!tp.sections.length && tp.kind === "topic") built.log.push(`тема «${tp.title}» без разделов (## …) — проверь структуру страницы`);
  return built;
}
// Сквозные бизнес-блоки: дочерние страницы корня бизнес-плана, кроме страниц уровней → «уровень» BIZ
async function discoverBlocks(rootId) {
  const blocks = await allChildren(rootId);
  return blocks.filter((b) => b.type === "child_page").map((b) => ({ id: nid(b.id), title: ((b.child_page && b.child_page.title) || "").trim() }))
    .filter((p) => p.title && !/^\s*[ABC][0-2]\s*[—–-]/.test(p.title) && !/\(1\)$/.test(p.title));
}
async function rebuildBlocks(rootId) {
  const pages = await discoverBlocks(rootId);
  const topics = []; const bodies = new Map();
  for (const [i, cp] of pages.entries()) {
    const p = await notion(`/pages/${cp.id}`);
    const pt = pageTitle(p);
    let title = pt.title || cp.title; let emoji = pt.emoji || "";
    const em = title.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+/u);
    if (em) { emoji = emoji || em[1]; title = title.slice(em[0].length).trim(); }
    const tTree = await blockTree(cp.id);
    const tt = new Map(); const w2 = (bs) => { for (const b of bs) { if (b.type === "child_page") tt.set(nid(b.id), { title: b.child_page.title, emoji: "" }); if (b.children) w2(b.children); } }; w2(tTree);
    bodies.set(cp.id, blocksToMarkdown(tTree, tt));
    topics.push({ n: i + 1, id: cp.id, emoji, title, description: "", contains: "", kind: "topic", category: "business" });
  }
  return buildLevel({ code: "BIZ", title: "Бизнес-блоки", emoji: "💼", intro: "Их не нужно проходить по порядку — открывай тот, который нужен на этой неделе.", checkpoint: [], topics }, bodies);
}
async function writeLevel(built, track) {
  for (const [id, tp] of built.topics) await store().setJSON(`${PFX(track)}:topic:${id}`, tp);
  await store().setJSON(`${PFX(track)}:level:${built.record.code}`, built.record);
}
async function publishIndex(bundledIndex, track) {
  const pfx = PFX(track);
  // собираем индекс из уровней в Blobs; для уровней, которых там нет, берём встроенные
  const codes = ["A0", "A1", "A2", "B1", "B2", "C1", ...(track === "business" ? ["BIZ"] : [])];
  const records = []; const sources = {};
  for (const c of codes) {
    const rec = await store().get(`${pfx}:level:${c}`, { type: "json" });
    if (rec && Array.isArray(rec.topics)) { records.push(rec); sources[c] = "notion"; }
    else if (track !== "business") { const b = bundledIndex && bundledIndex.levels.find((l) => l.code === c); if (b) { records.push(JSON.parse(JSON.stringify(b))); sources[c] = "bundle"; } }
  }
  const index = assembleIndex(records, new Date().toISOString().slice(0, 10));
  await store().setJSON(`${pfx}:index`, index);
  await store().setJSON(`${pfx}:meta`, { builtAt: new Date().toISOString(), sources, topics: index.levels.reduce((a, l) => a + l.topics.length, 0) });
  return index;
}

async function runCourse(body) {
  const track = body.track === "business" ? "business" : "general";
  const rootId = track === "business" ? nid(process.env.NOTION_BUSINESS_ROOT || DEFAULT_BIZ_ROOT) : nid(process.env.NOTION_COURSE_ROOT || DEFAULT_ROOT);
  let queue = Array.isArray(body.levels) && body.levels.length ? body.levels : null;
  if (!queue) {
    await setStatus({ mode: track === "business" ? "bizCourse" : "course", status: "running", startedAt: new Date().toISOString(), finishedAt: null, by: body.by || null, log: [], done: [], failed: [], error: null });
    await appendLog("ищу страницы уровней в Notion…");
    const levels = await discoverLevels(rootId);
    if (!levels.length) throw new Error("не нашла страницы уровней (A0 — …, A1 — …) под корневой страницей. Проверь, что интеграции открыт доступ к странице плана.");
    await appendLog(`уровни: ${levels.map((l) => l.code).join(", ")}`);
    queue = levels.map((l) => `${l.code}:${l.id}`);
    if (track === "business") queue.push(`BIZ:${rootId}`);
    await setStatus({ total: queue.length, queue });
  }
  const [code, id] = queue[0].split(":");
  await appendLog(`уровень ${code}: читаю страницы…`);
  let failed = false;
  try {
    const built = code === "BIZ" ? await rebuildBlocks(id) : await rebuildLevel({ code, id });
    await writeLevel(built, track);
    for (const l of built.log) await appendLog(`${code}: ${l}`);
    await appendLog(`уровень ${code}: ${built.record.topics.length} тем записано`);
  } catch (e) {
    failed = true;
    await appendLog(`уровень ${code}: ошибка — ${String((e && e.message) || e)}. Этот уровень останется прежним, иду дальше.`);
  }
  const rest = queue.slice(1);
  const cur = (await store().get(STATUS_KEY, { type: "json" })) || {};
  await setStatus({ done: [...(cur.done || []), code], failed: [...(cur.failed || []), ...(failed ? [code] : [])], queue: rest });
  if (rest.length) {
    // следующий уровень — отдельным вызовом, чтобы не упереться в лимит времени
    await selfInvoke({ ...body, levels: rest });
    return;
  }
  await appendLog("собираю индекс курса…");
  const index = await publishIndex(BUNDLED_INDEX, track);
  const fin = (await store().get(STATUS_KEY, { type: "json" })) || {};
  const failedLevels = fin.failed || [];
  await setStatus({ status: failedLevels.length ? "warning" : "done", finishedAt: new Date().toISOString(), topics: index.levels.reduce((a, l) => a + l.topics.length, 0), error: failedLevels.length ? `не удалось обновить уровни: ${failedLevels.join(", ")} — для них оставлена прежняя версия` : null });
  await appendLog(`готово: ${index.levels.length} уровней, ${index.levels.reduce((a, l) => a + l.topics.length, 0)} тем${failedLevels.length ? ` (не обновились: ${failedLevels.join(", ")})` : ""}`);
}
async function selfInvoke(body) {
  const base = (process.env.URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("нет переменной URL — не могу продолжить следующим уровнем");
  const r = await fetch(`${base}/.netlify/functions/course-rebuild-background`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok && r.status !== 202) throw new Error(`не удалось запустить следующий уровень: ${r.status}`);
}

// ---------- грамматика ----------
const PROP = { title: "Предложение", type: "Тип", o1: "Вариант 1", o2: "Вариант 2", o3: "Вариант 3", correct: "Верный", explain: "Объяснение", active: "Активно" };
const txt = (p) => (p && (p.rich_text || p.title) ? (p.rich_text || p.title).map((r) => (r.plain_text != null ? r.plain_text : (r.text && r.text.content) || "")).join("").trim() : "");
async function grammarDbId() { return nid(process.env.NOTION_GRAMMAR_DB || (await store().get("grammar:dbId", { type: "json" })) || ""); }
async function runGrammar(body) {
  await setStatus({ mode: "grammar", status: "running", startedAt: new Date().toISOString(), finishedAt: null, by: body.by || null, log: [], error: null });
  const dbId = await grammarDbId();
  if (!dbId) throw new Error("базы заданий ещё нет — сначала нажми «Создать базу заданий в Notion»");
  await appendLog("читаю базу заданий…");
  const rows = []; let cursor;
  do { const d = await notion(`/databases/${dbId}/query`, { method: "POST", body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } }); rows.push(...(d.results || [])); cursor = d.has_more ? d.next_cursor : null; } while (cursor);
  const byLabel = Object.fromEntries(GRAMMAR_TYPES.map(([k, label]) => [label, k]));
  const items = Object.fromEntries(GRAMMAR_TYPES.map(([k]) => [k, []])); const skipped = [];
  for (const r of rows) {
    const p = r.properties || {};
    const template = txt(p[PROP.title]); const typeName = p[PROP.type] && p[PROP.type].select ? p[PROP.type].select.name : "";
    const key = byLabel[typeName] || GRAMMAR_TYPES.find(([k]) => k === typeName)?.[0];
    const options = [txt(p[PROP.o1]), txt(p[PROP.o2]), txt(p[PROP.o3])];
    const correct = p[PROP.correct] && typeof p[PROP.correct].number === "number" ? p[PROP.correct].number : null;
    const explain = txt(p[PROP.explain]);
    const active = p[PROP.active] && p[PROP.active].type === "checkbox" ? p[PROP.active].checkbox : true;
    if (!active) continue;
    const why = !key ? `неизвестный тип «${typeName}»` : !template.includes("___") ? "нет пропуска ___" : options.some((o) => !o) ? "не все 3 варианта" : !(correct >= 1 && correct <= 3) ? "«Верный» должен быть 1, 2 или 3" : null;
    if (why) { skipped.push(`«${template.slice(0, 50) || "(без текста)"}»: ${why}`); continue; }
    items[key].push({ template, options, correctIdx: correct - 1, explain });
  }
  const counts = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.length]));
  await store().setJSON("grammar:items", { ...items, builtAt: new Date().toISOString(), counts, skipped: skipped.slice(0, 50), dbId });
  for (const s of skipped.slice(0, 20)) await appendLog(`пропущено: ${s}`);
  await setStatus({ status: "done", finishedAt: new Date().toISOString(), counts });
  await appendLog(`готово: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}${skipped.length ? `, пропущено ${skipped.length}` : ""}`);
}
async function runSeedGrammar(body) {
  await setStatus({ mode: "seedGrammar", status: "running", startedAt: new Date().toISOString(), finishedAt: null, by: body.by || null, log: [], error: null });
  let dbId = await grammarDbId();
  if (dbId) { try { await notion(`/databases/${dbId}`); } catch (e) { dbId = ""; } }
  if (!dbId) {
    const rootId = nid(process.env.NOTION_COURSE_ROOT || DEFAULT_ROOT);
    await appendLog("создаю базу «Задания бота» под страницей курса…");
    const db = await notion("/databases", { method: "POST", body: {
      parent: { type: "page_id", page_id: rootId },
      icon: { type: "emoji", emoji: "🤖" },
      title: [{ type: "text", text: { content: "Задания бота — предлоги, условные, герундий" } }],
      description: [{ type: "text", text: { content: "Каждая строка — одно задание бота. В «Предложении» пропуск обозначай ___ (три подчёркивания). «Верный» — номер правильного варианта (1, 2 или 3). Сними галочку «Активно», чтобы задание не показывалось. После правок нажми в приложении «Пересобрать задания из Notion»." } }],
      properties: {
        [PROP.title]: { title: {} },
        [PROP.type]: { select: { options: GRAMMAR_TYPES.map(([, label], i) => ({ name: label, color: ["blue", "purple", "green", "orange"][i] })) } },
        [PROP.o1]: { rich_text: {} }, [PROP.o2]: { rich_text: {} }, [PROP.o3]: { rich_text: {} },
        [PROP.correct]: { number: { format: "number" } },
        [PROP.explain]: { rich_text: {} },
        [PROP.active]: { checkbox: {} },
      },
    } });
    dbId = nid(db.id);
    await store().setJSON("grammar:dbId", dbId);
    await appendLog(`база создана: ${db.url || dbId}`);
  } else await appendLog("база уже есть — добавляю недостающие задания");
  // что уже есть — не дублируем
  const existing = new Set(); let cursor;
  do { const d = await notion(`/databases/${dbId}/query`, { method: "POST", body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } }); for (const r of d.results || []) existing.add(txt((r.properties || {})[PROP.title])); cursor = d.has_more ? d.next_cursor : null; } while (cursor);
  let added = 0, total = 0;
  for (const [, label, list] of GRAMMAR_TYPES) {
    for (const it of list) {
      total += 1; if (existing.has(it.template)) continue;
      const rich = (s) => [{ type: "text", text: { content: String(s || "").slice(0, 1900) } }];
      await notion("/pages", { method: "POST", body: { parent: { database_id: dbId }, properties: {
        [PROP.title]: { title: rich(it.template) }, [PROP.type]: { select: { name: label } },
        [PROP.o1]: { rich_text: rich(it.options[0]) }, [PROP.o2]: { rich_text: rich(it.options[1]) }, [PROP.o3]: { rich_text: rich(it.options[2]) },
        [PROP.correct]: { number: it.correctIdx + 1 }, [PROP.explain]: { rich_text: rich(it.explain) }, [PROP.active]: { checkbox: true },
      } } });
      added += 1;
      if (added % 25 === 0) await appendLog(`добавлено ${added}…`);
    }
  }
  await setStatus({ status: "done", finishedAt: new Date().toISOString(), dbId, added, total });
  await appendLog(`готово: в базе ${total} заданий (добавлено ${added}). Редактируй в Notion, потом «Пересобрать задания из Notion».`);
}

export default async (req) => {
  let body = {};
  try { body = await req.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (secret && body.secret !== secret) return new Response("forbidden", { status: 403 });
  if (!process.env.NOTION_TOKEN) { await setStatus({ mode: body.mode, status: "error", error: "нет переменной NOTION_TOKEN в Netlify", finishedAt: new Date().toISOString() }); return new Response("no token", { status: 200 }); }
  try {
    if (body.mode === "course") await runCourse(body);
    else if (body.mode === "bizCourse") await runCourse({ ...body, track: "business" });
    else if (body.mode === "grammar") await runGrammar(body);
    else if (body.mode === "seedGrammar") await runSeedGrammar(body);
    else return new Response("bad mode", { status: 400 });
    return new Response("ok", { status: 200 });
  } catch (e) {
    const msg = String((e && e.message) || e);
    await setStatus({ status: "error", error: msg, finishedAt: new Date().toISOString() });
    await appendLog(`ошибка: ${msg}`);
    return new Response("error", { status: 200 });
  }
};
