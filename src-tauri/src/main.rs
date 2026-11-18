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
/// 升级过程日志。出问题的时候，日志是唯一的证据——别再靠猜。
fn ulog(msg: &str) {
    use std::io::Write;
    let dir = if let Ok(d) = std::env::var("APPDATA") {
        std::path::PathBuf::from(d).join("清单工作台")
    } else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true)
        .open(dir.join("update.log")) else { return };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    let _ = writeln!(f, "[{}] {}", now, msg);
}

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
/// 挂一个独立的 cmd：等安装器退出后拉起新版本。
///
/// 为什么不直接 start？因为 NSIS 安装器要替换正在运行的 app exe，
/// 会先把我们的进程杀掉——status() 之后的任何代码都不会执行。
/// 所以自启动必须「先挂出去、再跑安装器」，与 app 的生死完全解耦。
fn relaunch_when_installed_gone(installer: &std::path::Path, app: &tauri::AppHandle) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return,
    };

    // 批处理必须纯 ASCII：cmd 按 GBK 解析，UTF-8 的中文路径会变乱码。
    // exe 路径含中文，改从命令行参数传（命令行是 Unicode 安全的）。
    let script = std::env::temp_dir().join("qingdan-relaunch.cmd");
    let content = "@echo off\r\n\r\necho cmd start >> \"%TEMP%\\qingdan-relaunch.log\"\r\n\r\nrem 等主进程退干净\r\nping -n 4 127.0.0.1 >nul\r\n\r\nset /a tries=0\r\n:wait\r\ntasklist /FI \"IMAGENAME eq qingdan-update-setup.exe\" 2>nul | find /I \"qingdan-update-setup.exe\" >nul\r\nif errorlevel 1 goto startnow\r\nset /a tries+=1\r\nif %tries% GEQ 60 goto startnow\r\nping -n 2 127.0.0.1 >nul\r\ngoto wait\r\n\r\n:startnow\r\necho installer gone, starting app >> \"%TEMP%\\qingdan-relaunch.log\"\r\nstart \"\" \"%~1\"\r\necho start err=%errorlevel% >> \"%TEMP%\\qingdan-relaunch.log\"\r\ndel \"%~f0\"\r\n";
    if std::fs::write(&script, content).is_err() {
        ulog("自启动脚本写入失败");
        return;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let spawned = Command::new("cmd")
            .args([
                "/C",
                &script.to_string_lossy(),
                &exe.to_string_lossy().to_string(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        ulog(&format!("自启动 cmd 已挂出: {}", spawned.is_ok()));
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("cmd")
            .args(["/C", &script.to_string_lossy(), &exe.to_string_lossy().to_string()])
            .spawn();
    }
    let _ = app; // 占位：保持签名一致
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
            Ok(Some(u)) => {
                ulog(&format!("发现新版本 {}", u.version));
                u
            }
            _ => {
                ulog("没有可用更新");
                return;
            }
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

        // 下载：多线路候选。镜像站（gh-proxy/ghfast 等）经常抽风或限速，
        // 卡 0% 是常态；每条线路独立超时，失败自动切下一条，最后直连 GitHub 兜底。
        let dl_win = win.clone();
        let mut candidates: Vec<url::Url> = Vec::new();
        {
            let orig = update.download_url.clone();
            if let Some(idx) = orig.as_str().find("https://github.com/") {
                let inner = &orig.as_str()[idx..];
                for host in ["", "https://ghfast.top/", "https://gh-proxy.com/"] {
                    if let Ok(u) = url::Url::parse(&format!("{host}{inner}")) {
                        if !candidates.contains(&u) {
                            candidates.push(u);
                        }
                    }
                }
            }
            if candidates.is_empty() {
                candidates.push(orig.clone());
            } else if !candidates.contains(&orig) {
                // 原始线路（工作流选的镜像）优先
                candidates.insert(0, orig);
            }
        }
        ulog(&format!(
            "下载候选线路: {}",
            candidates.iter().map(|u| u.as_str().split("//").nth(1).unwrap_or("").split('/').next().unwrap_or("")).collect::<Vec<_>>().join(" → ")
        ));

        let bytes = 'dl: {
            for (idx, cand) in candidates.iter().enumerate() {
                if idx > 0 {
                    let _ = win.eval(&format!(
                        "window.__upd(null, '线路较慢，切换备用线路 {}/{}…');",
                        idx + 1,
                        candidates.len()
                    ));
                    ulog(&format!("切换下载线路: {cand}"));
                }
                let mut u = update.clone();
                u.download_url = cand.clone();
                u.timeout = Some(Duration::from_secs(240));

                let w = win.clone();
                // 注意：插件回调的第一个参数是「本片大小」不是累计字节（源码 on_chunk(chunk.len(), …)），
                // 直接除以 total 会永远算出 0%~1% 之间抖动。必须自己累加。
                let acc = std::cell::Cell::new(0u64);
                let last_paint = std::cell::Cell::new(0u128);
                let fut = u.download(
                    move |chunk, total| {
                        let now = acc.get() + chunk as u64;
                        acc.set(now);
                        if let Some(total) = total {
                            if total == 0 {
                                return;
                            }
                            // 节流：每 150ms 刷一次，chunk 频率太高会闪
                            let ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis())
                                .unwrap_or(0);
                            if ms.saturating_sub(last_paint.get()) < 150 {
                                return;
                            }
                            last_paint.set(ms);
                            let pct = now as f64 / total as f64 * 100.0;
                            let _ = w.eval(&format!(
                                "window.__upd({:.0}, '正在下载 {:.0}%（{:.1} MB / {:.1} MB）');",
                                pct,
                                pct,
                                now as f64 / 1048576.0,
                                total as f64 / 1048576.0
                            ));
                        }
                    },
                    || {},
                );
                // 单线路 4 分钟上限：进度条卡死的下载没有等下去的价值
                match tokio::time::timeout(Duration::from_secs(240), fut).await {
                    Ok(Ok(b)) => {
                        ulog(&format!("下载完成 {} bytes（线路 {cand}）", b.len()));
                        break 'dl Ok(b);
                    }
                    Ok(Err(e)) => ulog(&format!("线路失败: {e}")),
                    Err(_) => ulog(&format!("线路超时(240s): {cand}")),
                }
            }
            Err("所有下载线路均失败".to_string())
        };
        let bytes = match bytes {
            Ok(b) => b,
            Err(e) => {
                ulog(&format!("下载最终失败: {e}"));
                say(&win, None, "自动下载失败，已为你打开下载页，请手动安装");
                // 浏览器走用户自己的代理，直连 GitHub 没问题
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    let _ = Command::new("cmd")
                        .args(["/C", "start", "", "https://github.com/WX308806058/list_qingdan_workbench/releases/latest"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn();
                }
                std::thread::sleep(Duration::from_secs(10));
                app.exit(0);
                return;
            }
        };

        say(&win, None, "正在停止后台服务…");
        kill_sidecar(&app);
        std::thread::sleep(Duration::from_millis(800));
        ulog("sidecar 已停止");

        say(&win, None, "正在安装新版本…");

        let installer = std::env::temp_dir().join("qingdan-update-setup.exe");
        if std::fs::write(&installer, &bytes).is_err() {
            ulog("安装包写入失败");
            say(&win, None, "写入安装包失败，请手动更新");
            std::thread::sleep(Duration::from_secs(6));
            app.exit(0);
            return;
        }
        ulog(&format!("安装包已写入 {:?}", installer));

        // 顺序关键：自启动 cmd 必须先挂出去，再跑安装器。
        // 安装器替换运行中的 exe 时会把本进程杀掉，这之后的代码不会执行。
        relaunch_when_installed_gone(&installer, &app);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = Command::new(&installer)
                .arg("/S")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new(&installer).arg("/S").spawn();
        }
        ulog("安装器已启动；本进程将由安装器结束，新版本由 cmd 拉起");
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
                .title(format!(
                    "清单工作台 v{}",
                    h.package_info().version
                ))
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
