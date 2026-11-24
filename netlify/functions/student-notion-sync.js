// Задания учеников из Notion обновляются сами: раз в час (с 8 до 23 по Москве) эта функция
// находит всех учеников с привязанной страницей и ставит их в очередь фоновой функции
// course-rebuild-background (режим student). Та перечитывает только изменившиеся страницы.
// Привязки ставит только преподаватель; здесь ничего не привязывается и доступ не меняется.
// Отключить автообновление можно, удалив этот файл: кнопка «Обновить» в кабинете останется.
import { getStore } from "@netlify/blobs";

const store = () => getStore("vocab-bot-course", { consistency: "strong" });

export default async () => {
  const base = (process.env.URL || "").replace(/\/+$/, "");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  if (!base || !process.env.NOTION_TOKEN) { console.log("[student-notion-sync] нет URL или NOTION_TOKEN — пропуск"); return new Response("skip", { status: 200 }); }
  let keys = [];
  try { const r = await store().list({ prefix: "stu:" }); keys = (r.blobs || []).map((b) => b.key); } catch (e) { console.log("[student-notion-sync] list failed", String(e)); return new Response("list failed", { status: 200 }); }
  const queue = [];
  for (const k of keys) {
    const m = k.match(/^stu:(\d{1,20}):link$/); if (!m) continue;
    // уже читается (кнопка в кабинете или прошлый запуск) — не дублируем
    let st = null; try { st = await store().get(`stu:${m[1]}:status`, { type: "json" }); } catch (e) { st = null; }
    if (st && st.status === "running" && Date.now() - Date.parse(st.updatedAt || 0) < 10 * 60 * 1000) continue;
    queue.push(m[1]);
  }
  // отметка «я запускалась» — ее показывает команда /notion у преподавателя
  try { await store().setJSON("stusync:last", { at: new Date().toISOString(), linked: keys.filter((k) => /:link$/.test(k)).length, queued: queue.length }); } catch (e) {}
  if (!queue.length) { console.log("[student-notion-sync] привязанных учеников нет"); return new Response("empty", { status: 200 }); }
  try {
    const res = await fetch(`${base}/.netlify/functions/course-rebuild-background`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "student", chatId: queue[0], queue: queue.slice(1), secret, by: "schedule" }) });
    console.log(`[student-notion-sync] в очереди ${queue.length}, статус запуска ${res.status}`);
  } catch (e) { console.log("[student-notion-sync] start failed", String(e)); }
  return new Response("ok", { status: 200 });
};

// минуты 7 каждого часа с 05 до 20 UTC = с 08:07 до 23:07 по Москве
export const config = { schedule: "7 5-20 * * *" };
