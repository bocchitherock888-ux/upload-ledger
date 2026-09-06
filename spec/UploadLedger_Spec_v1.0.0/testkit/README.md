# 本地测试工具包

该目录服务于扩展开发和验收。运行测试服务器只使用开发者自己的电脑；最终扩展的核心工作不需要服务器。

## 运行

```sh
node testkit/server.mjs
# 打开 http://127.0.0.1:8765/
```

第二个终端可运行 `node testkit/server.mjs --port 8766`，测试相同主机不同端口的精确授权。服务器仅监听回环地址，拒绝其他 Host 和跨来源 POST。停止使用 Ctrl+C。

页面包含标准单选/多选、隐藏和动态 input、选择后立即清空/移除、真实拖放、程序生成的非真实 change、SPA 路由、即时导航、开放/闭合 Shadow DOM 及 iframe。页面日志显示事件的 isTrusted，自动化工具应记录实际值。

`POST /upload` 对原始请求体流式计算 SHA-256 和字节数；`POST /fail` 消耗请求体后返回500；`POST /form` 对整个 multipart 请求体计算摘要，**multipart 摘要不能直接与其中某个文件的摘要比较**。`/done.html` 用于跳转。服务器不保存请求内容，不输出正文、文件名或请求URL参数。

## 样本

`fixtures/` 仅有虚构小文件，含同名不同内容、别名同内容、空文件、UTF-8、二进制与小PNG。HTML/SVG是安全测试素材，只在源码文本层面检查，含自写标记动作且无外部网络请求。服务器下载这些文件时使用 attachment 与 octet-stream。

```sh
python3 testkit/generate_fixtures.py
# 需要大文件边界测试时显式生成，共约100MiB：
python3 testkit/generate_fixtures.py --large
```

生成器只重写此工具自己的固定样本名称，不删除其他文件。`--large` 内容可确定重建，规格ZIP不附带这些大文件。PDF/Office 格式测试样本由实现agent使用虚构内容创建，并记录许可和预期；当前包没有把伪造后缀当真实PDF。

## 独立备份校验

```sh
python3 testkit/validate_archive.py testkit/fixtures/valid-backup.zip
# 可选：在虚拟环境安装 jsonschema，启用完整JSON Schema检查。
python3 -m venv .venv
.venv/bin/pip install jsonschema
.venv/bin/python testkit/validate_archive.py testkit/fixtures/valid-backup.zip --require-jsonschema
```

校验器只读取ZIP，不解压到文件系统。默认执行路径、引用、长度、摘要和基础结构检查；jsonschema 可用时另外执行完整schema。输出 `schemaValidation` 说明实际覆盖。未安装时不能把基础检查称为完整schema验证。

`bad-checksum-backup.zip`、`bad-path-backup.zip`、`bad-duplicate-backup.zip` 应失败；它们是体积很小的受控负例。这里不制造压缩炸弹。

## 规格自检

```sh
python3 testkit/validate_spec.py
```

自检检查机器合同、翻译键、需求/用例映射、来源编号、样本摘要和备份正负例。它不运行浏览器扩展，扩展产品测试仍为 not_run。

## M0 的测试顺序

先读取 SP-01 至 SP-06。用普通 input 完成一次字节往返，再测立即清空、取消、失败和跳转。然后做权限撤销、worker中止、分块重试与容量限制。真实拖放必须从操作系统操作，并用虚构数据记录证据。开发调试开关不能进入发布包。
