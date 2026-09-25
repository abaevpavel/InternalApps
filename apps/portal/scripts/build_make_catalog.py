#!/usr/bin/env python3
"""
build_make_catalog.py — снимок каталога писем и payload'ов сценариев Make для Dev Apps
(BAS-1556 письма, BAS-1504 payload'ы).

Make только ЧИТАЕМ: блюпринты выгружаются через MCP `scenarios_get` (ответы сохраняются в
файлы — они по 100–700 КБ), этот скрипт их разбирает и пишет src/data/make-catalog.json.
Портал в Make не ходит никогда.

  build_make_catalog.py <каталог с <scenarioId>.json> [--scope scripts/make-catalog-scope.json]
                        [--out src/data/make-catalog.json]

Что достаётся:
  • письма — модули отправки (Gmail, Email/SMTP, emailsender, QuickBooks SendInvoice): от кого,
    кому, CC/BCC, reply-to, тема, тело, вложения, и УСЛОВИЕ — все фильтры и маршруты роутера
    на пути к модулю, по-человечески;
  • payload — поля входного вебхука (metadata.interface триггера) и где каждое читается.
    Поле, переданное целиком (массив в итератор и т.п.), своих детей «неиспользуемыми» не делает.
"""
import argparse
import json
import os
import re
from datetime import datetime, timezone

ORG_ID = 10349  # BasementRemodeling.com, зона us1

EMAIL_MODULES = {
    'app#emailsender-vt4aje:sendEmail',
    'google-email:sendAnEmail',
    'google-email:ActionSendEmail',
    'email:ActionSendEmail',
    'quickbooks:SendInvoice',
}

OPS = {
    'exist': 'exists', 'notexist': 'does not exist',
    'text:equal': '=', 'text:notequal': '≠', 'text:equal:ci': '= (any case)', 'text:notequal:ci': '≠ (any case)',
    'text:contain': 'contains', 'text:notcontain': 'does not contain',
    'text:contain:ci': 'contains (any case)', 'text:notcontain:ci': 'does not contain (any case)',
    'text:startwith': 'starts with', 'text:endwith': 'ends with', 'text:pattern': 'matches',
    'number:equal': '=', 'number:notequal': '≠', 'number:greater': '>', 'number:less': '<',
    'number:greaterorequal': '≥', 'number:lessorequal': '≤',
    'boolean:equal': '=', 'boolean:notequal': '≠',
    'array:contain': 'contains', 'array:notcontain': 'does not contain',
    'date:greater': 'after', 'date:less': 'before',
}


def walk(flow, path=()):
    """Все модули с цепочкой предков-условий: (module, [ (label, filter) ... ])."""
    for m in flow:
        conds = list(path)
        if m.get('filter'):
            conds.append((m['filter'].get('name') or '', m['filter'].get('conditions') or []))
        yield m, conds
        for i, r in enumerate(m.get('routes') or []):
            yield from walk(r.get('flow', []), tuple(conds) + ((f'route {i + 1}', None),))
        if m.get('onerror'):
            yield from walk(m['onerror'], tuple(conds) + (('on error', None),))


def cond_text(conds):
    parts = []
    for label, groups in conds:
        if groups is None:
            continue  # маркер маршрута без собственного фильтра
        ors = []
        for group in groups:
            ands = []
            for c in group or []:
                op = OPS.get(c.get('o'), c.get('o'))
                b = c.get('b')
                ands.append(f"{c.get('a')} {op}" + (f' {b}' if b not in (None, '') and op not in ('exists', 'does not exist') else ''))
            if ands:
                ors.append(' and '.join(ands))
        if ors:
            body = ' or '.join(f'({o})' if len(ors) > 1 else o for o in ors)
            parts.append(f'«{label}»: {body}' if label else body)
    return '; '.join(parts) or None


def as_list(v):
    if v is None or v == '':
        return []
    if isinstance(v, list):
        out = []
        for x in v:
            out.extend(as_list(x) if not isinstance(x, dict) else [x.get('address') or x.get('email') or json.dumps(x)])
        return [s for s in out if s]
    return [s.strip() for s in str(v).split(',') if s.strip()] if '{{split' not in str(v) else [str(v)]


def email_entry(m, conds, label):
    mp = m.get('mapper') or {}
    t = m['module']
    conn = (m.get('parameters') or {}).get('__IMTCONN__') or (m.get('parameters') or {}).get('account')
    if t == 'app#emailsender-vt4aje:sendEmail':
        name, addr = mp.get('from_name'), mp.get('from_email')
        frm = f'{name} <{addr}>' if name and addr else (addr or name)
        return dict(to=as_list(mp.get('to_email')), cc=as_list(mp.get('cc')), bcc=as_list(mp.get('bcc')),
                    frm=frm, reply=mp.get('reply_to') or None, subject=mp.get('subject') or '',
                    body=mp.get('html') or mp.get('text') or '', att=attachments(mp))
    if t == 'google-email:sendAnEmail':
        return dict(to=as_list(mp.get('to')), cc=as_list(mp.get('cc')), bcc=as_list(mp.get('bcc')),
                    frm=mp.get('from') or (f'Gmail connection {conn}' if conn else None), reply=mp.get('replyTo') or None,
                    subject=mp.get('subject') or '', body=mp.get('content') or '', att=attachments(mp))
    if t == 'google-email:ActionSendEmail':
        return dict(to=as_list(mp.get('to')), cc=as_list(mp.get('cc')), bcc=as_list(mp.get('bcc')),
                    frm=mp.get('from') or (f'Gmail account {conn}' if conn else None), reply=mp.get('replyTo') or None,
                    subject=mp.get('subject') or '', body=mp.get('html') or mp.get('text') or '', att=attachments(mp))
    if t == 'email:ActionSendEmail':
        return dict(to=as_list(mp.get('to')), cc=as_list(mp.get('cc')), bcc=as_list(mp.get('bcc')),
                    frm=mp.get('from') or mp.get('sender') or (f'SMTP account {conn}' if conn else None),
                    reply=mp.get('replyTo') or None, subject=mp.get('subject') or '',
                    body=mp.get('html') or mp.get('text') or '', att=attachments(mp))
    if t == 'quickbooks:SendInvoice':
        return dict(to=as_list(mp.get('sendTo')) or ['(customer’s billing email in QuickBooks)'], cc=[], bcc=[],
                    frm='QuickBooks (company invoice email)', reply=None,
                    subject='(QuickBooks invoice email template)',
                    body=f'<p><i>QuickBooks sends invoice <b>{mp.get("id", "")}</b> with its own email template.</i></p>', att=['invoice PDF (QuickBooks)'])
    return None


def attachments(mp):
    out = []
    for a in mp.get('attachments') or []:
        if isinstance(a, dict):
            out.append(a.get('fileName') or a.get('filename') or a.get('name') or json.dumps(a)[:80])
        else:
            out.append(str(a))
    return out


def flatten_interface(items, prefix=''):
    """metadata.interface триггера → [(path, type, is_container)]."""
    out = []
    for it in items or []:
        name = it.get('name')
        if not name:
            continue
        path = f'{prefix}{name}'
        typ = it.get('type')
        spec = it.get('spec')
        container = typ in ('collection', 'array') and spec is not None
        out.append((path, typ, container))
        if typ == 'collection' and isinstance(spec, list):
            out.extend(flatten_interface(spec, path + '.'))
        elif typ == 'array' and spec is not None:
            inner = spec.get('spec') if isinstance(spec, dict) else spec
            if isinstance(inner, list):
                out.extend(flatten_interface(inner, path + '[].'))
    return out


def ref_forms(trigger_id, path):
    """Как путь выглядит внутри {{…}}: 1.a.b, 1.`a b`.c, 1.items[].x."""
    segs = path.replace('[]', '').split('.')
    def fmt(s):
        return f'`{s}`' if re.search(r'[^A-Za-z0-9_]', s) else s
    plain = f'{trigger_id}.' + '.'.join(segs)
    quoted = f'{trigger_id}.' + '.'.join(fmt(s) for s in segs)
    # И как есть — с [] у массивов: {{1.estimateResult.estimatesInfo[].status}}.
    raw_segs = path.split('.')
    with_arr = f'{trigger_id}.' + '.'.join(raw_segs)
    with_arr_q = f'{trigger_id}.' + '.'.join(fmt(s.replace('[]', '')) + ('[]' if s.endswith('[]') else '') for s in raw_segs)
    return {plain, quoted, with_arr, with_arr_q}


def texts_of(m):
    """(где, текст) для всего, что модуль читает: поля mapper и фильтр."""
    out = []
    def rec(prefix, v):
        if isinstance(v, str):
            out.append((prefix, v))
        elif isinstance(v, dict):
            for k, x in v.items():
                rec(f'{prefix}.{k}' if prefix else k, x)
        elif isinstance(v, list):
            for x in v:
                rec(prefix, x)
    rec('', m.get('mapper') or {})
    if m.get('filter'):
        rec('filter', m['filter'].get('conditions'))
    return out


SEG = r'(?:`[^`]+`|[A-Za-z_][\w]*)(?:\[\d*\])?'


def referenced_paths(trig_id, mods, trig):
    """Все пути payload'а, которые сценарий читает: {{1.a.b[].c}} → 'a.b[].c'."""
    pat = re.compile(rf'(?<![\w.]){trig_id}\.({SEG}(?:\.{SEG})*)')
    out = set()
    for m, _ in mods:
        if m is trig:
            continue
        txt = json.dumps({'m': m.get('mapper'), 'f': m.get('filter')})
        for p in pat.findall(txt):
            # `x[]` в конце — тот же массив x, а не отдельное поле.
            out.add(re.sub(r'\[\]$', '', re.sub(r'\[\d+\]', '[]', p.replace('`', ''))))
    return out


def filter_actions(trig_id, mods):
    """Какие значения action / статуса сметы / депозита сценарий ловит фильтрами."""
    found = set()
    for m, _ in mods:
        for g in ((m.get('filter') or {}).get('conditions') or []):
            for c in g or []:
                a, b = str(c.get('a', '')), c.get('b')
                mm = re.search(rf'\b{trig_id}\.(action|estimateResult\.estimatesInfo\[\]\.status|depositStatus)\b', a)
                if mm and b not in (None, ''):
                    found.add(str(b))
    return sorted(found)


TOKEN = re.compile(r'(?<![\w.`])(\d+)\.((?:`[^`]+`|[A-Za-z_][\w]*)(?:\[\d*\])?(?:\.(?:`[^`]+`|[A-Za-z_][\w]*)(?:\[\d*\])?)*)')
# Объекты с переменными ключами: приложение шлёт их целиком, ключи внутри — названия документов и т.п.
DICT_KEYS = {'list', 'documentList', 'customData'}
WHOLE_SINKS = {'json:TransformToJSON', 'json:CreateJSON', 'http:ActionSendData', 'http:MakeRequest',
               'app#jsrunner-ygu6nz:RunCode', 'builtin:BasicAggregator'}


def _segs(path):
    return [x.replace('`', '') for x in re.findall(r'`[^`]+`(?:\[\d*\])?|[^.`]+', path)]


def payload_reads(trig_id, mods, label):
    """
    Что сценарий реально читает из payload'а — с учётом посредников.

    Объект из payload'а может уйти в итератор (BasicFeeder: {{N.x}} — поля элемента) или в
    переменную (SetVariable2 / SetVariables: {{N.<имя>}}); такие чтения сводим обратно к пути
    payload'а. Возвращает {путь: [(moduleId, где, whole)]}: whole=True — объект передан
    целиком (в JSON, HTTP, JS-код…), то есть сам Make его поля не читает.
    """
    alias = {str(trig_id): []}          # префикс ссылки → сегменты пути payload'а
    reads = {}

    def resolve(mod_id, rest):
        segs = _segs(rest)
        key2 = f'{mod_id}.{segs[0].replace("[]", "")}' if segs else None
        if key2 in alias:
            base, tail = alias[key2], segs[1:]
        elif mod_id in alias:
            base, tail = alias[mod_id], segs
        else:
            return None
        path = base + [re.sub(r'\[\d+\]', '[]', t) for t in tail]
        return re.sub(r'\[\]$', '', '.'.join(path)) if path else ''

    def exact_ref(v):
        if not isinstance(v, str):
            return None
        m = re.fullmatch(r'\{\{\s*(\d+)\.([^}]+?)\s*\}\}', v or '')
        return resolve(m.group(1), m.group(2)) if m else None

    for m, _ in mods:
        mid = str(m['id'])
        if mid == str(trig_id):
            continue
        mp = m.get('mapper') or {}
        t = m['module']
        # Регистрация посредников: объект payload'а уходит в итератор / переменную.
        if t == 'builtin:BasicFeeder':
            p = exact_ref(mp.get('array'))
            if p is not None:
                alias[mid] = _segs(p) + [] if p else []
                if alias[mid]:
                    alias[mid][-1] = alias[mid][-1].replace('[]', '') + '[]'
        elif t == 'util:SetVariable2':
            p = exact_ref(mp.get('value'))
            if p is not None and mp.get('name'):
                alias[f'{mid}.{mp["name"]}'] = _segs(p)
        elif t == 'util:SetVariables':
            for v in mp.get('variables') or []:
                p = exact_ref((v or {}).get('value'))
                if p is not None and (v or {}).get('name'):
                    alias[f'{mid}.{v["name"]}'] = _segs(p)

        # Чтения в этом модуле.
        for where, text in texts_of(m):
            if '{{' not in text:
                continue
            # toCollection(массив; "ключ"; "значение") читает эти два поля у каждого элемента.
            for mod_id, rest, k, v in re.findall(r'toCollection\(\s*(\d+)\.([^;)]+?)\s*;\s*"([^"]+)"\s*;\s*"([^"]+)"', text):
                base = resolve(mod_id, rest)
                if base:
                    arr = base if base.endswith('[]') else base + '[]'
                    for fld in (k, v):
                        reads.setdefault(f'{arr}.{fld}', []).append((m['id'], f"{label(m) or t} · {where} (toCollection)", False, t))
            for mod_id, rest in TOKEN.findall(text):
                path = resolve(mod_id, rest)
                if path is None or path == '':
                    continue
                # Служебные поля Make (__IMTINDEX__, __IMTLENGTH__…) — не payload.
                if '__IMT' in path:
                    continue
                # Хвост формулы TOKEN не захватывает; пробел внутри пути — это `имя ключа с пробелами`
                # (documentList.`Client Scope (Proposal)`), резать по нему нельзя.
                # Хвост формулы («rate / 100») отрезаем по оператору, а не по любому пробелу.
                path = re.split(r'\s+[-+*/%<>=!&|]', path, 1)[0].rstrip('.')
                # Ссылка ровно на объект (без хвоста), и модуль — «сток»: объект уходит целиком.
                whole = t in WHOLE_SINKS and re.search(r'\{\{\s*' + re.escape(f'{mod_id}.{rest}') + r'\s*\}\}', text) is not None
                reads.setdefault(path, []).append((m['id'], f"{label(m) or t} · {where}", whole, t))
    return reads


def uses(text, forms):
    for f in forms:
        for m in re.finditer(re.escape(f), text):
            nxt = text[m.end():m.end() + 1]
            if nxt == '' or not re.match(r'[A-Za-z0-9_`]', nxt):
                return True
    return False


def build(src_dir, scope, mac=None):
    mac = mac or {'kinds': {}, 'actionExtras': {}, 'scenarios': {}}
    scenarios = []
    for sid_str, meta in scope['scenarios'].items():
        sid = int(sid_str)
        path = os.path.join(src_dir, f'{sid}.json')
        if not os.path.exists(path):
            raise SystemExit(f'missing blueprint for {sid}: {path}')
        d = json.load(open(path))
        # Каталог — только о том, что работает: выключенный сценарий в Make не берём, даже если он в скоупе.
        if not d.get('isActive'):
            print(f'skip {sid} {d.get("name")!r}: scenario is off in Make')
            continue
        flow = d['blueprint']['flow']
        mods = list(walk(flow))
        label = lambda m: (m.get('metadata') or {}).get('designer', {}).get('name')

        emails = []
        for m, conds in mods:
            if m['module'] not in EMAIL_MODULES:
                continue
            e = email_entry(m, conds, label(m))
            if not e:
                continue
            emails.append({
                'moduleId': m['id'],
                'label': label(m),
                'module': m['module'],
                'condition': cond_text(conds),
                'from': e['frm'],
                'to': e['to'], 'cc': e['cc'], 'bcc': e['bcc'],
                'replyTo': e['reply'],
                'subject': e['subject'],
                'bodyHtml': e['body'],
                'attachments': e['att'],
            })

        webhook = None
        trig = next((m for m in flow if m['module'] == 'gateway:CustomWebHook'), None)
        if trig:
            md = trig.get('metadata') or {}
            hook_name = ((md.get('restore') or {}).get('hook') or {}).get('label')
            fields_raw = flatten_interface(md.get('interface') or [])
            fields = []
            known = {fp for fp, _, _ in fields_raw}
            # Что сценарий читает — с учётом итераторов и переменных-посредников.
            reads = payload_reads(trig['id'], mods, label)
            # Пути, которые сценарий читает, но которых нет в описании вебхука (у Forge описания
            # нет вовсе) — добавляем как «видно только по чтению».
            for rp in sorted(reads):
                if rp not in known:
                    fields_raw.append((rp, None, False))
                    known.add(rp)
            structure_paths = {fp for fp, _, _ in flatten_interface(md.get('interface') or [])}
            # Что шлёт Mac-приложение (из кода estimatingTool): payload своего вида + поля действий.
            m_conf = mac['scenarios'].get(str(sid))
            app_paths = set()
            if m_conf:
                app_paths = set(mac['kinds'][m_conf['kind']]['paths'])
                for a in m_conf.get('actions', []):
                    app_paths |= set(mac['actionExtras'].get(a, []))
            # Реальный payload из Make (только ключи) главнее кода приложения: берём ровно его.
            added_on_way = {k: v for k, v in ((mac.get('addedOnTheWay') or {}).get(str(sid)) or {}).items()}
            sample = (mac.get('samples') or {}).get(str(sid))
            if sample:
                app_paths = set(sample['paths'])
            for ap in sorted(app_paths):
                if ap not in known:
                    fields_raw.append((ap, None, False))
                    known.add(ap)

            # Тексты JS-кода сценария: поле, переданное в код целиком, считается прочитанным,
            # если его имя встречается в коде.
            code_texts = {m['id']: ((m.get('mapper') or {}).get('code') or '') for m, _ in mods
                          if m['module'] == 'app#jsrunner-ygu6nz:RunCode'}

            def ancestors(path):
                out, cur = [], ''
                for seg in path.split('.'):
                    cur = f'{cur}.{seg}' if cur else seg
                    out.append(cur)
                    if cur.endswith('[]'):
                        out.append(cur[:-2])
                return [a for a in out if a != path]

            fields = []
            for fpath, typ, container in fields_raw:
                direct = [{'moduleId': mid, 'where': w} for mid, w, whole, _ in reads.get(fpath, []) if not whole]
                forwarded = []
                for a in ancestors(fpath):
                    for mid, w, whole, mtype in reads.get(a, []):
                        if not whole:
                            continue
                        leaf = fpath.split('.')[-1].replace('[]', '')
                        if mtype == 'app#jsrunner-ygu6nz:RunCode' and re.search(rf'\b{re.escape(leaf)}\b', code_texts.get(mid, '')):
                            direct.append({'moduleId': mid, 'where': f'{w} (read in JS code)'})
                        else:
                            forwarded.append({'moduleId': mid, 'where': f'{a} → {w}'})
                # Сам объект передан целиком — это тоже чтение объекта (но не его полей).
                whole_self = [{'moduleId': mid, 'where': f'{w} (whole)'} for mid, w, whole, _ in reads.get(fpath, []) if whole]
                bare = fpath[:-len('[].value')] if fpath.endswith('[].value') else fpath
                # Ключ внутри объекта, который приложение шлёт целиком, считается отправленным только
                # у словарей с переменными ключами (list, documentList, customData); у строковых полей
                # (baseboardsInfo — строка) «дочерних» полей нет.
                sent_by_app = any(bare == a or a.startswith(bare + '.') or a.startswith(bare + '[].') or
                                  (a.split('.')[-1] in DICT_KEYS and bare.startswith(a + '.')) for a in app_paths)
                origin = 'structure' if fpath in structure_paths else ('app' if sent_by_app else 'reference')
                # Сценарий Mac-приложения: поле есть только в сохранённом описании вебхука (например,
                # старая структура JotForm у Submit sale — formID, rawRequest…), приложение его не шлёт
                # и никто его не читает — на самом деле не приходит, в каталог не берём.
                if m_conf and origin == 'structure' and not sent_by_app and not (direct or whole_self or forwarded):
                    continue
                fields.append({'path': fpath, 'type': typ, 'usedIn': direct + whole_self,
                               'forwardedTo': forwarded[:3], 'origin': origin})
            webhook = {
                'name': hook_name,
                # usedIn — Make сам читает поле (напрямую, через итератор/переменную или в JS-коде).
                # forwardedTo — поле уходит только внутри объекта, переданного целиком (в JSON, HTTP,
                #   агрегатор): Make его не читает, использовать может только получатель.
                # unused — поле точно приходит (structure / app), а Make его не читает.
                # missing — сценарий читает поле, которого Mac-приложение не шлёт (для его сценариев).
                'fields': [{'path': f['path'], 'type': f['type'], 'example': None, 'usedIn': f['usedIn'],
                            'forwardedTo': f['forwardedTo'], 'origin': f['origin'],
                            'unused': f['origin'] in ('structure', 'app') and not f['usedIn'],
                            # origin уже учитывает, шлёт ли приложение поле (см. sent_by_app).
                            'missing': bool(m_conf) and f['origin'] == 'reference' and f['path'] not in added_on_way,
                            **({'addedBy': added_on_way[f['path']]} if f['path'] in added_on_way else {})}
                           for f in fields],
            }

        scenarios.append({
            'id': sid,
            'name': d.get('name'),
            'stage': meta['stage'],
            'active': bool(d.get('isActive')),
            'url': f'https://us1.make.com/{ORG_ID}/scenarios/{sid}/edit',
            'webhook': webhook,
            'source': {'kind': meta.get('source', 'unknown'), 'sender': meta.get('sender')},
            'actions': filter_actions(trig['id'], mods) if trig else [],
            # Какие действия Mac-приложения приходят в этот сценарий — по коду estimatingTool.
            'appActions': (mac['scenarios'].get(str(sid)) or {}).get('actions', []),
            'appPayload': (mac['kinds'].get((mac['scenarios'].get(str(sid)) or {}).get('kind', ''), {}) or {}).get('label'),
            # Ключ пометок полей: общий для всех сценариев с одним видом payload'а приложения.
            'markScope': (f"mac:{mac['scenarios'][str(sid)]['kind']}" if str(sid) in mac['scenarios'] else f'scenario:{sid}'),
            'emails': emails,
        })
    return {'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'appActions': scope.get('appActions', []), 'scenarios': scenarios}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--scope', default=os.path.join(here, 'make-catalog-scope.json'))
    ap.add_argument('--out', default=os.path.join(here, '..', 'src', 'data', 'make-catalog.json'))
    a = ap.parse_args()
    scope = json.load(open(a.scope))
    mac_path = os.path.join(here, 'mac-app-payloads.json')
    mac = json.load(open(mac_path)) if os.path.exists(mac_path) else None
    cat = build(a.src, scope, mac)
    if mac:
        cat['appActionRoutes'] = mac.get('actionRoutes', {})
        cat['appPayloadSource'] = mac.get('_comment')
    with open(a.out, 'w') as f:
        json.dump(cat, f, ensure_ascii=False, indent=1)
    n_e = sum(len(s['emails']) for s in cat['scenarios'])
    n_f = sum(len(s['webhook']['fields']) for s in cat['scenarios'] if s['webhook'])
    n_u = sum(sum(1 for x in s['webhook']['fields'] if x['unused']) for s in cat['scenarios'] if s['webhook'])
    print(f"{len(cat['scenarios'])} scenarios · {n_e} emails · {n_f} payload fields ({n_u} unused) → {a.out}")


if __name__ == '__main__':
    main()
