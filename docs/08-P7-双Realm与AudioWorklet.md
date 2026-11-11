# P7 · 双 Realm 与 AudioWorklet（W4 结论）

> ⚠️ 本文是 P7 阶段的记录，描述的是当时状态；当前能力以 [README](../README.md) 为准。

> 这一份只回答一个问题：**worker 那几种「另一个 JS 世界」到底覆盖到什么程度，哪些明确不做、为什么不做的不是「音频指纹」。**
> 所有数字都是本机真机实测（Chrome 157.0.8103.40），复跑命令在最后。

## 1. 结论表

| 目标 | 状态 | 证据 | 备注 |
|---|---|---|---|
| 专用 worker | **已覆盖** | 脚本首行 `self.__fpRealm === 'worker'`；canvas 与主帧同值 | 首行前注入，无裸窗口 |
| SharedWorker | **已覆盖** | 同上 | UA 靠 JS 补（CDP 不传播） |
| ServiceWorker（新建） | **已覆盖** | 同上 | 卡在脚本顶层之前注入 |
| 嵌套 worker（worker 里再 `new Worker`） | **已覆盖** | 外层与嵌套层首行都是 `realm='worker'`；实测五层深链（页→w4→…→w0）核数全等于主帧 | 每个 worker 会话自己再挂 `setAutoAttach`，递归覆盖、不设深度上限；P7 收尾时补，`injected` 精确 +2 |
| ServiceWorker（启动前已在运行） | **未覆盖** | — | 只在其下次被激活时接入 |
| AudioWorkletGlobalScope | **明确不做（none）** | 实测 `fpInjected=false`，可测表面只有 `sampleRate`/`currentTime` | 见第 3 节三条理由 |
| OOPIF 子帧 | **未覆盖** | 只计数不注入 | 子帧里取原生函数仍可能看到两套 |

## 2. 真机实测

### 2.1 五个 canvas 哈希同值

同一张页里分别用主帧 DOM canvas、主帧 OffscreenCanvas、专用 worker、SharedWorker、ServiceWorker
画**同一份配方**（渐变 + 矩形 + 圆弧，不含文字），各自取 `getImageData` 后算 FNV：

```
main.DOM         9b2e7181
main.Offscreen   9b2e7181
dedicated        9b2e7181
shared           9b2e7181
service          9b2e7181
```

哈希值随环境种子变（不同环境跑出来是 `81462dd7` / `8d98981b` / `6ded8017` 等），
但**同一环境里五处恒等** —— 说明 worker 与主帧引用的是同一份噪声实现、同一个入库种子。

配方里不画文字是刻意的：文字度量走字体回退链，主帧和 worker 不完全一样，
画了文字就分不清「噪声不同源」还是「字体不同」，反而失去判别力。

### 2.2 UA 传播差异（这是 JS 补丁必须存在的理由）

把 UA 故意设成 `Chrome/131`（真实内核 157），看各 realm 的 `__fpApplied`：

| Realm | `applied` 里有 `userAgent`？ | 读到的 UA |
|---|---|---|
| 主帧 | — | 131.0.0.0 |
| 专用 worker | **没有** | 131.0.0.0 |
| SharedWorker | **有**（`userAgent,appVersion`） | 131.0.0.0 |
| ServiceWorker | **有**（`userAgent,appVersion`） | 131.0.0.0 |

结论：`Emulation.setUserAgentOverride` 会传播到专用 worker，**不会**传播到 SharedWorker / ServiceWorker。
所以 worker 层的 UA 补丁写成「按值判断」——CDP 已经给对就不动（少一层 JS 痕迹），没给对才覆盖。
三类 worker 走同一条代码路径，没有特例。

时区 / locale 则是**会**传播的（实测三类 worker 里 `Intl.DateTimeFormat().resolvedOptions().timeZone`
都是声明值），所以**不**用 JS 兜底 —— 少一处可被 `toString` 识别的地方。

### 2.3 计数口径

`start` 响应里的 `workers` 字段（一轮真机测试的实况）：

```json
{"total":11,"injected":3,"skipped_extension":3,"iframes":1,"worklets":1,"other":2,
 "failed":[],"by_type":{"browser_ui":2,"service_worker":5,"worker":1,"shared_worker":1,
 "iframe":1,"worklet":1}}
```

- `injected 3` = 专用 worker 1 + SharedWorker 1 + ServiceWorker 1，**精确**。
- `service_worker: 5` 而只注入了 1：其中 3 个是扩展自带的（按 `chrome-extension://` 跳过），
  剩下 2 个是同一个 SW 被浏览器层与页面层各接住一次 —— 按 **targetId** 去重，不按 sessionId。
- `worklets: 1` 是 AudioWorklet（`type='worklet'` 的独立 target），按设计不注入但单独记账，
  不让它掉进 `other` 里变成「不知道怎么就没处理」。
- 上面是「三类 worker 探针」那一轮的实况。`test/workers.test.mjs` 之后还会单独起一组嵌套 worker（两层），
  所以那一轮的 `injected` 会到 5、`by_type.worker` 到 3 —— 这是嵌套修复生效的证据，不是重复计数。

## 3. AudioWorklet：为什么明确标 `none`

**先记一句最容易被误读的话：AudioWorklet 标 `none` ≠ 音频指纹裸奔。**

三条理由：

1. **没有独立 target，没有干净注入通道。** 它跑在渲染进程的音频线程里，
   `Target.setAutoAttach` 拿不到它（拿到的是 `worklet` target，但里面没有可注入的指纹表面）。
2. **靠 Fetch 拦 JS 改源码会被抓。** `addModule(url)` 加载的模块能通过 `import.meta.url`
   反查自己的真实地址，也能做模块完整性/字节长度校验；篡改痕迹比不注入更显眼。
3. **那个作用域里裸的只有两个数。** 实测（`src/selfcheck/worker-probe.js` 的 worklet 模块）：

   ```
   hasNavigator: false      // 没有 navigator
   hasCanvas: true          // OffscreenCanvas 存在
   fpInjected: false        // 我们没有注入，也不需要
   sampleRate: 48000
   currentTime: 0
   surfaces: ["sampleRate", "currentTime"]
   ```

   而**音频指纹本体不在这里**：本体是主帧 `OfflineAudioContext.startRendering()` 出来的
   浮点采样，已经被 `audio` 维度的噪声覆盖（自检 `audio` 项 full/partial 状态直接可见）。
   也就是说：检测方想用 AudioWorklet 拿音频指纹拿不到东西，想拿 `sampleRate`
   拿到的就是这台机器的真实值 —— 这个值本来就该是真的（它跟声卡走，和指纹无关）。

自检页和 README 里都写了这句提醒，避免用户把「这一项标 none」理解成「音频这块没做」。

## 4. 怎么复跑

```powershell
# 双 Realm 真机测试（自带起环境、收尾、删临时目录，24 项断言）
node test/workers.test.mjs

# 或跟着冒烟一起跑
npm run smoke

# 看单个环境的自检报告（含三项 realm + AudioWorklet）
npm start
curl "http://127.0.0.1:53380/api/v2/browser-profile/selfcheck?profile_id=<id>&format=html"
```

`test/workers.test.mjs` 断言的就是上面 2.1 / 2.2 / 2.3 三节的事实：
五处哈希一致、三类 worker 的 `atTop === 'worker'`、`injected === 3`、自检四项状态符合预期；
外加三条嵌套 worker 断言（外层与嵌套层 `atTop`、主帧/外层/嵌套三层核数一致、两层都进注入计数）。
换台机器、换个人都能复跑，不依赖 `.tmp`。