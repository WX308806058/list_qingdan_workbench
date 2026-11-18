"""清单工作台 — Tauri sidecar 入口。

由 Tauri 主程序拉起，只负责跑本地服务，不开浏览器、不弹控制台。
数据目录与旧版（PyInstaller + Inno）一致：%LOCALAPPDATA%\\清单工作台
所以从旧版升级过来时，待办与完成记录原样都在。
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import traceback

APP_DIR_NAME = "清单工作台"


def bundle_dir() -> str:
    """PyInstaller 解包目录（onedir 下就是 exe 所在目录）。"""
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def app_home() -> str:
    """用户数据放 Roaming，与安装目录（%LOCALAPPDATA%\清单工作台）分开。

    装到同一层的话，Tauri 的卸载程序可能把整个安装目录删掉，数据就没了。
    """
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    home = os.path.join(base, APP_DIR_NAME)

    # 一次性迁移：早期版本把数据放在 %LOCALAPPDATA%\清单工作台
    legacy = os.path.join(os.environ.get("LOCALAPPDATA", ""), APP_DIR_NAME)
    if not os.path.exists(os.path.join(home, "data")) and os.path.isdir(os.path.join(legacy, "data")):
        os.makedirs(home, exist_ok=True)
        for item in ("projects.json", "data", "cache", "records.json"):
            src = os.path.join(legacy, item)
            if os.path.exists(src):
                dst = os.path.join(home, item)
                try:
                    if os.path.isdir(src):
                        shutil.copytree(src, dst, dirs_exist_ok=True)
                    else:
                        shutil.copyfile(src, dst)
                except Exception:
                    pass
    return home


def ensure_user_data(bundle: str, home: str) -> str:
    for sub in ("data", "cache"):
        os.makedirs(os.path.join(home, sub), exist_ok=True)

    target = os.path.join(home, "projects.json")
    if not os.path.exists(target):
        seed = os.path.join(bundle, "projects.json")
        if os.path.exists(seed):
            shutil.copyfile(seed, target)

    records = os.path.join(home, "data", "records.json")
    if not os.path.exists(records):
        with open(records, "w", encoding="utf-8") as f:
            f.write("{}")
    return target


def patch_pipeline(home: str, projects_json: str):
    """pipeline 的路径是模块级常量，导入后统一改写到用户目录。"""
    import pipeline

    orig_keys = list(getattr(pipeline, "KEY_CANDIDATES", []))
    old_cache = getattr(pipeline, "CACHE", "")

    data = os.path.join(home, "data")
    cache = os.path.join(home, "cache")

    pipeline.BASE = home
    pipeline.DATA = data
    pipeline.CACHE = cache
    pipeline.DEC = os.path.join(cache, "dec")
    pipeline.MANIFEST = os.path.join(cache, "manifest.json")
    pipeline.CURSOR = os.path.join(cache, "cursor.json")
    pipeline.MANUAL_MAP = os.path.join(cache, "manual_map.json")
    pipeline.EXTRACT = os.path.join(cache, "extract.json")
    pipeline.ALIASES = os.path.join(cache, "aliases.json")
    pipeline.PROJECTS = projects_json
    pipeline.STATE = os.path.join(data, "state.json")
    pipeline.RECORDS = os.path.join(data, "records.json")
    pipeline.PROJ_STATUS = os.path.join(data, "projects_status.json")
    pipeline.REMOVED = os.path.join(data, "projects_removed.json")

    # 只丢掉「旧缓存目录里的那份」，保留 .workbuddy 等外部备用密钥位置
    pipeline.KEY_CANDIDATES = [os.path.join(cache, "wx_keys.json")] + [
        p for p in orig_keys if not (old_cache and p.startswith(old_cache))
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8792)
    args, _ = ap.parse_known_args()

    bundle = bundle_dir()
    home = app_home()
    os.makedirs(home, exist_ok=True)

    # Tauri 是窗口程序，stdout 可能为空；写日志而不是 print 崩掉
    log_path = os.path.join(home, "backend.log")
    try:
        log = open(log_path, "a", encoding="utf-8", buffering=1)
        if sys.stdout is None:
            sys.stdout = log
        if sys.stderr is None:
            sys.stderr = log
    except Exception:
        pass

    try:
        projects_json = ensure_user_data(bundle, home)
        patch_pipeline(home, projects_json)

        # 源码直跑时 ui/ 在工程根目录；打包后随 _MEIPASS 分发
        static = bundle if getattr(sys, "_MEIPASS", None) else \
            os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        os.environ["LISTWB_STATIC"] = static
        os.environ["LISTWB_PIPELINE"] = bundle
        os.environ["LISTWB_PORT"] = str(args.port)

        # 复用 server.main()：--no-browser 由 Tauri 负责开窗口
        sys.argv = [sys.argv[0], "--no-browser"]
        import server
        server.main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
