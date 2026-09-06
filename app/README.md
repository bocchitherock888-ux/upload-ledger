# 留底 · Upload Ledger

为网页附件保存一份可查、可下载的本地副本。Chrome 桌面扩展，当前版本 **1.0.0**。

![留底资料库](implementation/screenshots/library.png)

在目标网站主动启用留底，照常选择附件。资料库会保存选取时的内容、时间和去敏来源；同名文件的不同版本分别保留，相同内容共用存储。网页的提交结果由你核对并标记。

## 安装

1. 从 [GitHub Releases](https://github.com/bocchitherock888-ux/upload-ledger/releases/latest) 下载 `UploadLedger-1.0.0.zip`，解压到一个长期保留的文件夹。
2. 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的文件夹。
3. 打开留底，阅读并确认本地存储说明。访问普通 HTTP/HTTPS 网页，在扩展弹窗点击「在此站点启用」，允许 Chrome 的站点访问请求。
4. 选择附件，等资料库显示「副本已保存」，再离开页面。选择记录可以预览、下载当次副本、添加备注或确认提交状态。

也可以通过「手动留底」选择文件。手动保存会记录当前操作时间。

**更新前先导出完整备份。** 将新版本覆盖到原扩展文件夹，再在扩展管理页点击重新加载，保持原路径和扩展 ID。迁移到新电脑或新浏览器配置时，加载扩展并从「备份与恢复」导入备份。网站权限需重新开启。

## 功能

- 标准单选、多选、动态文件输入，开放 Shadow DOM；逐站点开启的真实拖放。批次排队、256 KiB 分块、SHA-256 校验、相同内容去重、后台中断恢复。
- 文件名、显示名称、备注、标签搜索，来源/日期/状态筛选，置顶，稳定分页；原始记录与可编辑用户信息分开保存。
- 本地文本、图片和 PDF 预览；小文本逐行比较；原件下载；安全显示 HTML/SVG 文本。Office 等其他格式提供信息和原件下载。
- 完整或选定记录备份、独立分包、严格 ZIP/清单校验、导入预检查与原子发布。重复导入保留本地的新备注和状态；ID 内容冲突会阻止整批导入。
- 明确确认后的删除、共享引用保护、容量设置、后台清理、暂停与站点控制；简体中文/英国英语，浅色/深色/跟随系统，窄窗口布局。

![深色界面](implementation/screenshots/dark.png)

## 数据与权限

文件及元信息以**明文**存储在当前浏览器配置的扩展 IndexedDB 中。备份 ZIP 同样是明文。能读取此设备或备份的人可能读取内容；请将备份保存在可信位置。**卸载扩展、删除浏览器配置或清理其存储会丢失本地资料。** 定期导出备份，并用独立配置验证恢复。

初始网站列表为空。权限由你逐站点授予；应用按完整 origin（协议、主机、端口）执行策略。Chrome 主机权限模式覆盖同主机端口，应用会额外校验端口。设置可关闭来源路径或页面标题；URL 查询参数和片段自动移除，路径本身仍可能包含敏感信息。

运行资源、字体、PDF worker 都随扩展打包。应用无账户、遥测、云端同步或 AI 服务调用。自动采集默认跳过 `.env`、SSH 密钥等敏感文件名，可编辑排除规则。扩展权限为 `activeTab`、`scripting`、`unlimitedStorage`、`alarms`；HTTP/HTTPS 访问是可选授权。

文件副本表示当次选择内容。网站可能转换附件，取消上传后已保存的副本仍会保留。提交状态初始为未知，确认状态来自你的操作。置顶只影响检索；应用不会按年龄自动删除原件。

## 限制与验证范围

单文件上限 50 MiB，单批最多 100 个文件 / 200 MiB。超大单文件仅保留元信息，超出批次上限会拒绝整批。容量默认 1 GiB，最高 5 GiB，实际还受可用磁盘空间限制。文本预览和文本比较有独立限制；PDF 超过 500 页或渲染超时会降级为下载。

支持边界为顶层页面标准文件输入和开放 Shadow DOM。目录输入、iframe、封闭 Shadow DOM、自定义非标准上传控件、浏览器内部页及无痕窗口属于支持范围之外。来源链接可能需要重新登录，也可能已经失效。

发布验证环境：**macOS / Chromium 153.0.8010.12**，全部使用虚构文件与独立临时配置。当前 manifest 声明 Chrome 120 起可安装；Chrome 120、Windows、Linux 及真实业务网站的兼容性尚待实测。推荐使用当前 Chrome 桌面版。完整结果和剩余覆盖项见 [测试报告](implementation/TEST_EVIDENCE.md)。

## 开发与测试

仓库根目录包含 `app/` 和 `spec/`。Node 24、npm 11；依赖版本锁定在 `package-lock.json`。

```sh
cd app
npm ci
npx playwright install chromium
npm run build
npm test
npm run test:e2e
npm run test:performance
npm run package
```

浏览器回归使用 18765/18766 回环端口，生成临时扩展副本并仅为测试副本预授予回环权限。正式产物保留可选站点权限。原生授权测试单独运行 `node tests/native-permissions.mjs`，在可见 Chrome 窗口确认授权。

备份独立校验可选 Python `jsonschema==4.25.1`；完整发布校验要求安装该依赖。用 `VALIDATION_PYTHON=/path/to/venv/bin/python npm run test:e2e` 指定隔离解释器。`npm run package` 将确定性 ZIP 和 SHA256SUMS 输出到仓库根目录的 `deliverables/`。

`tests/fixtures/migration-v0.1.0.zip` 是本项目旧开发版的固定迁移夹具，只供自动升级测试。正式安装请使用最新 Release。

## 许可


源码采用 MIT 许可。第三方依赖适用各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。GitHub 发布提供源码和可加载安装包；Chrome Web Store 上架需单独办理。
