# CS2-Bot-Improver — Inno Setup 安装脚本

[English](README.md) · **简体中文**

`setup.iss` 用于生成 `CS2-Bot-Improver-Setup.exe`：一个把 Panel 应用程序与插件
的全部文件安装到 Counter-Strike 2 的 `game\csgo` 目录里的 Windows 安装程序。

---

## 环境要求

- **Inno Setup 6.3 或更高版本。** 脚本声明了 `ArchitecturesAllowed=x64compatible`，
  更早的 6.x 版本会拒绝该取值。已在 6.7.3 上验证。
- Windows x64（Counter-Strike 2 本身仅支持 64 位）。

## 快速开始

1. 把打包好的 Panel 可执行文件放到**仓库根目录下的 `Panel.exe`**。
   仓库里没有已构建的 Panel —— 它的 Tauri 后端（`Panel/src-tauri`）并未公开，
   否则安装包会缺少 Panel。
2. 编译：

   ```bat
   ISCC.exe setup.iss
   ```

   ……或者用 Inno Setup IDE 打开 `setup.iss`，点击 **Compile**。
3. 产物为 `inno-setup\output\CS2-Bot-Improver-Setup.exe`（已被 git 忽略）。

如果可执行文件在别处，用命令行覆盖 —— 命令行定义的优先级高于内置查找：

```bat
ISCC.exe /DPanelExe="C:\build\Panel.exe" setup.iss
```

---

## 版本号从哪里来

**没有任何硬编码。** `Panel/package.json` 的 `version` 字段是唯一来源，脚本在编译期
读取它，并用于 `AppVersion`、`VersionInfoVersion`、`VersionInfoProductVersion`，
因此安装程序自身的文件属性与 Panel 完全一致：

```powershell
(Get-Item .\output\CS2-Bot-Improver-Setup.exe).VersionInfo.ProductVersion
# -> 1.4.5
```

同一个值也驱动 Panel 的标题栏（通过 Vite 的 `define` 注入）和它的更新检查器，
三者不可能再出现版本漂移。**升版本只需要改一个地方 —— `Panel/package.json`。**

ISPP 没有 JSON 解析器，但它可以逐行读取文件（`FileOpen`/`FileRead`），
取单个键值足够；随后用 `Pos`/`Copy` 提取 `"version"` 的值。
如果读不到该字段，**编译会直接报错并说明原因**，而不是悄悄打出一个版本号错误的包。

---

## 安装到哪里

`DefaultDirName={code:GetDefaultCsgoDir}` —— 目标目录在运行时由 `[Code]` 中的
Pascal Script 解析，查找顺序如下：

1. Steam 根目录：先读 `HKCU\Software\Valve\Steam\SteamPath`，再读
   `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`，最后读
   `HKLM\SOFTWARE\Valve\Steam\InstallPath`。
2. 系统盘上的常规位置：`Program Files (x86)\Steam`、`Program Files\Steam`、`Steam`。
3. 每个根目录下 `steamapps\libraryfolders.vdf` 里列出的全部库。
4. 再加上 `<系统盘>\SteamLibrary`。

然后查找
`<库>\steamapps\common\Counter-Strike Global Offensive\game\csgo`，
并优先选择同时存在 `appmanifest_730.acf`（CS2 的 Steam 应用清单）的库，
避免无关的同名目录遮蔽真正的安装位置。

### 为什么不遍历其它盘符

这里的 Pascal Script **没有**驱动器枚举 API（`GetDriveType` 与 `GetLogicalDrives`
都不存在），而逐个探测盘符可能在空光驱或断开的网络驱动器上卡住数秒 ——
这在安装程序里是不可接受的停顿。不遍历也没有损失：只要读到**任意一个**
Steam 根目录下的 `libraryfolders.vdf`，就能得到位于其它所有盘上的库。

这一点已在一台**完全没有任何 Steam 注册表键**（Steam 被移动过）、
且 CS2 装在非系统盘的机器上实测通过，检测结果为：

```
E:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive\game\csgo
```

### 检测失败时

目标目录页会把说明文字替换成提示，告诉用户该选择哪个文件夹，并且该提示对每种
内置语言都有翻译；用户也可以手动浏览选择。默认值仍会落在常规位置上。

---

## 安装内容

始终安装：

| 源 | 目标 |
| --- | --- |
| `addons\` | `{app}\addons\` |
| `cfg\`（不含 `*_rules_unchanged.cfg`） | `{app}\cfg\` |
| `overrides\High\`、`overrides\Low\`、`overrides\Medium\` | `{app}\overrides\...` |
| `Commands.txt`、`README.md`、`LICENSE` | `{app}\` |
| `Panel\LICENSE` | `{app}\LICENSE-Panel.txt` |
| `docs\` | `{app}\docs\` |
| 打包好的 Panel | `{app}\CS2-Bot-Improver-Panel.exe` |

以下为可选任务，**默认全部不勾选**：

- **`rulesunchanged`** —— 两个 `*_rules_unchanged.cfg`，给需要保持标准游戏规则的
  专用服务器用。
- **`archived`** —— `overrides\archived\`，约 **32 MB** 的额外机器人档案变体。
- **`desktopicon`** —— 桌面快捷方式。

两个可选文件组加起来，体积几乎与包的其余部分相当，因此都不预选。

### 几点说明

- Panel 以**固定名称** `CS2-Bot-Improver-Panel.exe` 安装，而不是
  `Panel v1.4.5.exe`。这样升级时会覆盖上一版，而不会在游戏目录里留下一堆过期的
  带版本号可执行文件。
- `Panel\LICENSE` 随 Panel 二进制一起分发，因为 Panel 采用 PolyForm Strict 1.0.0，
  而项目其余部分是 AGPL-3.0。
- 卸载会移除安装程序添加的文件（由 Inno 跟踪记录）。用户就地修改过的文件也会被一并移除。

---

## 发布版本

Panel 的更新检查器只在最新 GitHub 发布中查找**一个确切名称**的资产：

```
CS2-Bot-Improver-Setup.exe
```

该名称来自 `[Setup]` 里的 `OutputBaseFilename`。如果某个发布中**没有**这个确切名称
的资产，Panel 仍能检测到新版本，但无法提供安装程序，只会把用户引向发布页面。

因此，带安装包的发布流程是：

1. 提升 `Panel/package.json` 的 `version`，并用它构建 Panel。
2. 针对该 Panel 构建安装包：
   `ISCC /DPanelExe="…\Panel.exe" setup.iss`
3. 创建 GitHub 发布，标签为 **`v<版本号>`** —— 与 `package.json` 声明的版本字符串
   完全一致，因为版本比较就是基于它进行的。
4. 把 `CS2-Bot-Improver-Setup.exe` 上传到该发布中，保持脚本产出的名称不变，
   与已有的 Windows / Linux 压缩包并列。

两点需要注意：

- Panel 调用的接口是 `releases/latest`，它会**跳过草稿和预发布版本**。
  打上 `v1.5.0-rc1` 的标签永远不会被推送给任何用户。
- Panel 本身不由本仓库中的任何东西构建，因为它的 Tauri 后端（`Panel/src-tauri`）
  并未公开。因此第 2 步始终是手动交接构建好的可执行文件。

---

## 静默 / 无人值守安装

```bat
CS2-Bot-Improver-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART ^
  /TASKS="" /LANG=chinesesimplified ^
  /DIR="D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive\game\csgo"
```

> [!IMPORTANT]
> **在静默模式下，Inno 会选中所有任务**，包括标记为 `unchecked` 的那些。
> 因此不显式传 `/TASKS=""` 的无人值守安装，也会把约 32 MB 的归档覆盖一并装上。
> 在自动化里请务必显式传入 `/TASKS`：
>
> - 不要任何可选项 —— `/TASKS=""`
> - 全都要 —— `/TASKS="archived,rulesunchanged,desktopicon"`

其它常用参数：`/DIR=…`、`/LANG=…`、`/LOG="install.log"`、`/NORESTART`、
`/SUPPRESSMSGBOXES`。

---

## 游戏运行状态检查

安装前，脚本会调用 `tasklist` 查找 `cs2.exe`。如果游戏正在运行，会提示用户先关闭
游戏 —— 运行时插件 DLL 被占用，会导致安装中途失败 —— 用户也可以选择仍然继续。

静默安装会跳过该提示，因此**在自动化部署前请自行关闭 CS2。**

---

## 语言

向导内置英文、简体中文、俄语、德语、日语、韩语。Inno 自身没有翻译的那些文案
（检测失败提示、游戏运行中警告、可选文件任务标签）已在 `[CustomMessages]`
中为这六种语言全部提供。

---

## 本目录文件

| 文件 | 用途 |
| --- | --- |
| `setup.iss` | 完整的安装脚本 —— 元数据、打包内容、任务、语言与 Pascal Script。 |
| `output/` | 编译产物，已被 git 忽略。 |
| `README.md` | 英文文档。 |
| `README.zh-CN.md` | 本文档。 |

---

## 常见问题

**编译时出现 `Warning: Panel executable not found …`**
安装包仍会生成，但**不含** Panel。请把打包好的 Panel 放到仓库根目录的 `Panel.exe`，
或用 `/DPanelExe="<路径>"` 指定。

**出现 `Error: Panel\package.json is missing …`**
`inno-setup` 与 `Panel` 两个目录必须并排放在同一个仓库里。脚本的所有路径都从自身
位置推导，因此放到任何检出目录都能编译 —— 但这仅限于两个目录没有被拆开的情况。

**出现 `Invalid value for ArchitecturesAllowed`**
本机 Inno Setup 低于 6.3。请升级，或把该指令的值改成 `x64`。

**安装中途失败，或提示文件被占用**
Counter-Strike 2（或正在更新游戏的 Steam）在运行。关闭后重新运行安装程序即可，
它会就地覆盖，重试是安全的。
