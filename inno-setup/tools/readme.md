**意图**：一个构建/打包/部署三合一工具——从官方发行树（`--base`）镜像出 payload，叠加本地重建的 DLL，并从 `setup.iss` 反读必需文件清单和 `[InstallDelete]` 作为 CI 校验闸门；`--deploy` 路径复用同一套映射，把重建程序集推到实机游戏目录并用自维护的 hash 清单做回撤。整体设计有明确的防御意识（重叠守卫、dry-run、游戏运行检测），以下 3 个问题经双子代理独立验证均确认存在（2/2 一致）。

📊 **关键流程概览**

```mermaid
flowchart LR
    A[parseArgs] --> B{--verify-only?}
    B -->|yes| C[校验 outDir 必需文件<br/>API drift / InstallDelete 覆盖]
    B -->|no| D{--base 提供且合法?}
    D -->|no| E[stage-references / build /<br/>fix-references 后退出]
    D -->|yes| F[重叠守卫 out vs base]
    F --> G[rmSync outDir 镜像 base 树]
    G --> H[叠加 bin/Release 产物]
    H --> I[Panel.exe + 校验必需文件]
    A --> J{--deploy?}
    J --> K[定位 game\\csgo<br/>检测 CSS / cs2.exe / 模式]
    K --> L[deployMappings + 按 hash 清单回撤]
    style F fill:#fff3e0,color:#e65100
    style G fill:#bbdefb,color:#0d47a1
    style L fill:#c8e6c9,color:#1a5e20
```
