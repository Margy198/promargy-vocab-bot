#!/usr/bin/env python3
"""Собирает контент курса из выгрузки Notion (content-export/) в data/course/.

Вход:  <export>/index.json, <export>/topics/*.txt (сырые ответы Notion MCP, Notion-flavored Markdown)
Выход: data/course/index.json           — уровни и список тем (без контента)
       data/course/topics/<id>.json      — одна тема: intro, sections[] (html), exercises[], selfcheck[]

Запуск: python3 scripts/build-course.py /home/claude/content-export
"""
import json, re, sys, os, html

SRC = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/content-export"
DST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "course")
os.makedirs(os.path.join(DST, "topics"), exist_ok=True)

# ---------- inline ----------
def inline(s):
    s = s.replace("\\~", "~").replace("\\_", "_").replace("\\*", "*").replace("\\[", "[").replace("\\]", "]")
    s = re.sub(r"<br\s*/?>", "<br>", s)
    # links [text](url) -> <a>
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", lambda m: '<a href="%s" target="_blank" rel="noopener">%s</a>' % (m.group(2), m.group(1)), s)
    # notion internal links -> plain text
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    # keep allowed tags, escape stray <
    s = re.sub(r"<(?!/?(b|i|code|br|a|s|u)\b)", "&lt;", s)
    return s

def strip_tags(s):
    return re.sub(r"<[^>]+>", "", s)

# ---------- block parser ----------
def parse_blocks(lines):
    """Превращает строки Notion-markdown в HTML. Обрабатывает toggle/callout/columns рекурсивно."""
    out = []; i = 0; n = len(lines)
    def flush_para(buf):
        if buf: out.append("<p>%s</p>" % inline(" ".join(buf)))
    para = []
    while i < n:
        ln = lines[i]; st = ln.strip()
        if not st:
            flush_para(para); para = []; i += 1; continue
        # block containers
        m = re.match(r"<toggle(?:\s+heading=\"(h\d)\")?>$", st)
        if m:
            flush_para(para); para = []
            depth = 1; j = i + 1; body = []
            while j < n:
                t = lines[j].strip()
                if t.startswith("<toggle"): depth += 1
                if t == "</toggle>":
                    depth -= 1
                    if depth == 0: break
                body.append(lines[j]); j += 1
            # first non-empty line = title
            k = 0
            while k < len(body) and not body[k].strip(): k += 1
            title = inline(body[k].strip()) if k < len(body) else ""
            inner = parse_blocks(body[k + 1:])
            out.append('<details class="tg"><summary>%s</summary><div class="tg-body">%s</div></details>' % (title, inner))
            i = j + 1; continue
        m = re.match(r"<callout(?:\s+icon=\"([^\"]*)\")?(?:\s+color=\"([^\"]*)\")?>$", st)
        if m:
            flush_para(para); para = []
            j = i + 1; body = []; depth = 1
            while j < n:
                t = lines[j].strip()
                if t.startswith("<callout"): depth += 1
                if t == "</callout>":
                    depth -= 1
                    if depth == 0: break
                body.append(lines[j]); j += 1
            icon = m.group(1) or ""
            if icon.startswith("/"): icon = ""
            out.append('<div class="callout">%s<div>%s</div></div>' % (('<span class="ico">%s</span>' % icon) if icon else "", parse_blocks(body)))
            i = j + 1; continue
        if st.startswith("<columns") or st.startswith("</columns") or st.startswith("<column") or st.startswith("</column"):
            flush_para(para); para = []; i += 1; continue
        if st.startswith("<page ") or st == "</page>" or st.startswith("<database") or st.startswith("<embed") or st.startswith("<p />") or st.startswith("<p/>"):
            flush_para(para); para = []
            # skip until closing for <page>
            if st.startswith("<page ") and not st.endswith("/>"):
                while i < n and lines[i].strip() != "</page>": i += 1
            i += 1; continue
        if st in ("---", "***"):
            flush_para(para); para = []; out.append("<hr>"); i += 1; continue
        m = re.match(r"^(#{1,6})\s+(.*)$", st)
        if m:
            flush_para(para); para = []
            lvl = min(6, len(m.group(1)) + 1)  # ## -> h3 inside the page, ### -> h4
            out.append("<h%d>%s</h%d>" % (lvl, inline(m.group(2)), lvl)); i += 1; continue
        if st.startswith(">"):
            flush_para(para); para = []
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip()[1:].strip()); i += 1
            out.append('<blockquote>%s</blockquote>' % inline(" ".join(buf))); continue
        if st.startswith("|"):
            flush_para(para); para = []
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")]); i += 1
            rows = [r for r in rows if not all(re.match(r"^:?-{2,}:?$", c) for c in r)]
            if rows:
                head = rows[0]; body = rows[1:]
                t = "<table><thead><tr>%s</tr></thead>" % "".join("<th>%s</th>" % inline(c) for c in head)
                t += "<tbody>%s</tbody></table>" % "".join("<tr>%s</tr>" % "".join("<td>%s</td>" % inline(c) for c in r) for r in body)
                out.append('<div class="tbl">%s</div>' % t)
            continue
        if re.match(r"^- \[[ xX]\]\s", st):
            flush_para(para); para = []
            items = []
            while i < n and re.match(r"^- \[[ xX]\]\s", lines[i].strip()):
                items.append(inline(lines[i].strip()[6:])); i += 1
            out.append('<ul class="check">%s</ul>' % "".join("<li>%s</li>" % x for x in items)); continue
        if re.match(r"^[-*•]\s", st):
            flush_para(para); para = []
            items = []
            while i < n and re.match(r"^[-*•]\s", lines[i].strip()):
                items.append(inline(lines[i].strip()[2:])); i += 1
            out.append("<ul>%s</ul>" % "".join("<li>%s</li>" % x for x in items)); continue
        if re.match(r"^\d+[.)]\s", st):
            flush_para(para); para = []
            items = []
            while i < n and re.match(r"^\d+[.)]\s", lines[i].strip()):
                items.append(inline(re.sub(r"^\d+[.)]\s", "", lines[i].strip()))); i += 1
            out.append("<ol>%s</ol>" % "".join("<li>%s</li>" % x for x in items)); continue
        if st.startswith("<table"):  # raw html table (rare)
            flush_para(para); para = []
            j = i
            while j < n and "</table>" not in lines[j]: j += 1
            out.append('<div class="tbl">%s</div>' % "\n".join(lines[i:j + 1])); i = j + 1; continue
        para.append(st); i += 1
    flush_para(para)
    return "".join(out)

# ---------- topic ----------
SECTION_KEYS = [
    ("why", r"Зачем эт"), ("theory", r"Теория"), ("native", r"Как это видит носитель"), ("narrative", r"Нарративные приемы"),
    ("examples", r"Примеры с разбором"), ("pitfalls", r"Подводные камни"), ("exercises", r"Упражнения"),
    ("extra", r"Дополнительные \d+ упражнени"), ("links", r"Дополнительная практика"), ("selfcheck", r"Самопроверка"),
]
def section_key(title):
    t = strip_tags(title)
    for k, rx in SECTION_KEYS:
        if re.search(rx, t): return k
    return "other"

def split_top(lines):
    """Делит тело страницы на разделы по '## ' вне toggle/callout."""
    sections = []; cur = {"title": "", "lines": []}; depth = 0
    for ln in lines:
        st = ln.strip()
        if st.startswith("<toggle") or st.startswith("<callout"): depth += 1
        elif st in ("</toggle>", "</callout>"): depth -= 1
        if depth == 0 and re.match(r"^## ", st):
            sections.append(cur); cur = {"title": st[3:].strip(), "lines": []}
        else: cur["lines"].append(ln)
    sections.append(cur)
    return sections

def unwrap_plain_toggles(lines):
    """Убирает обёртки <toggle> без heading (например «➕ Еще 25 упражнений»), оставляя содержимое."""
    out = []; stack = []  # stack: True если toggle «прозрачный»
    i = 0
    while i < len(lines):
        st = lines[i].strip()
        if st.startswith("<toggle"):
            plain = st == "<toggle>"
            if plain:
                k = i + 1
                while k < len(lines) and not lines[k].strip(): k += 1
                title = lines[k].strip() if k < len(lines) else ""
                if re.search(r"Ответ|ответ|Answer|Ключ|Решени|Вариант", title): plain = False
            stack.append(plain)
            if plain:
                i = k + 1  # пропускаем открывающий тег и заголовок
                continue
        elif st == "</toggle>":
            if stack and stack.pop(): i += 1; continue
        out.append(lines[i]); i += 1
    return out

def extract_answers(body):
    """Вытаскивает toggle-блоки с ответами; возвращает (остальные строки, html ответов)."""
    ans = ""; rest = []; j = 0
    while j < len(body):
        st = body[j].strip()
        if st.startswith("<toggle"):
            k = j + 1; d = 1; tb = []
            while k < len(body):
                t = body[k].strip()
                if t.startswith("<toggle"): d += 1
                if t == "</toggle>":
                    d -= 1
                    if d == 0: break
                tb.append(body[k]); k += 1
            first = next((x for x in tb if x.strip()), "")
            if re.search(r"Ответ|ответ|Answer|Ключ|Решени|Вариант", first):
                ans += parse_blocks(tb[tb.index(first) + 1:]) if first in tb else parse_blocks(tb)
            else:
                rest.extend(body[j:k + 1])
            j = k + 1; continue
        rest.append(body[j]); j += 1
    return rest, ans

def parse_exercises(lines, fallback_title=""):
    """### Упражнение N. ... + toggle с ответами → [{n, title, html, answers}]"""
    lines = unwrap_plain_toggles(lines)
    if not any(re.match(r"^### ", l.strip()) for l in lines):
        rest, ans = extract_answers(lines)
        html_ = parse_blocks(rest)
        return [{"n": 1, "title": inline(fallback_title), "html": html_, "answers": ans}] if strip_tags(html_).strip() else []
    ex = []; cur = None; depth = 0; buf = []
    def close():
        if cur is not None:
            rest, ans = extract_answers(buf[:])
            cur["html"] = parse_blocks(rest); cur["answers"] = ans; ex.append(cur)
    for ln in lines:
        st = ln.strip()
        m = re.match(r"^### (.*)$", st)
        if m and depth == 0:
            close(); buf = []
            title = m.group(1).strip()
            mm = re.match(r"Упражнение\s+(\d+)\.?\s*(.*)", strip_tags(title))
            cur = {"n": int(mm.group(1)) if mm else len(ex) + 1, "title": inline(mm.group(2) if mm else title)}
            continue
        if st.startswith("<toggle") or st.startswith("<callout"): depth += 1
        elif st in ("</toggle>", "</callout>"): depth -= 1
        if cur is not None: buf.append(ln)
    close()
    return ex

def parse_selfcheck(lines):
    items = [inline(l.strip()[6:]) for l in lines if re.match(r"^- \[[ xX]\]\s", l.strip())]
    rest = [l for l in lines if not re.match(r"^- \[[ xX]\]\s", l.strip())]
    return items, parse_blocks(rest)

def build_topic(meta):
    raw = json.loads(open(os.path.join(SRC, meta["file"])).read())
    text = raw["text"]
    body = text[text.find("<content>") + len("<content>"):text.rfind("</content>")]
    lines = body.split("\n")
    # intro: первый blockquote до первого '## '
    pre = []; k = 0
    while k < len(lines) and not re.match(r"^## ", lines[k].strip()):
        pre.append(lines[k]); k += 1
    pre = [l for l in pre if not re.match(r"^\[← ", l.strip()) and l.strip() not in ("---",)]
    intro = parse_blocks(pre)
    secs = split_top(lines[k:])
    sections = []; exercises = []; selfcheck = []; selfcheck_html = ""
    for s in secs:
        if not s["title"]: continue
        key = section_key(s["title"])
        title = inline(s["title"])
        if key in ("exercises", "extra"):
            has_h3 = any(re.match(r"^### ", l.strip()) for l in unwrap_plain_toggles(s["lines"]))
            exs = parse_exercises(s["lines"], strip_tags(s["title"]))
            if has_h3:
                lead = []
                for l in s["lines"]:
                    if re.match(r"^### ", l.strip()): break
                    lead.append(l)
                if key == "exercises" and strip_tags(parse_blocks(lead)).strip():
                    sections.append({"key": "exercises_intro", "title": title, "html": parse_blocks(lead)})
            exercises.extend(exs)
            continue
        if key == "selfcheck":
            selfcheck, selfcheck_html = parse_selfcheck(s["lines"]); continue
        sections.append({"key": key, "title": title, "html": parse_blocks(s["lines"])})
    # теория: разбить на подстраницы по h4 (### в исходнике)
    for s in sections:
        if s["key"] == "theory":
            parts = re.split(r"(?=<h4>)", s["html"])
            pages = []
            for p in parts:
                if not p.strip(): continue
                m = re.match(r"<h4>(.*?)</h4>", p)
                pages.append({"title": strip_tags(m.group(1)) if m else "", "html": p[m.end():] if m else p})
            s["pages"] = pages
    return {
        "id": meta["id"], "level": meta["level"], "n": meta["n"], "emoji": meta.get("emoji", ""), "title": meta["title"], "kind": meta["kind"],
        "description": meta.get("description", ""), "contains": meta.get("contains", ""),
        "intro": intro, "sections": sections, "exercises": exercises, "selfcheck": selfcheck, "selfcheckNote": selfcheck_html,
    }

# ---------- категории (структура «Список тем» из макета Маргариты) ----------
# Каждая тема плана попадает в одну категорию; уроки внутри категории идут по уровням.
CATEGORIES = [
    ("basics", "Основы", "алфавит и звуки, цифры, дни и месяцы, have got", [r"Алфавит", r"Цифры", r"Дни, месяцы", r"Have got"]),
    ("tobe", "Глагол to be", "am / is / are, was / were, there is / there are, синонимы to be", [r"To be", r"There is", r"Синонимы to be"]),
    ("tenses", "Времена", "Pr.S., Pr.C., P.S., P.C., F.S., Pr.P., P.P., F.C., F.P., все 12 времён", [r"Present Simple", r"Present Continuous", r"Past Simple", r"Past Continuous", r"Будущее", r"Present Perfect", r"Past Perfect", r"Future Continuous", r"Все 12 времен", r"Stative", r"narrative tenses", r"would — все значения"]),
    ("modals", "Модальные глаголы", "can, could, should, must, have to, may, might, модальные в прошлом", [r"Can / can't", r"Модальные", r"may / might"]),
    ("nouns", "Существительные", "множественное число, исчисляемые и неисчисляемые, some / any / much / many", [r"Множественное число", r"Some / any", r"Исчисляемые"]),
    ("articles", "Артикли", "a, an, the, отсутствие артикля, географические названия", [r"Артикли"]),
    ("pronouns", "Местоимения", "this / that / these / those, притяжательные, 's", [r"This / that", r"Притяжательный"]),
    ("adjectives", "Прилагательные и наречия", "порядок прилагательных, степени сравнения", [r"Порядок прилагательных", r"Степени сравнения"]),
    ("prepositions", "Предлоги", "времени, места, самые частоупотребимые предлоги", [r"предлоги"]),
    ("conditionals", "Условные предложения", "First, Second, Third, Mixed, wish / if only", [r"Conditional", r"wish / if only", r"Mixed conditionals"]),
    ("passive", "Пассивный залог", "введение, все времена, продвинутые формы", [r"Passive"]),
    ("reported", "Косвенная речь", "reported speech, reporting verbs, whether vs if", [r"Reported Speech", r"whether vs if"]),
    ("verbals", "Герундий и инфинитив", "gerund vs infinitive, инфинитивные конструкции", [r"Gerund", r"Инфинитивные"]),
    ("syntax", "Строение предложения", "повелительное наклонение, relative clauses, инверсия, cleft, причастные обороты", [r"Повелительное", r"Relative clauses", r"Инверсия", r"Cleft", r"Participle", r"Nominalisation", r"Subjunctive", r"Correlative"]),
    ("vocab", "Лексика и стиль", "фразовые глаголы, словообразование, идиомы, linking words, регистр", [r"Фразовые", r"Phrasal", r"Словообразование", r"Idioms", r"Linking words", r"Discourse markers", r"Hedging", r"Register", r"Лексика высокого", r"Профессиональное", r"аргументация"]),
    ("bridges", "Мосты и экзамены", "переход между уровнями, экзамен-чекпоинты B2 и C1", []),
]
def category_of(meta):
    if meta["kind"] != "topic": return "bridges"
    for key, _, _, pats in CATEGORIES:
        for rx in pats:
            if re.search(rx, meta["title"], re.I): return key
    return "syntax"
HIDDEN = [r"\(1\)$"]  # дубликаты страниц в Notion

idx = json.load(open(os.path.join(SRC, "index.json")))
out_levels = []; total = 0; stats = []; cat_topics = {k: [] for k, *_ in CATEGORIES}
for lv in idx["levels"]:
    topics = []
    for t in lv["topics"]:
        t = dict(t); t["level"] = lv["code"]
        if any(re.search(h, t["title"]) for h in HIDDEN): continue
        t["category"] = category_of(t)
        tp = build_topic(t)
        cat_topics[t["category"]].append(tp["id"])
        json.dump(tp, open(os.path.join(DST, "topics", tp["id"] + ".json"), "w"), ensure_ascii=False)
        topics.append({"id": tp["id"], "n": t["n"], "level": lv["code"], "category": t["category"], "emoji": tp["emoji"], "title": tp["title"], "kind": tp["kind"], "description": tp["description"], "contains": tp["contains"],
                       "sections": [s["key"] for s in tp["sections"]], "exercises": len(tp["exercises"]), "selfcheck": len(tp["selfcheck"])})
        stats.append((lv["code"], t["n"], tp["title"][:40], len(tp["sections"]), len(tp["exercises"]), len(tp["selfcheck"]), sum(len(s["html"]) for s in tp["sections"])))
        total += 1
    out_levels.append({"code": lv["code"], "title": lv["title"], "emoji": lv.get("emoji", ""), "intro": inline(lv.get("intro", "")), "checkpoint": [inline(x) for x in lv.get("checkpoint", [])], "topics": topics})
categories = [{"key": k, "title": title, "outline": outline, "topics": cat_topics[k]} for k, title, outline, _ in CATEGORIES if cat_topics[k]]
json.dump({"levels": out_levels, "categories": categories, "builtAt": __import__("datetime").date.today().isoformat()}, open(os.path.join(DST, "index.json"), "w"), ensure_ascii=False)
for c in categories: print("CAT %-14s %2d" % (c["key"], len(c["topics"])))
for s in stats: print("%s %2d %-40s sec=%d ex=%2d chk=%2d html=%d" % s)
print("topics:", total, "->", DST)
