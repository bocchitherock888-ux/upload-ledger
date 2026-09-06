# 留底 · Upload Ledger

**找回当时上传的那份文件。**

留底是一款 Chrome 扩展。投简历、交作业、提交申请时，它会在你选择附件后保存一份副本。以后即使修改或删除了电脑上的原文件，也能找到当时选择的版本。

![留底资料库](app/implementation/screenshots/library.png)

## 怎么用

1. [下载最新版](https://github.com/bocchitherock888-ux/upload-ledger/releases/latest)，把 ZIP 解压到一个固定文件夹。
2. 在 Chrome 地址栏打开 `chrome://extensions`，开启右上角的「开发者模式」，点击「加载已解压的扩展程序」，选择刚才的文件夹。
3. 打开要上传文件的网站，点击留底图标，再点击「在此站点启用」并允许访问。
4. 照常选择附件。看到「副本已保存」后，就能在留底中查看和下载这份文件。

也可以点击「手动留底」，自己选文件保存。

## 能帮你做什么

- **找回旧版本**：同名文件改过多次，也能找到每次选择的那一份。
- **记住用途**：给文件加备注和标签，例如「秋季申请」「已补交」。
- **查看和比较**：直接看文字、图片和 PDF，也能比较两份文本的差异。
- **备份和搬家**：导出备份文件，在另一台电脑的留底中恢复。

界面支持简体中文、繁體中文、English，可切换浅色和深色。

![深色界面](app/implementation/screenshots/dark.png)

## 文件保存在哪里

副本保存在当前浏览器中，文件和导出的备份均未加密。卸载扩展或清除浏览器资料会删除副本，重要文件请定期备份。

每个文件最多保存 50 MiB，默认可用空间为 1 GiB，可在设置中调整。[使用指南](app/implementation/USAGE.md)介绍了支持的网站、文件格式和备份恢复。

更新时先导出备份，再用新版本覆盖原文件夹，在扩展管理页点击重新加载。

## 开发

使用 Node 24，在仓库根目录运行：

```sh
cd app
npm ci
npm run build
npm test
```

完整回归见 [GitHub Actions](https://github.com/bocchitherock888-ux/upload-ledger/actions)。

## 许可与反馈

[MIT](LICENSE) · [第三方许可](app/THIRD_PARTY_NOTICES.md) · [反馈问题](https://github.com/bocchitherock888-ux/upload-ledger/issues)
