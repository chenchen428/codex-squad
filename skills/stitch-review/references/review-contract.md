# 审阅数据与决定合同

## 文件与身份

data.json 是可编辑事实源；校验通过后 --sync-data 生成等值的 data.js，让静态页不依赖 fetch。images/ 存完整图，previews/ 存本地可交互稿。别把演示的书目或问题换名后称为真实产品。

顶层：schemaVersion:1、稳定 id、本轮 revision、title、round、demo、groups，可选 stitchProjectUrl。不得将项目私有路径或账号写入通用模板。项目的来源清单与授权继续由该项目维护，不要求某种固定目录。

模板里的 Stitch 身份只追溯中性工具设计及其提取片段，不是后续业务任务的执行目标；真实任务应从本轮当前稿确认 project/screen。

每组包含：

| 字段 | 用法 |
| --- | --- |
| id / code / title / intent | 稳定组身份、显示序号、本轮目标 |
| viewport（可选） | 被审阅页面的设计视口 {width,height}；桌面如 1440×900。模板将组内画板等宽呈现，宽度最多 720 CSS px，高度按每张完整图真实比例计算；不裁切长页 |
| issues[] | id、quote 原话、page、state、viewport、evidence、likes、dislikes、verified；演示另标 demo |
| options[] | 第一项 id=current；已采用稿或明确小修可只保留当前稿，需要比较时按本轮增加真实候选，不设固定双栏或数量上限 |
| option | id、title、shortTitle、version、recommended、tradeoff、states[] |
| state | id、label、asset；跨稿同状态用相同 state id |
| implementation | status、captures[]；没有实现证据用 not-started 与空数组 |

可直接参考 [中性示例](../assets/review/data.json)，不需要另一份重复 schema。

asset 最少含 id/image/width/height/kind/sha256，可选 preview。图片和交互稿用当前审阅目录内的相对路径。宽高是完整图片的实际像素，不是舞台尺寸或缩略图声明；长图高度可以大于截屏视口。资产 ID 一经使用就不得指向另一份字节或身份，版本改动用新 option/asset id。

可选 displaySource / displayNote 用于图旁的简短来源与取舍说明，不能与 kind 矛盾。从工具导出稿中提取的中性手机示意是导出片段的浏览器稿，需留原始 HTML 身份、提取/修复说明和渲染尺寸；不能冒称独立生成的 Stitch screen 或真实产品截图。

| kind | 图旁显示 | 额外证据 |
| --- | --- | --- |
| illustration | 本地界面示意 | 只供中性演示，不能充当产品实测 |
| stitch-original | 原始 Stitch | projectId、screen、file、originalHTML:{path,sha256} |
| browser-repaired | 来源修复 · 浏览器稿 | 上述身份，repairs[]、render:{viewport,capturedAt} |
| product-capture | 真实产品截图 | capture:{page,state,viewport:{width,height},capturedAt,build} |

sha256 为图文件哈希。原始 HTML 不改字节；修复另存并留链路。验证器当前校验 PNG/SVG 的自然尺寸；其他格式先无裁切转换并记录转换关系，不隐瞒其来源。

implementation.captures[] 每项为 {optionId,version,stateId,build,asset}，asset 必须 product-capture。只有明确已确认的采用稿才能进入实现对照；必须同宽、同状态、同采用版本，否则显示证据缺口。浏览器稿与原生截图可有字体/系统栏差异，需实际解释。

## 本机保存和续轮

存储键：stitch-review:<页面目录路径>:<review id>:user；QA 为 stitch-review:<页面目录路径>:<review id>:qa:<qa 名称>。revision 不进入存储键，避免每轮丢失备注。切勿在 QA 中调用 localStorage.clear，也不要给正常用户种测试决定。

每组保存 choice、status、note、events、source。viewing option 与 choice 完全独立；choice 单选只是暂存，confirmed 为用户本机确认。Agent 采用依据是用户主动复制并发送的本轮结果或对话中的明确指示，不能自行读取页面/存储推断。

| 操作 | 状态 | 产品行为 |
| --- | --- | --- |
| 浏览推荐、写备注、暂存选择 | open | 当前产品不变 |
| 确认某候选或明确确认保留 | confirmed | 锁定本组；仍不等于产品已实现 |
| 暂时保留、继续改稿、原话仍要求重来 | revise | 当前产品保留，该组继续改稿复选 |
| 补充/修改已确认决定 | open | 留原决定记录，显式重新审阅 |
| 已选来源消失或版本/哈希改变 | open | 保留旧 source 与备注，提示复核 |

模板在「保留当前＋含否定/重来措辞的备注」时显示二选一的澄清框：仍需改稿，或问题已解决并确认保留。关键词只决定是否展示澄清，绝不替用户决定状态。原话不需要重写；例如“不喜欢的问题已经解决”可以直接明确确认保留并保留该备注。

输入即时保存；重新编辑的第一次输入先保存此前备注，失焦再记当前备注，确认/待改/重开均追加事件；刷新不能丢失此前原话。导出原始记录可保留全过程；复制清单包含全部组的选择、状态、当前备注和问题原话。实现验收不根据单选、DOM测试或复制成功自动变绿。

## 导航与主动交接

自定义组选择器显示组名、当前组和每组状态；确认进度只计算 confirmed。确认后主操作为下一组，按顺序跳过已确认组，必要时回到前面的待选/待改组。修改决定显式重开并扣减进度。最后一组确认自动打开结果页，不自动复制或发送。

结果页固定保留“复制结果给 Agent”动作，正文可滚动。用户检查后点击复制，得到本次打开结果页时的准确文本快照，包含审阅 id/revision、组与方案 id/版本、已确认图稿 id/sha256/来源、各组状态和原话备注。复制不等于发送；页面提示用户粘贴给 Agent。未确认与继续改稿不得写成已采用。JSON 导出仅为用户本机备份。

## 最小验收场景

1. 无左侧菜单，当前与多个候选在整块画布同时可见，适应全部显示完整画板；定位、总览、拖动、缩放不改变选择。推荐稿默认可见，零选中；未选写两行，换稿/状态/组再刷新，内容仍在。
2. 选择当前，备注要求重新来：仍待改；另一组确认并锁定，待改组不能受影响。
3. 桌面横稿保持横向原图比例，移动/长页同理，无额外圆角外框或粗选中边；图底可见，放大后能拖动；整图复位回到全图。独立全屏中可操作且能退出；同宽模式实际 CSS 图宽相同，不只按钮变色。
4. 长图、短高和窄屏实际可用；缺状态/缺图提示明确；来源名称、版本、图像和交互链接一致。
5. 汇总含未选和待改组的多行备注；复制内容与可见清单相符。测试作用域与正常存储隔离。
6. 没有真实实现图时不显示验收通过。采用稿更新不能无声继承旧确认。

7. 键盘与窄屏实际切组；确认后下一组跳过已确认，待改组不消失；全部确认后用户点击前剪贴板不变，点击后与可见快照完全一致，无自动发送请求。
