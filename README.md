# OA 桌面壳

独立的 EMobile10 OA 桌面窗口。使用简洁的浅色界面，保留现有消息、通讯录、应用和 OA 导航。分身固定在会话列表顶部，点开后在聊天区查看加班明细、刷新出勤或设置本机提醒。

加班明细中，OA 已关联加班申请流程的记录会显示绿色“已申请”标识。标识依据 OA 返回的关联流程，不表示审批已通过。

聊天图片双击预览，单击会提示“双击查看图片”。双击后立即显示加载状态，等待时阻止重复触发；图片预览出现后提示自动消失。原图仍由 OA 加载。

可以给本机分身下命令，也可以直接说“本月加班”“刷新出勤”。`/加班` 查看未申请记录，`/刷新` 重新读取出勤，`/打开 工作消息` 或 `/打开 首页` 打开页面，`/提醒 18:00 提交加班` 到点后只发本机通知。`/取消 提交加班` 取消还没到点的提醒。分身不会代发消息或提交申请。

界面使用 Vue 3，运行时为当前受支持的 Electron 45。主进程、预加载脚本和打包由 electron-vite 与 electron-builder 管理。OA 页面仍由原网页负责登录、聊天和申请。

```powershell
npm install
npm test
npm run test:preview
npm run dev
```

`npm run dev` 会热更新 Vue 分身界面，不会因此重新加载 OA 页面。主进程或预加载脚本改动后需要重启开发进程。

```powershell
npm start
npm run dist:dir
npm run dist:win
```

`npm start` 先构建，再预览生产版本。`dist:dir` 输出 `dist/win-unpacked/oa-shell.exe`，`dist:win` 生成 Windows 安装包。双击 `start-oa.cmd` 优先打开该 exe；未打包时使用 `npm start`。后续统一使用这一发布入口，不再按修复任务建立多套目录。

## 当前目录

「分身 → 接入设置 → AI 模型」可连接本机 Magpie，刷新模型目录、启用对话和验证工具调用。Codex 执行器提供单独的固定示例测试，真实任务开发流程仍待接入。

分身右上角“接入设置”可添加多个 Jira / 内部任务系统，保存后测试连接、预览任务。在对话中发送 `/任务` 或“查看任务”读取预览。此阶段只读，未开启自动领取、AI 开发或定时执行。接入方式、认证与验证范围见 [INTEGRATIONS.md](INTEGRATIONS.md)。

- `src/main/`：TypeScript 主进程与窗口管理。
- `src/preload/`：Electron 预加载入口。
- `src/renderer/`：Vue 3 分身界面。
- `src/*.js`：当前仍使用的 OA 兼容、消息提醒、出勤和本地存储模块。
- `resources/`：OA 主题及 Windows 闪烁辅助脚本。
- `assets/`：当前图标及打包图标。
- `test/`：业务和兼容性回归测试。

`out/`、`dist/` 为构建产物，`node_modules/` 为开发依赖。旧版根目录 `renderer/`、旧 Electron 入口及临时排查脚本已移除。用户登录状态和本机数据保存在用户目录，清理项目不会删除这些数据。

第一次打开需要重新登录 OA。登录状态保存在本程序自己的会话里。关闭窗口不会退出，右键托盘图标可以选择退出。

程序、任务栏、快捷方式和托盘使用独立的靛蓝色折角文件图标。后台收到消息后，右下角托盘整个图标闪烁。窗口可见或最小化时，任务栏持续闪烁，直到用户打开 OA；已关闭到托盘时保持隐藏。点击托盘或通知会打开窗口，结束闪烁并恢复普通图标。

图标源文件位于 `assets/*.svg`，运行时的 PNG 与 ICO 也在 `assets/`。OA 聊天外观位于 `resources/oa-theme.css`，样式限定在客户端导航与消息区域。Windows 闪烁辅助脚本位于 `resources/win-flash.ps1`。

Windows 的 [FlashWindowEx 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-flashwindowex)说明其返回值是调用前的活动状态，因此辅助进程不会将返回零误判为闪烁失败。
