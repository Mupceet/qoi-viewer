# Copilot / AI Agent Instructions — qoi-viewer

目标：快速让 AI 代码代理在此代码库中立即可用并高效工作。包括项目大局、开发/构建流程、关键约定与示例位置。

1) 大局与架构
- 这是一个 VS Code 扩展，用于在自定义只读编辑器中预览 QOI 图像（Quit-OK-Image）。核心是 `src` 下的 TypeScript 源。入口由 `src/extension.ts` 注册自定义编辑器 `qoi.previewEditor`。
- 自定义编辑器/预览的实现：`src/preview.ts`。它创建 Webview、通过 `postMessage` 通信、并使用 `src/decode.ts` 将 `.qoi` 数据解码为像素后用 `pngjs` 打包为 PNG data URI。
- 状态栏与 UI：`sizeStatusBarEntry.ts`、`binarySizeStatusBarEntry.ts`、`zoomStatusBarEntry.ts` 展示尺寸、文件大小和缩放控制。

2) 关键文件（快速导航）
- `src/extension.ts`：扩展激活点与 provider 注册（查看 `activationEvents` 与 `registerCustomEditorProvider`）。
- `src/preview.ts`：自定义编辑器的大部分逻辑（webview HTML、CSP/nonce、消息处理、资源转换）。
- `src/decode.ts`：QOI 解码实现（`decode(data, QOIChannels.RGBA)` 返回像素 Buffer）。
- `media/main.js` 与 `media/main.css`：webview 前端资源；修改时注意 CSP nonce 和 `extensionResource()` 的处理。 

3) 常用开发/调试命令
- 构建打包：`npm run compile`（使用 `webpack`，输出编译产物到 `dist/`）。
- 持续打包（监视）：`npm run watch`（在开发中常用，webpack --watch）。
- TypeScript 测试构建监视：`npm run watch-tests`（会运行 `tsc -w` 输出到 `out/`）。
- 运行测试：`npm test`（依赖先执行 `pretest`：会跑 `compile-tests`, `compile`, `lint`）。
- 推荐本地调试：在 VS Code 中执行 “Run Extension”（F5），先运行 `npm run watch` 以便实时更新 `dist/`。

4) 项目约定与实现细节（针对 AI）
- 不使用默认导出（named exports）。编辑或新增模块时保持相同风格。
- Webview 安全：`src/preview.ts` 使用 `nonce` 和严格 CSP；如果修改 webview HTML，务必维持 nonce 注入和 `webview.cspSource` 的使用。
- 资源访问：使用 `webview.asWebviewUri()` 通过 `extensionResource()` 生成可被 webview 访问的 URI。前端引用 `data-settings` JSON（由 `escapeAttribute(JSON.stringify(settings))` 注入）。
- QOI -> PNG 流程：`preview.getResourcePath()` 读文件（`fs.readFileSync(resource.fsPath)`），通过 `QOI.decode()` 得到像素 buffer，再用 `pngjs` 的 `PNG` + `pack()` 生成 PNG 流并转为 data URI。修改此流程需注意可能的二进制大小与内存分配。
- 处理特殊 scheme：对于 `git:` scheme，逻辑会读取 stat 并在 size 为 0 时返回占位空 PNG。

5) 变更与 PR 建议（AI 助手的行为准则）
- 小改动优先：修改应尽量局部（比如修复 preview 的 CSP、nonce 或消息通道）。
- 修改 webview 前端时同时更新 `getWebviewContents()` 中的 CSP 与 `nonce` 生成逻辑。
- 对于性能相关修改（大文件、内存分配），添加简单基准或说明可测方法。

6) 示例任务指引（具体示例）
- 添加一个新的缩放命令：在 `src/zoomStatusBarEntry.ts` 添加命令处理器，调用 `webview.postMessage({type:'setScale', scale})` 并在 `src/preview.ts` 的 message handler 中处理。
- 支持额外 QOI 通道处理：在 `src/decode.ts` 改动需确保 `preview.getResourcePath()` 中的 `PNG` 构造器参数与 `png.data = qoi.pixels` 保持兼容。

7) 本仓库的限制/注意事项
- 本项目依赖 Node `fs.readFileSync(resource.fsPath)` 读取本地文件；在 Remote / virtual workspace 下可能需要适配。 
- 构建依赖：`webpack`, `typescript`, `pngjs`。若新增本地依赖，记得更新 `package.json` 并运行 `npm install`。

如果本说明有遗漏或你希望我把某些实现细节展开为具体代码示例（例如调试步骤、如何在 webview 中添加新消息类型等），请告诉我要扩展的部分。
