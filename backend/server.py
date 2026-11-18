"""清单工作台 — 本地服务
======================
`wx-workbench` 的**薄封装**：数据抽取、会话归属、记录聚合全部复用
`../wx-workbench/pipeline.py`，本文件只负责 HTTP、静态资源与 6 个接口。

接口
----
GET  /                     工作台页面
GET  /ui/*                 静态资源
GET  /api/state            rebuild() 后返回最新快照
GET  /api/ping             {app, ver, token}，写操作鉴权用
POST /api/record           透传 pipeline.set_record（改派 / 完成 / 改截止日）
POST /api/project          透传 pipeline.set_project（整项目完成 / 恢复）
POST /api/refresh          后台线程跑 pipeline.extract()，立即返回
GET  /api/refresh/status   {running, step, pct, error}

端口默认 8790（桌面版用 8792），与 8770 / 8780 上的另两个工作台互不干扰。
"""
from __future__ import annotations

import json
import os
import secrets
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = int(os.environ.get("LISTWB_PORT") or 8790)

# HTTP 访问日志：内存环形缓冲；轮询类接口不计入，避免自刷爆
import collections as _collections
HTTP_LOG = _collections.deque(maxlen=400)
_HTTPLOG_LOCK = threading.Lock()


def _app_version() -> str:
    """应用版本：CI 发版时写入仓库根的 VERSION 文件，随包分发。"""
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(STATIC, "VERSION"),
                 os.path.join(os.path.dirname(STATIC), "VERSION"),
                 os.path.join(here, "VERSION"),
                 os.path.join(os.path.dirname(here), "VERSION")):
        try:
            if os.path.isfile(cand):
                with open(cand, encoding="utf-8") as f:
                    v = f.read().strip()
                if v:
                    return v
        except Exception:
            continue
    return ""
APP_NAME = "list-workbench"

# 每次启动换一个令牌：写操作必须带 X-WB-Token。
# 自定义请求头会触发 CORS 预检，而本服务从不返回 Access-Control-Allow-Origin，
# 因此跨站页面既发不出带令牌的请求，也读不到 /api/ping 里的令牌。
TOKEN = secrets.token_urlsafe(18)

BASE = os.path.dirname(os.path.abspath(__file__))
# 桌面版：安装目录只读，可写数据放在 %LOCALAPPDATA%；静态资源随包分发
STATIC = os.environ.get("LISTWB_STATIC") or BASE
SIBLING = os.environ.get("LISTWB_PIPELINE") or os.path.normpath(
    os.path.join(BASE, "..", "wx-workbench"))

# 复用老项目的数据层：sys.path 指过去后 pipeline 自己的 BASE 仍是 wx-workbench，
# 所以读写的是同一份 data/state.json、data/records.json、cache/extract.json。
if not os.path.isdir(SIBLING):
    SIBLING = BASE   # 桌面打包后 pipeline.py 与 server.py 同目录
sys.path.insert(0, SIBLING)
import pipeline  # noqa: E402

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".png": "image/png",
}

# 采集进度。pipeline 本身不维护进度状态，这里挂在模块上，
# 既让本服务可读，也满足「读 pipeline.PROGRESS」的约定。
PROGRESS = {"running": False, "step": "空闲", "pct": 0.0, "error": None, "at": None}
pipeline.PROGRESS = PROGRESS

_refresh_lock = threading.Lock()


def run_refresh():
    """后台采集：decrypt → 抽样 → 聚合。进度写进 PROGRESS。"""
    try:
        def cb(step, pct):
            PROGRESS["step"] = step
            PROGRESS["pct"] = max(0.0, min(1.0, float(pct)))

        ex = pipeline.extract(cb)
        PROGRESS["step"] = "聚合进度看板"
        PROGRESS["pct"] = 0.99
        pipeline.build_state(ex)
        PROGRESS.update({"running": False, "step": "完成", "pct": 1.0, "error": None,
                         "at": time.strftime("%H:%M:%S")})
    except Exception as e:  # 采集失败不能拖垮服务
        PROGRESS.update({"running": False, "step": "失败", "pct": 0.0,
                         "error": str(e), "at": time.strftime("%H:%M:%S")})
        traceback.print_exc()


PROJECTS_JSON = getattr(pipeline, "PROJECTS", os.path.join(BASE, "projects.json"))
PROJECTS_BAK = PROJECTS_JSON + ".bak"
LEVELS = ("P0", "P1", "P2", "P3")


def _read_projects():
    import json as _json
    with open(PROJECTS_JSON, "r", encoding="utf-8") as f:
        return _json.load(f)


def _write_projects(doc):
    import json as _json
    import shutil
    # 先留一份上一版，写坏了还能救
    try:
        shutil.copyfile(PROJECTS_JSON, PROJECTS_BAK)
    except Exception:
        pass
    tmp = PROJECTS_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        _json.dump(doc, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PROJECTS_JSON)


def _new_key(text):
    import hashlib
    import time as _t
    h = hashlib.sha1((text + str(_t.time())).encode("utf-8")).hexdigest()[:8]
    return "m-" + h


def manual_apply(body):
    """op=add|update|del。文本必填，等级限定 P0..P3，截止日允许空。"""
    op = str(body.get("op") or "").strip()
    pid = str(body.get("project") or "").strip()
    if op not in ("add", "update", "del"):
        raise ValueError("op 只能是 add / update / del")

    doc = _read_projects()
    proj = None
    for p in doc.get("projects", []):
        if p.get("id") == pid:
            proj = p
            break
    if proj is None:
        raise ValueError("项目不存在：%s" % pid)

    items = proj.setdefault("open", [])
    key = str(body.get("key") or "").strip()

    # 前端只知道记录 id（c-<hash>），不知道 key。这里按 pipeline 的同一套规则反查。
    if not key and body.get("id"):
        rid = str(body.get("id")).strip()
        for it in items:
            try:
                if pipeline._rid("c-", pid, it.get("key") or it.get("text") or "") == rid:
                    key = str(it.get("key") or "").strip()
                    break
            except Exception:
                continue

    if op == "add":
        text = str(body.get("text") or "").strip()
        if not text:
            raise ValueError("内容不能为空")
        level = str(body.get("level") or "P2").upper()
        if level not in LEVELS:
            raise ValueError("等级只能是 P0-P3")
        items.append({
            "level": level,
            "key": key or _new_key(text),
            "text": text,
            "owner": str(body.get("owner") or "").strip(),
            "due": str(body.get("due") or "").strip(),
        })

    else:
        if not key:
            raise ValueError("缺少 key")
        idx = next((i for i, it in enumerate(items) if it.get("key") == key), -1)
        if idx < 0:
            raise ValueError("找不到这条人工记录（可能来自会话抽取，不能在这里改）")
        if op == "del":
            items.pop(idx)
        else:
            it = items[idx]
            if not it.get("key"):
                it["key"] = _new_key(it.get("text") or "")
            if "text" in body:
                text = str(body.get("text") or "").strip()
                if not text:
                    raise ValueError("内容不能为空")
                it["text"] = text
            if "level" in body:
                level = str(body.get("level") or "").upper()
                if level not in LEVELS:
                    raise ValueError("等级只能是 P0-P3")
                it["level"] = level
            if "due" in body:
                it["due"] = str(body.get("due") or "").strip()
            if "owner" in body:
                it["owner"] = str(body.get("owner") or "").strip()

    _write_projects(doc)
    pipeline.rebuild()
    return pipeline.rebuild()


class Handler(BaseHTTPRequestHandler):
    server_version = "ListWorkbench/1.0"

    def log_message(self, fmt, *args):
        try:
            msg = fmt % args
        except Exception:
            msg = str(fmt)
        low = msg.lower()
        if "refresh/status" in low or "favicon" in low:
            return
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), msg))

    # ---------------- 输出辅助 ----------------
    def _send(self, code, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if getattr(self, "_head_only", False):
            return
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    def log_message(self, fmt, *args):
        """覆写默认 stderr 访问日志：进内存环，页面里可查看。"""
        try:
            path = self.path.split("?")[0]
            if path in ("/api/ping", "/api/httplog", "/api/httplog/clear"):
                return
            try:
                msg = fmt % args
            except Exception:
                msg = fmt
            with _HTTPLOG_LOCK:
                HTTP_LOG.append(time.strftime("%H:%M:%S") + "  " + (msg.replace('"', '') if isinstance(msg, str) else str(msg)))
        except Exception:
            pass

    def _snap(self):
        st = pipeline.rebuild()
        st["desktop"] = bool(os.environ.get("LISTWB_DESKTOP"))
        st["appVersion"] = _app_version()
        return st

    def _file(self, rel: str):
        path = os.path.normpath(os.path.join(STATIC, rel.lstrip("/")))
        if not path.startswith(STATIC) or not os.path.isfile(path):
            self._err(404, "not found")
            return
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as f:
            self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))

    # ---------------- 路由 ----------------
    def do_HEAD(self):
        self._head_only = True
        self.do_GET()

    def do_GET(self):
        p = self.path.split("?")[0]
        try:
            if p in ("/", "/index.html"):
                self._file("ui/index.html")
            elif p.startswith("/ui/"):
                self._file(p[1:])
            elif p == "/api/state":
                self._json(self._snap())
            elif p == "/api/ping":
                self._json({"app": APP_NAME, "ver": 1, "token": TOKEN})
            elif p == "/api/refresh/status":
                self._json(PROGRESS)
            elif p == "/api/httplog":
                with _HTTPLOG_LOCK:
                    items = list(HTTP_LOG)
                items.reverse()                 # 最新在前
                self._json({"items": items})
            else:
                self._err(404, "not found")
        except Exception as e:
            traceback.print_exc()
            self._err(500, str(e))

    def _guard(self) -> bool:
        """拒绝跨站写操作：校验 Origin（若有）与令牌。"""
        origin = self.headers.get("Origin")
        if origin:
            host = self.headers.get("Host", "")
            local = any(k in origin for k in ("127.0.0.1", "localhost", "[::1]"))
            if not local or (host and host not in origin):
                self._err(403, "forbidden origin")
                return False
        if self.headers.get("X-WB-Token") != TOKEN:
            self._err(403, "invalid token")
            return False
        return True

    def do_POST(self):
        p = self.path.split("?")[0]
        if not self._guard():
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if p == "/api/refresh":
            with _refresh_lock:
                if PROGRESS["running"]:
                    self._json({"started": False, "reason": "已在采集中"})
                    return
                PROGRESS.update({"running": True, "step": "准备中", "pct": 0.0,
                                 "error": None, "at": None})
            threading.Thread(target=run_refresh, daemon=True).start()
            self._json({"started": True})
            return

        if p == "/api/record":
            try:
                body = json.loads(raw or b"{}")
                rid = body["id"]
            except Exception:
                self._err(400, "参数不完整")
                return
            try:
                pipeline.set_record(rid, body.get("project"), body.get("status"),
                                    body.get("due"))
                self._json(self._snap())
            except ValueError as e:
                self._err(400, str(e))
            except Exception as e:
                self._err(500, str(e))
            return

        if p == "/api/quit":
            if not os.environ.get("LISTWB_DESKTOP"):
                self._err(403, "仅桌面版支持退出")
                return
            self._json({"bye": True})
            threading.Timer(0.2, lambda: os._exit(0)).start()
            return

        if p == "/api/manual":
            # 人工记录：增 / 改 / 删。落在 wx-workbench/projects.json 的 projects[].open，
            # 这是三个工作台共用的配置源，所以改完必须 rebuild 让状态立刻一致。
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                self._err(400, "参数不是合法 JSON")
                return
            try:
                self._json(manual_apply(body))
            except ValueError as e:
                self._err(400, str(e))
            except Exception as e:
                self._err(500, str(e))
            return

        if p == "/api/project":
            try:
                body = json.loads(raw or b"{}")
                pipeline.set_project(body["id"], body.get("status", "done"))
                self._json(self._snap())
            except Exception as e:
                self._err(400, str(e))
            return

        if p == "/api/httplog/clear":
            with _HTTPLOG_LOCK:
                HTTP_LOG.clear()
            self._json({"ok": True})
            return

        if p == "/api/project/hide":
            # 软隐藏：项目从所有列表与统计中消失（pipeline 已剔除），
            # 数据原样保留，可随时恢复。识别错的项目、已完结的项目用这个。
            try:
                body = json.loads(raw or b"{}")
                pid = body["id"]
                if body.get("hidden", True):
                    pipeline.remove_project(pid)
                    # 合成项目（如 __other__）不在配置里，remove_project 拿不到名字
                    if body.get("name"):
                        data = pipeline.read_json(pipeline.REMOVED, {})
                        if pid in data and not data[pid].get("name"):
                            data[pid]["name"] = str(body["name"])
                            pipeline.write_json(pipeline.REMOVED, data)
                else:
                    pipeline.restore_project(pid)
                self._json(self._snap())
            except Exception as e:
                self._err(400, str(e))
            return

        self._err(404, "not found")


def pick_port(start: int = DEFAULT_PORT, tries: int = 25) -> int:
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("找不到可用端口")


def existing_instance(port: int) -> bool:
    """该端口上已跑着本工作台时不再另起实例（老工作台返回的是别的 app 名）。"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=2) as r:
            return r.status == 200 and APP_NAME.encode() in r.read(200)
    except Exception:
        return False


def main():
    if existing_instance(DEFAULT_PORT):
        url = f"http://127.0.0.1:{DEFAULT_PORT}/"
        print("=" * 58)
        print("  清单工作台已在运行，直接打开现有实例：")
        print(f"  {url}")
        print("=" * 58)
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        time.sleep(1.5)
        return

    port = pick_port(DEFAULT_PORT)
    url = f"http://127.0.0.1:{port}/"

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("=" * 58)
    print("  清单工作台 — List Workbench")
    print(f"  {url}")
    print(f"  数据层：{SIBLING}")
    print("  仅监听本机回环地址，不对外暴露")
    print("  Ctrl+C 停止")
    print("=" * 58)

    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
