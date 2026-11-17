# 亚华 OA 桌面壳

独立的 EMobile10 OA 桌面窗口。使用微信式浅色界面，保留现有消息、通讯录、应用和 OA 导航。右侧加班面板从 OA 出勤读取本月汇总与每日明细，展开后与聊天区并排显示。

加班明细中，OA 已关联加班申请流程的记录会显示绿色“已申请”标识。标识依据 OA 返回的关联流程，不表示审批已通过。

```powershell
npm install
npm test
npm start
```

第一次打开需要重新登录 OA。登录状态保存在本程序自己的会话里。关闭窗口不会退出，右键托盘图标可以选择退出。

程序、任务栏、快捷方式和托盘使用独立的靛蓝色折角文件图标。后台收到消息后，右下角托盘每秒交替显示文件图标和带琥珀色信封的图标，保持图标可见，不闪红点。窗口可见或最小化时，任务栏持续闪烁，直到用户打开 OA；已关闭到托盘时保持隐藏。点击托盘或通知会打开窗口，结束交替并恢复普通图标。

图标源文件位于 `assets/*.svg`，PNG 与 ICO 用于 Windows 窗口、通知及托盘。OA 聊天外观位于 `renderer/oa-theme.css`，样式限定在客户端导航与消息区域。

Windows 的 [FlashWindowEx 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-flashwindowex)说明其返回值是调用前的活动状态，因此辅助进程不会将返回零误判为闪烁失败。
