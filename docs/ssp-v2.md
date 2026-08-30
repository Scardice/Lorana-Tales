# SSP v2 工程格式

SSP 是 Lorana Tales 的可继续编辑工程包。v2 的目标是：用户可读、浏览器优先、资源高效、可扩展，同时不允许工程文件携带或执行任意代码。

## 包结构

SSP v2 是 ZIP 容器，但只接受以下内容：

```text
story.lorana
manifest.lorana
metadata.lorana
assets/<sha256>.<ext>
```

- `story.lorana` 使用 Lorana Tales Story Language 2，只保存角色、消息、布局、演出编排和特效参数，不再重复标题和署名。
- `metadata.lorana` 单独保存标题与作者署名；`manifest.lorana` 只描述包结构，并把逻辑资源 ID 映射到内容哈希、MIME、大小和尺寸。
- `assets/` 按 SHA-256 内容寻址。两个逻辑资源的压缩后内容相同时，包内只保存一份。
- 不保存 JSON 文档，也不接受清单外文件。当前 Testify 阶段不兼容早期试验包，格式变更会直接升级 v2 结构。

## 安全边界

SSP 是声明式数据，不是插件包。导入器遵循以下规则：

- 不使用 `eval`、`new Function`、包内脚本、动态模块或任意 HTML 执行。
- 只识别白名单中的 story、set、role、effect、msg、time、wt 和 word 指令；未知指令直接拒绝。
- 拒绝绝对路径、盘符、反斜线逃逸和 `..` 路径；限制文件数、压缩体积、解压体积和单资源体积。
- 所有 v2 资源都校验清单大小和 SHA-256。清单外文件、缺失资源、篡改资源均拒绝导入。
- 外部媒体地址只允许 HTTP(S) 或站内绝对路径。导出的离线 HTML 使用 CSP 禁止网络、插件和外部脚本。
- 服务端不解释二进制 SSP；账号云端工程只执行鉴权、CSRF、风险验证、配额和字节存储。

默认限制定义在 `web/src/story/package.ts` 的 `DEFAULT_STORY_PACKAGE_LIMITS`，调用方可以传入更严格的部署限制。

## 性能设计

- SSP 压缩、解压、SHA-256、导入、导出和离线 HTML 生成都在浏览器完成。
- ZIP 使用异步接口，资源解析使用有界并发，不为每个资源复制 Base64 字符串。
- 云端工程直接上传 SSP 二进制，旧版 Base64 JSON 工程仅保留读取兼容；这可减少约三分之一的 Base64 膨胀和保存时的峰值内存。
- 离线演出只保留一个资源数据表，并对消息窗口化，默认最多同时创建 360 条历史消息 DOM；“加载更早的消息”按需扩展窗口。
- 编辑器的大日志列表继续使用虚拟化；调整界面参数不应触发整份文档重新序列化或重新挂载所有消息。

## 扩展规则

新增功能时，按以下顺序扩展，避免把行为塞进 SSP：

1. 在 `types.ts` 定义新的有限联合类型或结构化参数。
2. 在 `raw-script.ts` 增加明确的白名单语法、校验和往返序列化。
3. 在编辑器提供 GUI；GUI 的每次修改都必须能还原为 Story Language。
4. 在应用内播放器和 `standalone-performance.ts` 分别注册同名渲染器；未知效果必须安全降级，而不是执行包内代码。
5. 在 `scripts/verify-story-format.ts` 增加往返、篡改和离线导出测试。

特效可以拥有持续时间、目标角色、媒体打开/返回等参数，但 SSP 只能选择应用内已经实现的效果 ID。若未来需要第三方扩展，应通过受版本控制、由站点管理员安装的代码扩展实现，不能把 JavaScript 放进用户 SSP。

持续区间效果不再集中写成带 `from` / `to` 的全局声明。起点消息前单独写事件，终点消息后结束事件，源码阅读顺序与演出时间线一致：

```xml
<effect-start id="rain-1" type="rain-glass" color="cyan" intensity="90%" opacity="70%" speed="120%" />
<msg by="character-a">
  雨落下来了。
</msg>
<msg by="character-b">
  窗上的水痕越来越长。
</msg>
<effect-end id="rain-1" />
```

起止事件必须成对出现；开发期格式不解析旧的全局 `<effect ... from="..." to="...">` 写法。

单条消息最多叠加五段独立特效。`delay` 是相对该消息出现时刻的延迟，文字、屏幕和头像互动可以放在同一段，也可以拆成多段：

```xml
<effects>
  <effect id="fx-1" delay="0ms" text="impact" />
  <effect id="fx-2" delay="420ms" screen="damage" color="red" duration="600ms" speed="120%" repeat="1" />
  <effect id="fx-3" delay="800ms" interact="magic" target="character-b" interaction-color="purple" interaction-speed="130%" />
  <msg by="character-a">
    看好了——这才叫叠加。
  </msg>
</effects>
```

`target` 可以省略，此时只播放发起角色的动作，不生成目标头像。互动类型包括 `throw`、`heart`、`magic`、`magic-circle`、`surprise`、`impact`、`bullet`、`blade`；`magic-circle` 只展开法阵，不发射光弹。

启用自动播放时，每段的“延迟 + 自身持续时间”不得超过该消息停留时长。图形编辑器会在保存时阻止超时配置；多选批量应用会整体覆盖原有特效栈。

## 离线 HTML

“内嵌 HTML”导出的是单文件演出播放器：头像、图片、QQ 表情和语音都转换为 data URL，现代浏览器可直接用 `file://` 打开。开始遮罩展示标题和作者署名；播放器还包含上一条/下一条、播放/暂停、进度、倍速、音量、全屏、图片查看、语音阻塞、引用定位、逐词动画、单次与持续屏幕效果。

远程资源在导出时无法获取会变成占位符，并在开始界面提示数量；播放器不会在观看时重新联网。浏览器的 `prefers-reduced-motion` 设置会自动压缩动画时长。

## 验证

```bash
pnpm test:story-format
pnpm lint
pnpm build
```

格式测试会验证字段往返、相同资源去重、未知文件拒绝、哈希篡改拒绝、离线 CSP 和播放控件存在性。
