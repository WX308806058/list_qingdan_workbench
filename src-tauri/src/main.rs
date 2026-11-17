#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
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

/// 启动后静默检查更新；有新版本就下载安装并重启。
fn check_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(_) => return,
        };
        if let Ok(Some(update)) = updater.check().await {
            if update
                .download_and_install(|_, _| {}, || {})
                .await
                .is_ok()
            {
                app.restart();
            }
        }
    });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let mut child: Option<Child> = None;

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
            if let Some(state) = handle.try_state::<Sidecar>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut c) = guard.take() {
                        let _ = c.kill();
                    }
                }
            }
        }
    });
}
