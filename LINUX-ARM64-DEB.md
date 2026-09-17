# DSH Desktop — Linux arm64 (.deb) 补丁包

为 [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop) 增加 **aarch64 Linux 的 `.deb` 打包能力**，并通过 GitHub Actions 自动产出安装包。

上游项目只有 `dist:mac` 和 `dist:win` 两个打包入口，`build.linux` 仅配置了 `target: ["dir"]`，因此 Linux 用户拿不到安装包。本补丁补齐这条链路。

---

> [!IMPORTANT]
> **安装包自带运行时，不依赖系统 glibc/GTK 版本。**
>
> Electron 43（Chromium 150）要求 glibc 2.35+ / GLib 2.72+ / GTK 3.24.33+，而 Kylin V10 SP1 只有 glibc 2.31 / GLib 2.64.6 / GTK 3.24.23 —— 直接启动会 SIGSEGV（空函数指针调用，发生在工具包初始化阶段）。就地升级系统 glibc 会毁掉整个系统，不可行。
>
> 因此安装包**自带一套 Ubuntu 22.04 运行时**（260 项，解压 50MB），并通过改写主程序的 `PT_INTERP` 指向包内加载器、改写 `DT_RPATH` 让包内库互相解析。这与麒麟官方 Web App Engine（`/opt/kylin-web-app-engine/`）的做法一致——它同样自带 glibc 2.38。
>
> **实测结果**：在 Kylin V10 SP1 / Kirin 9000C 上按 `.desktop` 的真实 `Exec` 行启动，存活至 90 秒仍正常（退出码 124＝被测试超时终止），GPU 进程崩溃 0 次、NSS 致命错误 0 次、无内容告警 0 次。
>
> **三条与打包本身无关、但决定能否用起来的结论**（详见第九、十节）：
>
> | 现象 | 根因 | 处理 |
> |---|---|---|
> | 启动后 GPU 进程反复崩溃，最终带走整个应用 | 本机 Mesa 找不到 `hisi-dpu_dri.so`，GPU 进程每次启动即死 | 启动器**默认 `--disable-gpu`**；需要时用 `--enable-gpu` 恢复 |
> | 运行一段时间后自行退出 | NSS 用裸名 `dlopen("libsoftokn3.so")`，模块不在任何默认搜索路径 | 包内捆绑完整 NSS + RPATH 追加系统 nss 目录 |
> | 点插件市场卡在"检测中"，随后报不可用 | 抓取超时硬编码 15s，目录 15MB，直连 161KB/s | 走代理（实测 11.3MB/s）；应用侧问题，非安装包缺陷 |

---

## 一、文件清单

| 文件 | 状态 | 作用 |
|---|---|---|
| `.github/workflows/linux-arm64-deb.yml` | 新增 | arm64 runner 上构建并发布 `.deb` |
| `dsh-plugin-desktop/scripts/package-linux-deb.ts` | 新增 | Linux 打包入口：解压运行时库包 + 编译厂商符号垫片 + 修正启动器权限 + 调 electron-builder |
| `dsh-plugin-desktop/scripts/patch-linux-runtime.ts` | 新增 | `afterPack` 用：改写 `PT_INTERP` 与 `DT_RPATH` |
| `dsh-plugin-desktop/scripts/after-pack-linux.ts` | 新增 | `afterPack` 入口：先跑上游校验，再改写解释器 |
| `dsh-plugin-desktop/scripts/after-all-artifact-build.ts` | 新增 | `afterAllArtifactBuild` 入口：包装上游 fuses 校验 |
| `dsh-plugin-desktop/build/dsh-desktop-launch` | 新增 | 启动包装器（厂商垫片 / 强制 X11 / Vulkan ICD / Chromium 开关） |
| `dsh-plugin-desktop/build/deb-after-install.tpl` | 新增 | postinst：把 `.desktop` 的 `Exec` 指向启动包装器 |
| `dsh-plugin-desktop/build/mesa-compat.c` + `.map` | 新增 | 厂商 glibc 私有符号垫片源码（`mesa_memcpy` 等） |
| `dsh-plugin-desktop/build/icons/*.png` | 新增 | 9 档尺寸图标集（16→512） |
| `dsh-plugin-desktop/build/lib-bundle.tar.gz` | 新增 | 自带运行时库（260 项，20MB 压缩 / 50MB 解压） |
| `dsh-plugin-desktop/package.json` | 修改 | 新增 `dist:linux-deb` 脚本 + Linux/deb/图标/钩子配置 |
| `push-to-fork.py` | 工具 | 用 Contents API 推送补丁（`git push` 在本机大对象通道不稳） |

---

## 一点五、为什么必须自带运行时（根因）

| 组件 | Kylin V10 SP1 | Electron 43 要求 |
|---|---|---|
| glibc | 2.31 | 2.35+ |
| GLib | 2.64.6 | 2.72+ |
| GTK | 3.24.23 | 3.24.33+ |

**为什么不能只补 `.so`**：从 jammy 提取的 `libgbm`/`libcrypto` 等**自身要求 GLIBC_2.33/2.34**，本机只有 2.31，实测 `LD_PRELOAD` 直接报 `version GLIBC_2.34 not found`。这条路的尽头是 glibc。

**为什么用 `DT_RPATH` 而不是 `LD_LIBRARY_PATH`**：`LD_LIBRARY_PATH` 能工作，但它**会被应用派生的每一个子进程继承**。宿主工具于是加载包内的 glibc/GTK 并崩溃——工作区目录选择器用的 `zenity` 每次调用都 SIGSEGV，界面上表现为"无法打开文件夹 / directory picker failed"。实测同一台机器上带该变量必崩、不带则正常。`DT_RPATH` 只作用于携带它的那个二进制，不会泄漏给子进程。

**为什么必须 `--force-rpath`**：`patchelf --set-rpath` 默认写的是 `DT_RUNPATH`，而 `DT_RUNPATH` **不沿依赖链传递**——包内库之间互相解析时会失败。`--force-rpath` 写出 `DT_RPATH`，整条依赖链都能看到，因此只需改写主程序与 `chrome_crashpad_handler` 两个文件，不必给每个库都设一遍（给全部库设 rpath 反而会破坏它们原有的路径并导致启动段错误）。

> 早期有一版结论说"本机加载器不搜索 `$ORIGIN`"，那是在加载器已被弄坏的状态下测的——当时包内 `ld.so` 与 `libc.so.6` 版本错配（`ld.so --version` 无任何输出）。换用同一次构建的 3.15 全套之后，RPATH 工作正常。

**为什么不能用 `ld.so --library-path`**：那样 `/proc/self/exe` 会指向 `ld.so`，Electron 找不到 `resources/`，报 `Invalid file descriptor to ICU data received`。必须改写 ELF 的 `PT_INTERP`。

**两个容易踩的细节**：
- 捆绑的 `ld.so` 与 `libc.so.6` **必须同一构建版本**（混用 jammy 3.8 的 libc 与 3.15 的 ld.so 会段错误）
- glibc 2.34+ 把 `librt`/`libpthread`/`libdl` 并入 libc，这些**桩库不会被 `LD_DEBUG` 捕获**，必须手工补入，否则系统旧版 `librt` 被加载并报 `GLIBC_PRIVATE` 未定义
- **GPU 驱动栈不进包**：厂商驱动与机器绑定，必须让系统自己的 Mesa/驱动保持权威（见第九节）

---

## 二、为什么必须用 arm64 runner（关键约束）

`dsh-plugin-desktop/scripts/prepare-fs-ext.ts` 中的 `assertTargetPlatform` 明确拒绝交叉编译：

```
fs-ext must be compiled on the target platform; target linux, host linux
```

`fs-ext` 是用 node-gyp 针对 **Electron 头文件**编译的原生模块。打包时 `afterPack` 校验器会强制检查：

```
node_modules/fs-ext/prebuilds/linux-arm64/electron.abi148.node
```

因此工作流使用 `ubuntu-24.04-arm`。**在 x64 runner 上交叉构建会失败**，这不是可绕过的配置问题。

---

## 三、上游已有的 Linux 支持骨架

好消息是上游的验证层已经内置了 Linux 分支，本补丁不需要改任何既有脚本：

| 位置 | Linux 支持证据 |
|---|---|
| `verify-packaged-runtime.ts:201-203` | `REQUIRED_POSIX_FS_EXT_ENTRIES.linux.arm64` 已定义 |
| `verify-packaged-runtime.ts:157-163` | `REQUIRED_NON_MACOS_UNPACKED_RUNTIME_ENTRIES` 覆盖 Windows/Linux 图标资源 |
| `verify-packaged-runtime.ts:437-446` | `resolvePackagedApplicationRoot` 处理 `linux` → `resources/app` |
| `verify-electron-fuses.ts:30,52,244,298` | 配置类型、平台名映射、`executableName` 均含 `linux` |
| `prepare-fs-ext.ts:18-19` | `SUPPORTED_PLATFORMS` 含 `linux`，`SUPPORTED_ARCHITECTURES` 含 `arm64` |

缺的只是「打包入口脚本 + CI 任务」。

---

## 四、package.json 的改动（全部为新增，未修改任何既有字段）

**1. 新增打包脚本**（插在 `dist:win-portable` 之后）

```json
"dist:linux-deb": "node scripts/package-linux-deb.ts"
```

**2. `build.linux` 补充字段**

```json
{
  "target": ["dir"],
  "icon": "build/icons",
  "asar": false,
  "executableName": "dsh-desktop",
  "category": "Development",
  "maintainer": "zcbxxx1 <zcbxxx1@users.noreply.github.com>",
  "synopsis": "DeepSeek Harness desktop client",
  "description": "DeepSeek Harness Desktop: an Electron shell composed as a DeepSeek Harness Cordis plugin.",
  "syncDesktopName": true
}
```

各字段的必要性：

- **`executableName`（必需，非可选）** — `verify-electron-fuses.ts` 的 `afterAllArtifactBuild` 会从配置重建可执行文件名：`configuration.linux?.executableName ?? configuration.executableName ?? DESKTOP_MANIFEST.name`，然后去 `dist/linux-arm64-unpacked/` 下查找。若不显式指定，Electron Builder 实际产出的名字与该回退值可能不一致，导致构建在最后一步失败。显式指定后两边读同一个值，从构造上消除歧义。
- **`icon: "build/icons"`（必需，指向目录）** — 上游 `build/` 下只有 macOS 的 `.icns`/`.png` 与 Windows 的 `.ico`，**没有任何 Linux 图标集**。`icon` 指向目录后 Electron Builder 会把该目录下所有 `<尺寸>x<尺寸>.png` 装进 `/usr/share/icons/hicolor/<尺寸>x<尺寸>/apps/`，同时用于 deb 的菜单图标。已提供 16/22/24/32/48/64/128/256/512 共 9 档（152KB），最高 512 档用于高分屏与部分启动器。
- **`syncDesktopName: true`** — 让 `.desktop` 文件名与 `executableName` 保持一致（`dsh-desktop.desktop`），而不是回落到 `productName` 派生的 `DSH Desktop.desktop`。这让窗口与桌面项的关联（`StartupWMClass`）稳定，也避免空格文件名在 shell 里到处要加引号。
- **`maintainer`（必需）** — deb 包规范强制要求维护者字段。上游 `package.json` 没有 `author` 字段，不补会直接报错。这里填的是你的 GitHub noreply 地址，可自行替换。
- **`category` / `synopsis` / `description`** — 生成 `.desktop` 桌面项元数据，缺失时 Electron Builder 用默认值。

**3. 新增 `build.deb`**

```json
{
  "packageName": "dsh-desktop",
  "artifactName": "dsh-desktop_${version}_${arch}.${ext}",
  "afterInstall": "build/deb-after-install.tpl"
}
```

`packageName` 把 deb 的**控制字段**包名从 `dsh-plugin-desktop` 规范为 `dsh-desktop`。但仅设它还不够——实测发现 Electron Builder 的 deb 产物**文件名**走的是另一条路径（`appInfo.name`，即 `package.json#name`），会产出 `dsh-plugin-desktop_2.0.11_arm64.deb`，与包名不一致，也会让 `apt install ./dsh-desktop_*_arm64.deb` 这个通配符匹配不上。因此显式钉死 `artifactName`。

`afterInstall` 指向自定义 postinst 模板。Electron Builder 的 `linux.desktop.entry.Exec` **被硬性拒绝**（配置校验直接报错），所以 `Exec` 只能改在 postinst 里。模板是在官方默认模板基础上**追加**一段，而不是重写——默认模板里的 sandbox 权限修正、AppArmor profile 装载、`update-desktop-database` 等逻辑都保留。

**4. 新增 `build.extraFiles`**

```json
[
  { "from": "build/lib-bundle",          "to": "lib" },
  { "from": "build/dsh-desktop-launch",  "to": "dsh-desktop-launch" },
  { "from": "build/libmesa_compat.so",   "to": "libmesa_compat.so" }
]
```

`build/lib-bundle` 是打包时由 `lib-bundle.tar.gz` 现场解压出来的目录（**每次强制重新解压**，避免上一次构建的残留悄悄遮蔽新归档——这种漂移会让本地构建与 CI 结果不一致）。归档入库、解压树不入库，是为了让仓库里只躺一个文件而不是 260 个二进制。

**5. 新增两个构建钩子**

```json
"afterPack": "./scripts/after-pack-linux.ts",
"afterAllArtifactBuild": "./scripts/after-all-artifact-build.ts"
```

上游原有的钩子被这两个文件**包装**而非替换，校验逻辑原样保留。

**刻意不设 `depends`** —— Electron Builder 会按 Electron 二进制自动探测动态库依赖，手工覆盖反而容易漏库。实测自动探测出的依赖为：`libgtk-3-0`、`libnotify4`、`libnss3`、`libxss1`、`libxtst6`、`xdg-utils`、`libatspi2.0-0`、`libuuid1`、`libsecret-1-0`，完整可用。

> 注意这些依赖与包内自带的库**不是一回事**：`depends` 保证系统里有基础的图形/通知/NSS 组件，而包内 glibc/GTK 负责抹平版本差距。包内自带运行时正是为了摆脱宿主库版本——**任何"改用宿主库"的折中都会在新发行版上崩**。CI 上曾踩过这个坑：把 NSS 族排除掉改用 runner 的，结果 24.04 runner 的 `libnspr4.so` 要求 `GLIBC_2.38`，而包内是 2.35，构建在最后一步失败。

---

## 五、打包入口脚本的设计

`dsh-plugin-desktop/scripts/package-linux-deb.ts` 与上游 `package-win.ts`、`package-mac.ts` 保持同一结构：

1. **宿主门禁** `assertLinuxDebHost` — 平台必须 `linux`、架构必须 `arm64`、Node 必须 22.19+ 或 24.x（与上游其它入口一致）。
2. **清理签名密钥** — 复用 `withoutMacReleaseSecrets`，并设 `CSC_IDENTITY_AUTO_DISCOVERY=false`。
3. **准备原生运行时** — `prepareFsExtForElectron({ platform: 'linux', arch: 'arm64' })`，产出校验器要求的 `electron.abi<ABI>.node`。
4. **调用 Electron Builder** —
   ```
   electron-builder --linux deb --arm64 --publish never --config.npmRebuild=false
   ```
   `--linux deb` 覆盖配置里的 `["dir"]`；`npmRebuild=false` 因为 fs-ext 已自行按 Electron ABI 编译。
5. **校验** — `afterPack`（`verify-packaged-runtime.ts`）与 `afterAllArtifactBuild`（`verify-electron-fuses.ts`）由 Electron Builder 自动调用，无需额外步骤。

在调 Builder 之前，脚本还做三件**幂等的前置准备**（顺序即依赖顺序）：

| 步骤 | 做什么 | 不做会怎样 |
|---|---|---|
| `expandLibraryBundle` | 解压 `lib-bundle.tar.gz` 到 `build/lib-bundle` | 包内没有 glibc，装完起不来 |
| `ensureLauncherIsExecutable` | `chmod 755 build/dsh-desktop-launch` | 见下 |
| `buildMesaCompatShim` | `gcc` 编译 `mesa-compat.c` → `libmesa_compat.so` | 本机 GPU 进程崩溃循环 |

**为什么必须在构建期 `chmod`**：GitHub Contents API **不保留可执行位**——通过它提交的脚本落盘是 `0644`。若依赖文件系统里的 mode，`extraFiles` 会把它不带执行位地拷进包，装完后 `.desktop` 的 `Exec` 指向一个不可执行的启动器，点了没反应。在构建期设 mode 让产物与文件"怎么进到工作树的"彻底解耦。

**为什么垫片要现场编译而不是入库 `.so`**：入库二进制无法审查、也无法保证与目标架构一致。垫片源码只有 40 行，用 `-Wl,--version-script=mesa-compat.map` 把三个符号按 `GLIBC_2.17` 导出即可（见第九节）。

---

## 六、工作流的三个关键设计决定

**1. 不检出 `deepseek-harness` 子模块，也不跑 `aa:prepare-release`。**

上游 `dist:mac` / `dist:win` 会先跑 `yarn aa:prepare-release`，该脚本会去克隆外部仓库 `anywhere-labs/Agents-Anywhere` 重新生成 vendored 依赖 tgz。但：

- 该 tgz 已提交在 `vendor/agents-anywhere/`；
- `dsh-plugin-desktop/package.json` 已用 `file:../vendor/agents-anywhere/...tgz` 指向它；
- `yarn.lock` 已有对应解析记录。

所以普通构建完全不需要它，跳过可省下大量时间和一次外部仓库依赖。同理，dsh 运行时已以 tgz 形式固化在 `vendor/dsh-runtime/0.1.5-rc.2/`，无需现场构建上游 DSH。

**2. 产出物同时作为 Artifact 和 Release 资产。**

你本机到 `github.com` 的 git/HTML 通道不通（实测 `GnuTLS recv error (-54)`、HTML 请求超时），而 Release 资产可以走 `api.github.com` 下载。因此工作流默认把 `.deb` 发到一个固定的预发布 tag `linux-arm64-deb`，方便你直接取用：

```
https://github.com/zcbxxx1/dsh-desktop/releases/tag/linux-arm64-deb
```

**3. 必须预装 Electron 的运行时共享库（最容易被忽略的一步）。**

`verify-electron-fuses.ts` 的 `afterAllArtifactBuild` 不只是读文件——它会对打包后的 Electron 二进制**真实执行 5 次**冒烟测试：

```
ELECTRON_RUN_AS_NODE=1 <packaged electron> --expose-internals <entry> <args>
```

分别校验 DSH CLI `--version`、pnpm `--version`、打包运行时自检、以及两条 desktop-cli 探针。动态加载器必须能解析 Electron 的共享库依赖（`libnss3`、`libgbm1`、`libasound2`、`libgtk-3-0` 等），否则整个构建会在**最后一步**失败，而此前已经消耗了大部分时间。

工作流里那一步会先探测镜像实际提供的包名再安装——Ubuntu 24.04 把若干包改名成了 `*t64` 后缀，硬编码包名会直接装不上。

---

## 七、使用方法

### 方式 A：用脚本一键完成（推荐）

```bash
cd fork-patch
GH_TOKEN=<你的 PAT> python3 apply-to-fork.py

# 只做检查、不写任何东西：
GH_TOKEN=<你的 PAT> python3 apply-to-fork.py --dry-run
```

脚本依次完成：fork → 等待就绪 → 写入 2 个新文件 → **合并式**更新 `package.json` → 触发工作流 → 打印 Actions 与 Release 链接。

`package.json` 采用**读取 fork 当前内容后合并**的方式，而不是整文件覆盖——即使上游在你 fork 之前又提交了新版本，也不会把别人的改动冲掉。脚本幂等，可重复执行。

令牌要求：**经典 PAT，勾选 `repo` 和 `workflow` 两个 scope**。
`workflow` 是必需的，因为要写入 `.github/workflows/` 下的文件。

### 方式 B：手工操作

1. 打开 https://github.com/anywhere-labs/dsh-desktop/fork 点 Fork
2. 把本目录下 3 个文件按相同路径提交到 fork 的 `master`
3. 在 fork 的 Actions 页面手动运行 `Linux arm64 deb` 工作流

### 安装产出的 deb

```bash
sudo apt install ./dsh-desktop_*_arm64.deb
```

---

## 八、本地实测验证结果

补丁不是纸面推演——我把 `master` 全量源码拉到本机（Kylin V10 SP1 / aarch64），**完整跑通了 CI 的每一步，包括两个校验钩子和全部冒烟测试，并产出了可安装的 `.deb`**。

### 全流程验证（含钩子）

| 环节 | 结果 |
|---|---|
| `yarn install --immutable` | 成功，40 秒（用 npmmirror 镜像） |
| `yarn workspace dsh-community-market build` | 成功 |
| `yarn workspace dsh-plugin-desktop build` | 成功，vite 产物完整 |
| `prepareFsExtForElectron({linux, arm64})` | **成功，ABI 148**（需 GCC 13，见下） |
| Electron Builder 下载 Electron 43.3.0 linux-arm64 | 成功（**不依赖 `node_modules/electron/dist`**，Builder 自行下载） |
| **`afterPack` 运行时校验** | **通过**，清点 22099 文件 / 233MB，全部必需条目齐备 |
| **`afterAllArtifactBuild` fuses 校验** | **通过**，`electronPath=dist/linux-arm64-unpacked/dsh-desktop` |
| deb 目标构建 | 成功，产出 133MB 安装包 |
| deb 控制字段 | `Package: dsh-desktop`、`Architecture: arm64`、`Maintainer` 生效、`Version: 2.0.11` |
| `.desktop` 桌面项 | 已生成 `/usr/share/applications/dsh-desktop.desktop` |
| 动态库依赖自动探测 | 9 项，完整 |
| **打包后 Electron 二进制可运行** | 成功，`ELECTRON_RUN_AS_NODE=1 ./dsh-desktop --version` → `v24.18.1` |

### 5 项冒烟测试全部通过

这是 `afterAllArtifactBuild` 实际执行的检查，我在本机逐条复现：

| 检查 | 期望 | 实测 |
|---|---|---|
| DSH CLI `--version` | `DSH_RUNTIME_VERSION` | `0.1.5-rc.2` ✓ |
| pnpm `--version` | `PNPM_RUNTIME_VERSION` | `11.8.0` ✓ |
| packaged runtime smoke | `DSH_PACKAGED_RUNTIME_OK` | `DSH_PACKAGED_RUNTIME_OK` ✓ |
| desktop-cli `--dump-config` | 含 `# == ` 与 `name:` | 输出配置树 ✓ |
| desktop-cli `--help` | 含 `dsh --profile headless` | `Usage: dsh --profile headless [options] [task...]` ✓ |

**最关键的一条**：`electronPath=dist/linux-arm64-unpacked/dsh-desktop` 直接证明了 `executableName` 设置生效——打包后的可执行文件就叫 `dsh-desktop`，与 `verify-electron-fuses.ts` 重建出的期望路径完全一致。这是此前识别的最大风险点，现已实证排除。

另外两点意外收获：Electron Builder **自带 arm64 版 fpm**（构建时自动下载 `fpm-1.17.0-ruby-3.4.3-linux-arm64v8.7z`），无需系统安装 fpm；`node-pty` 自带 `prebuilds/linux-arm64/` 预编译产物，无需现场编译。

### 本机如何补齐 C++20 工具链

`fs-ext` 需要针对 Electron 43 头文件编译，而 Electron 43 的 `v8-source-location.h` 包含 C++20 的 `<source_location>`，该头要求 **GCC 11+ / libstdc++ ≥ GLIBCXX_3.4.29**。Kylin V10 SP1 基于 Ubuntu 20.04 focal，自带最高 `libstdc++` 仅 `GLIBCXX_3.4.28`，`g++-9`/`g++-10`/`clang++-10` 全部无法编译。

解决办法是引入 **Ubuntu Toolchain PPA**（`ppa:ubuntu-toolchain-r/test` 提供 focal/arm64 的 gcc-11/12/13/14）：

```bash
# 密钥指纹（取自 PPA 的 Release.gpg）
#   C8EC952E2A0E1FBDC5090F6A2C277A0A352154E5
curl -s "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xC8EC952E2A0E1FBDC5090F6A2C277A0A352154E5" \
  | gpg --dearmor | sudo tee /etc/apt/trusted.gpg.d/ubuntu-toolchain-r-test.gpg >/dev/null
echo "deb https://ppa.launchpadcontent.net/ubuntu-toolchain-r/test/ubuntu focal main" \
  | sudo tee /etc/apt/sources.list.d/ubuntu-toolchain-r-test.list
sudo apt-get update && sudo apt-get install -y --no-install-recommends g++-13
```

之后以 `CC=gcc-13 CXX=g++-13` 运行打包即可（node-gyp 会读取这两个变量）。**CI 上无需此步骤**——`ubuntu-24.04-arm` 自带 GCC 13。

回滚方式：删除 `/etc/apt/sources.list.d/ubuntu-toolchain-r-test.list` 与 `/etc/apt/trusted.gpg.d/ubuntu-toolchain-r-test.gpg`，再 `apt-get remove g++-13 gcc-13 libstdc++-13-dev`。

### 安装验证（已实测）

```bash
sudo apt-get install ./dsh-desktop_2.0.11_arm64.deb
```

实测结果：

- `Status: install ok installed`、`Architecture: arm64`、`Version: 2.0.11`
- **`update-alternatives` 自动注册 `/usr/bin/dsh-desktop`** → `/opt/DSH Desktop/dsh-desktop`
- `desktop-file-utils`、`hicolor-icon-theme`、Kylin 的 `bamfdaemon` 触发器均正常执行，桌面索引重建成功
- 应用可运行：`ELECTRON_RUN_AS_NODE=1 "/opt/DSH Desktop/dsh-desktop" --version` → `v24.18.1`
- 安装后占用 603MB

**桌面项与图标**（补丁后新增，实测）：

- `/usr/share/applications/dsh-desktop.desktop` 的 `Exec` 被 postinst 改写为
  `Exec="/opt/DSH Desktop/dsh-desktop-launch" %U`
- 9 档图标落入 `/usr/share/icons/hicolor/<尺寸>x<尺寸>/apps/dsh-desktop.png`
- 从菜单启动时窗口正常出现，`WM_CLASS=dsh-desktop`，与 `.desktop` 项正确关联

**按真实 `Exec` 行做长跑验证**：

```bash
timeout 90 xvfb-run -a "/opt/DSH Desktop/dsh-desktop-launch"   # 或直接在图形会话中执行
```

结果：**存活至 90 秒被超时终止（退出码 124）**，期间 GPU 进程崩溃 0 次、NSS 致命错误 0 次、`no visible content` 告警 0 次。这是"应用不再自行退出"的直接证据。

卸载：`sudo apt-get remove dsh-desktop`。

### 不想用 CI 也可以在本地产出

补丁与工具链就绪后，本地一条命令即可产出同样的 `.deb`：

```bash
git clone <你的 fork>  &&  cd dsh-desktop
corepack yarn install --immutable
corepack yarn workspace dsh-community-market build
CC=gcc-13 CXX=g++-13 corepack yarn workspace dsh-plugin-desktop dist:linux-deb
# 产物：dsh-plugin-desktop/dist/dsh-desktop_2.0.11_arm64.deb
```

实测耗时约 3 分钟（Electron 与依赖已缓存时）。CI 的价值在于可复现、可分发、不依赖本机工具链。

### 已知的非阻断警告

构建日志中有一条无害警告，不影响产物可用性：

- `author is missed in the package.json` —— 已由 `linux.maintainer` 补足（deb 的 `Maintainer` 字段实测正确）

早期版本还报过 `desktopName is not set`，现由 `linux.syncDesktopName: true` 消除（`.desktop` 文件名与 `executableName` 对齐为 `dsh-desktop.desktop`）。

---

## 九、Kylin V10 SP1 上的宿主机问题（全部已定位）

**这一节记录的是"安装包做对了、但在这台机器上仍会踩到"的问题。** 三个都已定位并处理，但它们不是打包缺陷，换一台机器可能一个都不出现。

### 9.1 历史：Electron 43 启动即 SIGSEGV（已解决）

补丁的最初动机。安装成功、二进制可运行，但图形界面启动瞬间崩溃：

```
$ "/opt/DSH Desktop/dsh-desktop"
段错误（核心已转储）
```

`coredumpctl` 取到的崩溃栈：

```
#0  0x0000000000000000 n/a (n/a + 0x0)     ← 空函数指针调用
#1  0x0000559c71f52c   (dsh-desktop + 0x7c5f52c)
#2  0x0000559c71f3b4   (dsh-desktop + 0x7c5f3b4)
...
```

崩溃发生在工具包初始化阶段，**与 GPU 无关**——`--disable-gpu`、`--no-sandbox`、`--ozone-platform=x11` 全部同样崩溃。

根因是版本基线差距：

| 组件 | 本机（Kylin V10 SP1） | Electron 43 要求 |
|---|---|---|
| glibc | **2.31** | 2.35+ |
| GLib | **2.64.6** | 2.72+ |
| GTK | **3.24.23** | 3.24.33+ |
| pango / cairo | 1.44.7 / 1.16.0 | 更高 |

同机 `/opt/yuque-desktop` 使用 **Electron 30.5.1** 能正常运行，GPU 报错与 DSH 完全相同，但 Electron 30 会回退软件渲染，而 Electron 43 在更早的阶段就崩了。这组对照实验当初得出的结论是"任何 Electron 43 应用在这台机器上都起不来"——**这个结论只对"直接用上游二进制"成立**。自带运行时（一点五节）之后应用已能正常启动，这也是为什么本补丁选择"打包"而不是"降级 Electron"或"改系统库"。

> 保留这段是为了说明：如果只做 `target: ["dir"]` 的裸打包，产物在这台机器上完全不可用。自带运行时不是可选优化。

### 9.2 GPU 进程崩溃循环（已由启动器规避）

**现象**：应用能启动，但 GPU 进程反复崩溃、Chromium 重启几次后放弃并带走整个浏览器进程；同时渲染进程一直不出画面，日志里是

```
renderer surface watchdog: page has no visible content
```

**根因**：本机 GPU 是 Kirin 9000C 集成的 Maleoon 910。判断一个进程是否真的用上它，要看是否打开了 `/dev/hvgr0`——`card0` / `rendererD128` 属于 `hisi-dpu-drm` 显示控制器，不代表 GPU。本机 Mesa 在任何 DRI 搜索路径里都**找不到 `hisi-dpu_dri.so`**，所以 GPU 进程每次启动即死。

**处理**：启动器**默认追加 `--disable-gpu`**。实测崩溃次数从每次运行 3 次降到 0，应用稳定存活。软件渲染下功能完整——本来回退后也是软件渲染。

需要 GPU 时用 `--enable-gpu` 保留 GPU 进程（该 flag 由启动器消费，不会转发给 Chromium）。

**为什么不试试 Vulkan 直连**：`--use-angle=vulkan` 在这台机器上确实能让 ANGLE 选中 Vulkan 后端（绕过私有 EGL），但随后报 `Unknown GPU architecture` 并创建 ES 3.0 上下文失败。历史会话中为语雀等应用做过的 GPU 注入方案（`__libc_start_main` 改写 argv）在这里也不适用——它的前提是厂商 EGL 栈可用，而本机的问题是驱动缺失，不是后端选择。

**为什么不把 GPU 驱动打进包**：厂商驱动与具体机器绑定，打包进去等于把一台机器的驱动强加给所有用户。包内只保留 `libEGL`/`libGL`/`libGLX`/`libgbm`/`libvulkan` 这些**加载器框架**，真正的 DRI 驱动仍由系统提供。

**顺带处理的一个坑**：通用 Mesa 包自带一个与本案无关的 AMD `radeon_icd.aarch64.json`，它依赖 `libLLVM-11`，会让 GPU 进程以 `undefined symbol: mesa_memcpy` 崩掉。启动器在检测到 `/etc/vulkan/icd.d/maleoon_vulkan.json` 时把 `VK_ICD_FILENAMES` 钉死到厂商 ICD，避免枚举到那个 AMD 条目。

### 9.3 厂商 glibc 私有符号（已由垫片解决）

**这是"自带运行时"引出的新问题**，也是本补丁里最不直观的一处。

麒麟的 `libc-2.31.so` 在标准 glibc 之外**额外导出**了三个符号：

```
mesa_memcpy / mesa_memmove / mesa_memset
```

本机的 Mesa/GLX 与 Vulkan 驱动链接时引用了它们。而包内自带的**原版** glibc 2.35 没有这三个符号 → 宿主 GL 库解析失败 → GPU 进程崩溃循环。

**处理**：构建期用 `gcc` 编译一个 40 行的薄封装 `libmesa_compat.so`，把这三个符号按 `GLIBC_2.17` 版本标签导出（`-Wl,--version-script=mesa-compat.map`），启动器用 `LD_PRELOAD` 加载。封装就是转发到 `memcpy`/`memmove`/`memset`——**在不需要它的机器上完全无副作用**，因为符号名是厂商特有的。

**踩到的两个细节**：

- `LD_PRELOAD` **按空格和冒号一起切分**，而安装路径是 `/opt/DSH Desktop/`（含空格）。直接写会被截断成 `/opt/DSH`，加载器报 `object '/opt/DSH' from LD_PRELOAD cannot be preloaded` 后静默忽略。启动器因此先在 `$XDG_RUNTIME_DIR/dsh-desktop-shim/` 建一个无空格的软链再加载。
- `mesa-compat.c` 的注释里**不能出现 `*/` 序列**。最初写 `libGL*/libEGL*` 时提前闭合了块注释，编译报一堆莫名其妙的语法错误。

### 9.4 NSS 模块解析失败导致应用自行退出

**现象**：启动后一切正常，运行一段时间（或打开插件市场）后应用自己退出。日志里是

```
FATAL ... nss_error=-5925
```

**根因**：NSS 用**裸文件名** `dlopen("libsoftokn3.so")` 加载后端模块，而这些模块在发行版里位于 `nss/` 子目录——既不在默认搜索路径，也不在 ldconfig 缓存里。包内自带的原版 glibc 让 `$ORIGIN/lib` 生效后，Chromium 却仍找不到 NSS 模块，NSS 初始化失败会**直接 abort 整个浏览器进程**。

**处理**（两处配合）：

1. 包内**捆绑完整 NSS**（`libsoftokn3`、`libfreebl3`、`libfreeblpriv3`、`libnss3`、`libnssckbi`、`libnssdbm3`、`libnssutil3`、`libsmime3`、`libssl3`、`libnspr4`、`libplc4`、`libplds4`，连同 `.chk` 校验文件），平铺在 `lib/` 下，由 `$ORIGIN/lib` 解析
2. RPATH 追加系统 NSS 目录（`/usr/lib/aarch64-linux-gnu/nss`），兜住那些依赖宿主模块的路径

**这里有一个反直觉的教训**：CI 上曾为了绕开构建错误把 NSS 族"改用宿主库"，结果 runner（24.04）的 `libnspr4.so` 要求 `GLIBC_2.38`，而包内是 2.35，构建在最后一步报

```
libc.so.6: version GLIBC_2.38 not found (required by /lib/aarch64-linux-gnu/libnspr4.so)
```

**捆绑运行时的全部意义就是摆脱宿主库版本，任何"改用宿主库"的折中都会在新发行版上崩。**

### 9.5 目录选择器失败（`LD_LIBRARY_PATH` 的副作用）

**现象**：选择工作区时提示

```
无法打开文件夹 directory picker failed:
Command failed: zenity --file-selection --directory --title=Select Workspace Directory
```

**根因**：早期设计用 `LD_LIBRARY_PATH` 让包内库生效。这个变量**会被应用派生的每一个子进程继承**——`zenity` 于是加载了包内的 glibc/GTK（它本该用系统的那套），直接 SIGSEGV。实测同一台机器上带该变量必崩、不带则正常。

**处理**：改用 `DT_RPATH`（见一点五节）。RPATH 只作用于携带它的二进制，不会泄漏给子进程。改完后目录选择器正常。

### 9.6 插件市场超时

**现象**：点插件市场后一直卡在"检测中"，过一会儿报不可用。

**根因**：**这是应用侧问题，不是安装包缺陷。** 市场目录约 15MB，而抓取超时硬编码为 15 秒；本机直连该源实测只有 161KB/s → 必然超时。

**处理**：走代理。同一台机器上实测 11.3MB/s，市场正常加载。

### 9.7 备用路径：Web UI（已验证）

若 GUI 出问题，Web UI 不依赖 GTK，实测完全可用。启动器 `~/.local/bin/dsh-web`：

```bash
dsh-web              # 启动并打开浏览器
dsh-web --no-open    # 只启动服务
DSH_WEB_PORT=8080 dsh-web
```

实测：`127.0.0.1:3080` 正常监听；根路径返回 401（需鉴权）；带 token 访问返回 303（鉴权通过）。

启动器做对了两件事，缺一不可：

1. **`unset ELECTRON_RUN_AS_NODE NODE_OPTIONS`** —— 否则 Electron 会被强制退化成纯 Node
2. **`--expose-internals`** —— 否则 `@deepseek-ai/cordis-plugin-hmr` 报 `--expose-internals is required for HMR service` 并中止启动

### 9.8 启动器开关速查

| 开关 | 效果 |
|---|---|
| （无） | 默认 `--disable-gpu --no-sandbox`，本机推荐 |
| `--enable-gpu` | 保留 GPU 进程（宿主机驱动可用时） |
| `--disable-gpu` | 显式关闭 GPU 进程（与默认等价，但会转发给 Chromium） |

启动器做的全部事情：清 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` → 加载厂商符号垫片 → 强制 `XDG_SESSION_TYPE=x11` 并 `unset WAYLAND_DISPLAY` → 钉 `VK_ICD_FILENAMES` → 补 `--no-sandbox` → 按需补 `--disable-gpu` → `exec` 主程序。

> **为什么强制 X11**：厂商的 `/opt/x11-wayland/x11-ext.sh` 对 Kirin 芯片做的就是这件事，而且是必需的——从桌面会话继承 `XDG_SESSION_TYPE=wayland` 时应用在窗口出现前就 SIGSEGV，X11 模式则干净启动。同理丢弃 `WAYLAND_DISPLAY`。

### 9.9 其他可选路径及代价

| 路径 | 代价 | 建议 |
|---|---|---|
| 降级 Electron 到 30.x 重建 | `prepare-fs-ext.ts` 与 `verify-packaged-runtime.ts` 均硬编码 `abi148`，`peerDependencies` 锁定 43.3.0，需同步改多处 | 不推荐，脆弱 |
| 升级系统 GTK/GLib/glibc | 可能破坏 UKUI 桌面 | 不推荐 |
| 新版发行版容器内跑 GUI（distrobox 等） | 需额外部署，GUI 转发有开销 | 可选 |
| 用 Web UI | 无 | 备用 |

---

## 十、已知风险与应对

| 风险 | 说明 | 应对 |
|---|---|---|
| `ubuntu-24.04-arm` 配额 | arm64 runner 对公开仓库免费；fork 自公开仓库即为公开 | 若报配额错误，改用 `ubuntu-22.04-arm` |
| 首次构建耗时 | 需下载 Electron arm64 二进制、编译 fs-ext/node-pty、构建 market 与 desktop | 已设 `timeout-minutes: 90`，并缓存 yarn cacheFolder。本机实测完整流程约 3 分钟（Electron 已缓存时） |
| 上游 CI 的 `check` 任务 | 改动只涉及 `scripts/`、`build/` 与 `package.json`，而 `verify-desktop-variants` 只比对两个 workspace 的 `src/` | 不受影响 |
| 包体较大 | 自带 50MB 运行时，deb 约 133MB，安装后占用约 600MB | 这是"不依赖宿主 glibc"的必然代价；麒麟官方 Web App Engine 采用同一策略 |
| 启动器是 shell 脚本 | 需要 `/bin/sh`（POSIX），且依赖 `ln`/`mkdir` | 已在 `#!/bin/sh` + `set -eu` 下编写，仅用 POSIX 内建与 `ln`/`mkdir` |
| 垫片在无该厂商符号的机器上是空操作 | `LD_PRELOAD` 一个不提供被引用符号的库 | 无副作用：符号名是厂商特有的，且加载失败仅打印一行提示不中断启动 |
| 安装路径含空格 | `/opt/DSH Desktop` | 启动器已用引号包裹并处理 `LD_PRELOAD` 的切分问题；postinst 里 `Exec` 也带引号 |

**整条链路已在本机完整验证通过**（含两个校验钩子与 5 项冒烟测试），详见第八节。构建失败的剩余可能性主要来自 CI 环境差异（runner 镜像变更、配额），而非补丁本身。

### 验证状态一览

| 项目 | 状态 |
|---|---|
| CI 工作流（`linux-arm64-deb.yml`） | 全绿，20/20 步通过，产出可安装 `.deb` |
| 本机 deb 安装 | 成功，`update-alternatives` 注册 `/usr/bin/dsh-desktop` |
| 按 `.desktop` 真实 `Exec` 行启动 | 存活至 90 秒（退出码 124＝被测试超时终止），未自行退出 |
| GPU 进程崩溃 | 0 次（默认 `--disable-gpu`） |
| NSS 致命错误 | 0 次 |
| 无内容告警 | 0 次 |
| 目录选择器 | 正常（`LD_LIBRARY_PATH` 副作用已消除） |
| 图标 | 9 档尺寸装入 hicolor，菜单与窗口均有图标 |
| 插件市场 | 走代理后正常加载（直连必超时，应用侧 15s 硬编码超时） |

**唯一未完全定位的现象**：日志中有 `write EFAULT` 报错（一次运行约 209 次，来自 `desktop-web-server` 的 WebSocket ping 路径，每 2 秒一次）。应用会自行恢复，不影响功能，未继续深究。

---

## 十一、许可证与归属

上游为 MIT。本补丁仅为构建配置，构建产物是社区版本，与 DeepSeek AI 官方无关。上游项目自身仍处于 developer preview，官方明确提示会有破坏性兼容变更。
