# 设计评审接入

用户需要看候选再决定时，使用插件自带的审阅技能 [stitch-review](../../stitch-review/SKILL.md) 与 `assets/review/` 画布模板。它是本插件的一部分，不要求另装全局 `stitch-review`；模板是实际评审 UI，不用整页截图代替。

## 建立本轮审阅目录

```sh
PLUGIN="<本插件根目录>"   # 由当前安装位置解析，例如 ~/.codex/plugins/codex-squad 或仓库 plugins/codex-squad
REVIEW_DIR="<本轮任务目录>/review"
node "$PLUGIN/skills/stitch-review/scripts/new-review.mjs" "$REVIEW_DIR"
```

- 复制后只填本轮事实：`data.json` 的 review id、revision、组、问题原话、方案与状态，以及 `images/`、`previews/` 素材。保留模板的通用结构与交互，不写入项目私有路径或账号。
- 资产用相对路径，登记完整图实际像素与 sha256；来源类型按 [数据合同](../../stitch-review/references/review-contract.md) 区分原始 Stitch、来源修复浏览器稿、真实产品截图。
- 校验并同步，再挂载到插件的统一服务：

```sh
node "$PLUGIN/skills/stitch-review/scripts/validate-review.mjs" "$REVIEW_DIR" --sync-data
node "$PLUGIN/cli/index.mjs" review open <<'REVIEW_JSON'
{"directory":"/absolute/path/to/review"}
REVIEW_JSON
```

`review open` 的 stdin JSON 为 `{"directory":"本轮目录的实际路径"}`，用结构化 JSON 或带引号的 heredoc 传入。返回的本机 URL 与小队、用量、总结使用同一进程和端点；只挂载当前会话工作目录内的评审目录。续轮直接更新同一目录，保留 review/group/option 身份，不另开独立评审服务或端口。

## 与 UED 流程的衔接

- 已有用户确认的设计与实现授权：直接实施，不重复选稿，也不为走查另造候选。
- 需要选稿：推荐稿可预览，不能自动选中；确认与备注只存在用户本机。
- 用户主动复制并粘贴到原对话的结果，或对话中直接明确的决定，才是采用依据。Agent 不读取正常页面、浏览器存储或剪贴板推断采用；评审页不向后台发送结果。
- QA 只用 `?qa=<独立名称>`，不种真实决定；模板演示数据与用户业务数据分开。
- 采用后把最终设计系统、导出 DOM/CSS/字体/图片、identity（project/screen/file/哈希）与用户原话交接给 `implementer`。真实实现完成后另做同视口、同状态的视觉比较，不以评审页或截图代替实现。
