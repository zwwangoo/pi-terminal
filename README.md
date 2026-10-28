# Terminal (local.terminal)

PI-Desktop 工作面板里的内嵌终端：xterm.js 前端 + python3 PTY relay，在当前工作区打开登录 shell（`$SHELL -l`）。需要 PATH 里有 python3（macOS 自带）。

## 目录

```
manifest.json            插件清单：视图 terminal、命令 local.terminal.open、设置项与权限
src/main.src.js          插件进程：会话、长轮询、背压、设置、输入法切换；含 __RELAY_SRC__ 占位
src/ring-buffer.js       每会话输出环形缓冲
src/relay.py             PTY relay（pty.fork + select），构建时内嵌进 main.js
src/views/               面板：index.html / panel.js / panel.css
scripts/build.js         组装 dist/local.terminal/（拷入 xterm 与 addon、内嵌 relay）
test/ring-buffer.js      环形缓冲单测
test/shortcut.js         ⌘T 命令：注册、唤起视图、被拒时不抛错
test/e2e.js              离线端到端（mock pi，直连 onPanelInvoke，会起真实 shell）
test/harness.js          HTTP 假桥接，可在浏览器里预览面板
dist/                    构建产物（不入库）
```

## 构建与发布

```bash
npm ci
npm run build            # -> dist/local.terminal/
npm test
```

在 PI-Desktop 里对 `dist/local.terminal` 跑 PluginCheck / PluginPack（只认当前工作区内的相对路径），在插件页安装生成的 `.piplug`。发版前同步改 `manifest.json` 和 `package.json` 的版本号。

## 功能

- **按项目隔离**：会话记下所属项目，面板只显示当前项目的终端；切换项目后约 1.5 秒换成新项目的终端，旧 shell 留在后台，切回来时回放输出。只有一个会话时隐藏标签栏，悬停右上角出现 `+`。
- **⌘T 打开终端**：设置项 `openShortcut`（默认 `Mod+T`，Windows/Linux 为 Ctrl+T）在对话窗口里把终端面板切到前台，没有终端页签就新建一个；⌘K 命令面板里也有「打开终端」。焦点在终端里时，⌘T 是新建标签。
- **面板快捷键**：⌘C 仅在有选区时复制（Ctrl+C 始终是中断）、⌘V 粘贴（bracketed paste）、⌘A 全选、⌘K 清除滚动缓冲、⌘+ / ⌘- / ⌘0 缩放字体（只认 ⌘，Ctrl+- 留给 readline）、⌘T / ⌘W 新建 / 关闭标签；非 mac 用 Ctrl+Shift+C / V。
- **右键菜单**：复制、粘贴、粘贴为单行（换行折成空格，防止多行命令直接执行）、全选、清除滚动缓冲、新建 / 关闭标签；悬停在 http(s) 链接上时多出「打开链接 / 复制链接地址」。支持键盘导航，跟随宿主明暗主题与语言。
- **链接**：点击终端里的 http(s) 链接，经宿主 `shell.openExternal` 用默认浏览器打开；失败原因写到状态行。
- **输入法自动切换**（仅 macOS，默认关闭，需 `brew install im-select`）：点进终端时切到英文（`imeTarget`），离开时切回原输入源；如果离开时你已手动换成别的输入源，则不覆盖。

### 设置

设置弹窗里的项：`openShortcut`、`linkNeedsModifier`（按住 ⌘/Ctrl 才打开链接）、`pasteSingleLine`（⌘V 与右键「粘贴」默认折成单行）、`imeAutoSwitch`。

以下三项没有放进弹窗（宿主的文本框比开关高很多，排版参差，manifest 又不能调样式），需手改 `~/.pi-desktop/plugins/data/local.terminal/settings.json`（不存在就新建一个 JSON 对象）：

- `fontSize`：默认 13，范围 8–32。用 ⌘+ / ⌘- / ⌘0 调整会自动保存，一般不用手改。
- `fontFamily`：默认空，即内置字体栈 `ui-monospace, "SF Mono", Menlo…`（未指定中文回退字体）。例：`"fontFamily": "JetBrains Mono"`。
- `imeTarget`：默认 `com.apple.keylayout.ABC`。

手改后，在设置弹窗里保存一次或重载插件才会生效：宿主只在弹窗保存时推送设置，插件订阅了这个推送就不再轮询。

## 实现要点

- **输出通道**：宿主没有「插件 → 面板」的推送接口，输出靠 `term.poll` 长轮询，按键由 `term.write` 合并批量发送。每段输出带单调递增的 `seq`，`poll` 从上次渲染的位置续读，重试只会重复、不会跳过；`term.attach` 回放缓冲并返回 `nextSeq`，旧的 poller 通过 `gen` 被顶掉。
- **缓冲与背压**：每会话保留 1 MiB，裁剪只丢整块。有面板在读且落后超过 512 KiB 时暂停 pty，追到 128 KiB 以下恢复；5 秒内没人轮询（面板关了、切到别的项目）就不暂停，改为丢最旧的块，后台 shell 不会被冻结。只有面板停顿后接着读、中间那段已被丢掉时，`poll` 才返回 `truncated`，面板打出 `[output dropped…]`。
- **设置读取**：面板通过 `term.settings` 取值（每 2 秒，以及聚焦、可见性变化时），`term.saveFont` 写回字号（防抖 0.6 秒）。后端与输入法共用一份缓存：有宿主推送事件就只读一次，没有就按 3 秒 TTL 重读。插件自己 `setSettings` 不会触发推送，所以保存字号时自己更新缓存，失败则还原。清洗规则：字号取整并限幅，非正数 / 非数字用默认值；字体名去掉 `; { } < > \` 和换行、限 200 字符，用 `CSS.supports` 校验，不合法时逐级降级到内置字体栈；开关只认 `true`。
- **输入法**：面板监听 focus / blur / visibilitychange / pagehide，另每 500 ms 用 `document.hasFocus()` 对账（宿主切页签时不保证发 blur）。每个面板文档带 `client` id，后端只认最后一次上报聚焦的文档发来的失焦。插件进程把焦点变化排成串行队列，按「想要英文」「已经切过」两个状态收敛，重复事件不会重复调用 im-select；切换失败时保留记住的原输入源，下一次焦点变化或 `onUnload` 时重试。im-select 从 `/opt/homebrew/bin` 等路径自动探测，找不到的结果缓存 5 秒；测试时可用环境变量 `PI_TERMINAL_IM_SELECT` 指定路径。

## 已知限制

- ⌘T 是窗口内快捷键，不用宿主的系统级全局快捷键，以免抢走其它应用的 ⌘T。终端已在前台时再按不会收起。按 ⌘T 后要点一下面板才能输入：宿主切换视图时不转移键盘焦点，面板侧 `window.focus()` 也拿不到焦点。
- 面板内快捷键只在焦点位于面板时有效。程序开启鼠标上报（vim / tmux 等）时，要按住 Shift 右键才弹出本菜单。右键链接项只覆盖 http(s)。
- 宿主只放行 http(s) / mailto 链接，`file://` 和纯路径不会打开。
- 输入法切换是系统级的，焦点在终端期间其它输入框也是英文；目标必须是系统里已启用的输入源。im-select 失败（被移除、超时、拒绝）时可能停留在英文，状态行不提示，只有 `ime.state` 能看到 `error`。
- 剪贴板优先走宿主通道，被拒时退回 `navigator.clipboard`，两边都失败则在状态行提示 4 秒。
- 以下行为只做过离线测试，需在宿主里人工确认：点进 / 点出终端时输入法切换的时序、剪贴板回退路径、右键与 ⌘+ / ⌘- 是否被宿主先截走、桥接延迟与字体渲染。
