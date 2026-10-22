"""Запасной сервер «Лучника» для игры по Wi-Fi без интернета.

Сам он правил игры не знает: комната (room.js) работает в браузере того,
кто создал игру, — так же, как в режиме P2P. Сервер только:
  * отдаёт браузерам файлы игры;
  * пересылает сообщения между создателем игры («хостом») и остальными.

Протокол пересылки (JSON по WebSocket):
  хост  -> {action:'relay_host', game_id}         ответ {type:'relay_ok'} или {type:'relay_taken'}
  гость -> {action:'relay_join', game_id}         нет хоста — {type:'relay_nohost'} и разрыв;
           дальше любые сообщения гостя уходят хосту как {type:'relay_msg', cid, data}
  хосту приходят {type:'relay_open', cid} / {type:'relay_close', cid}
  хост  -> {action:'relay_send', cid, data}       data уходит гостю как есть
  хост  -> {action:'relay_close', cid}            отключить гостя
Ушёл хост — сервер отключает его гостей: они переподключатся, когда хост вернётся.
"""
import asyncio
import json
import os
import socket

import websockets
from websockets.datastructures import Headers
from websockets.http11 import Response

PORT = int(os.environ.get('ARCHER_PORT', 8765))
HERE = os.path.dirname(os.path.abspath(__file__))

# game_id -> {'host': ws, 'guests': {cid: ws}}
rooms = {}
next_cid = 0


async def send(ws, msg):
    try:
        await ws.send(json.dumps(msg, ensure_ascii=False))
    except Exception:
        pass


async def close(ws):
    try:
        await ws.close()
    except Exception:
        pass


def clean_id(v):
    return str(v or '').strip().upper()[:12]


async def serve_host(ws, gid):
    room = rooms.get(gid)
    if room and room['host'] is not ws:
        await send(ws, {'type': 'relay_taken'})
        return
    room = rooms[gid] = {'host': ws, 'guests': {}}
    await send(ws, {'type': 'relay_ok', 'game_id': gid})
    print(f"[+] Игра {gid}: хост на связи")
    try:
        async for raw in ws:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            g = room['guests'].get(m.get('cid'))
            if m.get('action') == 'relay_send' and g is not None:
                await send(g, m.get('data'))
            elif m.get('action') == 'relay_close' and g is not None:
                await close(g)
    finally:
        if rooms.get(gid) is room:
            del rooms[gid]
        for g in list(room['guests'].values()):
            await close(g)
        print(f"[-] Игра {gid}: хост ушёл")


async def serve_guest(ws, gid):
    global next_cid
    room = rooms.get(gid)
    if not room:
        await send(ws, {'type': 'relay_nohost'})
        return
    next_cid += 1
    cid = next_cid
    room['guests'][cid] = ws
    await send(room['host'], {'type': 'relay_open', 'cid': cid})
    try:
        async for raw in ws:
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            await send(room['host'], {'type': 'relay_msg', 'cid': cid, 'data': data})
    finally:
        room['guests'].pop(cid, None)
        if rooms.get(gid) is room:
            await send(room['host'], {'type': 'relay_close', 'cid': cid})


async def handler(ws):
    try:
        first = json.loads(await ws.recv())
        action = first.get('action')
        gid = clean_id(first.get('game_id'))
        if not gid:
            return
        if action == 'relay_host':
            await serve_host(ws, gid)
        elif action == 'relay_join':
            await serve_guest(ws, gid)
    except (websockets.exceptions.ConnectionClosed, ValueError):
        pass
    except Exception as e:
        print(f"[!] Ошибка: {e}")


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
        body = json.dumps({'archer': True, 'relay': 2, 'lan': [f'http://{ip}:{PORT}' for ip in local_ips()]}).encode('utf-8')
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
