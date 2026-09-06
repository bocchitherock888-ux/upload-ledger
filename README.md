# 留底 · Upload Ledger

保存网页附件的当次版本，随时查找、预览和下载。

![留底资料库](app/implementation/screenshots/library.png)

## 安装

1. [下载最新版](https://github.com/bocchitherock888-ux/upload-ledger/releases/latest)，将 ZIP 解压到固定文件夹。
2. 打开 `chrome://extensions`，开启开发者模式，点击「加载已解压的扩展程序」，选择解压目录。
3. 在目标网页打开留底，点击「在此站点启用」并授权。
4. 照常选择附件，等待「副本已保存」。也可以在资料库使用「手动留底」。

更新前导出备份，再覆盖原目录并重新加载扩展，保持原路径和扩展 ID。

## 功能

- 自动或手动保存附件，区分同名版本，相同内容共用存储。
- 按文件名、备注、标签、来源和日期检索，添加置顶与提交状态。
- 预览文本、图片、PDF，比较文本版本，下载原件。
- 导出完整或选定记录的备份，在新浏览器中恢复。
- 简体中文 / English，浅色、深色与跟随系统。

![深色界面](app/implementation/screenshots/dark.png)

## 使用说明

文件保存在当前浏览器中，文件与备份均未加密。卸载扩展或清除浏览器资料会删除本地副本，请定期备份。留底保存所选附件，提交状态由你手动标记。

单文件上限 50 MiB，单批最多 100 个文件 / 200 MiB；资料库默认 1 GiB，可调至 5 GiB。支持顶层网页的标准文件选择，以及逐站点开启的拖放。更多格式、权限与恢复说明见 [使用指南](app/implementation/USAGE.md)。

## 开发

在仓库根目录运行：

```sh
cd app
npm ci
npm run build
npm test
```

使用 Node 24。浏览器回归、性能数据和兼容范围见 [测试报告](app/implementation/TEST_EVIDENCE.md)。

## 许可

[MIT](LICENSE) · [第三方许可](app/THIRD_PARTY_NOTICES.md) · [反馈问题](https://github.com/bocchitherock888-ux/upload-ledger/issues)
