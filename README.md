# FreePower

独立实现的指纹浏览器（AdsPower 同类产品）：多环境隔离、指纹注入、代理绑定、本地 API。

- 内核：官方 Chrome for Testing（独立进程）+ CDP 注入
- 主程序：Electron
- 本地 API：127.0.0.1 + 自带 API Key（离线可校验）
- 不搬运 AdsPower 的私有代码、二进制、资源与商标

## 文档

- [技术方案](docs/00-技术方案.md)

## 状态

方案定稿阶段（P0 未开工）。目录结构见方案 §3。