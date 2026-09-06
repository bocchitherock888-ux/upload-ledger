# 1.0.0 测试与发布验收

2026-09-06，macOS / Chromium 153.0.8010.12 / Node 24.9.0。全部测试使用虚构文件、回环测试网站与全新临时浏览器配置；没有使用个人浏览器资料或真实业务附件。

| 执行项 | 结果 | 证据 |
|---|---|---|
| 单元/事务/合同测试 | 40/40 通过 | [记录](evidence/unit-tests.txt) |
| 核心真实浏览器回归 | 17/17 组通过 | [JSON](evidence/core-browser.json) |
| 生产 UI 流程 | 13/13 组通过 | [JSON](evidence/ui-browser.json) |
| 性能与容量边界 | 3/3 组通过 | [JSON](evidence/performance.json) |
| 旧版同 ID 升级 | v0.1.0 → v1.0.0，元信息与原件 SHA 一致 | [JSON](evidence/migration.json) |
| 原生权限 | 用户在 Chrome 原生弹窗允许，随后撤销并验证关闭 | [JSON](evidence/native-permissions.json) |
| 独立备份校验 | Python 完整 JSON Schema + 语义校验通过 | [JSON](evidence/archive-validation.json) |
| 无障碍 | axe WCAG 2 A/AA、2.1 AA，0 违规 | [JSON](evidence/accessibility.json) |
| 可重复构建 | 连续两次构建 ZIP 字节完全相同，200 个条目 | [JSON](evidence/package.json) |
| 锁定依赖漏洞审计 | 0 个已知漏洞 | [JSON](evidence/npm-audit.json) |

## 可用性验证

真实文件输入产生 trusted 事件；同名不同内容保留两个版本，同内容别名共用对象。服务端收到的上传体 SHA 与原始虚构文件一致。覆盖多文件、动态/隐藏/立即清空/移除输入、零字节、块边界、开放 Shadow DOM、iframe 隔离、逐站点拖放与端口隔离。

在 50 MiB 保存中实际终止 service worker，恢复后完整摘要一致，未产生重复块。撤权中断、暂停与手动保存、字段 revision 冲突、读取 lease 与删除、共享引用、清除挑战及迟到 epoch 拒绝均有执行证据。事务测试补充预算预留、写入失败、幂等重试、来源丢失、GC、恶意消息及导入原子回滚。

UI 测试从初装说明开始，经手动保存 7 个合成文件、文本/图片/PDF 预览、原件下载、备注与状态编辑、搜索、比较、ZIP 导出，再在另一全新配置恢复每个对象的内容和全部元信息。重复导入保留新备注，3 个损坏 ZIP 被拒绝。键盘焦点/取消/删除和清除全部通过实际按钮操作验证。

PDF 预览在离线状态渲染两页，文档内合成 JavaScript 标记保持未执行，501 页文件降级。HTML/SVG 按文本显示。扩展上下文没有外部网络请求。完整恢复包包含 7 条记录、7 个对象、9 条审计，Python 独立验证全部结构、引用与摘要。

## 性能与视觉迭代

50 MiB 正常保存由首轮约 18.4 秒优化到 **9.614 秒**；200 MiB（4×50 MiB）批量保存 **43.890 秒**，每个 SHA 正确。1 万条元信息的搜索输入到结果显示 P50 **317 ms**、P95 **342 ms**，含 180 ms 搜索防抖。页面/UI 的 JS heap 峰值约 49.8/6.8 MiB；此测量排除了浏览器原生缓冲、PDF worker 和 service worker 进程，完整 RSS 目标仍待验证。

人工检查最终 [资料库](screenshots/library.png)、[深色](screenshots/dark.png)、[窄窗口](screenshots/narrow.png)、[弹窗](screenshots/popup.png)、[PDF](screenshots/pdf.png)、[备份](screenshots/backup.png) 和 [恢复](screenshots/import.png)。迭代修复了多文件队列停滞、导入 token 合同不匹配、长备注导致备份失败、深色按钮对比度、设置控件名称、折叠侧栏及对话框焦点。

## 覆盖边界

72 条规格验收项的逐项关联见 [test-results.json](test-results.json)。其中保留 `partial` 与 `not_run`，测试组通过数不能直接折算为 72 条全部验收通过。真实业务网站、Chrome 120、Windows/Linux、原生保存选择器取消、屏幕阅读器朗读、完整进程内存、导入中实际 worker 中断及迁移事务失败等子场景仍待补充。

原生允许动作由用户完成；授权拒绝通过测试注入 `false` 验证应用状态。普通浏览器测试只对临时扩展副本预授予回环权限，正式 manifest 含可选 HTTP/HTTPS 权限，固定 host_permissions 为空。包无源映射、开发服务器连接或个人目录内容。

备份模块完成独立审查并修复问题；核心与 UI 的并行审查因额度中断，由主代理继续集成检查及上述实际回归。此报告反映具体执行证据和已知覆盖范围。
