# CS2-Bot-Improver — Inno Setup 安装脚本

[English](README.md) · **简体中文**

`setup.iss` 用于生成 `CS2-Bot-Improver-Setup.exe`：一个把 Panel 应用程序与整个插件
安装到 Counter-Strike 2 的 `game\csgo` 目录里的 Windows 安装程序。

---

## 环境要求

- **Inno Setup 6.3 或更高版本。** 脚本声明了 `ArchitecturesAllowed=x64compatible`，
  更早的 6.x 版本会拒绝该取值。已在 6.7.3 上验证。
- Windows x64（Counter-Strike 2 本身仅支持 64 位）。
- 一份用于打包的**发行树** —— 见下方[载荷](#载荷)一节。这一节最容易踩坑，
  动手前请先读完。

---

## 载荷

> [!IMPORTANT]
> **本仓库只有源代码，不能直接用来打包。**

`.gitignore` 排除了 `**/bin/` 与 `**/obj/`，而 CS2 需要的加载器文件则从未被提交过。
因此一次检出里是 97 个 `.cs` 文件和 **0 个 DLL**，而真正运行所需的是 **510 个 DLL**
加上 Metamod 加载桩和一个打包好的 `botprofile.vpk` —— 152 MB 二进制对 4.6 MB 源码。

直接从检出打包，得到的安装程序会把源码文件复制进 `game\csgo`，没有任何可加载的代码。
CS2 启动后插件完全不存在，而界面不会给出任何提示。现在 `setup.iss` 拒绝在这种情况下
构建：它会检查 21 个插件启动所必需的文件，缺任何一个就中止，并逐条列出缺失路径。

载荷必须来自一份**发行树** —— 也就是官方 `CS2BotImprover.zip` 的内容：

```
addons/
backup/
cfg/
overrides/
gameinfo.gi
Panel.exe                        （打包好的 Panel 应用程序）
```

把这份树放到 **`inno-setup\payload\`**（已被 git 忽略），或用参数指向它：

```bat
ISCC /DPayloadRoot="D:\build\CS2BotImprover" setup.iss
```

### 为什么这 21 个文件缺一个就是致命问题

| 缺失项 | 后果 |
| --- | --- |
| `gameinfo.gi` | CS2 根本不会去 `addons\` 里找东西 —— 什么都加载不了 |
| `addons\metamod.vdf`、`addons\metamod_x64.vdf` | Metamod 从未被注入，整条链在此断掉 |
| `addons\metamod\bin\win64\server.dll`、`metamod.2.cs2.dll` | Metamod 没有可加载的实现 |
| `addons\metamod\counterstrikesharp.vdf` | Metamod 不会去加载 CounterStrikeSharp |
| `counterstrikesharp\bin\win64\counterstrikesharp.dll` | 没有脚本宿主，任何插件都跑不起来 |
| `counterstrikesharp\dotnet\dotnet.exe` | CounterStrikeSharp 没有可启动的运行时 |
| `counterstrikesharp\configs\core.json` | Panel 的皮肤开关没有可修改的对象 |
| `counterstrikesharp\gamedata\gamedata.json` | 不知道该游戏版本的签名与偏移 |
| `counterstrikesharp\plugins\BotAI\BotAI.dll` | 链条上其他环节依赖的插件不存在 |
| `addons\{BotController,BotHider,BotVision}\bin\win64\*.dll` | 三个原生插件全部缺失 |
| `addons\RayTrace\bin\win64\RayTrace.dll` | 光线追踪缺失 |
| `backup\Online\gameinfo.gi`、`backup\WithBots\gameinfo.gi` | Panel 的联机 / 机器人模式切换没有可复制的文件 |
| `overrides\botprofile.vpk`、`overrides\Medium\botprofile.vpk` | Panel 的难度切换没有可启用的档案 |
| `cfg\my_bot_normal_config.cfg` | 游戏不会加载任何机器人配置 |

### 特意不作为选项提供的内容

仓库里还带着 `overrides/archived/` 和两个 `cfg/*_rules_unchanged.cfg`。这两者都不属于
发行内容：

- `overrides/archived/*/botprofile.db` 是**未编译**的档案，游戏读的是 `botprofile.vpk`。
  装进去这些 `.db` 不会有任何作用。
- 规则不变版本是以**独立发行压缩包、相同文件名**提供的一一在那个包里
  `my_bot_normal_config.cfg` 本身就是规则不变配置。两套并排安装不可能生效。

---

### 组装载荷 —— `tools/assemble-payload.mjs`

不需要手工拷来拷去。这个辅助脚本以一棵现成的发行树为底，覆盖你重新编译出来的产物，
然后**拒绝交出一棵缺少 CS2 启动所需任何文件的树**：

```bat
node inno-setup\tools\assemble-payload.mjs ^
  --base "D:\build\CS2BotImprover" ^
  --panel "D:\build\Panel.exe"
```

| 参数 | 含义 |
| --- | --- |
| `--base <dir>` | 作为底部的发行树，必须含 `gameinfo.gi`。 |
| `--out <dir>` | 载荷输出位置，默认 `inno-setup\payload`。会先清空，不会残留旧文件。 |
| `--panel <exe>` | 打包好的 Panel 应用程序，发布为 `Panel.exe`。 |
| `--build` | 先对全部可编译项目执行 `dotnet build -c Release`。用 VS 编译过就不需要这个参数。 |
| `--stage-references` | 只暂存缺失的 `libs/` 引用然后停止。打开 VS 之前跑一次。 |
| `--fix-references` | 修复指向不存在目录的 `<ProjectReference>`。需显式开启（它会改源码），并会打印回滚用的 `git checkout`。 |
| `--write-solution <path>` | 生成一个 `.slnx`，列出打包所需的全部项目，供 Visual Studio 构建。 |
| `--deploy` | 把重新编译的程序集直接推进已安装的游戏，而不是组装载荷。只新增和更新，并撤回**自己先前推送过**、而当前构建已不含有的文件。见 [改代码时的循环](#改代码时的循环)。 |
| `--game <dir>` | 推送到哪个安装：`…\game\csgo`、CS2 根目录，或包含它的 Steam 库。省略时自动探测 —— 也就是说裸跑 `--deploy` 会写入它找到的那个安装。 |
| `--dry-run` | 只报告 `--deploy` 会新增、更新、撤回哪些文件，然后停止，不写入任何内容。用来确认探测到的目标。 |
| `--no-pdb` | 丢弃 `.pdb` 调试符号。 |
| `--verify-only` | 只校验已有载荷，不组装。载荷不完整**或**有插件目录未列入 `[InstallDelete]` 时退出码为 1，可直接当 CI 门禁。 |

传路径给它之前，有两条安全性质值得知道：

- **`--out` 与 `--base` 在任一方向上都不允许重叠。** 载荷在写入前会被清空，而 base tree
  是读取来源 —— 因此 `--out` 等于 `--base` 会删掉它即将复制的源，而 `--base` 位于
  `--out` 内部则会跟着一起被删。两种情况都会被拒绝；比较时忽略大小写，因为 Windows
  路径就是忽略大小写的。
- **清理多余的 Panel 只作用于载荷副本。** base tree 里原有的文件保持不动。

有两件事是它自己推导出来的，而不是靠你告诉它：

- **必需文件清单直接读自 `setup.iss`** —— 解析脚本里的
  `#define NeedPayload("…")` 检查项。这份清单全项目只有一处，所以脚本和安装程序
  对"完整"的定义不可能不一致。
- **每个项目的目标目录就是它自己的源码目录。** 只有当程序集名称与文件夹名一致时才会
  被打包，因为 CounterStrikeSharp 就是按 `plugins\<Name>\<Name>.dll` 找插件的。
  同目录下的辅助程序集（`plugins\BotAI\Common.csproj`）会被列出并跳过。
- **只有位于 `counterstrikesharp\plugins\` 或 `\shared\` 下的项目才算插件。**
  `addons\` 下其它位置的临时项目（比如构建工作区）会被列出并排除在包之外。
- **项目输出根目录下的子路径，映射到 CounterStrikeSharp 的安装根，而不是项目目录。**
  `BotHiderImpl` 就依赖这一条：它有一个自定义 MSBuild target 把 `0Harmony.dll`
  拷进 `shared\0Harmony\`，因此构建产物是

  ```
  bin\Release\net10.0\BotHiderImpl.dll
  bin\Release\net10.0\shared\0Harmony\0Harmony.dll
  ```

  第二条路径在载荷里对应
  `addons\counterstrikesharp\shared\0Harmony\0Harmony.dll`。漏掉它会导致
  `Lib.Harmony` 升版后包里仍是旧的 Harmony —— 因为再没有别的环节会更新这个文件。

### 如果你想自己重新编译插件

载荷里大约 150 个文件是第三方的、直接 vendor 进来；真正由本仓库编译的只有那些托管
插件。打开 Visual Studio 之前，有几件事值得先知道：

- **16 个项目里有 11 个可以编译**，全部走 NuGet —— `dotnet restore` 就够了，
  **不需要**在本机安装 CounterStrikeSharp。`CounterStrikeSharp.API` 是以包的形式引用的。
- **有三个项目引用了仓库里并不存在的 `libs\` 目录中的预编译程序集。**
  `BotAimImprover` 与 `NadeSystem` 需要 `libs\RayTraceApi.dll`；
  `BotState` 需要 `libs\BotControllerApi.dll`。缺了它们这三个项目根本编不过 ——
  编译器会直接停止，而不会产出坏程序集（其中 `BotAimImprover` 是真正用到该 API 的，
  源码里有 `using RayTraceAPI;`）。

  打开 Visual Studio 之前先执行一次，工具会把程序集从发行树拷进一个被 git 忽略的
  `libs\` 目录：

  ```bat
  node inno-setup\tools\assemble-payload.mjs --stage-references --base "D:\build\CS2BotImprover"
  ```

  `--build` 会自动完成这一步。
- **有两处 `<ProjectReference>` 指向了不存在的目录**，因此这两个项目同样编不过 ——
  而且失败表现出来是约 40 行 `CS0246`，看起来像代码问题而不是路径问题：

  | 项目 | 指向 | 实际位置 |
  | --- | --- | --- |
  | `plugins\BotControllerImpl` | `../BotControllerApi/` | `shared\BotControllerApi\` |
  | `plugins\BotHiderImpl` | `..\BotHiderApi\` | `shared\BotHiderApi\` |

  工具只报告、不静默改写 —— 文件是你的。若要让它套用上面那行替换、并打印回滚命令：

  ```bat
  node inno-setup\tools\assemble-payload.mjs --fix-references
  ```

  替换后的路径是从项目的真实位置推导出来的，因此在这次检出里它是唯一能生效的路径。
  已验证：套用之后**11 个项目全部编译通过**；不套用则那两个失败、其余正常。
- **参与构建的 `CounterStrikeSharp.API` 有三档版本**：1.0.367（×2）、1.0.371（×6）、
  1.0.373（×2），分布在 8 个项目的 10 处引用上（`BotControllerApi` 与
  `BotHiderApi` 完全没有引用 CSS API）。

  真正要紧的是**运行时**提供的版本，它可以从发行树自己的
  `addons\counterstrikesharp\api\CounterStrikeSharp.API.deps.json` 里以纯文本读到：
  **1.0.373**。所以这 10 处里有 8 处低于它们要加载的运行时。这个方向通常无害 ——
  .NET Core 会把引用解析**向上**到实际存在的版本，而不是要求精确匹配，因此只有在插件
  调用的成员被移除时才会出错。致命的反而是另一个方向：钉版**高于**运行时时，插件会调用
  运行时不存在的成员，加载即抛 `MissingMethodException`。

  工具和本文档此前都声称构建里有浮动的 `*` 和一处 1.0.362 —— **这是错的**。它们在
  `plugins\disabled\` 里，而该目录被 `walk()` 跳过、被解决方案生成器排除、也从不进入
  安装包。**构建中没有任何浮动钉版**，所以还原不会悄悄拉到比运行时更新的版本。
  `--deploy` 与载荷组装都会针对眼前的树重新检查这一点，一旦不再成立就会告警。
- **安装包自带 .NET 运行时，目标框架由它决定。**
  `addons\counterstrikesharp\dotnet\shared\Microsoft.NETCore.App\` 里是 **10.0.3**，
  且 `api\CounterStrikeSharp.API.runtimeconfig.json` 设置了 `"rollForward": "Major"`。
  项目面向两个框架 —— 多数是 `net10.0`，`BotBuy` 与 `RoundDamageRecap` 是 `net8.0` ——
  **两者都能加载**：前者直接匹配运行时，后者向前滚动到 10.0.3。

  这是对着发行树验证过的，不是推断：在本机构建产出的 `runtimeTarget` 与发行版一致
  （`v10.0` / `v8.0`），而且 `BotAI.deps.json` 与发行版**逐字节相同**。该文件记录了
  整个依赖图，能完全一致已经是最接近"证明"的证据：你的工具链与当初构建发行版的
  工具链是一致的。
- **钉版可能在无人察觉的情况下偏离发行版。** 同一次比对就抓到一处：仓库把 `BotBuy`
  钉在 `1.0.367`，而**发行版**里的 `BotBuy` 是按 `1.0.366` 构建的。这个方向无害 ——
  两者都会向上解析到运行时的 1.0.373 —— 但它说明钉版在发版之后被改过，而这正是
  "钉版变得比运行时更新"的典型成因。
- **仓库里没有 `.sln`、没有 `Directory.Build.props`、没有 `NuGet.config`**，所以用一条
  命令生成一份只包含正确项目的解决方案：

  ```bat
  node inno-setup\tools\assemble-payload.mjs --write-solution addons\plugins.slnx
  ```

  指向已有的 `.slnx` 即可覆盖它。请把
  `addons\counterstrikesharp\plugins\disabled\` 排除在解决方案之外：那个目录装的是
  Linux 变体，其中一个引用了原开发者电脑上的路径
  （`..\..\..\..\Tmp\ArchiveV02\Common\bin\Debug\net8.0\Common.dll`）。这些内容都不属于发布。
  你自己在 `addons\` 下其它位置建的临时项目会被自动排除。
- 目标框架上，多数项目是 `net10.0`，`BotBuy` 与 `RoundDamageRecap` 是 `net8.0`。
  一个 .NET 10 SDK 可以同时面向两者 —— 不需要再装第二套 SDK。

四个原生插件（`BotController`、`BotHider`、`BotVision`、`RayTrace`）在**本仓库没有源码**，
它们在别的项目里，因此请把它们的二进制当作 vendor 输入，而不是可重新编译的产物。

### 改代码时的循环

只要游戏里已经装过一次，之后改代码**不需要重新做安装包**就能看到效果：

```bat
:: 每个 checkout 只需要跑一次 —— 生成只含打包所需项目的解决方案
node inno-setup\tools\assemble-payload.mjs --write-solution addons\plugins.slnx

:: 编译它（Visual Studio 里点生成，或用命令行）
dotnet build addons\plugins.slnx -c Release

:: 把重新编译的 DLL 推进游戏
node inno-setup\tools\assemble-payload.mjs --deploy
```

`--build --deploy` 一条命令完成后两步。**`.slnx` 本身只负责编译** —— 把产物放到
游戏会读取的位置是独立的第三步，`--deploy` 就是这一步。

推送步骤会自己找到安装位置（注册表 → `libraryfolders.vdf` → 常规盘符布局），所以
只有一个 Steam 库、一个 CS2 时不需要任何参数。它会打印出选中的目录；用 `--game`
可以覆盖。

**自动探测不是只读操作。** 裸跑 `--deploy` 会写入它找到的那个安装 —— 所以"只想看看
会探测到哪儿"这条命令本身就是一次写入。那种情况请加 `--dry-run`：

```bat
node inno-setup\tools\assemble-payload.mjs --deploy --dry-run
```

它会打印同样的报告 —— 目标目录、模式、API 检查、以及每个将要新增/更新/撤回的文件 ——
但不写入任何内容，也不改动推送记录。

它会做和不会做的事：

- **只新增和更新，并且只撤回它自己写下的东西。** 因此不可能把一份能用的安装弄坏：
  它唯一会做的删除，是针对自己记录里列出、且内容仍与当初推送时一致的文件。此后被
  修改过的文件会被报告并保留。*升级*时的清理仍然由安装程序的 `[InstallDelete]` 负责。
- **拒绝做一半。** 只要有项目没有 `bin\Release` 产物，就会停下并点名 —— 否则推完剩下的
  会让新旧程序集并排存在，那是最难排查的状态。
- **CS2 在运行时拒绝执行**，因为运行中的游戏会占用插件 DLL，复制会中途失败。
- **目标目录里没有 CounterStrikeSharp 时拒绝执行。** 没有插件加载器，复制会"看起来
  成功"却什么都不改变。
- **只涉及那 11 个托管插件。** Metamod、CounterStrikeSharp、.NET 运行时、4 个原生插件
  和 `overrides\*.vpk` 都是 vendor 内容，本仓库没有任何东西能构建它们。
- **会把 `CounterStrikeSharp.API` 的钉版与目标树里的运行时做比对。** 钉版高于运行时、
  或浮动 `*` 可能被还原拉到更高版本时，会在插件加载时抛 `MissingMethodException` ——
  这种故障在插件自身的代码里看不出任何线索。钉版低于运行时只报个数，因为 .NET Core 会
  向上解析，通常没问题。

**它会记住自己推过什么，所以别人删掉的插件不会残留。** 记录写在
`inno-setup\.deploy-state.json` —— 已被 git 忽略，按游戏目录分别记录，逐文件存一个
哈希。队友删除或改名一个插件后，下一次 `--deploy` 会撤掉当初为它写入的文件并清理空
目录：否则 CounterStrikeSharp 会加载 `plugins\` 下的**每一个**目录，旧版构建就会和新版
并排被加载。这件事无法靠磁盘推断 —— 游戏里的插件目录与 `RayTraceImpl` 这类 vendor
目录（随包发布、本仓库无源码）从外观上无法区分。推送后被修改过的文件会被报告并保留，
且继续留在记录中，以便后续运行仍然知道它的存在。

**在怀疑"为什么改了没变化"之前，先看模式。** 联机模式会刻意装上**原版**
`gameinfo.gi`，此时 CS2 根本不会读取 `addons\metamod` —— Metamod、CounterStrikeSharp
和所有插件都不加载，这是有意为之，为的是不影响官方服务器。这种状态下推送依然成功，
只是不可能在游戏里体现。`--deploy` 会报告它检测到的模式，并在联机模式下打印出那个
可以恢复模组的 `backup\WithBots\gameinfo.gi`。把 Panel 切回机器人模式就是全部修复动作，
推上去的文件已经在位了。

---

## 快速开始

```bat
:: 1. 组装载荷（发行树 + 你重新编译的 DLL + Panel）
node inno-setup\tools\assemble-payload.mjs --base "D:\build\CS2BotImprover" --panel "D:\build\Panel.exe"

:: 2. 编译安装包 —— 会自动使用 inno-setup\payload
ISCC.exe inno-setup\setup.iss
```

产物为 `inno-setup\output\CS2-Bot-Improver-Setup.exe`，约 44 MB。

只要 `inno-setup\payload` 目录里有 `gameinfo.gi`，`setup.iss` 就会自动使用它，
因此第 2 步不需要任何参数。如需读写别处的树：

```bat
ISCC.exe /DPayloadRoot="D:\build\CS2BotImprover" /DPanelExe="D:\build\Panel.exe" setup.iss
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

Panel 可执行文件与载荷必须来自**同一个发行版本**。当可执行文件的版本信息与
`package.json` 不一致时，编译会给出警告 —— 版本错配会让安装包的版本标签
与里面实际装的 Panel 不符。

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

无论用户最终选了哪个目录，**写入任何文件之前都会先校验**：如果该目录里既没有
`gameinfo.gi` 也没有 `steam.inf`，会弹出一个确认框说明插件将被装到游戏根本不会读取的
位置，并把所选文件夹显示出来。没有这道校验的话，一个输错的路径、或一台检测不到 CS2
的机器，都会得到一个看起来完全成功、实际毫无作用的 650 个文件的安装。

`LooksLikeCsgoDir` 就是整个校验 —— 两次 `FileExists`。实测结果：真实安装目录（true）、
同一路径带尾反斜杠（true）、`C:\Windows`（false）、不存在的路径（false）。

---

## 安装内容

来自**载荷**：

| 源 | 目标 |
| --- | --- |
| `addons\`（510 个 DLL、全部配置与加载器） | `{app}\addons\` |
| `cfg\` | `{app}\cfg\` |
| `overrides\` | `{app}\overrides\` |
| `gameinfo.gi` | `{app}\gameinfo.gi` |
| `backup\` | `{app}\backup\` |
| 打包好的 Panel | `{app}\CS2-Bot-Improver-Panel.exe` |

来自**仓库**（文档类，载荷里没有）：

| 源 | 目标 |
| --- | --- |
| `Commands.txt`、`README.md`、`LICENSE` | `{app}\` |
| `docs\` | `{app}\docs\` |
| `Panel\LICENSE` | `{app}\LICENSE-Panel.txt` |

唯一一个可选任务，**默认不勾选**：创建桌面快捷方式（文案由 Inno 自带翻译提供）。

### 覆盖升级已安装的版本

Inno **不会**清除上一版装过、而新版本已不再提供的文件。用双版本探针实测确认：
一个被移除的文件和一个被改名的文件，在就地升级后都残留了下来 —— 即使在 Inno 从注册表
读取上次安装目录的真实升级路径下也一样。

这对本项目很关键，因为 CounterStrikeSharp 会加载 `plugins\` 下的**每一个**目录。
上一版遗留的插件仍会被加载到新版本旁边，轻则产生重复插件错误。

因此 `[InstallDelete]` 会在解包前清空每个模组独占的目录。清单里只列模组自己的路径 ——
`overrides` 里还有 `swift_demo_menu_override.vpk`，`cfg\` 里有 Valve 的配置和用户修改，
`counterstrikesharp\configs` 里有用户的 `core.json`，`metamod\` 里有用户可能改过的
`metaplugins.ini`，这些一概不碰。

`assemble-payload.mjs` 会拿载荷对照这份清单，发现未被覆盖的插件目录就告警，
`--verify-only` 则直接判失败 —— 因此新增插件不可能让清单悄悄过期。

`gameinfo.gi` 与 Panel 是单独处理的，且是有意为之：

- Panel 以**固定名称**安装，升级时覆盖旧版本，而不是留下带版本号的副本；
- `gameinfo.gi` 标记为 `uninsneveruninstall` 并在卸载时还原，详见下文。

### 卸载行为，以及为什么 `cfg\` 与 `gameinfo.gi` 要特殊处理

插件会覆盖基础游戏自带的文件：`gameinfo.gi`（加两条搜索路径，让 CS2 去 `addons\` 里找）
以及 `cfg\gamemode_*.cfg` 那一组。

Inno 的卸载程序按自己的文件清单删除，**完全不管内容是否已被改动** —— 实测做法是：
装好一个文件、把它换成完全不同的内容、再卸载，结果照样被删掉。这带来一个危险情形：
Steam 更新把 Valve 的 `gameinfo.gi` 还原之后，卸载我们的包会**删掉游戏需要的文件**，
游戏只能靠 Steam 的"验证游戏文件完整性"才能恢复。

因此这两项带上了 `uninsneveruninstall`，卸载时会保留：

| 项目 | 卸载时 |
| --- | --- |
| `gameinfo.gi` | 保留，并且**恢复成 Valve 的原始内容** —— `CurUninstallStepChanged` 会在 Inno 删除 `backup\` 之前，把纯净的 `backup\Online\gameinfo.gi` 覆盖上去。用 `usUninstall` 这个步骤，是因为实测确认它触发时 `backup\` 仍然存在。 |
| `cfg\*` | 原样保留。模组自己的三个配置（`bot_buy.cfg`、`my_bot_ffa_config.cfg`、`my_bot_normal_config.cfg`，约 9 KB）会留下，`gamemode_*.cfg` 也保持模组的机器人友好规则。因为什么都不删，游戏绝不会缺少必需文件。 |
| `addons\`、`overrides\`、`backup\`、Panel、文档 | 正常删除 —— 这些全部是模组自己的内容。 |

其余由安装程序添加的内容（Panel、文档、卸载程序本身）都正常移除。

### 几点说明

- Panel 以**固定名称** `CS2-Bot-Improver-Panel.exe` 安装，而不是
  `Panel v1.4.5.exe`。这样升级时会覆盖上一版，而不会在游戏目录里留下一堆过期的
  带版本号可执行文件。
- `Panel\LICENSE` 随 Panel 二进制一起分发，因为 Panel 采用 PolyForm Strict 1.0.0，
  而项目其余部分是 AGPL-3.0。

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
2. 针对该 Panel 与该版本的发行树构建安装包：
   `ISCC /DPayloadRoot="…" /DPanelExe="…\Panel.exe" setup.iss`
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

> [!NOTE]
> **在静默模式下，Inno 会选中所有任务**，包括标记为 `unchecked` 的那些。
> 这里唯一受影响的是桌面快捷方式 —— 传 `/TASKS=""` 不创建快捷方式，
> 传 `/TASKS="desktopicon"` 则创建。

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
（检测失败提示、游戏运行中警告）已在 `[CustomMessages]` 中为这六种语言全部提供。

---

## 本目录文件

| 文件 | 用途 |
| --- | --- |
| `setup.iss` | 完整的安装脚本 —— 元数据、载荷、任务、语言与 Pascal Script。 |
| `tools/assemble-payload.mjs` | 组装并校验载荷树，见上文。 |
| `payload/` | 待打包的发行树，已被 git 忽略，由上述工具生成。 |
| `output/` | 编译产物，已被 git 忽略。 |
| `README.md` | 英文文档。 |
| `README.zh-CN.md` | 本文档。 |

---

## 常见问题

**出现 `Error: The payload is incomplete.`**
当载荷是仓库而不是发行树时，这就是预期的拦截。报错正上方的警告会逐条列出所有缺失路径，
详见[载荷](#载荷)。

**出现 `Warning: Panel executable is version X but this installer is built as Y`**
Panel 可执行文件与载荷来自不同版本。请用配套的一对重新构建 —— 版本号跟随
`Panel/package.json`。

**出现 `Error: Panel\package.json is missing`**
`inno-setup` 与 `Panel` 两个目录必须并排放在同一个仓库里。脚本的所有路径都从自身
位置推导，因此放到任何检出目录都能编译 —— 但这仅限于两个目录没有被拆开的情况。

**出现 `Invalid value for ArchitecturesAllowed`**
本机 Inno Setup 低于 6.3。请升级，或把该指令的值改成 `x64`。

**安装中途失败，或提示文件被占用**
Counter-Strike 2（或正在更新游戏的 Steam）在运行。关闭后重新运行安装程序即可，
它会就地覆盖，重试是安全的。
