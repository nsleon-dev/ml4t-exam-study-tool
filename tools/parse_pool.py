"""Parse the ML4T Exam Question Pool PDF into private/questions.json (+ .js).

Usage:
    pip install pymupdf
    python tools/parse_pool.py "path/to/ML4T Exam Question Pool.pdf"

private/ is git-ignored and never deployed. questions.json is what
tools/upload_pool.py puts in Supabase (readable only by signed-in users);
questions.js (window.ML4T_DATA = {...}) is for running locally without Supabase.
"""
import json
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "private" / "questions.js"
OUT_JSON = ROOT / "private" / "questions.json"
OVERRIDES = Path(__file__).resolve().parent / "overrides.json"

# ID prefix -> (part key, exam number, section)
PARTS = {
    "ML": ("ML1", 1, "ML"),
    "QF": ("QF1", 1, "QF"),
    "ML2": ("ML2", 2, "ML"),
    "QF2": ("QF2", 2, "QF"),
}
PART_HEADINGS = [
    ("ML1", "Machine Learning – Part 1"),
    ("QF1", "Quantitative Finance – Part 1"),
    ("ML2", "Machine Learning – Part 2"),
    ("QF2", "Quantitative Finance – Part 2"),
]

QID_RE = re.compile(r"^\[((ML2|QF2|ML|QF)-D(\d+)G(\d+)Q(\d+))\]\s*$", re.M)
BULLET = "\uf0b7"

# Glyphs from Word equations that pypdf decodes into unrelated scripts.
# Mapped to a small inline markup the app renders: _{x} subscript, ^{x} superscript.
SUB = {
    "\u0b34": "0", "\u0b35": "1", "\u0b36": "2", "\u0b37": "3", "\u0b38": "4",
    "\u0b39": "5", "\u0b3a": "6", "\u0b3b": "7", "\u0b3c": "8", "\u0b3d": "9",
    "\u0bdc": "i", "\u0bdd": "j", "\u0bdb": "h", "\u0bde": "k", "\u0bdf": "l",
    "\u0be0": "m", "\u0be1": "n", "\u0be3": "p", "\u0be4": "q", "\u0be5": "r",
    "\u0be6": "s", "\u0be7": "t", "\u0bd4": "a", "\u0bd5": "b", "\u0bd7": "d",
    "\u0bd8": "e", "\u0bda": "g", "\u0bcb": "R", "\u0bc5": "L", "\u0bba": "A", "\u0bbb": "B",
    "\u0bbe": "P", "\u0bc0": "T", "\u0b6b": "m", "\u0b6c": "n", "\u0b67": "i",
    "\u0b40": "=", "\u0b5f": "a", "\u0b76": "x", "\u0b3e": "+",
}
# Hats, bars and stretchy brackets from the equation font.
GLYPHS = {
    "\u0ddc": "\u0302", "\u1218": "\u0302", "\u0d24": "\u0304",
    "\u0d6b": "(", "\u0d6f": ")", "\u0d63": "[", "\u0d67": "]", "\u0d5b": "{", "\u0d5f": "}",
    "\u1240": "(", "\u1241": ")", "\u1246": "(", "\u1247": ")", "\u124c": "(", "\u124d": ")",
}


def clean(text: str) -> str:
    text = text.replace("\ufb01", "fi").replace("\ufb02", "fl")
    # "Ư" is the ff ligature; the extractor often inserts a space before it.
    text = re.sub(r"(\w) \u01af", r"\1ff", text)
    text = text.replace("\u01af", "ff")
    text = re.sub(r"\s+", " ", text).strip()
    # Hyphens split across lines: "next- month" -> "next-month" (but keep "short- and long-term"),
    # "one -standard" -> "one-standard".
    text = re.sub(r"(\w)- (?!(?:and|or|to|versus|vs)\b)(?=[A-Za-z])", r"\1-", text)
    text = re.sub(r"([A-Za-z0-9]) -(?=[A-Za-z])", r"\1-", text)
    # Stray spaces before closing curly quotes / punctuation.
    text = re.sub(r"([,.;:!?]) \u201d", "\\1\u201d", text)
    text = re.sub(r"\u201c ", "\u201c", text)
    text = fix_straight_quotes(text)
    text = map_math(text)
    return text


def fix_straight_quotes(text: str) -> str:
    out, open_q = [], False
    for i, ch in enumerate(text):
        if ch == '"':
            if open_q and out and out[-1] == " " and len(out) > 1 and out[-2] in ",.;:!?":
                out.pop()
            open_q = not open_q
        out.append(ch)
    return "".join(out)


def map_math(text: str) -> str:
    def repl(m):
        run = m.group(0)
        mapped = "".join(SUB.get(c, c) for c in run)
        return "_{" + mapped + "}"

    cls = "[" + "".join(re.escape(k) for k in SUB) + "]+"
    text = re.sub(cls, repl, text)
    text = re.sub(r"_\{(\w+)\},_\{(\w+)\}", r"_{\1,\2}", text)  # X_{1},_{a} -> X_{1,a}
    # R_{2}, σ_{2}, (...)_{2} are squares (but R_{2}(j, s) is region 2).
    text = re.sub(r"(𝑅|R|𝜎|σ|\))_\{2\}(?!\()", r"\1^{2}", text)
    for a, b in GLYPHS.items():
        text = text.replace(a, b)
    # The extractor drops the space after an inline formula: "X_{1}has" -> "X_{1} has".
    text = re.sub(r"\}(?=[a-z]{2,})", "} ", text)
    text = re.sub(r"([)\]λ])(?=[a-z]{2,})", r"\1 ", text)  # "O(p)model", "[0, 1]when", "λstrengthens"
    text = re.sub(r"(\d)(?=(?!(?:th|st|nd|rd|bps|bp|ms|pp|bn|mm|am|pm|yr|yrs|x|k|m)\b)[a-z]{2,}\b)", r"\1 ", text)  # "0.04for"
    text = space_operators(text)
    # Math italic letters -> plain letters (they're the same symbols, just styled).
    def plain(m):
        import unicodedata
        name = unicodedata.name(m.group(0), "")
        mm = re.match(r"MATHEMATICAL (?:BOLD |SANS-SERIF |SCRIPT |DOUBLE-STRUCK )*(?:ITALIC )?(CAPITAL|SMALL) (\w+)", name)
        if not mm:
            return m.group(0)
        case, letter = mm.groups()
        if len(letter) == 1:
            return letter if case == "CAPITAL" else letter.lower()
        greek = {"ALPHA": "α", "BETA": "β", "GAMMA": "γ", "DELTA": "δ", "EPSILON": "ε", "LAMDA": "λ",
                 "MU": "μ", "SIGMA": "σ", "RHO": "ρ", "THETA": "θ", "PI": "π", "TAU": "τ", "OMEGA": "ω"}
        g = greek.get(letter, m.group(0))
        return g.upper() if case == "CAPITAL" and g != m.group(0) else g
    text = re.sub(r"[\U0001D400-\U0001D7FF]", plain, text)
    text = text.replace("\U0001D716", "ε").replace("\U0001D715", "∂")
    return text


def space_operators(text: str) -> str:
    """Equation text carries no space glyphs: "K= 1to", "X_{j}≤s", "1 −max". Put one space
    around relations, and around binary +/− (but not a sign such as "of +0.045" or "−0.02")."""
    text = re.sub(r"\s*([=≤≥→⟺⟹∈])\s*", r" \1 ", text)

    def pm(m):
        prev, op = m.group(1), m.group(2)
        binary = re.fullmatch(r"[A-Za-zα-ωΑ-Ω]|.*[0-9)}\]̂̄]", prev) and not re.fullmatch(r"\d{4}", prev)
        return f"{prev} {op} " if binary else m.group(0)

    text = re.sub(r"(\S+?) ?([+−]) ?(?=[\w(\[|∣])", pm, text)
    # Undo spacing inside sub/superscripts: _{i = 1} -> _{i=1}.
    text = re.sub(r"([_^]\{)([^{}]*)\}", lambda m: m.group(1) + re.sub(r" ?([=+−]) ?", r"\1", m.group(2)) + "}", text)
    return re.sub(r" {2,}", " ", text)


def extract_text(pdf_path: str) -> str:
    """One line per PDF text block (≈ paragraph). Paragraphs split by a page break are rejoined."""
    paras = []
    for page in pymupdf.open(pdf_path):
        for block in page.get_text("blocks"):
            if block[6] != 0:  # image block
                continue
            t = re.sub(r"\s*\n\s*", " ", block[4]).strip()
            if not t or re.fullmatch(r"\d+ Rev:\d+", t):  # blank or running page footer
                continue
            if paras and not re.search(r"[.?:!)\]”\"]$", paras[-1]) and re.match(r"[a-z(]", t) \
                    and not paras[-1].startswith("[") and not re.match(r"^(G\d+|Domain \d+):", paras[-1]):
                paras[-1] += " " + t
            else:
                paras.append(t)
    return "\n".join(paras)


def parse_toc(text: str):
    """Domain names per part, from the table of contents."""
    domains, part = {}, None
    for line in text.splitlines()[:200]:
        s = line.strip()
        for key, heading in PART_HEADINGS:
            if s.startswith(heading):
                part = key
                domains.setdefault(part, {})
        m = re.match(r"Domain (\d+): (.+?)\s*\.{3,}", s)
        if m and part:
            domains[part][int(m.group(1))] = clean(m.group(2))
    return domains


def parse_groups(text: str):
    """Group names per (part-prefix, domain) from each domain's 'Topic Groups' list."""
    groups = {}
    # Each domain section starts with "Domain N: name\nDomain Summary".
    for m in re.finditer(r"Domain (\d+): [^\n]+\n\s*Domain Summary(.*?)(?=\[(?:ML2|QF2|ML|QF)-D)", text, re.S):
        d = int(m.group(1))
        body = m.group(2)
        nxt = re.search(r"\[(ML2|QF2|ML|QF)-D(\d+)G", text[m.end() - 1: m.end() + 20])
        if not nxt:
            continue
        prefix = nxt.group(1)
        gm = {}
        for g in re.finditer(r"^\s*G(\d+):\s*(.+)$", body, re.M):
            gm.setdefault(int(g.group(1)), clean(g.group(2)))
        groups[(prefix, d)] = gm
    return groups


def split_body(qid: str, body: str):
    ak = re.search(r"^\s*Answer Key([^:\n]*):", body, re.M)
    if not ak:
        raise ValueError(f"{qid}: no answer key")
    # Trim trailing headings (next group / domain / part) that follow the answer key.
    heading = re.compile(r"^\s*(G\d+:\s|Domain \d+:\s|Machine Learning – Part|Quantitative Finance – Part|Chapter Introduction)", re.M)
    cut = heading.search(body, ak.end())
    if cut:
        body = body[: cut.start()]

    flipped = "incorrect" in ak.group(1)
    q_part, a_part = body[: ak.start()], body[ak.end():]

    def letter_blocks(s):
        pos = [(m.group(1), m.start(), m.end()) for m in re.finditer(r"^\s*([A-E])\.\s", s, re.M)]
        # Keep only the last A..E sequence in order.
        seq, want = [], "ABCDE"
        for L, st, en in pos:
            if L == want[len(seq) % 5] and (L != "A" or not seq or len(seq) == 5):
                if L == "A":
                    seq = []
                seq.append((L, st, en))
        if len(seq) != 5:
            raise ValueError(f"{qid}: found {len(seq)} lettered lines")
        blocks = []
        for i, (L, st, en) in enumerate(seq):
            end = seq[i + 1][1] if i < 4 else len(s)
            blocks.append(s[en:end])
        return seq[0][1], blocks

    stem_end, stmts = letter_blocks(q_part)
    stem_raw = q_part[:stem_end]
    _, answers = letter_blocks(a_part)

    # Stem: each extracted line is one paragraph; bullet items keep their marker.
    stem_lines = []
    for line in stem_raw.splitlines():
        s = line.strip()
        if not s:
            continue
        stem_lines.append("• " + s[1:].strip() if s.startswith(BULLET) else s)
    stem = []
    for s in stem_lines:
        bullet = s.startswith("• ")
        s = clean(s[2:] if bullet else s)
        # Some lists were typed inline as "Item 1 * Item 2 * Item 3".
        parts = re.split(r" \* (?=[A-Z])", s)
        if len(parts) > 1:
            stem += ["• " + p for p in parts]
        else:
            stem.append("• " + s if bullet else s)

    parsed_answers = []
    for i, a in enumerate(answers):
        m = re.match(r"\s*(True|False)\s*[–—-]?\s*(.*)", a, re.S)
        if not m:
            raise ValueError(f"{qid}: bad answer {'ABCDE'[i]}: {a[:60]!r}")
        parsed_answers.append((m.group(1) == "True", clean(m.group(2))))

    # Reversed scoring is announced either in the answer-key header or only in the stem
    # ("mark each statement True when the stated claim is incorrect ...").
    flipped = flipped or bool(re.search(
        r"True (?:if|when)[^.]*\b(?:incorrect|inaccurate|flawed|wrong)\b", " ".join(stem), re.I))

    return {
        "stem": stem,
        "flipped": flipped,
        "statements": [
            {"text": clean(stmts[i]), "answer": parsed_answers[i][0], "explanation": parsed_answers[i][1]}
            for i in range(5)
        ],
    }


def apply_overrides(questions, over):
    """Hand fixes for formulas the PDF text layer garbles.

    overrides.json maps a question id (or "_all") to:
      "replace": [[old, new], ...]   literal replacements in every text field
      "regex":   [[pattern, new], ...]
      "stem":    [...]                replaces the stem paragraphs outright
    Every replacement must match at least once, so stale fixes are reported.
    """
    errors = []
    by_id = {q["id"]: q for q in questions}

    def fields(q):
        for i in range(len(q["stem"])):
            yield q["stem"], i
        for st in q["statements"]:
            yield st, "text"
            yield st, "explanation"

    for key, patch in over.items():
        if key.startswith("#"):
            continue
        targets = questions if key == "_all" else [by_id[key]]
        if "stem" in patch:
            targets[0]["stem"] = patch["stem"]
        rules = [(re.escape(o), n.replace("\\", "\\\\")) for o, n in patch.get("replace", [])]
        rules += [(p, n) for p, n in patch.get("regex", [])]
        for pat, new in rules:
            hits = 0
            for q in targets:
                for obj, k in fields(q):
                    obj[k], n = re.subn(pat, new, obj[k])
                    hits += n
            if not hits:
                errors.append(f"override {key}: no match for {pat!r}")
        for q in targets:
            q["stem"] = [s for s in q["stem"] if s.strip()]  # a replacement may empty a line
    return errors


def main(pdf_path: str):
    text = extract_text(pdf_path)
    domains = parse_toc(text)
    groups = parse_groups(text)

    matches = list(QID_RE.finditer(text))
    questions, errors = [], []
    for i, m in enumerate(matches):
        qid, prefix, d, g, q = m.group(1), m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5))
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        try:
            parsed = split_body(qid, text[m.end(): end])
        except ValueError as e:
            errors.append(str(e))
            continue
        part, exam, section = PARTS[prefix]
        questions.append({
            "id": qid, "part": part, "exam": exam, "section": section,
            "domain": d, "group": g, "q": q, **parsed,
        })

    if OVERRIDES.exists():
        errors += apply_overrides(questions, json.loads(OVERRIDES.read_text(encoding="utf-8")))

    meta = {"parts": {}}
    for key, heading in PART_HEADINGS:
        prefix = [p for p, v in PARTS.items() if v[0] == key][0]
        meta["parts"][key] = {
            "title": heading,
            "domains": {
                str(d): {"name": name, "groups": {str(k): v for k, v in groups.get((prefix, d), {}).items()}}
                for d, name in domains[key].items()
            },
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"meta": meta, "questions": questions}, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text("window.ML4T_DATA = " + payload + ";\n", encoding="utf-8")
    OUT_JSON.write_text(payload, encoding="utf-8")
    print(f"{len(questions)} questions written to {OUT_JSON} and {OUT.name}")
    if errors:
        print(f"{len(errors)} errors:")
        for e in errors:
            print("  ", e)
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "ML4T Exam Question Pool.pdf"))
