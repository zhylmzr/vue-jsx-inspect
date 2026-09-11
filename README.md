# vue-jsx-inspect

一个 Vite 插件：在浏览器中点击页面元素，直接在编辑器中打开对应的 JSX/TSX 源码位置。功能对标 [vite-plugin-vue-inspector](https://github.com/webfansplz/vite-plugin-vue-inspector)，但只处理 `.jsx` / `.tsx` 文件，并用 [yuku-parser](https://github.com/yuku-toolchain/yuku)（原生实现的解析器）替代 babel。

## 特性

- 仅处理 `.jsx` / `.tsx`，不碰 `.vue` 文件
- yuku-parser + yuku-ast 遍历，无 babel 依赖
- 点击元素跳转编辑器精确到行列（基于 Vite 内置的 `/__open-in-editor`）
- 组合键开关（默认 `Ctrl+Shift`，macOS 为 `Cmd+Shift`），`Esc` 退出
- 只在 `vite serve` 时生效，不影响生产构建

## 安装与使用

```bash
pnpm add -D vue-jsx-inspect
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueJsxInspector from 'vue-jsx-inspect'

export default defineConfig({
  plugins: [
    vueJsx(),
    vueJsxInspector(), // 顺序无关，插件内部用 enforce 控制执行时机
  ],
})
```

## 选项及默认值

```ts
vueJsxInspector({
  enabled: false,                    // 初始是否激活检查模式
  toggleComboKey: 'control-shift',   // 切换组合键，macOS 默认 'meta-shift'
  toggleButtonVisibility: 'active',  // 浮动按钮显示策略：'always' | 'active' | 'never'
  toggleButtonPos: 'top-right',      // 浮动按钮位置
  disableInspectorOnEditorOpen: true // 打开编辑器后自动退出检查模式
})
```

## 性能

```
样本：500 个文件（jsx/tsx 各半），每个约 15 个 JSX 元素

场景               冷转换总耗时   单文件均值 HMR 转换总耗时 插件开销(冷)
baseline              1456.3 ms    2.91 ms    1051.0 ms         —
vue-inspector         2122.4 ms    4.24 ms    1718.1 ms +666.1 ms (+46%)
ours                  1639.2 ms    3.28 ms    1221.3 ms +182.9 ms (+13%)

baseline = 仅 @vitejs/plugin-vue-jsx；每场景 3 轮取最优；开销 = 与 baseline 的差值
```

## 工作原理

1. **pre 阶段**：用 yuku-parser 解析 `.jsx` / `.tsx`，给每个 `JSXElement` 注入 `data-v-inspector="绝对路径:行:列"` 属性；
2. **post 阶段**：在 `@vitejs/plugin-vue-jsx` 编译产物上包装 `createVNode` 系列函数，把该属性从渲染 props 转移到 vnode.props 的不可枚举属性 `__v_inspector`（DOM 上不留痕迹）；
3. **运行时**：通过 `transformIndexHtml` 注入客户端脚本，组合键激活后经 `composedPath` 找到携带 `__v_inspector` 的元素，点击时请求 `/__open-in-editor?file=...` 打开编辑器。

## 本地开发

```bash
pnpm dev        # 启动 playground 示例
pnpm test       # 类型检查（库 + playground 双 tsconfig）+ node:test 测试
pnpm bench      # 与 vite-plugin-vue-inspector 的性能对比基准
pnpm build      # 构建 dist（index.js + index.d.ts + client.js）
pnpm typecheck  # 仅类型检查
```

注意：通过 `link:` 方式在其他项目中联调时，改动需先 `pnpm build` 才会同步到 `dist`。

## License

MIT
