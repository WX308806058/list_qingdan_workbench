"""把 backend/ 打成 Tauri 资源里的 sidecar（PyInstaller onedir）。

    python scripts/build-sidecar.py

产物：src-tauri/sidecar/qingdan-backend/  （整目录随 Tauri 包分发）
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BACKEND = os.path.join(ROOT, "backend")
UI = os.path.join(ROOT, "ui")
NAME = "qingdan-backend"

DIST = os.path.join(BACKEND, "dist")
BUILD = os.path.join(BACKEND, "build")
STAGE = os.path.join(ROOT, "src-tauri", "sidecar", NAME)


def main():
    for d in (DIST, BUILD, os.path.join(ROOT, "src-tauri", "sidecar")):
        shutil.rmtree(d, ignore_errors=True)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        # --windowed：GUI 子系统。运行时不弹 DOS 窗，日志由 sidecar.py 重定向到 backend.log
        "--noconfirm", "--clean", "--windowed",
        "--name", NAME,
        "--paths", BACKEND,
        "--add-data", UI + ";ui",
        "--add-data", os.path.join(BACKEND, "projects.json") + ";.",
        "--add-data", os.path.join(ROOT, "VERSION") + ";.",
        "--hidden-import", "pipeline",
        "--distpath", DIST,
        "--workpath", BUILD,
        "--specpath", BACKEND,
        os.path.join(BACKEND, "sidecar.py"),
    ]
    print(">>", " ".join(cmd))
    if subprocess.run(cmd, cwd=ROOT).returncode != 0:
        raise SystemExit("PyInstaller failed")

    shutil.copytree(os.path.join(DIST, NAME), STAGE)
    exe = os.path.join(STAGE, NAME + ".exe")
    n_files = sum(len(fs) for _, _, fs in os.walk(STAGE))
    print(f"sidecar ready: {exe}  ({os.path.getsize(exe) / 1024 / 1024:.1f} MB exe, {n_files} files)")


if __name__ == "__main__":
    main()
