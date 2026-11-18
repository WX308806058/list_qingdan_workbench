#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

const PORT: u16 = 8792;

/// 由 Tauri 拉起的 Python sidecar，退出时要确保它跟着结束，否则会留下僵尸进程占端口。
struct Sidecar(Mutex<Option<Child>>);

fn sidecar_exe(app: &tauri::AppHandle) -> Option<PathBuf> {
    // 打包后：<安装目录>\sidecar\qingdan-backend\qingdan-backend.exe
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir
            .join("sidecar")
            .join("qingdan-backend")
            .join("qingdan-backend.exe");
        if p.exists() {
            return Some(p);
        }
    }
    // tauri dev：直接用仓库里的暂存目录
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("sidecar")
        .join("qingdan-backend")
        .join("qingdan-backend.exe");
    if dev.exists() {
        Some(dev)
    } else {
        None
    }
}

fn port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn wait_port(port: u16, timeout: Duration) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < timeout {
        if port_open(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// 杀掉 sidecar 并等它真的退出（kill 只是发信号，句柄可能还没释放）。
fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Sidecar>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

/// 升级进度窗：一个小窗口告诉用户「正在干什么」，下载百分比实时刷新。
/// 没有它，升级期间应用毫无征兆地消失又出现，像被杀进程一样。
fn build_progress_window(
    app: &tauri::AppHandle,
    to: &str,
) -> Result<tauri::WebviewWindow, tauri::Error> {
    let win = WebviewWindowBuilder::new(
        app,
        "updater",
        WebviewUrl::App("update.html".into()),
    )
    .title("正在更新 清单工作台")
    .inner_size(430.0, 168.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .center()
    .build()?;

    let _ = win.eval(&format!(
        "window.__ver('{}'); window.__upd(null, '正在检查更新…');",
        to
    ));
    Ok(win)
}

/// 升级完成后拉起新版本。
/// 不直接 spawn：刚 exit 的瞬间安装器可能还没交还句柄，新进程起不来。
/// 写一个自删除的 cmd，等 2 秒再 start，彻底和旧进程解耦。
fn relaunch_detached() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };
    let script = std::env::temp_dir().join("qingdan-relaunch.cmd");
    let content = format!(
        "@echo off\r\nping -n 3 127.0.0.1 >nul\r\nstart \"\" \"{}\"\r\ndel \"%~f0\"\r\n",
        exe.display()
    );
    if std::fs::write(&script, content).is_ok() {
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = Command::new("cmd")
                .args(["/C", &script.to_string_lossy()])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
            return;
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new(exe).spawn();
        }
    } else {
        let _ = Command::new(exe).spawn();
    }
}

/// 启动后静默检查更新：发现新版本 → 弹进度窗 → 下载（带百分比）→
/// 杀 sidecar → /S 静默安装 → 拉起新版本退出。
fn check_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(_) => return,
        };

        let update = match updater.check().await {
            Ok(Some(u)) => u,
            _ => return,
        };

        let to = update.version.clone();
        let win = match build_progress_window(&app, &to) {
            Ok(w) => w,
            Err(_) => return,
        };
        let say = |win: &tauri::WebviewWindow, pct: Option<f64>, label: &str| {
            let _ = win.eval(&format!(
                "window.__upd({:.0}, '{}');",
                pct.unwrap_or(-1.0).max(0.0),
                label
            ));
        };

        // 下载：按字节进度刷进度条
        let dl_win = win.clone();
        let bytes = update
            .download(
                |received, total| {
                    if let Some(total) = total {
                        if total > 0 {
                            let pct = received as f64 / total as f64 * 100.0;
                            let _ = dl_win.eval(&format!(
                                "window.__upd({:.0}, '正在下载 {:.0}%（{:.1} MB / {:.1} MB）');",
                                pct,
                                pct,
                                received as f64 / 1048576.0,
                                total as f64 / 1048576.0
                            ));
                        }
                    }
                },
                || {},
            )
            .await;
        let bytes = match bytes {
            Ok(b) => b,
            Err(_) => {
                say(&win, None, "下载失败，可稍后重试或手动下载新版本");
                std::thread::sleep(Duration::from_secs(6));
                app.exit(0);
                return;
            }
        };

        say(&win, None, "正在停止后台服务…");
        kill_sidecar(&app);
        std::thread::sleep(Duration::from_millis(800));

        say(&win, None, "正在安装新版本…");
        let installer = std::env::temp_dir().join("qingdan-update-setup.exe");
        if std::fs::write(&installer, &bytes).is_err() {
            say(&win, None, "写入安装包失败，请手动更新");
            std::thread::sleep(Duration::from_secs(6));
            app.exit(0);
            return;
        }

        // /S = NSIS 静默安装；status() 等它真正装完再拉新版本
        #[cfg(windows)]
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let ok = {
            #[cfg(windows)]
            {
                Command::new(&installer)
                    .arg("/S")
                    .creation_flags(CREATE_NO_WINDOW)
                    .status()
            }
            #[cfg(not(windows))]
            {
                Command::new(&installer).arg("/S").status()
            }
        }
        .map(|st| st.success())
        .unwrap_or(false);
        let _ = std::fs::remove_file(&installer);

        if !ok {
            say(&win, None, "安装失败，请手动更新");
            std::thread::sleep(Duration::from_secs(8));
            app.exit(0);
            return;
        }

        say(&win, Some(100.0), "安装完成，正在启动新版本…");
        std::thread::sleep(Duration::from_millis(500));
        relaunch_detached();
        app.exit(0);
    });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let mut child: Option<Child> = None;

            // 升级重启时旧实例可能还没退干净：等它把端口释放，最多 12 秒。
            // 不等的话新 sidecar 会误判「已有实例」而直接退出，窗口就连不上了。
            let mut waited = 0;
            while port_open(PORT) && waited < 120 {
                std::thread::sleep(Duration::from_millis(100));
                waited += 1;
            }

            if !port_open(PORT) {
                if let Some(exe) = sidecar_exe(&handle) {
                    child = Command::new(exe)
                        .arg("--port")
                        .arg(PORT.to_string())
                        .spawn()
                        .ok();
                }
            }
            app.manage(Sidecar(Mutex::new(child)));

            let h = handle.clone();
            std::thread::spawn(move || {
                let ready = wait_port(PORT, Duration::from_secs(40));
                // 起不来也开窗口：页面的「加载失败」态会告诉用户看日志
                let url = format!("http://127.0.0.1:{PORT}/");
                let built = WebviewWindowBuilder::new(
                    &h,
                    "main",
                    WebviewUrl::External(url.parse().expect("bad url")),
                )
                .title("清单工作台")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                .center()
                .build();

                if built.is_ok() && ready {
                    check_update(h.clone());
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building 清单工作台");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            kill_sidecar(handle);
        }
    });
}
