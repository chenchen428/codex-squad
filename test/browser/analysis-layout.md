# 分析页运行态布局门禁

复用已登记的插件页面服务和宿主浏览器，在真实分析页完成渲染后，通过 CUA 的只读 `tab.playwright.evaluate` 执行 `analysis-layout-probe.mjs` 中的 `checkAnalysisLayout`。该函数只读取 DOM、计算样式和元素边界，失败时抛出具体表格/列和原因，不依赖 CSS 实现文本。

依次覆盖 390、541、1280 CSS px 和 Codex/Qoder/对比视图；用真实点击和 Enter 操作排序后复查。390px 时实际横向滚动收益指标区，确认 scrollLeft 变化而整页宽度不变。收益依据弹层、统计区间、CLI 搜索继续通过实际界面操作验证。保存当前 build.json 指纹、函数返回结果和截图；修改后重新构建并复验。

此门禁需要浏览器运行态，不属于 Node 单测；Node 发布测试通过不能替代它。不新增服务、端口或独立浏览器框架。
