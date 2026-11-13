// Проверка интерактивных заданий по правилам скилов Марго
// (tense-exercise-validator, eng-exercise-builder, plan-a1-c1).
// Запуск: node scripts/lint-drills.mjs [путь к папке тем]   (по умолчанию data/course/topics)
// Печатает отчет; код выхода 1, если найдены ошибки класса A (брак конвертера).
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTopicDrills, htmlToText, parseKey, IRREG } from "../netlify/lib/drill-builder.mjs";
const PP = new Set(Object.values(IRREG).flat());
const ADJ = new Set(["open", "close", "clean", "clear", "free", "live", "warm", "cool", "dry", "empty", "busy", "ready", "fine", "quiet", "right", "wrong", "complete", "correct", "present", "perfect"]);

const here = dirname(fileURLToPath(import.meta.url));
const DIR = process.argv[2] || join(here, "..", "data", "course", "topics");
const strip = (h) => htmlToText(h);
const low = (s) => String(s || "").toLowerCase().replace(/[.!?;:,]+$/g, "").replace(/\s+/g, " ").trim();

// Проверки из tense-exercise-validator (Check 2)
const BAD_GRAMMAR = [
  [/\bin the at\b|\bon in\b|\bat the in\b/i, "двойной предлог"],
  [/\bfor to [a-z]+/i, "for to + глагол"],
  [/\barrive(s|d)? to\b/i, "arrive to → arrive at/in"],
  [/\bdepend(s|ed|ing)? of\b/i, "depend of → depend on"],
  [/\bdiscuss(es|ed|ing)? about\b/i, "discuss about → discuss"],
  [/\bmarried with\b/i, "married with → married to"],
  [/\blisten(s|ed|ing)? (the|a|my|your|his|her)\b/i, "listen без to"],
  [/\breturn(s|ed|ing)? back\b|\brevert(s|ed|ing)? back\b/i, "return back — лишнее back"],
  [/\b(are is|is are|was were|do does|has have)\b/i, "два вспомогательных подряд"],
  [/\b(can|could|will|would|should|must|might|may) [a-z]+s\b(?<!\b(?:was|is|has|does|goes|this|his|its|hers|ours|yours|theirs|us|less|unless|across|focus|process|access|address|business|success|class|pass|miss|guess|discuss|express|stress|cross|press|kiss|toss|boss|bus|gas|plus|yes|always|perhaps|series|news|means|lens))/i, "модальный + форма с -s"],
  [/\bsaid (that )?(he|she|they|I|we) will\b/i, "said ... will (без сдвига)"],
  [/\bwould [a-z]+ed\b(?<!\bwould (?:need|feed|bleed|speed|seed|proceed|succeed|exceed|breed|shed|wed|bed))/i, "would + -ed"],
];
const RU = /[а-яё]/i;

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
const A = []; // брак конвертера — чинить обязательно
const B = []; // вопросы к содержанию в Notion — решает Марго
const total = { items: 0, choice: 0, build: 0, type: 0, recall: 0, whole: 0, mismatch: 0 };
const yo = new Set();
for (const f of files) {
  const topic = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  const { drills, stats } = buildTopicDrills(topic);
  for (const k in total) total[k] += stats[k] || 0;
  const where = (d) => `${topic.level} «${topic.title}» упр.${d.ex} п.${d.i + 1}`;
  if (stats.mismatch) B.push(`${topic.level} «${topic.title}»: в ${stats.mismatch} упр. число заданий и ответов не совпадает`);
  const seenQ = new Map();
  for (const d of drills) {
    const qt = strip(d.q);
    if (/ё/i.test(qt + strip(d.key))) yo.add(`${topic.level} «${topic.title}»`);
    // дубли внутри темы (разрешены только в «финальных тестах», где Марго повторяет пункты намеренно)
    // тот же пункт с тем же ответом (одно предложение в разных заданиях — «сделай отрицание» / «сделай вопрос» — не повтор)
    const sig = qt + " ⇒ " + low(strip(d.key));
    if (qt.length > 12 && seenQ.has(sig) && !/тест|бонус/i.test(d.task)) B.push(`${where(d)}: тот же пункт, что и ${seenQ.get(sig)}: «${qt.slice(0, 60)}»`);
    seenQ.set(sig, `упр.${d.ex} п.${d.i + 1}`);
    if (d.type === "choice") {
      const opts = d.options || [];
      if (opts.length < 2) A.push(`${where(d)}: меньше двух вариантов`);
      if (d.correct == null || d.correct < 0 || d.correct >= opts.length) A.push(`${where(d)}: нет правильного варианта`);
      if (new Set(opts.map((o) => o.toLowerCase().trim())).size !== opts.length) A.push(`${where(d)}: повторяющиеся варианты [${opts.join(" / ")}]`);
      if (d.src !== "legend" && opts.some((o) => RU.test(o.replace(/без артикля|ничего не нужно/g, "")))) A.push(`${where(d)}: русский текст в варианте [${opts.join(" / ")}]`);
      if (d.src === "gen") {
        const key = parseKey(d.key);
        const ok = new Set([key.main, ...(key.alts || []), ...String(key.main || "").split(/\s*\/\s*/)].map(low));
        for (const w of opts.filter((_, i) => i !== d.correct)) {
          if (ok.has(low(w))) A.push(`${where(d)}: неверный вариант «${w}» указан в ключе как допустимый`);
          const pm = w.toLowerCase().match(/^(am|is|are|was|were|been|being|be)( not|n't)? ([a-z]+)$/);
          if (pm && (PP.has(pm[3]) || /ed$/.test(pm[3]) || ADJ.has(pm[3]))) A.push(`${where(d)}: «${w}» может быть грамматичным (пассив или прилагательное)`);
          if (/^did [a-z]+$/i.test(w) && !/ed$/.test(w)) {
            // did + базовая форма — эмфатическая, грамматичная
            const v = w.split(" ")[1]; if (!/^(went|came|saw|bought|took|made|gave|wrote|ate|drank|got|knew|said|told|found|left|met|ran|sat|spoke|swam|taught|won|began|slept|felt|forgot|sent|spent|paid|brought|caught|flew|drove|broke|chose|wore|lost|heard|kept|built|thought|understood|became|fell|grew|drew|threw|rode|rose|sang|rang|stood|sold|held|led|meant|woke|showed|stole|tore|fed|fought|lent|dug|bit|hid|froze|blew|shook|stuck|struck|hung|dealt|laid|sought|bent|swept|withdrew|overcame|undertook|arose|beat|shot|sank)$/i.test(v)) A.push(`${where(d)}: «${w}» — эмфатическое did, это не ошибка`);
          }
        }
        if (key.both) A.push(`${where(d)}: в ключе «оба варианта», а варианты сгенерированы`);
      }
      // грамматика правильного предложения: подставляем верный вариант вместо пропуска / группы «(a / b)»
      let full = null;
      if (d.mode === "fix") full = opts[d.correct];
      else if (d.src === "alt") full = qt.replace(/\(([^()]*\/[^()]*)\)/, opts[d.correct]).replace(/…/, "");
      else if (/…/.test(qt)) full = qt.replace(/…/, opts[d.correct] || "");
      if (full) for (const [rx, why] of BAD_GRAMMAR) if (rx.test(full) && !RU.test(full.match(rx)[0])) B.push(`${where(d)}: ${why}: «${full.slice(0, 80)}»`);
    }
    if (d.type === "build") {
      const body = (d.tiles || []).join(" ");
      const nd = (x) => low(x).replace(/[—–.!?]/g, " ").replace(/\s+/g, " ").trim();
      if (nd(body + (d.end || "")) !== nd(d.answer)) A.push(`${where(d)}: плитки не складываются в ответ («${body}» ≠ «${d.answer}»)`);
      if (RU.test(d.answer)) A.push(`${where(d)}: русский текст в ответе «${d.answer}»`);
      const tl = new Set((d.tiles || []).map((t) => t.toLowerCase().replace(/[,;:]$/, "")));
      for (const t of d.traps || []) if (tl.has(t.toLowerCase())) A.push(`${where(d)}: ловушка «${t}» есть в ответе`);
      if ((d.tiles || []).length > 18) A.push(`${where(d)}: слишком длинно для сборки (${d.tiles.length} слов)`);
      if (d.mode !== "fill" && /\b(\w+)\s+\1\b/i.test(d.answer) && !/\b(\w+)\s+\1\b/i.test(qt + " " + strip(d.key))) A.push(`${where(d)}: повтор слова в ответе «${d.answer}»`);
      for (const [rx, why] of BAD_GRAMMAR) if (rx.test(d.answer)) B.push(`${where(d)}: ${why}: «${d.answer}»`);
    }
  }
}

const pct = (n) => Math.round((n / total.items) * 100);
console.log(`=== ПРОВЕРКА ЗАДАНИЙ ===`);
console.log(`Тем: ${files.length}. Пунктов: ${total.items}. Выбор: ${total.choice} (${pct(total.choice)}%). Сборка: ${total.build} (${pct(total.build)}%). Впиши: ${total.type} (${pct(total.type)}%). Вспомни: ${total.recall} (${pct(total.recall)}%). Упражнений целиком: ${total.whole}.`);
console.log(`\n[A] Брак конвертера: ${A.length}`);
for (const x of A.slice(0, 60)) console.log("  - " + x);
if (A.length > 60) console.log(`  … и еще ${A.length - 60}`);
console.log(`\n[B] Вопросы к содержанию в Notion (решает Марго): ${B.length}`);
for (const x of B) console.log("  - " + x);
console.log(`\n[ё] Темы, где в тексте есть «ё»: ${yo.size}${yo.size ? " — " + [...yo].join("; ") : ""}`);
process.exit(A.length ? 1 : 0);
