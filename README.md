# 清单工作台

把微信客户群里的沟通，整理成一份能直接干活的待办清单。

基于 **Tauri 2 + Rust** 做外壳、**Python** 做数据后端的 Windows 桌面应用：
本地读取微信数据库（SQLCipher），按项目归类会话、抽取待办、生成工作日志，
并按你的格式导出到腾讯文档表格。

> 所有数据只在本机处理，不联网、不上传。

---

## 功能

- **会话归类**：按 `projects.json` 的规则把微信群/联系人归到项目下
- **待办抽取**：从近 N 天消息里识别需要处理的事项，分 P0–P3
- **工作台三视图**：列表（可分组/批量/键盘操作）、图形化面板、今日概览
- **人工待办**：微信之外的事也能记（新建 / 编辑 / 删除，落 `projects.json`）
- **工作日志**：按「编号叙述体」生成当日日志，可编辑后复制
- **表格记录**：按「开发部门综合」的 11 列生成处理记录，TSV 一键粘贴
- **自动更新**：启动时静默检查 GitHub Releases，有新版本自动升级

## 数据位置

```
%APPDATA%\清单工作台\           ← 用户数据（Roaming）
├── projects.json      项目定义 + 人工待办（可手改）
├── data\              待办快照、完成记录
├── cache\             微信库缓存、密钥
└── backend.log        后端日志

%LOCALAPPDATA%\清单工作台\      ← 程序文件（安装目录）
```

两者刻意分开：安装/卸载只动程序目录，**待办与完成记录不受影响**。
早期版本数据在 `%LOCALAPPDATA%\清单工作台\`，首次启动会自动迁移到 Roaming。

微信密钥需要放在 `cache\wx_keys.json`，或 `%USERPROFILE%\.workbuddy\wx_keys.json`。

## 开发

```bash
npm install
python scripts/build-sidecar.py   # 先打 Python 后端
npm run dev                       # tauri dev
```

`npm run dev` 会用 `src-tauri/sidecar/` 里已打好的后端；改了 Python 代码要重新跑一次 sidecar 构建。

## 构建安装包

```bash
python scripts/build-sidecar.py
npm run build
```

产物：

```
src-tauri\target\release\bundle\nsis\清单工作台_<版本>_x64-setup.exe
```

本地构建带签名的更新包需要设置：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content qingdan.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run build
```

## 发布与自动更新

推一个 `v*` 标签即可，GitHub Actions 自动完成：构建 → 签名 → 发 Release → 改写国内镜像。

```bash
git tag v1.0.1
git push origin main --tags
```

已安装旧版本的用户下次启动会自动升级（`tauri-plugin-updater`，minisign 签名校验）。

### 首次准备（一次性）

1. 在仓库 **Settings → Secrets and variables → Actions** 添加：
   - `TAURI_SIGNING_PRIVATE_KEY`：`qingdan.key` 的完整内容
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：留空
2. **私钥务必自己备份**。私钥丢失后，历史版本将无法收到自动更新，只能手动下载安装。

## 更新记录

- **v1.0.6** — 升级时显示进度窗（检查/下载百分比/安装），升级完自动拉起新版本
- **v1.0.5** — 升级进度窗与自启动逻辑
- **v1.0.4** — 自动升级改为静默安装（`/S`），修复 sidecar 锁文件导致的安装失败
- **v1.0.3** — 安装前释放 sidecar 文件句柄
- **v1.0.1** — 验证自动升级链路
- **v1.0.0** — 首个 Tauri 版本

## 项目结构

```
├── ui/                    前端（原生 HTML/CSS/JS，由本地服务托管）
├── backend/
│   ├── server.py          HTTP 服务 + 静态资源 + API
│   ├── pipeline.py        微信库解密、消息抽取、状态聚合
│   ├── sidecar.py         打包入口（启动服务，不弹浏览器）
│   └── projects.json      项目规则与人工待办
├── scripts/build-sidecar.py
├── src-tauri/
│   ├── src/main.rs        拉起 sidecar、开窗口、检查更新
│   ├── tauri.conf.json
│   └── sidecar/           构建产物（git 忽略）
└── .github/workflows/publish.yml
```
