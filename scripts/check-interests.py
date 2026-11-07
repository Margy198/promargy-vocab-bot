#!/usr/bin/env python3
"""Проверяет банк предложений по интересам (data/interests/*.json) и собирает data/interests/index.json."""
import json, glob, os, sys, re
D = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "interests")
ok = True; index = []
for f in sorted(glob.glob(os.path.join(D, "*.json"))):
    if f.endswith("index.json"): continue
    try: d = json.load(open(f))
    except Exception as e: print("BAD JSON", f, e); ok = False; continue
    key = os.path.basename(f)[:-5]
    errs = []
    if d.get("key") != key: errs.append("key != filename")
    for k in ("title", "emoji", "group"):
        if not d.get(k): errs.append("no " + k)
    ss = d.get("sentences") or []
    if len(ss) < 18: errs.append("sentences=%d" % len(ss))
    lv = {"A2": 0, "B1": 0, "B2": 0}
    for i, s in enumerate(ss):
        if s.get("level") not in lv: errs.append("s%d level" % i); continue
        lv[s["level"]] += 1
        en, ru = s.get("en", ""), s.get("ru", "")
        if not (6 <= len(en.split()) <= 22): errs.append("s%d len %d" % (i, len(en.split())))
        if not ru or re.search(r"[a-zA-Z]{4,}", ru) and not re.search(r"[а-яё]", ru): errs.append("s%d ru" % i)
        v = s.get("vocab") or []
        if not (1 <= len(v) <= 3): errs.append("s%d vocab n=%d" % (i, len(v)))
        for it in v:
            if not it.get("en") or not it.get("ru"): errs.append("s%d vocab fields" % i); continue
            if it["en"].lower() not in en.lower(): errs.append("s%d vocab '%s' not in sentence" % (i, it["en"]))
    if any(v < 4 for v in lv.values()): errs.append("levels %s" % lv)
    if errs: ok = False; print(key, "→", "; ".join(errs[:8]), ("… +%d" % (len(errs) - 8)) if len(errs) > 8 else "")
    else: print("OK", key, len(ss), lv)
    index.append({"key": key, "title": d.get("title"), "emoji": d.get("emoji"), "group": d.get("group"), "count": len(ss)})
json.dump(index, open(os.path.join(D, "index.json"), "w"), ensure_ascii=False, indent=0)
print("topics:", len(index), "status:", "OK" if ok else "ERRORS")
sys.exit(0 if ok else 1)
