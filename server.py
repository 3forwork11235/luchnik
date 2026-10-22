import asyncio
import json
import os
import random
import socket
import uuid

import websockets
from websockets.datastructures import Headers
from websockets.http11 import Response

PORT = int(os.environ.get('ARCHER_PORT', 8765))
HERE = os.path.dirname(os.path.abspath(__file__))
WIND_MAX = 6.0
HP_MAX = 100
RECONNECT_GRACE = 180  # сколько секунд держим место ушедшего игрока
BOT_DELAY = 8          # через сколько секунд за отошедшего игрока начинает играть бот (если боты включены)
SLOT_ORDER = ['L0', 'R0', 'L1', 'R1']

# game_id -> игра
games = {}


def team(sid):
    return 'left' if sid[0] == 'L' else 'right'


def other(t):
    return 'right' if t == 'left' else 'left'


def new_wind(prev, enabled):
    if not enabled:
        return 0.0
    w = prev * 0.35 + random.uniform(-1, 1) * WIND_MAX * 0.8
    return round(max(-WIND_MAX, min(WIND_MAX, w)), 1)


def clean_opts(o):
    o = o or {}
    return {
        'wind': bool(o.get('wind', True)),
        'birds': bool(o.get('birds', True)),
        'trees': o.get('trees') if o.get('trees') in ('none', 'few', 'many') else 'few',
        'diff': o.get('diff') if o.get('diff') in ('easy', 'normal', 'hard') else 'normal',
        'size': 2 if o.get('size') == 2 else 1,
        'bots': bool(o.get('bots', True)),
    }


def clean_name(n):
    return str(n or '').strip()[:14]


def new_slot():
    return {'kind': 'empty', 'ws': None, 'token': None, 'name': '', 'online': False, 'tasks': []}


# ---------- состояние раунда ----------

def members(g, t):
    return [s for s in g['active'] if team(s) == t]


def playable(g, sid):
    return g['hp'].get(sid, 0) > 0 and g['slots'][sid]['kind'] != 'gone'


def next_turn(g, cur):
    # команды ходят по очереди, внутри команды бойцы — по кругу
    t = team(cur)
    for tt in (other(t), t):
        m = members(g, tt)
        if not any(playable(g, s) for s in m):
            continue
        last = g['last_idx'][tt]
        for k in range(1, len(m) + 1):
            s = m[(last + k) % len(m)]
            if playable(g, s):
                return s
    return cur


def set_turn(g, sid):
    g['turn'] = sid
    m = members(g, team(sid))
    g['last_idx'][team(sid)] = m.index(sid)


def new_round(g):
    g['seed'] = random.randint(1, 2_147_000_000)
    g['hp'] = {s: HP_MAX for s in g['active']}
    g['pos'] = {s: None for s in g['active']}
    g['over'] = False
    g['winner'] = None
    g['shot'] = False
    g['last_idx'] = {'left': -1, 'right': -1}
    g['turn_no'] = 0  # сколько ходов прошло: от него зависит рост деревьев
    g['trees'] = {}   # урон деревьям: номер дерева (строкой) -> {dmg, felled}
    first = members(g, g['starter']) or g['active']
    set_turn(g, first[0])
    g['wind'] = new_wind(0.0, g['opts']['wind'])


def leader(g):
    # «ведущий» — первый игрок на связи: он управляет ботами и птицами
    for s in SLOT_ORDER:
        sl = g['slots'].get(s)
        if sl and sl['kind'] == 'human' and sl['online']:
            return s
    return None


def slots_view(g):
    return {s: {'name': sl['name'], 'kind': sl['kind'], 'online': sl['online'],
                'away': sl['kind'] == 'bot' and sl['token'] is not None}
            for s, sl in g['slots'].items()}


def start_payload(g):
    return {
        'type': 'game_started', 'seed': g['seed'], 'wind': g['wind'], 'turn': g['turn'],
        'opts': g['opts'], 'score': g['score'], 'active': g['active'],
        'turn_no': g['turn_no'], 'trees': g['trees'],
        'slots': slots_view(g), 'leader': leader(g),
    }


def full_state(g, sid):
    msg = {
        'type': 'resumed', 'game_id': g['id'], 'slot': sid, 'size': g['opts']['size'], 'bots': g['opts']['bots'],
        'started': g['started'], 'slots': slots_view(g), 'leader': leader(g),
    }
    if g['started']:
        p = start_payload(g)
        p.pop('type')
        msg.update(p)
        msg.update({'hp': g['hp'], 'pos': g['pos'], 'over': g['over'], 'winner': g['winner'], 'shot': g['shot']})
    return msg


# ---------- отправка ----------

async def send(ws, msg):
    if ws is None:
        return
    try:
        await ws.send(json.dumps(msg))
    except Exception:
        pass


async def broadcast(g, msg, exclude=None):
    for sl in list(g['slots'].values()):
        if sl['ws'] is not None and sl['ws'] is not exclude:
            await send(sl['ws'], msg)


async def send_slots(g):
    if g['started']:
        await broadcast(g, {'type': 'slots', 'slots': slots_view(g), 'leader': leader(g)})
    else:
        await broadcast(g, {'type': 'lobby', 'game_id': g['id'], 'slots': slots_view(g), 'leader': leader(g),
                            'size': g['opts']['size'], 'bots': g['opts']['bots']})


def can_control(g, me, sid):
    if sid not in g['slots']:
        return False
    if sid == me:
        return True
    return g['slots'][sid]['kind'] == 'bot' and leader(g) == me


async def finish_turn(g, result):
    """Применяет результат выстрела текущего бойца и передаёт ход."""
    hp = g['hp']
    shooter = g['turn']
    if result:
        kind = result.get('kind')
        if kind == 'player' and result.get('id') in hp:
            dmg = max(0, min(80, int(result.get('dmg', 0))))
            hp[result['id']] = max(0, hp[result['id']] - dmg)
        elif kind == 'bird' and shooter in hp:
            heal = max(0, min(15, int(result.get('heal', 0))))
            hp[shooter] = min(HP_MAX, hp[shooter] + heal)
        elif kind == 'tree' and type(result.get('tree')) is int and 0 <= result['tree'] < 8:
            # деревья считает стрелявший, сервер только запоминает — для тех, кто переподключится
            t = g['trees'].setdefault(str(result['tree']), {'dmg': 0, 'felled': False})
            t['dmg'] += max(0, min(80, int(result.get('tdmg', 0))))
            if result.get('felled'):
                t['felled'] = True
    g['shot'] = False
    alive = {t: any(hp[s] > 0 for s in members(g, t)) for t in ('left', 'right')}
    if not alive['left'] or not alive['right']:
        g['over'] = True
        g['winner'] = 'right' if not alive['left'] else 'left'
        g['score'][g['winner']] += 1
    else:
        set_turn(g, next_turn(g, shooter))
        g['wind'] = new_wind(g['wind'], g['opts']['wind'])
        g['turn_no'] += 1
    await broadcast(g, {
        'type': 'turn_result', 'result': result, 'hp': hp, 'turn': g['turn'], 'wind': g['wind'],
        'game_over': g['over'], 'winner': g['winner'], 'score': g['score'],
        'turn_no': g['turn_no'], 'trees': g['trees'],
    })


async def drop_pending_shot(g):
    # выстрел «повис» (стрелявший пропал) — засчитываем промах, чтобы игра не встала
    if g['started'] and g['shot'] and not g['over']:
        await finish_turn(g, {'kind': 'out', 'x': -100, 'y': 0, 'ang': 0, 'steps': 0})


async def skip_if_unplayable(g):
    # ход у бойца, за которого некому играть (ушёл, ботов нет) — передаём ход дальше
    if g['started'] and not g['over'] and not g['shot'] and g['slots'][g['turn']]['kind'] == 'gone':
        await finish_turn(g, None)


def cancel_tasks(sl):
    for t in sl['tasks']:
        t.cancel()
    sl['tasks'] = []


def release_slot(g, sid):
    """Игрок ушёл насовсем: место освобождается (в игре — бот или пусто)."""
    sl = g['slots'][sid]
    cancel_tasks(sl)
    sl['token'] = None
    sl['ws'] = None
    sl['online'] = False
    if not g['started']:
        sl['kind'] = 'empty'
        sl['name'] = ''
    elif sid in g['active']:
        sl['kind'] = 'bot' if g['opts']['bots'] else 'gone'
        if sl['kind'] == 'bot':
            sl['name'] = ''
    else:
        sl['kind'] = 'empty'


def game_dead(g):
    return all(sl['token'] is None for sl in g['slots'].values())


async def after_leave(g):
    if game_dead(g):
        for sl in g['slots'].values():
            cancel_tasks(sl)
        games.pop(g['id'], None)
        print(f"[-] Игра {g['id']} закрыта")
        return
    await skip_if_unplayable(g)
    await send_slots(g)


async def away_timer(g, sid, token):
    try:
        if g['opts']['bots'] and g['started']:
            await asyncio.sleep(BOT_DELAY)
            sl = g['slots'][sid]
            if sl['token'] == token and not sl['online'] and sl['kind'] == 'human':
                # за отошедшего пока играет бот; вернётся — получит управление обратно
                if g['shot'] and g['turn'] == sid:
                    await drop_pending_shot(g)
                sl['kind'] = 'bot'
                await send_slots(g)
            await asyncio.sleep(RECONNECT_GRACE - BOT_DELAY)
        else:
            await asyncio.sleep(RECONNECT_GRACE)
    except asyncio.CancelledError:
        return
    sl = g['slots'][sid]
    if sl['token'] == token and not sl['online']:
        print(f"[-] Игрок {sid} не вернулся в игру {g['id']}")
        if g['shot'] and g['turn'] == sid:
            await drop_pending_shot(g)
        release_slot(g, sid)
        await after_leave(g)


def free_slot_for_join(g):
    if not g['started']:
        for s in SLOT_ORDER:
            if s in g['slots'] and g['slots'][s]['kind'] == 'empty':
                return s
        return None
    # в идущей игре можно занять место бота или ушедшего
    for s in g['active']:
        sl = g['slots'][s]
        if sl['token'] is None and sl['kind'] in ('bot', 'gone'):
            return s
    return None


def start_game(g):
    active = []
    for s in SLOT_ORDER:
        if s not in g['slots']:
            continue
        sl = g['slots'][s]
        if sl['kind'] == 'human':
            active.append(s)
        elif g['opts']['bots']:
            sl['kind'] = 'bot'
            active.append(s)
    if not any(team(s) == 'left' for s in active) or not any(team(s) == 'right' for s in active):
        return False
    g['active'] = active
    g['started'] = True
    new_round(g)
    return True


async def handler(websocket):
    print(f"[+] Новое подключение: {websocket.remote_address}")
    g = None
    me = None

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            action = data.get('action')

            if action == 'ping':
                await send(websocket, {'type': 'pong'})

            elif action == 'create_game':
                gid = str(uuid.uuid4())[:6].upper()
                while gid in games:
                    gid = str(uuid.uuid4())[:6].upper()
                o = clean_opts(data.get('opts'))
                ids = SLOT_ORDER if o['size'] == 2 else ['L0', 'R0']
                g = {'id': gid, 'opts': o, 'slots': {s: new_slot() for s in ids}, 'active': [],
                     'started': False, 'score': {'left': 0, 'right': 0}, 'starter': 'left'}
                me = 'L0'
                sl = g['slots'][me]
                sl.update(kind='human', ws=websocket, token=uuid.uuid4().hex, name=clean_name(data.get('name')) or 'Игрок 1', online=True)
                games[gid] = g
                await send(websocket, {'type': 'joined', 'game_id': gid, 'slot': me, 'token': sl['token'],
                                       'lan': [f'http://{ip}:{PORT}' for ip in local_ips()]})
                await send_slots(g)
                print(f"[+] Игра {gid} создана ({o['size']} на {o['size']})")

            elif action == 'join_game':
                gid = str(data.get('game_id', '')).upper()
                gg = games.get(gid)
                sid = free_slot_for_join(gg) if gg else None
                if not sid:
                    await send(websocket, {'type': 'error', 'message': 'Игра не найдена или мест нет'})
                    continue
                g, me = gg, sid
                sl = g['slots'][me]
                n = len([s for s in g['slots'].values() if s['token']]) + 1
                sl.update(kind='human', ws=websocket, token=uuid.uuid4().hex, name=clean_name(data.get('name')) or f'Игрок {n}', online=True)
                await send(websocket, {'type': 'joined', 'game_id': gid, 'slot': me, 'token': sl['token']})
                print(f"[+] Игрок вошёл в {gid} на место {me}")
                if g['started']:
                    await send(websocket, full_state(g, me))
                    await send_slots(g)
                elif all(s['kind'] == 'human' for s in g['slots'].values()):
                    start_game(g)
                    await broadcast(g, start_payload(g))
                else:
                    await send_slots(g)

            elif action == 'resume':
                gid = str(data.get('game_id', '')).upper()
                sid = data.get('slot')
                gg = games.get(gid)
                if not gg or sid not in gg['slots'] or gg['slots'][sid]['token'] is None or gg['slots'][sid]['token'] != data.get('token'):
                    await send(websocket, {'type': 'resume_failed'})
                    continue
                g, me = gg, sid
                sl = g['slots'][me]
                old = sl['ws']
                cancel_tasks(sl)
                sl.update(ws=websocket, online=True, kind='human')
                if old is not None and old is not websocket:
                    try:
                        await old.close()
                    except Exception:
                        pass
                await send(websocket, full_state(g, me))
                await send_slots(g)
                print(f"[~] Игрок {me} вернулся в игру {gid}")

            elif g is None:
                continue

            elif action == 'start_game':
                if not g['started'] and leader(g) == me:
                    if start_game(g):
                        await broadcast(g, start_payload(g))
                    else:
                        await send(websocket, {'type': 'error', 'message': 'Нужен хотя бы один игрок в каждой команде (или включите ботов)'})

            elif action == 'state':
                sid = data.get('id')
                if g['started'] and g['turn'] == sid and not g['over'] and not g['shot'] and can_control(g, me, sid):
                    if isinstance(data.get('x'), (int, float)):
                        g['pos'][sid] = data['x']
                    await broadcast(g, {'type': 'remote_state', 'id': sid, 'x': data.get('x'),
                                        'angle': data.get('angle'), 'draw': data.get('draw')}, exclude=websocket)

            elif action == 'shoot':
                sid = data.get('id')
                if not g['started'] or g['over'] or g['shot'] or g['turn'] != sid or not can_control(g, me, sid):
                    continue
                g['shot'] = True
                if isinstance(data.get('x'), (int, float)):
                    g['pos'][sid] = data['x']
                await broadcast(g, {'type': 'arrow_shot', 'id': sid, 'x': data.get('x'), 'angle': data.get('angle'),
                                    'draw': data.get('draw'), 'no': data.get('no')}, exclude=websocket)

            elif action == 'bird_spawn':
                if leader(g) == me:
                    await broadcast(g, {'type': 'bird_spawn', 'birds': data.get('birds', [])}, exclude=websocket)

            elif action == 'arrow_result':
                sid = data.get('id')
                if g['started'] and not g['over'] and g['shot'] and g['turn'] == sid and can_control(g, me, sid):
                    await finish_turn(g, data.get('result') or {})

            elif action == 'restart':
                if g['started']:
                    if g['over']:
                        g['starter'] = other(g['winner'])  # следующий раунд начинает проигравшая команда
                    new_round(g)
                    await broadcast(g, start_payload(g))

            elif action == 'leave':
                if g['slots'][me]['ws'] is websocket:
                    if g['shot'] and can_control(g, me, g['turn']):
                        await drop_pending_shot(g)
                    release_slot(g, me)
                    await after_leave(g)
                g, me = None, None

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"[!] Ошибка: {e}")
    finally:
        print(f"[-] Соединение закрыто: {websocket.remote_address}")
        if g and me and g['slots'][me]['ws'] is websocket:
            sl = g['slots'][me]
            was_leader = leader(g) == me
            sl['ws'] = None
            sl['online'] = False
            # стрелял бот этого игрока — результат уже не придёт
            if was_leader and g['shot'] and g['slots'][g['turn']]['kind'] == 'bot':
                await drop_pending_shot(g)
            sl['tasks'].append(asyncio.create_task(away_timer(g, me, sl['token'])))
            await send_slots(g)


def http_response(status, reason, body, content_type):
    headers = Headers([
        ('Content-Type', content_type),
        ('Content-Length', str(len(body))),
        ('Cache-Control', 'no-cache'),
        ('Connection', 'close'),
    ])
    return Response(status, reason, headers, body)


# файлы игры, которые сервер отдаёт браузеру: путь -> (файл, тип)
STATIC = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/room.js': ('room.js', 'text/javascript; charset=utf-8'),
    '/sw.js': ('sw.js', 'text/javascript; charset=utf-8'),
    '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json; charset=utf-8'),
    '/icons/icon-180.png': ('icons/icon-180.png', 'image/png'),
    '/icons/icon-192.png': ('icons/icon-192.png', 'image/png'),
    '/icons/icon-512.png': ('icons/icon-512.png', 'image/png'),
}


def process_request(connection, request):
    # обычный HTTP-запрос из браузера — отдаём файлы игры,
    # WebSocket-запросы пропускаем дальше в handler
    if request.headers.get('Upgrade', '').lower() == 'websocket':
        return None
    path = request.path.split('?')[0]
    if path == '/archer-server.json':
        # по этому адресу страница понимает, что её отдал server.py и можно играть через него
        body = json.dumps({'archer': True, 'lan': [f'http://{ip}:{PORT}' for ip in local_ips()]}).encode('utf-8')
        return http_response(200, 'OK', body, 'application/json; charset=utf-8')
    if path in STATIC:
        name, ctype = STATIC[path]
        with open(os.path.join(HERE, name), 'rb') as f:
            return http_response(200, 'OK', f.read(), ctype)
    return http_response(404, 'Not Found', 'Не найдено'.encode('utf-8'), 'text/plain; charset=utf-8')


def local_ips():
    # первым идёт адрес основного сетевого адаптера (через который идёт интернет)
    primary = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        primary = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    others = set()
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith(('127.', '169.254.')) and ip != primary:
                others.add(ip)
    except OSError:
        pass
    return ([primary] if primary else []) + sorted(others)


async def main():
    print("=" * 56)
    print("  🏹 Сервер 'Лучник' запущен")
    print("=" * 56)
    print("  На этом компьютере откройте в браузере:")
    print(f"      http://localhost:{PORT}")
    ips = local_ips()
    if ips:
        print("  С телефонов/планшетов в той же Wi-Fi сети:")
        print(f"      http://{ips[0]}:{PORT}")
        if len(ips) > 1:
            print("  Если не открывается, попробуйте другие адреса:")
            for ip in ips[1:]:
                print(f"      http://{ip}:{PORT}")
    print("  Не закрывайте это окно, пока идёт игра.")
    print("=" * 56, flush=True)
    async with websockets.serve(handler, "0.0.0.0", PORT, process_request=process_request):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
