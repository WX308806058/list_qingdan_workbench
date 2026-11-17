"""
微信工作记录采集流水线
=====================
两段式架构：

    extract()      解密 + 抽取会话消息  → cache/extract.json   （慢，2~3 秒，需重新解密）
    build_state()  按配置聚合出进度看板  → data/state.json      （快，约 50ms）

之所以拆开，是因为「把某条记录改派到别的项目」「手动标记完成」这类操作
不该反复解密 190MB 数据库。改派只写 data/records.json，然后重建 state。

记录（record）是一等实体：
    - 人工记录  来自 projects.json 的 open，id = c-<项目>-<文本哈希>
    - 自动记录  来自近 72 小时消息识别，id = a-<会话+文本哈希>
    id 稳定，所以改派/完成的结果能在下次刷新后继续生效。
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import datetime as dt
import fnmatch
import glob
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(BASE, "cache")
DATA = os.path.join(BASE, "data")
DEC = os.path.join(CACHE, "dec")
MANIFEST = os.path.join(CACHE, "manifest.json")
CURSOR = os.path.join(CACHE, "cursor.json")
MANUAL_MAP = os.path.join(CACHE, "manual_map.json")
EXTRACT = os.path.join(CACHE, "extract.json")
ALIASES = os.path.join(CACHE, "aliases.json")
PROJECTS = os.path.join(BASE, "projects.json")
STATE = os.path.join(DATA, "state.json")
RECORDS = os.path.join(DATA, "records.json")
PROJ_STATUS = os.path.join(DATA, "projects_status.json")
REMOVED = os.path.join(DATA, "projects_removed.json")

KEY_CANDIDATES = [
    os.path.join(CACHE, "wx_keys.json"),
    r"C:\Users\OAO\.workbuddy\wx_keys.json",
]

WANTED_DBS = (["session/session.db", "contact/contact.db", "contact/contact_fts.db"]
              + [f"message/message_{i}.db" for i in range(10)])

PAGE, SALT_SZ, IV, HS = 4096, 16, 16, 64
RS = (IV + HS + 15) // 16 * 16
KEY_SZ = 32


# --------------------------------------------------------------------------
# WeChat 数据目录发现
# --------------------------------------------------------------------------
def find_db_root() -> str:
    env = os.environ.get("WX_WORKBENCH_DB_ROOT")
    if env and os.path.isdir(env):
        return env

    cfg = os.path.join(CACHE, "db_root.txt")
    if os.path.isfile(cfg):
        p = open(cfg, encoding="utf-8").read().strip()
        if os.path.isdir(p):
            return p

    roots = []
    for drive in ("C", "D", "E", "F", "G"):
        d = drive + ":\\"
        for rel in (r"Program Files (x86)\xwechat_files\*\db_storage",
                    r"Program Files\xwechat_files\*\db_storage",
                    r"xwechat_files\*\db_storage",
                    r"Users\*\Documents\xwechat_files\*\db_storage",
                    r"Users\*\Documents\WeChat Files\*\db_storage"):
            roots.extend(glob.glob(os.path.join(d, rel)))
    roots = [p for p in roots if os.path.isdir(p)]

    if not roots:
        raise RuntimeError(
            "未找到微信数据目录（xwechat_files/*/db_storage）。"
            "请在 cache/db_root.txt 中写入 db_storage 的完整路径，"
            "或设置环境变量 WX_WORKBENCH_DB_ROOT。"
        )
    roots.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    best = roots[0]
    os.makedirs(CACHE, exist_ok=True)
    with open(cfg, "w", encoding="utf-8") as f:
        f.write(best)
    return best


def find_db_root_safe() -> str | None:
    try:
        return find_db_root()
    except Exception:
        return None


def keys_available() -> bool:
    return any(os.path.isfile(p) for p in KEY_CANDIDATES)


# --------------------------------------------------------------------------
# AES-256-CBC（Windows CNG，无需 pycryptodome）
# --------------------------------------------------------------------------
_bcrypt = ctypes.WinDLL("bcrypt")
_bcrypt.BCryptOpenAlgorithmProvider.argtypes = [ctypes.POINTER(wt.HANDLE), wt.LPCWSTR, wt.LPCWSTR, wt.DWORD]
_bcrypt.BCryptSetProperty.argtypes = [wt.HANDLE, wt.LPCWSTR, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_ulong]
_bcrypt.BCryptGenerateSymmetricKey.argtypes = [wt.HANDLE, ctypes.POINTER(wt.HANDLE), ctypes.c_char_p,
                                               ctypes.c_ulong, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_ulong]
_bcrypt.BCryptDecrypt.argtypes = [wt.HANDLE, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_char_p, ctypes.c_char_p,
                                  ctypes.c_ulong, ctypes.c_char_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                                  ctypes.c_ulong]


class AesEngine:
    def __init__(self, key: bytes):
        self.h_alg = wt.HANDLE()
        if _bcrypt.BCryptOpenAlgorithmProvider(ctypes.byref(self.h_alg), "AES", None, 0) != 0:
            raise RuntimeError("BCryptOpenAlgorithmProvider 失败")
        mode = ("ChainingModeCBC\0").encode("utf-16-le")
        _bcrypt.BCryptSetProperty(self.h_alg, "ChainingMode", mode, len(mode), 0)
        self.h_key = wt.HANDLE()
        if _bcrypt.BCryptGenerateSymmetricKey(self.h_alg, ctypes.byref(self.h_key), None, 0, key, len(key), 0) != 0:
            raise RuntimeError("BCryptGenerateSymmetricKey 失败")

    def cbc(self, data: bytes, iv: bytes) -> bytes:
        iv_buf = ctypes.create_string_buffer(iv, len(iv))
        out = ctypes.create_string_buffer(len(data))
        n = ctypes.c_ulong(0)
        st = _bcrypt.BCryptDecrypt(self.h_key, data, len(data), None, iv_buf, len(iv),
                                   out, len(out), ctypes.byref(n), 0)
        if st != 0:
            raise RuntimeError(f"BCryptDecrypt 失败 {st:#x}")
        return out.raw[: n.value]

    def close(self):
        try:
            _bcrypt.BCryptDestroyKey(self.h_key)
            _bcrypt.BCryptCloseAlgorithmProvider(self.h_alg, 0)
        except Exception:
            pass


def decrypt_db(src: str, dst: str, key: bytes) -> None:
    """按页解密 WCDB 库：首页去掉 16 字节 salt，页尾 80 字节为 IV+HMAC 保留区。"""
    eng = AesEngine(key)
    try:
        with open(src, "rb") as f:
            raw = f.read()
        parts = []
        for i in range(0, len(raw) - PAGE + 1, PAGE):
            pg = raw[i:i + PAGE]
            if i == 0:
                pg = pg[SALT_SZ:]
            body, tail = pg[:-RS], pg[-RS:]
            dec = eng.cbc(body, tail[:IV])
            if i == 0:
                dec = b"SQLite format 3\x00" + dec
            parts.append(dec + b"\0" * RS)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = dst + ".part"
        with open(tmp, "wb") as f:
            f.write(b"".join(parts))
        os.replace(tmp, dst)
    finally:
        eng.close()


# --------------------------------------------------------------------------
# 结构辅助
# --------------------------------------------------------------------------
def load_keys() -> dict:
    for p in KEY_CANDIDATES:
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    raise RuntimeError(
        "缺少密钥文件 wx_keys.json。\n"
        "工作台无法自行从内存提取密钥，需要先运行密钥提取脚本生成 "
        "cache/wx_keys.json（格式：salt -> {key, db, kdf}）。"
    )


def wechat_running() -> bool:
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq Weixin.exe"],
                             capture_output=True, timeout=8).stdout
        return b"Weixin.exe" in out
    except Exception:
        return False


def self_wxid(db_root: str) -> str | None:
    """从数据目录名推断当前登录账号的 wxid，如 wxid_abc_883b -> wxid_abc。"""
    name = os.path.basename(os.path.dirname(db_root.rstrip("\\/")))
    if "_" in name:
        return name.rsplit("_", 1)[0]
    return name or None


def load_member_names() -> dict[str, str]:
    """
    群成员昵称。微信把「非好友群成员」的群昵称只存在 contact_fts.db 的
    chatroom_member_fts_v3_content(a_group_remark, room_id, member_id) 里，
    再借 name2id 把 member_id 还原成 wxid。
    """
    p = os.path.join(DEC, "contact", "contact_fts.db")
    if not os.path.isfile(p):
        return {}
    out: dict[str, str] = {}
    try:
        c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        n2i = {r[0]: r[1] for r in c.execute("select rowid, username from name2id")}
        for nm, _rid, mid in c.execute("select c0, c1, c2 from chatroom_member_fts_v3_content"):
            w = n2i.get(mid)
            if not w or not nm:
                continue
            nm = str(nm).strip()
            if nm and (w not in out or len(nm) > len(out[w])):
                out[w] = nm
        c.close()
    except Exception:
        return {}
    return out


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def clean_decrypted() -> dict:
    """删除 cache/dec 下的明文库（下次刷新会自动重新解密，代价约 3 秒）。"""
    before = dir_size(DEC)
    if os.path.isdir(DEC):
        shutil.rmtree(DEC, ignore_errors=True)
    os.makedirs(DEC, exist_ok=True)
    if os.path.isfile(MANIFEST):
        os.remove(MANIFEST)
    return {"freedMB": round(before / 1048576, 1)}


# --------------------------------------------------------------------------
# 解密阶段（增量）
# --------------------------------------------------------------------------
def refresh_decrypted(db_root: str, keys: dict, progress) -> tuple[list[str], list[str]]:
    manifest = read_json(MANIFEST, {})
    done, skipped, errors = [], [], []

    for rel in WANTED_DBS:
        rel_fs = rel.replace("/", os.sep)
        src = os.path.join(db_root, rel_fs)
        if not os.path.isfile(src):
            continue

        st = os.stat(src)
        sig = {"size": st.st_size, "mtime": int(st.st_mtime)}
        dst = os.path.join(DEC, rel_fs)

        if manifest.get(rel) == sig and os.path.isfile(dst):
            skipped.append(rel)
            continue

        try:
            with open(src, "rb") as f:
                salt = f.read(SALT_SZ).hex()
            info = keys.get(salt)
            if not info:
                errors.append(f"{rel}: 密钥表里没有该库的 salt ({salt[:8]}…)")
                continue
            progress(f"解密 {rel.split('/')[-1]}", 0.05 + 0.65 * (len(done) + len(skipped)) / len(WANTED_DBS))

            tmpdir = os.path.join(CACHE, "tmp")
            os.makedirs(tmpdir, exist_ok=True)
            snap = os.path.join(tmpdir, os.path.basename(rel_fs))
            shutil.copyfile(src, snap)
            decrypt_db(snap, dst, bytes.fromhex(info["key"]))
            os.remove(snap)

            manifest[rel] = sig
            done.append(rel)
        except Exception as e:
            errors.append(f"{rel}: {e}")

    write_json(MANIFEST, manifest)
    return done, errors


# --------------------------------------------------------------------------
# 消息解码
# --------------------------------------------------------------------------
def _zstd():
    try:
        import zstandard
        return zstandard.ZstdDecompressor()
    except Exception:
        return None


ZSTD = _zstd()

TYPE_LABEL = {3: "[图片]", 34: "[语音]", 42: "[名片]", 43: "[视频]", 47: "[表情]",
              48: "[位置]", 50: "[通话]"}

# 49 = appmsg，涵盖文件 / 链接 / 小程序 / 引用
FILE_EXT = (r"pdf|docx?|xlsx?|pptx?|zip|rar|7z|sql|txt|csv|md|json|xml|png|jpe?g|gif|bmp|"
            r"webp|mp4|mov|avi|mkv|wav|mp3|eml|msg|bak|dmp|log")

SYSTEM_TYPES = (10000, 10002)


def norm_type(local_type) -> int:
    # 微信 4.x 的 local_type 是复合值：低 32 位为真实类型，高位是子类型
    try:
        return int(local_type) & 0xFFFFFFFF
    except Exception:
        return 0


def decode_content(value) -> str:
    if isinstance(value, bytes):
        if value[:4] == b"\x28\xb5\x2f\xfd":
            if ZSTD is None:
                return ""
            try:
                value = ZSTD.decompress(value)
            except Exception:
                return ""
        try:
            return value.decode("utf-8", "replace")
        except Exception:
            return ""
    return value or ""


def appmsg_label(content: str) -> str:
    # appmsg 只取标题，绝不把 XML/二进制正文当消息文本
    if "<?xml" in content[:120] or "<appmsg" in content[:200] or "<msg" in content[:120]:
        m = re.search(r"<title>(.*?)</title>", content, re.S)
        if m and m.group(1).strip():
            t = re.sub(r"\s+", " ", m.group(1)).strip()
            return "[文件] " + t[:80]
    m = re.match(rf"\s*(?:wxid_\w+:\s*)?([^\s]{{1,90}}\.(?:{FILE_EXT}))\b", content, re.I)
    if m:
        return "[文件] " + m.group(1)[:80]
    return "[文件]"


def flatten(local_type: int, content: str) -> str:
    lt = norm_type(local_type)
    if lt == 49:
        return appmsg_label(content)
    if lt in TYPE_LABEL:
        return TYPE_LABEL[lt]
    content = re.sub(r"<[^>]+>", " ", content)
    content = re.sub(r"\bwxid_[0-9A-Za-z]+:\s*", "", content)
    content = re.sub(r"\s+", " ", content).strip()
    if len(content) > 400:
        content = content[:400] + "…"
    return content


# --------------------------------------------------------------------------
# 自动待办识别
# --------------------------------------------------------------------------
RE_TODO = re.compile(
    r"(待查|待确认|待定|未闭环|还没|没改好|没生效|不生效|不可用|打不开|"
    r"报错|失败|异常|超时|挂了|宕机|500|502|503|不通|"
    r"排查|查一下|看一下|看看|确认一下|核对|跟进|"
    r"明天|尽快|本周|麻烦|需要|能否|是否可以|什么时候|多久)"
)
RE_DONE = re.compile(
    r"(已改好|已修复|已上线|已完成|已发|已寄出|已处理|已删除|已开通|已补|"
    r"恢复了|解决了|搞定了|可以了|通过了|验证通过|没问题了|正常了)"
)
RE_NOISE = re.compile(r"^\[(图片|表情|语音|视频|位置|通话|系统|名片|文件)\]")
RE_QUOTE = re.compile(r"^(wxid_[\w]+|[a-zA-Z0-9_\-]{6,}):\s*")


def strip_quote(text: str) -> str:
    """引用回复的正文形如「wxid_xxx: 原文\\n新内容」，剥掉引用头。"""
    t = RE_QUOTE.sub("", text)
    if "\n" in text:
        parts = [p.strip() for p in text.split("\n") if p.strip()]
        if parts:
            t = RE_QUOTE.sub("", parts[-1])
    return t


def _norm(s: str) -> str:
    return re.sub(r"[\s\W_]+", "", s)[:24]


def _shingles(s: str, n: int = 3) -> set[str]:
    s = re.sub(r"[\s\W_]+", "", s)
    if len(s) < n:
        return {s}
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def similar(a: set[str], b: set[str]) -> bool:
    if not a or not b:
        return False
    return len(a & b) / max(1, min(len(a), len(b))) > 0.55


def is_candidate_todo(text: str) -> bool:
    if not text or len(text) < 8 or RE_NOISE.match(text):
        return False
    if RE_DONE.search(text):
        return False
    return bool(RE_TODO.search(text))


# ==========================================================================
# 第一段：extract（慢）
# ==========================================================================
def extract(progress=None) -> dict:
    if progress is None:
        progress = lambda step, pct: None

    t0 = time.time()
    progress("读取配置", 0.02)
    cfg = read_json(PROJECTS, {"config": {}, "projects": []})
    window_days = int(cfg.get("config", {}).get("windowDays", 14))
    exclude = cfg.get("config", {}).get("exclude", [])

    warnings: list[str] = []
    if wechat_running():
        warnings.append("微信正在运行：最新消息可能仍留在 WAL 未落盘，本次结果或缺少最后几条。退出微信后刷新可拿到完整数据。")

    progress("加载密钥", 0.04)
    keys = load_keys()

    progress("定位微信目录", 0.05)
    db_root = find_db_root()

    progress("解密数据库", 0.06)
    decrypted, errors = refresh_decrypted(db_root, keys, progress)
    if errors:
        warnings.extend(errors[:4])

    progress("读取会话列表", 0.72)
    sess_db = os.path.join(DEC, "session", "session.db")
    cont_db = os.path.join(DEC, "contact", "contact.db")
    if not os.path.isfile(sess_db) or not os.path.isfile(cont_db):
        raise RuntimeError("解密后的 session.db / contact.db 不存在，解密阶段可能失败。")

    con_c = sqlite3.connect(f"file:{cont_db}?mode=ro", uri=True)
    names: dict[str, str] = {}
    try:
        for u, remark, nick, alias in con_c.execute(
            "select username, remark, nick_name, alias from contact"
        ):
            names[u] = remark or nick or alias or u
    finally:
        con_c.close()

    aliases = read_json(ALIASES, {})
    member_names = load_member_names()
    me = self_wxid(db_root)

    def who_is(uname: str) -> str:
        if not uname:
            return "未知成员"
        if uname in aliases:
            return aliases[uname]
        if me and uname == me:
            return "我"
        n = names.get(uname)
        if n and n != uname:
            return n
        if uname in member_names:
            return member_names[uname]
        if uname.endswith("@chatroom"):
            return "群聊"
        if uname.startswith("wxid_"):
            return "成员·" + uname[5:9]
        return uname.split("@")[0][:16]

    now = time.time()
    since = int(now - window_days * 86400)

    sess_c = sqlite3.connect(f"file:{sess_db}?mode=ro", uri=True)
    sessions = list(sess_c.execute(
        "select username, sort_timestamp, summary from SessionTable order by sort_timestamp desc"
    ))
    sess_c.close()

    progress("筛选工作会话", 0.76)

    def excluded(display_name: str) -> bool:
        return any(fnmatch.fnmatch(display_name, pat) for pat in exclude)

    candidates, skipped = [], 0
    for uname, sort_ts, summary in sessions:
        if not sort_ts or sort_ts < since - 30 * 86400:
            continue
        if uname.startswith("gh_") or "sessionholder" in uname:
            continue
        display = names.get(uname, "")
        if not display or display == uname:
            display = who_is(uname)
        if excluded(display):
            skipped += 1
            continue
        candidates.append((uname, display, int(sort_ts), (summary or "")[:80]))

    progress("建立消息索引", 0.80)
    dbs = sorted(glob.glob(os.path.join(DEC, "message", "message_*.db")))
    table_to_db: dict[str, str] = {}
    for p in dbs:
        try:
            c = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
            for (tn,) in c.execute(
                "select name from sqlite_master where type='table' and name like 'Msg\\_%' escape '\\'"
            ):
                table_to_db[tn] = p
            c.close()
        except Exception:
            continue

    sender_cache: dict[str, dict[int, str]] = {}

    def sender_map(db_path: str) -> dict[int, str]:
        if db_path not in sender_cache:
            m = {}
            try:
                c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                for rid, uname in c.execute("select rowid, user_name from Name2Id"):
                    m[rid] = uname
                c.close()
            except Exception:
                pass
            sender_cache[db_path] = m
        return sender_cache[db_path]

    cursor = read_json(CURSOR, {})
    first_run = not cursor
    new_cursor: dict[str, int] = {}

    def fetch_chat(uname: str) -> tuple[list[dict], int]:
        tbl = "Msg_" + hashlib.md5(uname.encode()).hexdigest()
        db = table_to_db.get(tbl)
        if not db:
            return [], 0
        smap = sender_map(db)
        rows = []
        try:
            c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            for ts, ltype, rsid, content in c.execute(
                f"select create_time, local_type, real_sender_id, message_content "
                f"from {tbl} where create_time >= ? order by create_time",
                (since,),
            ):
                if norm_type(ltype) in SYSTEM_TYPES:
                    continue
                text = flatten(ltype, decode_content(content))
                if not text:
                    continue
                rows.append({"ts": int(ts), "who": who_is(smap.get(rsid, "")), "text": text})
            c.close()
        except Exception:
            return [], 0
        rows = rows[-600:]
        if not rows:
            return [], 0
        prev = cursor.get(uname, 0)
        # 首次见到的会话没有游标，不能把历史消息全算成「本次新增」
        new_n = 0 if (first_run or uname not in cursor) else sum(1 for it in rows if it["ts"] > prev)
        new_cursor[uname] = max(prev, rows[-1]["ts"])
        return rows, new_n

    progress("抽取消息内容", 0.84)

    chats_out = []
    total_new = 0
    for uname, display, sort_ts, summary in candidates:
        items, new_n = fetch_chat(uname)
        if not items:
            continue
        total_new += new_n

        # 自动待办候选：近 72 小时、命中待办特征、未被「已完成」否定，按语义去重
        auto, seen_sh, seen_cur = [], [], set()
        for it in reversed(items):
            if it["ts"] < now - 3 * 86400:
                break
            body = strip_quote(it["text"])
            if not is_candidate_todo(body):
                continue
            k = _norm(body)
            if k in seen_cur:
                continue
            sh = _shingles(body)
            if any(similar(sh, prev) for prev in seen_sh):
                continue
            seen_cur.add(k)
            seen_sh.append(sh)
            auto.append({"text": body[:150] + ("…" if len(body) > 150 else ""),
                         "who": it["who"], "ts": it["ts"]})
            if len(auto) >= 8:
                break

        chats_out.append({
            "username": uname,
            "name": display,
            "lastActive": items[-1]["ts"],
            "sortTs": sort_ts,
            "messages": len(items),
            "newMessages": new_n,
            "auto": auto,
            "items": items,
        })

    write_json(CURSOR, new_cursor)

    # 我在微信里有多种写法（昵称 / 群昵称 / 备注 / 微信号），@ 任一种都算找我
    self_names = []
    if me:
        for cand in (names.get(me), member_names.get(me), aliases.get(me)):
            if cand and cand not in self_names:
                self_names.append(cand)
        # contact 表里的 nick_name / alias 也一并收集
        try:
            con_self = sqlite3.connect(f"file:{cont_db}?mode=ro", uri=True)
            row = con_self.execute(
                "select remark, nick_name, alias from contact where username=?", (me,)).fetchone()
            con_self.close()
            for cand in (row or ()):
                if cand and cand not in self_names:
                    self_names.append(cand)
        except Exception:
            pass

    ex = {
        "at": int(now),
        "selfNames": self_names,
        "atText": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "windowDays": window_days,
        "durationMs": int((time.time() - t0) * 1000),
        "dbRoot": db_root,
        "warnings": warnings,
        "excluded": skipped,
        "decrypted": len(decrypted),
        "newMessages": total_new,
        "chats": chats_out,
    }
    progress("缓存抽取结果", 0.97)
    write_json(EXTRACT, ex)
    return ex


# ==========================================================================
# 第二段：build_state（快，可反复调用）
# ==========================================================================
def parse_due(text, now_ts: int):
    """把 due 的自由文本解析成时间戳；无法确定日期返回 None。"""
    if not text:
        return None
    t = str(text).strip()
    if not t:
        return None

    d = dt.datetime.fromtimestamp(now_ts)
    end_today = d.replace(hour=23, minute=59, second=59, microsecond=0)

    if t in ("立即", "马上", "今天", "今日"):
        return int(end_today.timestamp())
    if t == "明天":
        return int((end_today + dt.timedelta(days=1)).timestamp())
    if t == "后天":
        return int((end_today + dt.timedelta(days=2)).timestamp())
    if t == "本周":
        # 本周日
        return int((end_today + dt.timedelta(days=6 - d.weekday())).timestamp())
    if t == "下周":
        return int((end_today + dt.timedelta(days=13 - d.weekday())).timestamp())

    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", t)
    if m:
        try:
            return int(dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                                   23, 59, 59).timestamp())
        except ValueError:
            return None

    # 允许「10-21 起」「10-29 前」这类带后缀的写法
    m = re.match(r"^(\d{1,2})-(\d{1,2})(?:\D|$)", t)
    if m:
        try:
            cand = dt.datetime(d.year, int(m.group(1)), int(m.group(2)), 23, 59, 59)
        except ValueError:
            return None
        # 明显落在过去半年以上的，视为明年
        if cand.timestamp() < now_ts - 180 * 86400:
            cand = cand.replace(year=cand.year + 1)
        return int(cand.timestamp())

    return None


# 微信在正文里用「@昵称 + 分隔符」表示 @；@所有人 是群公告，不算找我
AT_SEPS = " \u2005\u00a0\u3000,，:：\n\t"


def mentions_me(text: str, names) -> bool:
    """正文里是否 @ 了「我」。消息被 @ 时形如 `@xin¿⁶ᴳ 你好`。"""
    if not text or "@" not in text:
        return False
    for nm in names:
        nm = (nm or "").strip()
        if len(nm) < 2:
            continue
        start = 0
        while True:
            i = text.find("@" + nm, start)
            if i < 0:
                break
            j = i + 1 + len(nm)
            if j >= len(text) or text[j] in AT_SEPS:
                return True
            start = i + 1
    return False


def _rid(prefix: str, *parts: str) -> str:
    return prefix + hashlib.md5("\x1f".join(parts).encode("utf-8")).hexdigest()[:10]


def build_state(ex: dict) -> dict:
    t0 = time.time()
    cfg = read_json(PROJECTS, {"config": {}, "projects": []})
    projects_def = cfg.get("projects", [])
    manual = read_json(MANUAL_MAP, {})
    overrides = read_json(RECORDS, {})
    proj_status = read_json(PROJ_STATUS, {})
    removed = read_json(REMOVED, {})

    now = ex.get("at") or int(time.time())
    self_names = ex.get("selfNames") or []
    by_id = {p["id"]: p for p in projects_def}

    # ---- 会话归属 ----
    def match_project(display_name: str, uname: str) -> str:
        if uname in manual:
            return manual[uname]
        for p in projects_def:
            for pat in p.get("match", []):
                if fnmatch.fnmatch(display_name, pat):
                    return p["id"]
        return "__other__"

    grouped: dict[str, list[dict]] = {p["id"]: [] for p in projects_def}
    grouped["__other__"] = []
    for ch in ex["chats"]:
        grouped.setdefault(match_project(ch["name"], ch["username"]), []).append(ch)

    # ---- 收集记录 ----
    records: list[dict] = []

    for p in projects_def:
        chats = grouped.get(p["id"], [])
        if not chats:
            continue
        for it in p.get("open", []):
            records.append({
                "id": _rid("c-", p["id"], it.get("key") or it["text"]),
                "text": it["text"],
                "level": it.get("level", "P2"),
                "owner": it.get("owner", ""),
                "due": it.get("due", ""),
                "source": "manual",
                "project": p["id"],
                "status": "open",
                "ts": None,
                "who": "",
                "chat": "",
            })

        curated = {_norm(it["text"]) for it in p.get("open", [])}
        picked, seen = [], set()
        for ch in chats:
            for a in ch.get("auto", []):
                k = _norm(a["text"])
                if k in curated or k in seen:
                    continue
                seen.add(k)
                picked.append({"text": a["text"], "who": a["who"], "ts": a["ts"], "chat": ch["name"]})
        picked.sort(key=lambda x: -x["ts"])
        for a in picked[:8]:
            records.append({
                "id": _rid("a-", a["chat"], a["text"]),
                "text": a["text"],
                "level": "P2",
                "owner": a["who"],
                "due": "",
                "source": "auto",
                "project": p["id"],
                "status": "open",
                "ts": a["ts"],
                "who": a["who"],
                "chat": a["chat"],
            })

    # ---- 应用人工覆盖（改派 / 完成）----
    for r in records:
        r["dueTs"] = parse_due(r.get("due"), now)
        ov = overrides.get(r["id"])
        # 人工改过的截止日优先
        if ov and ov.get("due"):
            r["due"] = ov["due"]
            r["dueTs"] = parse_due(ov["due"], now)
        if not ov:
            continue
        if ov.get("project") and ov["project"] in by_id:
            r["project"] = ov["project"]
        if ov.get("status") == "done":
            r["status"] = "done"
            r["doneAt"] = ov.get("at", "")

    today_end = int(dt.datetime.fromtimestamp(now).replace(hour=23, minute=59, second=59).timestamp())
    week_end = today_end + 7 * 86400
    for r in records:
        r["overdue"] = bool(r["status"] == "open" and r["dueTs"] and r["dueTs"] < today_end)
        if r["status"] != "open":
            r["bucket"] = "done"
        elif r["overdue"]:
            r["bucket"] = "overdue"
        elif r["dueTs"] and r["dueTs"] <= week_end:
            r["bucket"] = "soon"
        elif r["dueTs"]:
            r["bucket"] = "later"
        else:
            r["bucket"] = "none"

    # 自动记录若被改派，保留；人工记录被改派后仍跟随目标项目
    for r in records:
        if r["project"] not in grouped and r["project"] != "__other__":
            r["project"] = "__other__"

    # ---- 项目聚合 ----
    out_projects = []
    total_msgs = total_chats = 0

    for p in projects_def:
        # 用户已从星系移除的项目：连它会话一起不产出，也不落到「未归类」
        if p["id"] in removed:
            continue
        chats = grouped.get(p["id"], [])
        if not chats:
            continue
        total_chats += len(chats)

        members, chat_objs = set(), []
        proj_msgs = proj_new = 0
        heat24 = 0
        last_active = 0

        pending_reply = waiting_them = 0
        pending_days = 0.0

        for ch in chats:
            proj_msgs += ch["messages"]
            proj_new += ch["newMessages"]
            last_active = max(last_active, ch["lastActive"])
            for it in ch["items"]:
                members.add(it["who"])
                if it["ts"] > now - 86400:
                    heat24 += 1

            # 谁最后说话：客户最后说 = 等我回；我最后说 = 等客户回
            last_me = max((i["ts"] for i in ch["items"] if i["who"] == "我"), default=0)
            last_them = max((i["ts"] for i in ch["items"] if i["who"] != "我"), default=0)

            # 群聊里只有 @ 了我才需要回；私聊每条都是对我说的
            is_group = ch["username"].endswith("@chatroom")
            if is_group:
                last_need = max((i["ts"] for i in ch["items"]
                                 if i["who"] != "我" and mentions_me(i["text"], self_names)),
                                default=0)
            else:
                last_need = last_them

            if last_need and last_need > last_me:
                gap = (now - last_need) / 86400
                if gap >= 1:
                    pending_reply += 1
                    pending_days = max(pending_days, gap)
            elif last_me and last_me > last_them:
                if (now - last_me) / 86400 >= 1:
                    waiting_them += 1

            chat_objs.append({
                "username": ch["username"],
                "name": ch["name"],
                "messages": ch["messages"],
                "newMessages": ch["newMessages"],
                "lastActive": ch["lastActive"],
                "isGroup": is_group,
                "lastFromMe": last_me,
                "lastFromThem": last_them,
                "items": ch["items"],
            })

        total_msgs += proj_msgs
        mine = [r for r in records if r["project"] == p["id"]]
        open_recs = [r for r in mine if r["status"] == "open"]
        done_recs = [r for r in mine if r["status"] == "done"]

        out_projects.append({
            "id": p["id"],
            "name": p["name"],
            "subtitle": p.get("subtitle", ""),
            "priority": p.get("priority", "P2"),
            "owner": p.get("owner", ""),
            "tags": p.get("tags", []),
            "status": proj_status.get(p["id"], {}).get("status", "active"),
            "closedAt": proj_status.get(p["id"], {}).get("at", ""),
            "closed": p.get("closed", []),
            "risks": p.get("risks", []),
            "metrics": {
                "messages": proj_msgs,
                "chats": len(chat_objs),
                "members": len(members),
                "lastActive": last_active,
                "newMessages": proj_new,
                "heat24h": heat24,
                "openCount": len(open_recs),
                "doneCount": len(done_recs),
                "autoCount": sum(1 for r in open_recs if r["source"] == "auto"),
                "overdue": sum(1 for r in open_recs if r.get("overdue")),
                "pendingReply": pending_reply,
                "pendingDays": round(pending_days, 1),
                "waitingThem": waiting_them,
            },
            "records": open_recs,
            "doneRecords": done_recs,
            "chats": chat_objs,
        })

    # 未归类
    other = grouped.get("__other__", [])
    if other:
        oc = []
        for ch in sorted(other, key=lambda c: -c["lastActive"])[:20]:
            oc.append({"username": ch["username"], "name": ch["name"],
                       "messages": ch["messages"], "lastActive": ch["lastActive"],
                       "newMessages": ch["newMessages"], "items": ch["items"][-40:]})
        if oc:
            out_projects.append({
                "id": "__other__", "name": "未归类会话", "subtitle": "未命中项目规则，可手动归档",
                "priority": "P3", "owner": "", "tags": ["待归档"], "closed": [], "risks": [],
                "metrics": {"messages": sum(c["messages"] for c in oc), "chats": len(oc),
                            "members": 0, "lastActive": max(c["lastActive"] for c in oc),
                            "newMessages": 0, "heat24h": 0, "openCount": 0,
                            "doneCount": 0, "autoCount": 0, "overdue": 0,
                            "pendingReply": 0, "pendingDays": 0, "waitingThem": 0},
                "records": [], "doneRecords": [], "chats": oc,
            })

    order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    # 已完成的项目沉到末尾
    out_projects.sort(key=lambda x: (x.get("status") == "done",
                                     order.get(x["priority"], 9),
                                     -x["metrics"]["lastActive"]))

    # 记录按紧急度排序
    lv = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    for p in out_projects:
        # 逾期 → 临期 → 已排期 → 未排期，同组内按优先级与时间
        bucket_order = {"overdue": 0, "soon": 1, "later": 2, "none": 3}
        p["records"].sort(key=lambda r: (bucket_order.get(r.get("bucket"), 9),
                                          lv.get(r["level"], 9), -(r["ts"] or 0)))
        p["doneRecords"].sort(key=lambda r: r.get("doneAt", ""), reverse=True)

    flat = []
    for p in out_projects:
        for r in p["records"]:
            flat.append({**r, "projectName": p["name"], "projectSub": p["subtitle"]})

    state = {
        "generatedAt": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "generatedAtTs": now,
        "extractAt": ex.get("atText", ""),
        "windowDays": ex.get("windowDays", 14),
        "durationMs": ex.get("durationMs", 0),
        "buildMs": int((time.time() - t0) * 1000),
        "warnings": ex.get("warnings", []),
        "stats": {
            "projects": sum(1 for p in out_projects if p["id"] != "__other__"),
            "chats": total_chats,
            "messages": total_msgs,
            "openItems": sum(p["metrics"]["openCount"] for p in out_projects),
            "doneItems": sum(p["metrics"]["doneCount"] for p in out_projects),
            "risks": sum(len(p["risks"]) for p in out_projects),
            "overdue": sum(p["metrics"]["overdue"] for p in out_projects),
            "pendingReply": sum(p["metrics"]["pendingReply"] for p in out_projects),
            "newMessages": ex.get("newMessages", 0),
            "decrypted": ex.get("decrypted", 0),
            "excluded": ex.get("excluded", 0),
        },
        "projects": out_projects,
        "records": flat,
        "hiddenProjects": [
            {"id": k, "name": v.get("name") or k, "at": v.get("at", "")}
            for k, v in removed.items()
        ],
    }
    write_json(STATE, state)
    return state


# ==========================================================================
# 对外入口
# ==========================================================================
def run(progress=None) -> dict:
    ex = extract(progress)
    if progress:
        progress("聚合进度看板", 0.99)
    return build_state(ex)


def rebuild() -> dict:
    ex = read_json(EXTRACT, None)
    if not ex:
        return run()
    return build_state(ex)


DUE_TEXT_LABELS = ("待客户", "待确认", "持续", "观察", "跟进", "本周内")

def set_record(record_id: str, project=None, status=None, due=None) -> dict:
    # 改派 / 完成 / 改截止日，持久化到 data/records.json
    data = read_json(RECORDS, {})
    cur = data.get(record_id, {})
    if project:
        cur["project"] = project
    if due is not None:
        d = str(due).strip()
        # 允许清空（恢复项目里写的原始截止日），也允许保留「待客户」这类文字标签，
        # 但拒绝 2026-13-45 这种解析不出来的脏日期，否则会静默变成「未排期」
        if d and parse_due(d, int(time.time())) is None and d not in DUE_TEXT_LABELS:
            raise ValueError(f"无效的截止日：{due}")
        cur["due"] = d
    if status in ("open", "done"):
        cur["status"] = status
        cur["at"] = dt.datetime.now().strftime("%m-%d %H:%M")
    data[record_id] = cur
    write_json(RECORDS, data)
    return data


def set_records_bulk(ids, project=None, status=None) -> dict:
    """批量改派 / 完成，只重建一次看板。"""
    data = read_json(RECORDS, {})
    at = dt.datetime.now().strftime("%m-%d %H:%M")
    for rid in ids:
        cur = data.get(rid, {})
        if project:
            cur["project"] = project
        if status in ("open", "done"):
            cur["status"] = status
            cur["at"] = at
        data[rid] = cur
    write_json(RECORDS, data)
    return data


def reset_record(record_id: str) -> dict:
    data = read_json(RECORDS, {})
    data.pop(record_id, None)
    write_json(RECORDS, data)
    return data


def remove_project(project_id: str) -> dict:
    """从星系移除一个项目（数据保留，可恢复）。"""
    cfg = read_json(PROJECTS, {"projects": []})
    name = next((p.get("name") for p in cfg.get("projects", []) if p["id"] == project_id), project_id)
    data = read_json(REMOVED, {})
    data[project_id] = {"name": name, "at": dt.datetime.now().strftime("%m-%d %H:%M")}
    write_json(REMOVED, data)
    return data


def restore_project(project_id: str) -> dict:
    data = read_json(REMOVED, {})
    data.pop(project_id, None)
    write_json(REMOVED, data)
    return data


def set_project(project_id: str, status: str) -> dict:
    """把整个项目标记为已完成 / 恢复进行中。"""
    data = read_json(PROJ_STATUS, {})
    if status == "done":
        data[project_id] = {"status": "done",
                            "at": dt.datetime.now().strftime("%m-%d %H:%M")}
    else:
        data.pop(project_id, None)
    write_json(PROJ_STATUS, data)
    return data


if __name__ == "__main__":
    def cli(step, pct):
        sys.stdout.write(f"\r[{pct*100:5.1f}%] {step:<24}")
        sys.stdout.flush()

    if "--rebuild" in sys.argv:
        st = rebuild()
    else:
        st = run(cli)
        print()
    print(f"项目 {st['stats']['projects']} / 会话 {st['stats']['chats']} / "
          f"消息 {st['stats']['messages']} / 未闭环 {st['stats']['openItems']} / "
          f"已完成 {st['stats']['doneItems']} / 耗时 {st['durationMs']}ms+{st['buildMs']}ms")
    print("state:", STATE)
    for w in st["warnings"]:
        print("  警告:", w)
