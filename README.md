# Terminal (local.terminal)

PI-Desktop 工作面板里的内嵌终端：xterm.js 前端 + python3 PTY relay，在当前工作区打开你的登录 shell（`$SHELL -l`）。

## 目录

```
manifest.json            插件清单（id: local.terminal，权限 ui.view + shell.openExternal）
src/main.src.js          插件进程：会话管理、长轮询、背压、输入法切换（ime.*）；含 __RELAY_SRC__ 占位
src/relay.py             PTY relay（pty.fork + select），构建时内嵌进 main.js
src/views/               面板：index.html / panel.js / panel.css
scripts/build.js         组装 dist/local.terminal/（拷入 xterm 与 addon、内嵌 relay）
test/e2e.js              离线端到端（mock pi，直连 onPanelInvoke）
test/harness.js          仅测试用：HTTP 假桥接，可在浏览器里预览面板
dist/                    构建产物（不入库）
```

## 构建与发布

```bash
npm ci
npm run build            # -> dist/local.terminal/
npm test                 # 离线 e2e（会起真实 shell）
```

然后在 PI-Desktop 里对 `dist/local.terminal` 跑 PluginCheck / PluginPack（PluginCheck 只认工作区相对路径，
目录需在工作区内），得到 `.piplug`，在插件页安装。发版前同步改 `manifest.json` 和 `package.json` 的版本号。

## 设计要点

- 宿主没有 插件→面板 的推送接口，输出靠 `term.poll` 长轮询；按键 `term.write` 合并批量发送。
- 面板重开时 `term.attach` 回放 256KB 滚动缓冲，旧 poller 通过 `gen` 被顶掉。
- 面板落后 4MB 时暂停 shell（背压）。
- 只有一个会话时隐藏标签栏（宿主标题栏已有“终端”页签），悬停右上角出现 `+`；两个及以上会话时显示标签栏。
- 需要 PATH 里有 python3（macOS 自带）。
- 终端按项目隔离：会话创建时记下所属项目（`projectId`，宿主没给就用主文件夹路径），面板只 attach 当前项目的会话；切换项目后面板靠轮询（1.5s）发现 key 变化并换成新项目的终端，旧项目的 shell 留在后台，切回来时回放滚动缓冲。面板不再往通道里传 `ws`：`pi.workspace.get()` 与面板桥的 `workspace.get` 读的是同一个值。
- 输入法（macOS，0.1.6 起，**默认关闭**）：需要先在插件设置里打开「自动切换到英文输入法」——没装 `im-select` 的人没有开启的必要，所以默认是关的（设置项的详细说明在标题旁的提示图标里）。打开后：面板文档拿到键盘焦点时（点进终端）把系统输入源切到英文（`imeTarget`，默认 `com.apple.keylayout.ABC`），失焦（点回对话/切 tab/切到别的 app）时切回你原来那个输入源。实现上：面板监听 `window` 的 `focus`/`blur`、`visibilitychange`、`pagehide`，并每 500ms 用 `document.hasFocus()` 对账（宿主切 tab 是把 view 从 contentView 摘掉，不保证发 blur），只在后端**确认过**某条边沿后才认为状态一致，失败的发送会被对账重发；插件进程把边沿排成串行队列（失焦不会插到还在一半的聚焦写入中间），用可选依赖 `im-select`（`/opt/homebrew/bin` 等路径自动探测）读/写输入源，先记住旧值再切。失焦恢复的规则：只有当系统当前的输入源仍是我们切过去的目标时才恢复；若那时已经是别的输入源（你手动换过，或 macOS 报的是前台 app 自己的输入源），我们认为不该覆盖而保持不动。恢复/切换失败时记住的旧值不丢，下一次边沿或 `onUnload` 会重试。未安装 `im-select` 或非 macOS 时整个功能静默 no-op。TIS API 不需要辅助功能/输入监控授权。
- 链接：xterm 的 WebLinksAddon 捕获终端里的 http(s) 链接，点击后交给宿主桥接通道 `shell.openExternal`（默认浏览器打开）。该通道受同名的 manifest 权限门禁，缺失时宿主回 `PERMISSION_DENIED`，面板会把失败原因写到状态行（不再静默）。宿主只放行 http(s)/mailto，`file://` 或纯路径不会打开。

## 已知限制

- 插件无法把自己的 tab 切到前台，也不能声明全局快捷键；面板内 ⌘T / ⌘W 仅在焦点在面板时有效。
- 字体栈 `ui-monospace, "SF Mono", Menlo…` 13px，未指定中文回退字体。
- 宿主内的桥接往返延迟、停靠与字体渲染尚未做系统实测（离线 e2e 为 mock 桥接）。
- 链接打开完全依赖宿主通道：若插件版本权限里没有 `shell.openExternal`（老版本 0.1.4 即如此），点击链接会在状态行报 `missing permission: shell.openExternal`，需重新安装本插件以授予该权限。
- 输入法切换是**系统级**的（macOS 的输入源全局生效，不按窗口）：焦点在终端面板期间，其它面板/输入框也是英文。目标输入源必须是系统里已启用的输入源（`im-select` 只会切到可用项）；未安装 `im-select`（`brew install im-select`）时功能整体不生效。
- 输入法的失败面：`im-select` 被移除、超时或拒绝切换时，可能**停留在英文**（面板侧不会再发边沿，直到你再次点进/点出终端，或插件重载时 `onUnload` 兜底）；这种情况状态行不报错，只有 `ime.state` 通道能看到 `error`。
- 面板侧的焦点检测（`window` 的 focus/blur + `document.hasFocus()` 500ms 兜底）只在离线 e2e 里验证了插件进程一侧；宿主 WebContentsView 里“点进终端切英文、点回对话/切 tab 恢复”的真实时序需要装载后人工确认一次。
