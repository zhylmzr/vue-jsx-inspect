import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin, type ResolvedConfig } from "vite";
import { langFromPath, parse } from "yuku-parser";
import { walk } from "yuku-ast";
import { exactRegex } from "@rolldown/pluginutils";

const KEY_DATA = "data-v-inspector";
const KEY_PROPS_DATA = "__v_inspector";
const VIRTUAL_CLIENT_ID = "virtual:vue-jsx-inspector:client";
const HANDLE_ID = /\.[jt]sx$/;

/**
 * 公开的插件类型刻意收窄为最小结构，不引用 vite 的 Plugin。
 *
 * 原因：link: 软链场景下，本包 d.ts 里的 `Plugin` 会绑定到本仓库 node_modules
 * 中的 vite 声明，而消费方绑定的是他们自己那份——即使 vite 版本相同，pnpm 的
 * peer 变体（@types/node 等上下文不同）也会让两份声明无法互赋，消费方 tsc 报
 * TS2321（excessive stack depth）。收窄后使用方只做浅层结构比对，与 vite
 * 版本和安装方式彻底解耦。Plugin 只要求 `name` 必填，其余钩子均为可选，
 * 因此本类型可赋给任意版本 vite 的 PluginOption。
 */
export interface VitePluginLike {
  name: string;
  enforce?: "pre" | "post";
}

export interface VueJsxInspectorOptions {
  /** 初始是否开启检查模式，默认 false */
  enabled?: boolean;
  /** 切换开关的组合键，用 `-` 连接，默认 macOS 为 `meta-shift`，其余为 `control-shift` */
  toggleComboKey?: string;
  /** 浮动按钮的显示策略，默认 'active'（仅激活时显示） */
  toggleButtonVisibility?: "always" | "active" | "never";
  /** 浮动按钮位置，默认 'top-right' */
  toggleButtonPos?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /** 打开编辑器后自动关闭检查模式，默认 true */
  disableInspectorOnEditorOpen?: boolean;
}

const DEFAULT_OPTIONS: Required<VueJsxInspectorOptions> = {
  enabled: false,
  toggleComboKey:
    process.platform === "darwin" ? "meta-shift" : "control-shift",
  toggleButtonVisibility: "active",
  toggleButtonPos: "top-right",
  disableInspectorOnEditorOpen: true,
};

const queryRE = /\?.*$/s;
const hashRE = /#.*$/s;

function idToFile(id: string): string {
  return id.replace(hashRE, "").replace(queryRE, "");
}

function isJsxFile(id: string): boolean {
  const file = idToFile(id);
  return file.endsWith(".jsx") || file.endsWith(".tsx");
}

function getLineColumn(
  code: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  let i = code.indexOf("\n");
  while (i !== -1 && i < offset) {
    line++;
    lineStart = i + 1;
    i = code.indexOf("\n", lineStart);
  }
  return { line, column: offset - lineStart };
}

// pre 阶段：解析 .jsx/.tsx 源码，给每个 JSXElement 注入 `data-v-inspector="file:line:column"`
function injectLineData(code: string, id: string): string {
  const { program, diagnostics } = parse(code, { lang: langFromPath(id) });
  if (diagnostics.some((d) => d.severity === "error")) return code;

  // vite 的 /__open-in-editor 中间件固定以 process.cwd() 为基准解析文件路径，
  // 且目标文件不存在时会静默放弃，因此注入绝对路径
  const absolutePath = normalizePath(path.resolve(id));
  const inserts: { position: number; content: string }[] = [];

  walk(program, {
    JSXElement(node) {
      const opening = node.openingElement;
      const hasData = opening.attributes.some(
        (attr) =>
          attr.type === "JSXAttribute" &&
          attr.name.type === "JSXIdentifier" &&
          attr.name.name === KEY_DATA,
      );
      if (hasData) return;
      const position = opening.end - (opening.selfClosing ? 2 : 1);
      const { line, column } = getLineColumn(code, node.start);
      inserts.push({
        position,
        content: ` ${KEY_DATA}="${absolutePath}:${line}:${column}"`,
      });
    },
  });

  if (!inserts.length) return code;

  inserts.sort((a, b) => a.position - b.position);
  let result = "";
  let last = 0;
  for (const { position, content } of inserts) {
    result += code.slice(last, position) + content;
    last = position;
  }
  return result + code.slice(last);
}

// post 阶段：包装 vue 的 createVNode 系列函数，把 data-v-inspector 从渲染 props
// 转移到 vnode.props 上的不可枚举属性 __v_inspector
function interopVnode(code: string): string | undefined {
  if (code.includes("_interopJsxInspectorVNode")) return;
  if (!code.includes(KEY_DATA)) return;

  const fn = new Set<string>();
  const stripped = code.replace(
    /(createElementVNode|createVNode|createElementBlock) as _\1,?/g,
    (_, name: string) => {
      fn.add(name);
      return "";
    },
  );
  if (!fn.size) return;

  const names = Array.from(fn);
  const header = `/* Injection by vite-plugin-vue-jsx-inspector Start */
import { ${names.map((i) => `${i} as __jsxInspector_${i}`).join(", ")} } from 'vue'
function _interopJsxInspectorVNode(vnode) {
  if (vnode && vnode.props && '${KEY_DATA}' in vnode.props) {
    const data = vnode.props['${KEY_DATA}']
    delete vnode.props['${KEY_DATA}']
    Object.defineProperty(vnode.props, '${KEY_PROPS_DATA}', { value: data, enumerable: false })
  }
  return vnode
}
${names.map((i) => `function _${i}(...args) { return _interopJsxInspectorVNode(__jsxInspector_${i}(...args)) }`).join("\n")}
/* Injection by vite-plugin-vue-jsx-inspector End */
`;
  return header + stripped;
}

const toggleComboKeysMap: Record<string, string> = {
  control: process.platform === "darwin" ? "Control(^)" : "Ctrl(^)",
  meta: "Command(⌘)",
  shift: "Shift(⇧)",
};

export function normalizeComboKeyPrint(toggleComboKey: string): string {
  return toggleComboKey
    .split("-")
    .map(
      (key) => toggleComboKeysMap[key] || key[0]!.toUpperCase() + key.slice(1),
    )
    .join("+");
}

export default function VitePluginVueJsxInspector(
  options: VueJsxInspectorOptions = {},
): VitePluginLike[] {
  const normalizedOptions = { ...DEFAULT_OPTIONS, ...options };
  let config: ResolvedConfig;

  const clientCodePath = fileURLToPath(new URL("./client.js", import.meta.url));

  // 内部实现仍用 vite 的 Plugin 类型约束，保证钩子签名正确；
  // 只有对外的声明类型收窄为 VitePluginLike
  const plugins: Plugin[] = [
    {
      name: "vite-plugin-vue-jsx-inspector",
      enforce: "pre",
      apply(_, { command }) {
        return command === "serve";
      },
      configResolved(resolvedConfig) {
        config = resolvedConfig;
      },
      resolveId: {
        filter: { id: exactRegex(VIRTUAL_CLIENT_ID) },
        handler(id) {
          if (id === VIRTUAL_CLIENT_ID) return id;
        },
      },
      load: {
        filter: { id: exactRegex(VIRTUAL_CLIENT_ID) },
        handler(id) {
          if (id === VIRTUAL_CLIENT_ID) {
            const clientCode = fs.readFileSync(clientCodePath, "utf-8");
            return clientCode.replaceAll(
              "__VUE_JSX_INSPECTOR_OPTIONS__",
              JSON.stringify(normalizedOptions),
            );
          }
        },
      },
      transform: {
        order: "pre",
        filter: { id: HANDLE_ID },
        handler(code, id) {
          // filter 只是快速路径；id 可能带 query，.vue 的 script 块也会以 .tsx 结尾，
          // 仍然需要 isJsxFile 兜底
          if (!isJsxFile(id)) {
            return;
          }
          const file = idToFile(id);
          return injectLineData(code, file);
        },
      },
      configureServer(server) {
        const { toggleComboKey } = normalizedOptions;
        if (!toggleComboKey) return;
        const _printUrls = server.printUrls;
        server.printUrls = () => {
          _printUrls();
          console.log(
            `  ➜  Vue JSX Inspector: Press ${normalizeComboKeyPrint(toggleComboKey)} in App to toggle the Inspector\n`,
          );
        };
      },
      transformIndexHtml(html) {
        return {
          html,
          tags: [
            {
              tag: "script",
              injectTo: "head",
              attrs: {
                type: "module",
                src: `${config?.base || "/"}@id/${VIRTUAL_CLIENT_ID}`,
              },
            },
          ],
        };
      },
    },
    {
      name: "vite-plugin-vue-jsx-inspector:post",
      enforce: "post",
      apply(_, { command }) {
        return command === "serve";
      },
      transform: {
        filter: { id: HANDLE_ID },
        handler(code, id) {
          if (!isJsxFile(id)) {
            return;
          }
          return interopVnode(code);
        },
      },
    },
  ];
  return plugins;
}

export { DEFAULT_OPTIONS };
