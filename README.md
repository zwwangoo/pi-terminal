# Terminal (local.terminal)

PI-Desktop 工作面板里的内嵌终端：xterm.js 前端 + python3 PTY relay，在当前工作区打开你的登录 shell（`$SHELL -l`）。

## 目录

```
manifest.json            插件清单（id: local.terminal，权限 ui.view + shell.openExternal + clipboard.read + clipboard.write）
src/main.src.js          插件进程：会话管理、读者游标、长轮询、背压、输入法切换（ime.*）；含 __RELAY_SRC__ 占位
src/ring-buffer.js       每会话输出环形缓冲（seq 寻址、整块裁剪、truncated）
src/relay.py             PTY relay（pty.fork + select），构建时内嵌进 main.js
src/views/               面板：index.html / panel.js / panel.css
scripts/build.js         组装 dist/local.terminal/（拷入 xterm 与 addon、内嵌 relay）
test/ring-buffer.js      环形缓冲单测（seq 寻址、整块裁剪、truncated）
test/e2e.js              离线端到端（mock pi，直连 onPanelInvoke）
test/harness.js          仅测试用：HTTP 假桥接，可在浏览器里预览面板
dist/                    构建产物（不入库）
```

## 构建与发布

```bash
npm ci
npm run build            # -> dist/local.terminal/
npm test                 # 环形缓冲单测 + 离线 e2e（会起真实 shell）
```

然后在 PI-Desktop 里对 `dist/local.terminal` 跑 PluginCheck / PluginPack（PluginCheck 只认工作区相对路径，
目录需在工作区内），得到 `.piplug`，在插件页安装。发版前同步改 `manifest.json` 和 `package.json` 的版本号。

## 设计要点

- 宿主没有 插件→面板 的推送接口，输出靠 `term.poll` 长轮询；按键 `term.write` 合并批量发送。
- 每段输出带单调 `seq`：`term.poll` 传 `from` 从上次渲染的位置续读。同一位置重试会拿到同一块（可能重复，绝不会跳过）。
- 每个会话一个按块存取的环形缓冲（`src/ring-buffer.js`，保留 1MiB）：裁剪只丢整块、不会在块内部再切一刀（块边界来自 pty 的单次读取，字符会不会跨块由写入方决定，这一层只保证自己不新增切口）；`term.attach` 回放保留范围并返回 `nextSeq`，旧 poller 通过 `gen` 被顶掉。
- 背压按“读者落后量”算：有人轮询且落后超过 512KiB 就暂停 pty，追到 128KiB 以下恢复；没人轮询（面板关了、切到别的项目）则不暂停，改为丢最旧的块 —— 后台 shell 因此不会被冻结。只有“同一个面板停顿超过 5 秒后又接着读、而那段输出已被丢掉”时 poll 才返回 `truncated`，面板打出 `[output dropped…]`；切回项目走的是 attach 静默回放，不提示。
- 只有一个会话时隐藏标签栏（宿主标题栏已有“终端”页签），悬停右上角出现 `+`；两个及以上会话时显示标签栏。
- 需要 PATH 里有 python3（macOS 自带）。
- 终端按项目隔离：会话创建时记下所属项目（`projectId`，宿主没给就用主文件夹路径），面板只 attach 当前项目的会话；切换项目后面板靠轮询（1.5s）发现 key 变化并换成新项目的终端，旧项目的 shell 留在后台，切回来时回放滚动缓冲。面板不再往通道里传 `ws`：`pi.workspace.get()` 与面板桥的 `workspace.get` 读的是同一个值。
- 输入法（macOS，0.1.6 起，**默认关闭**）：需要先在插件设置里打开「自动切换到英文输入法」——没装 `im-select` 的人没有开启的必要，所以默认是关的（设置项的详细说明在标题旁的提示图标里）。打开后：面板文档拿到键盘焦点时（点进终端）把系统输入源切到英文（`imeTarget`，默认 `com.apple.keylayout.ABC`），失焦（点回对话/切 tab/切到别的 app）时切回你原来那个输入源。实现上：面板监听 `window` 的 `focus`/`blur`、`visibilitychange`、`pagehide`，并每 500ms 用 `document.hasFocus()` 对账（宿主切 tab 是把 view 从 contentView 摘掉，不保证发 blur），只在后端**确认过**某条边沿后才认为状态一致，桥被拒绝的发送（插件还在加载）会被对账重发，而 im-select 自身失败（后端回 `ok:false`）算已送达、不会每 500ms 重试；每个面板文档带一个 `client` id，后端只认**最后一次上报聚焦的那个文档**的失焦（重载/第二个面板迟到的失焦会被忽略，也不会因为某个视图没发失焦而卡死）；插件进程把边沿排成串行队列（失焦不会插到还在一半的聚焦写入中间），按「终端想要焦点」与「已经切换过」两个状态收敛，重复边沿不会再 spawn；插件订阅宿主的 `plugin:settingsChanged` 事件，设置保存后立即生效且不轮询：焦点期间关掉开关会**立刻**恢复原输入源，终端已有焦点时才打开开关会立刻切到英文（订阅成功后设置只在首次读一次，之后每条边沿都不再读设置；宿主没有 `pi.events` 时退回「最多 3 秒读一次」，在下一次焦点变化时生效）；找不到 `im-select` 的结果只缓存 5 秒，之后的下一次焦点变化会重新探测；设置了环境变量 `PI_TERMINAL_IM_SELECT` 时只用它（测试用）；用可选依赖 `im-select`（`/opt/homebrew/bin` 等路径自动探测）读/写输入源，先记住旧值再切。失焦恢复的规则：只有当系统当前的输入源仍是我们切过去的目标时才恢复；若那时已经是别的输入源（你手动换过，或 macOS 报的是前台 app 自己的输入源），我们认为不该覆盖而保持不动。恢复/切换失败时记住的旧值不丢，下一次边沿或 `onUnload` 会重试。未安装 `im-select` 或非 macOS 时整个功能静默 no-op。TIS API 不需要辅助功能/输入监控授权。
- 链接：xterm 的 WebLinksAddon 捕获终端里的 http(s) 链接，点击后交给宿主桥接通道 `shell.openExternal`（默认浏览器打开）。该通道受同名的 manifest 权限门禁，缺失时宿主回 `PERMISSION_DENIED`，面板会把失败原因写到状态行（不再静默）。宿主只放行 http(s)/mailto，`file://` 或纯路径不会打开。
- 右键菜单与快捷键（0.2.0 起）：终端区域右键弹出自绘菜单。鼠标悬停在 http(s) 链接上时，顶部多出「打开链接 / 复制链接地址」；其余固定为：复制 / 粘贴 / 粘贴为单行 / 全选 / 清除滚动缓冲 / 新建标签 / 关闭标签（共 7 项，有链接时 9 项）。「粘贴为单行」把剪贴板里的换行折成一个空格再粘贴，避免多行命令粘进去直接执行。菜单明暗主题跟随宿主，支持 ↑↓ Home End 与 Esc，点空白处、滚轮、窗口失焦或缩放时关闭；中文系统显示中文。快捷键：⌘C 仅在有选区时复制（没有选区不拦截，Ctrl+C 始终是中断信号）、⌘V 粘贴（走 `term.paste`，bracketed paste 生效）、⌘A 全选、⌘K 清除滚动缓冲、⌘+ / ⌘- / ⌘0 缩放字体（只认 ⌘，Ctrl+- 是 readline 的撤销，要留给 shell）；非 mac 键位用 Ctrl+Shift+C / V。全局点击聚焦终端的逻辑已排除菜单区域。
- 面板设置（0.2.0 起）：宿主的设置弹窗里只有三个开关——`linkNeedsModifier`（按住 ⌘/Ctrl 才打开链接，默认关；右键菜单的「打开链接」不受影响）、`pasteSingleLine`（⌘V 和右键「粘贴」折成单行，默认关；开启后菜单里第二项改为「粘贴（保留换行）」）、`imeAutoSwitch`（输入法，见上）。**字体大小、字体、输入法 id 三个输入框特意没有放进弹窗**：宿主把文本框画得比开关高很多，同一页里行高参差不齐，而插件的 manifest 没有任何字段能调样式。它们仍然是真实的设置，只是没有表单：
  - `fontSize`：默认 13，8–32。在面板里用 ⌘+ / ⌘- / ⌘0 调整会自动保存，不需要手改。
  - `fontFamily`：默认空（内置字体栈）。要换字体，手改配置文件加 `"fontFamily": "JetBrains Mono"`。
  - `imeTarget`：默认 `com.apple.keylayout.ABC`，手改同理。
  - 配置文件是 `~/.pi-desktop/plugins/data/local.terminal/settings.json`（宿主合并写入，弹窗保存开关时不会冲掉这些没声明的键；首次保存前文件可能不存在，自己建一个 JSON 对象即可）。手改后约 5 秒内面板就会采用字号和字体，输入法 id 在下次聚焦时生效。
  面板没有设置接口，靠通道 `term.settings` 向后端取值、`term.saveFont` 回写字号。后端在 `rawSettings()` 里复用输入法同一份缓存（有宿主推送事件就不轮询，没有则 3 秒 TTL）并做清洗：字号取整并限幅到 8–32，0 / 负数 / 非数字当作「未设置」用默认值，字体名去掉 `; { } < > \` 和换行、最长 200 字符，开关只认真正的 `true`。宿主只在**它自己的弹窗**保存时才推送变更事件，插件自己调 `pi.plugin.setSettings` 不会触发，所以 `saveFontSize` 写入后要自己更新缓存（写失败则还原缓存）。面板每 2 秒（以及窗口聚焦、可见性变化时）取一次，页面隐藏时不取；首个终端在设置返回后才创建，避免先闪一下默认字体。为防止一次已发出的旧读取把刚调好的字号拉回去，面板用一个计数器：读取期间用户又缩放过、或有一次保存尚未完成，就不采用这次读到的字号。字体名是裸名字（如 `JetBrains Mono`、`3270 Nerd Font`）时自动加引号，含逗号或引号时按原样使用，并用 `CSS.supports` 校验：整串会被浏览器拒绝的话降级成安全加引号的写法，再不行就用内置栈，避免终端掉成非等宽字体。内置字体栈始终作为回退追加在最后。

## 已知限制

- 插件无法把自己的 tab 切到前台，也不能声明全局快捷键；面板内 ⌘T / ⌘W / ⌘C / ⌘V / ⌘A / ⌘K / ⌘+ / ⌘- / ⌘0 仅在焦点在面板时有效。
- 内置字体栈 `ui-monospace, "SF Mono", Menlo…`，默认 13px，未指定中文回退字体；想换字体见上面「面板设置」里的 `fontFamily`（手改配置文件）。
- 宿主内的桥接往返延迟、停靠与字体渲染尚未做系统实测（离线 e2e 为 mock 桥接）。
- 链接打开完全依赖宿主通道：若插件版本权限里没有 `shell.openExternal`（老版本 0.1.4 即如此），点击链接会在状态行报 `missing permission: shell.openExternal`，需重新安装本插件以授予该权限。
- 输入法切换是**系统级**的（macOS 的输入源全局生效，不按窗口）：焦点在终端面板期间，其它面板/输入框也是英文。目标输入源必须是系统里已启用的输入源（`im-select` 只会切到可用项）；未安装 `im-select`（`brew install im-select`）时功能整体不生效。
- 输入法的失败面：`im-select` 被移除、超时或拒绝切换时，可能**停留在英文**（失败只上报一次、不自动重试，直到你再次点进/点出终端，或插件重载时 `onUnload` 兜底）；这种情况状态行不报错，只有 `ime.state` 通道能看到 `error`。
- 面板侧的焦点检测（`window` 的 focus/blur + `document.hasFocus()` 500ms 兜底）只在离线 e2e 里验证了插件进程一侧；宿主 WebContentsView 里“点进终端切英文、点回对话/切 tab 恢复”的真实时序需要装载后人工确认一次。
- 剪贴板 / 右键菜单（0.2.0 起）依赖宿主通道 `clipboard.readText` / `clipboard.writeText`（manifest 权限 `clipboard.read` / `clipboard.write`，属中风险权限，老版本升级需重新授权）。通道被拒时会退回 `navigator.clipboard`，两边都失败则在状态行提示 4 秒后清除；这条回退路径、以及宿主里右键事件是否会被宿主自己截走，都没有在真实宿主里实测过，装载后需人工确认一次。
- 程序开启鼠标上报（vim / tmux 等）时右键归该程序所有，此时按住 Shift 右键才会弹出本菜单。
- ⌘+ / ⌘- / ⌘0 的缩放（8–32px）所有标签共用，调整后约 0.6 秒写入插件设置（连按只写最后一次），下次打开面板保持这个大小；⌘0 回到默认 13 并同样写入。写入失败时状态行提示，但当前字号仍然生效。若宿主自己也绑定了 ⌘+ / ⌘-，可能先被宿主截走，需装载后人工确认。
- 右键链接项依赖 WebLinksAddon 的悬停回调，加上 xterm 的指针光标类 `xterm-cursor-pointer` 双重判断，只覆盖 http(s) 链接。
