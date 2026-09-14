import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'

const playgroundRoot = fileURLToPath(new URL('../playground', import.meta.url))
const tmpModule = path.join(playgroundRoot, '.tmp-hello-inspector-test.mjs')

/** @type {import('vite').ViteDevServer} */
let server

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function transform(url) {
  const result = await server.transformRequest(url)
  assert.ok(result, `transformRequest(${url}) 应返回结果`)
  return result.code
}

before(async () => {
  server = await createServer({
    root: playgroundRoot,
    logLevel: 'silent',
  })
})

after(async () => {
  // 先同步完成清理：node:test 不会无限等待 pending 的 hook，
  // 事件循环空了进程就直接退出，await 之后的代码会被静默跳过
  fs.rmSync(tmpModule, { force: true })
  server.close()
})

test('pre 阶段：给 .jsx 的每个 JSXElement 注入 file:line:column', async () => {
  const code = await transform('/App.jsx')
  // App.jsx: <div> 在第 8 行第 6 列（0 起），<h1> 9:8，<Hello> 10:8，<button> 11:8
  // 注入的是绝对路径，以 .jsx:line:column 结尾
  assert.match(code, /"data-v-inspector":\s*"[^"]*App\.jsx:8:6"/)
  assert.match(code, /"data-v-inspector":\s*"[^"]*App\.jsx:9:8"/)
  assert.match(code, /"data-v-inspector":\s*"[^"]*App\.jsx:10:8"/)
  assert.match(code, /"data-v-inspector":\s*"[^"]*App\.jsx:11:8"/)
})

test('pre 阶段：.tsx 同样生效（含自闭合标签）', async () => {
  const code = await transform('/Hello.tsx')
  // Hello.tsx: <section> 7:4，<p> 8:6，自闭合 <span data-x="1" /> 9:6
  assert.match(code, /"data-v-inspector":\s*"[^"]*Hello\.tsx:7:4"/)
  assert.match(code, /"data-v-inspector":\s*"[^"]*Hello\.tsx:8:6"/)
  assert.match(code, /"data-v-inspector":\s*"[^"]*Hello\.tsx:9:6"/)
})

test('回归：注入的路径能被 /__open-in-editor 中间件解析到真实文件', async () => {
  // vite 的中间件以 process.cwd() 为基准 path.resolve(file)，文件不存在时静默放弃。
  // 这里模拟同样的解析过程，确保路径有效（playground 根目录 ≠ cwd 的场景）
  const code = await transform('/App.jsx')
  const match = code.match(/"data-v-inspector":\s*"([^"]+)"/)
  assert.ok(match)
  const file = match[1].replace(/:\d+:\d+$/, '')
  const resolved = path.resolve(process.cwd(), file)
  assert.ok(fs.existsSync(resolved), `中间件解析结果 ${resolved} 应指向真实文件`)
})

test('post 阶段：createVNode 被 _interopJsxInspectorVNode 包装', async () => {
  const code = await transform('/App.jsx')
  assert.match(code, /function _interopJsxInspectorVNode/)
  assert.match(code, /function _createVNode\(\.\.\.args\) \{ return _interopJsxInspectorVNode/)
  // import 中的别名已被剥离，避免重复定义
  assert.doesNotMatch(code, /createVNode as _createVNode/)
})

test('非 jsx/tsx 文件不受影响', async () => {
  const code = await transform('/main.js')
  assert.ok(!code.includes('data-v-inspector'))
  assert.ok(!code.includes('_interopJsxInspectorVNode'))
})

test('transformIndexHtml：注入运行时客户端脚本', async () => {
  const html = fs.readFileSync(path.join(playgroundRoot, 'index.html'), 'utf-8')
  const result = await server.transformIndexHtml('/', html)
  assert.match(result, /@id\/virtual:vue-jsx-inspector:client/)
})

test('虚拟客户端模块：配置占位符已被替换', async () => {
  const code = await transform('virtual:vue-jsx-inspector:client')
  assert.ok(!code.includes('const options = __VUE_JSX_INSPECTOR_OPTIONS__'))
  const combo = process.platform === 'darwin' ? 'meta-shift' : 'control-shift'
  assert.ok(code.includes(`"toggleComboKey":"${combo}"`))
})

test('运行时行为：data-v-inspector 被转移到 vnode.props 的不可枚举属性 __v_inspector', async () => {
  // 把 post 阶段产物改写成可在 Node 中直接执行的模块（vue 换成裸导入）
  const code = (await transform('/Hello.tsx'))
    .replace(/from\s+"[^"]*vue\.js\?[^"]*"/g, 'from "vue"')
  fs.writeFileSync(tmpModule, code)

  const { default: Hello } = await import(pathToFileURL(tmpModule).href)
  const vnode = Hello({ msg: 'hi' })

  assert.ok(vnode.props.__v_inspector.endsWith('Hello.tsx:7:4'))
  assert.ok(path.isAbsolute(vnode.props.__v_inspector.replace(/:\d+:\d+$/, '')))
  assert.ok(!('data-v-inspector' in vnode.props), '原始属性应从 props 中删除')
  assert.ok(
    !Object.keys(vnode.props).includes('__v_inspector'),
    '__v_inspector 应不可枚举',
  )
  // 子元素同样被处理
  const [p] = vnode.children
  assert.ok(p.props.__v_inspector.endsWith('Hello.tsx:8:6'))
})

/**
 * 定位 token 在代码中的位置
 * @param {string} code
 * @param {string} token
 * @returns {{ line: number, column: number }} 1-based 行号，0-based 列号
 */
function posOf(code, token) {
  const idx = code.indexOf(token)
  assert.ok(idx !== -1, `token ${token} 应存在`)
  const up = code.slice(0, idx)
  return { line: up.split('\n').length, column: idx - (up.lastIndexOf('\n') + 1) }
}

test('sourcemap：注入点右侧的代码位置精确映射回原始文件', async () => {
  // 回归：pre 注入自定义属性后若不返回 map，plugin-vue-jsx 的 babel map 会把注入文本
  // 当作原始文件内容，同行注入点右侧的列号整体偏移；post 的头部 prepend 也会让行号偏移
  const cases = [
    // count.value++ 所在行左侧有 60+ 列的注入文本，且整个文件被 post 头部下移
    ['/App.jsx', 'App.jsx', 'count.value++'],
    // .tsx + 自闭合标签路径：{props.msg} 在 <p> 注入点右侧
    ['/Hello.tsx', 'Hello.tsx', 'props.msg'],
  ]
  for (const [url, file, token] of cases) {
    const result = await server.transformRequest(url)
    assert.ok(result?.map, `${url} 应返回 sourcemap`)
    const map = typeof result.map === 'string' ? JSON.parse(result.map) : result.map
    assert.ok(map.mappings, `${url} 的 map.mappings 不应为空`)

    const orig = fs.readFileSync(path.join(playgroundRoot, file), 'utf-8')
    const origPos = posOf(orig, token)
    const genPos = posOf(result.code, token)

    const traced = originalPositionFor(new TraceMap(map), {
      line: genPos.line,
      column: genPos.column,
    })
    assert.equal(traced.line, origPos.line, `${file} "${token}" 行号`)
    assert.equal(traced.column, origPos.column, `${file} "${token}" 列号`)
  }
})
