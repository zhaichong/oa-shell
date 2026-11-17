# Desktop UI

## Theme

简洁的浅色桌面办公界面。深灰导航、白色会话列表、浅灰聊天背景，靛蓝色用于选中状态和发送操作，与应用折角文件图标一致。绿色用于已申请等成功状态，不使用微信式双气泡图标。

## Colors

- Accent: #3555c5; hover #2b46a7; light #eaf0fc.
- Navigation: #252a31; inactive icon #c7ced8; active icon #a9bfff.
- Surface: #ffffff; conversation canvas #f5f6f8; selected row #e8eefb.
- Text: #222c38; secondary #586575; divider #e3e7ec.
- Outgoing message: #e2ebfc; incoming message: #ffffff.
- Applied state: #e7f3eb background, #116b3c text.

## Typography

Segoe UI、Microsoft YaHei 系统字体。正文 14px，辅助信息 12px，面板标题 17px。图标保留 OA 原字体与 SVG。

## Components & Layout

侧栏保持原有 OA 导航宽度与结构。会话列表降低分隔线强度，消息气泡圆角 8px。右侧加班面板宽 336px，页头、月度汇总、逐日明细和底部导航依次排列；展开后与 OA 内容并排，不覆盖聊天输入区。

会话姓名、消息预览和时间采用明确的字号层级，保持原有 64px 会话行高以兼容虚拟列表。会话与消息头像使用 8px 圆角。工具按钮使用统一悬停底色，发送按钮与下拉按钮连成一组。面板标题栏高度为 60px，与聊天标题栏对齐。

加班明细采用左侧日期块、右侧时段与 OA 原始时长、下方日期类型与“已申请”状态的紧凑列表，不改变统计口径。会话搜索框高度 30px，使用单层白底与中性灰边框；聊天输入区的聚焦分隔线保持浅灰，避免绿色横线。

## Notifications

程序、任务栏、快捷方式和托盘统一使用靛蓝色底、白色折角文件图标。未读时托盘以一秒间隔交替显示文件图标和叠加琥珀色信封的图标，不显示空白帧或快速闪红点。任务栏持续闪烁到打开 OA，查看后恢复。隐藏状态不会为创建任务栏按钮而显示窗口。

## Style Rules

多行 CSS，使用 Flex；不使用 CSS Grid 和 gap。交互过渡为 150ms，减少动态效果模式关闭过渡。
