# Product film / 产品短片

## 30-second public cut / 30秒公开版

`codex-squad-v6-public-30s.mp4` is the public version of the revision 6 30-second film that was confirmed and accepted on 2026-10-25. The footage comes from a real task recorded on 2026-10-24. It is not a re-shoot of the current 0.12 interface, and the README describes current behavior where the two differ.

`codex-squad-v6-public-30s.mp4` 是 2026-10-25 确认通过的第6版30秒成片的公开版本。画面来自 2026-10-24 的一次真实任务记录，不是按当前 0.12 界面重新实拍；两者不一致时，以 README 描述的当前行为为准。

### Source / 来源

- Source film: `codex-squad-launch-v6-30s.mp4` (revision 6), SHA256 `acceed35239e032756685382e5feef65275cdfb578a56a9339b1f3ce14136c56`
- Public output: `codex-squad-v6-public-30s.mp4`, SHA256 `ad7a9d174659889c29b4c17fe93740dd6251a54d318c8a651517f76c2a9487cf`
- Timing, frame rate, and resolution are unchanged: 30 seconds, 900 frames, 1920×1080, 30 fps. The GSAP timeline, dialogue scroll and highlight timing, fonts, layout, rhythm, and opening and closing are unchanged.

- 源成片：`codex-squad-launch-v6-30s.mp4`（第6版），SHA256 `acceed35239e032756685382e5feef65275cdfb578a56a9339b1f3ce14136c56`
- 公开成片：`codex-squad-v6-public-30s.mp4`，SHA256 `ad7a9d174659889c29b4c17fe93740dd6251a54d318c8a651517f76c2a9487cf`
- 时长、帧率和分辨率未变：30秒、900帧、1920×1080、30fps。GSAP 时间线、对话滚动与高亮节奏、字体、布局、节奏以及首尾均未改变。

### Public changes / 公开化改动

Only identification and the public entry point changed:

- Project names and local file paths in the captured screenshots are masked. The masks were applied in the local render only; the private layers and unmasked screenshots are not published.
- The closing install command now points to `github.com/chenchen428/codex-squad`.
- The prerequisites line now reads: GitHub Releases manual download, Node.js 22.5+, and a signed-in Qoder CLI. Optional Stitch design still needs MCP and a Google login. This is not a claim of a public Marketplace listing.
- The case footer now says project names and file paths are masked, with the original state preserved; scrolling and cross-screen motion are editing cues.

仅改动身份信息与公开获取入口：

- 截图中出现的项目名和本机文件路径已遮挡。遮挡只在本地渲染中完成；隐私层和未遮挡截图不公开发布。
- 片尾安装指令改为 `github.com/chenchen428/codex-squad`。
- 片尾前提改为 GitHub Releases 手动下载、Node.js 22.5+ 和已登录的 Qoder CLI；可选 Stitch 设计仍需 MCP 与 Google 登录。这不代表已上架任何公共 Marketplace。
- 案例脚注改为“项目名和文件路径已遮挡；原状态保持；滚动与跨界面动效为剪辑”。

### Music / 配乐

- Track: "Sounds Good" by Michael Ramir C. (Mixkit item 1077)
- Source: <https://mixkit.co/free-stock-music/funk/>
- License: <https://mixkit.co/license/#musicFree>

The confirmed V6 audio track was carried into the public cut with `-c:a copy`, so the AAC audio packets are identical to the source and no re-encode or re-cut was performed. Only this mixed film is published; the original music file and WAV are not redistributed separately.

配乐为 Michael Ramir C. 的 “Sounds Good”（Mixkit 条目 1077），来源与许可见上。公开成片使用 `-c:a copy` 沿用已确认 V6 的 AAC 音轨，音频包与源文件完全一致，未重新编码或重新剪辑。公开的只有这支混合成片，不单独再分发原曲文件或 WAV。
