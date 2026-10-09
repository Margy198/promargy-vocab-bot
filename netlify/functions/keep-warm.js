// «Будильник» против холодного старта. Netlify (как любой serverless) после
// нескольких минут тишины выгружает функцию, и первое нажатие после паузы
// ждёт 1–3 секунды, пока она запустится заново. Эта функция по расписанию
// раз в 5 минут делает пустой GET-запрос к вебхуку бота (он отвечает "ok",
// ничего не делая), чтобы основная функция оставалась «тёплой».
//
// Стоимость: ~8 600 вызовов в месяц — в пределах бесплатного лимита Netlify.
// Отключить можно, просто удалив этот файл.
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (!base) {
    console.log("[keep-warm] no site URL in env — skipping");
    return new Response("skip", { status: 200 });
  }
  const started = Date.now();
  try {
    const res = await fetch(`${base}/telegram-webhook`, { method: "GET" });
    console.log(`[keep-warm] ping status=${res.status} in ${Date.now() - started} ms`);
  } catch (err) {
    console.log("[keep-warm] ping failed:", String(err));
  }
  return new Response("ok", { status: 200 });
};

export const config = { schedule: "*/5 * * * *" };
