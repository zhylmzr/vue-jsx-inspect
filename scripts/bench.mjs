/**
 * 基准测试：对比 vite-plugin-vue-inspector 与本插件对 vite transform 速度的影响。
 *
 * 方法：
 * 1. 在 bench/src 下生成 N 个结构相同的组件文件（jsx/tsx 各半），三场景共用；
 * 2. 每个场景起一个新的 dev server（不监听端口、不监听文件），
 *    顺序 await transformRequest 全部文件，测「冷启动首次转换」耗时；
 * 3. invalidate 所有模块后再跑一遍，模拟「HMR 二次转换」耗时；
 * 4. 场景间只差一个 inspector 插件，差值即为插件引入的开销。
 *
 * 运行：pnpm bench （可用 BENCH_FILES=200 调整文件数量）
 */
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const benchRoot = fileURLToPath(new URL('../bench', import.meta.url))
const srcDir = path.join(benchRoot, 'src')
const FILE_COUNT = Number(process.env.BENCH_FILES || 100)

// ---------- 样本生成 ----------

function jsxTemplate(i) {
  return `export default function Comp${i}(props) {
  const items = [1, 2, 3]
  return (
    <div class="root-${i}">
      <header>
        <h1>Title ${i}</h1>
        <button onClick={() => props.onClick?.(1)} {...props.btnProps} />
      </header>
      <ul>
        {items.map(n => <li key={n} data-n={n}>item {n}</li>)}
      </ul>
      <footer>
        <span>footer ${i}</span>
        <input type="text" value={props.value} />
      </footer>
    </div>
  )
}
`
}

function tsxTemplate(i) {
  return `interface Comp${i}Props {
  value: string
  onClick?: (n: number) => void
  btnProps?: Record<string, unknown>
}

export default function Comp${i}(props: Comp${i}Props) {
  const items: number[] = [1, 2, 3]
  return (
    <div class="root-${i}">
      <header>
        <h1>Title ${i}</h1>
        <button onClick={() => props.onClick?.(1)} {...props.btnProps} />
      </header>
      <ul>
        {items.map(n => <li key={n} data-n={n}>item {n}</li>)}
      </ul>
      <footer>
        <span>footer ${i}</span>
        <input type="text" value={props.value} />
      </footer>
    </div>
  )
}
`
}

function genFiles() {
  fs.rmSync(srcDir, { recursive: true, force: true })
  fs.mkdirSync(srcDir, { recursive: true })
  const names = []
  for (let i = 0; i < FILE_COUNT; i++) {
    const isTsx = i % 2 === 1
    const name = `Comp${i}.${isTsx ? 'tsx' : 'jsx'}`
    fs.writeFileSync(path.join(srcDir, name), isTsx ? tsxTemplate(i) : jsxTemplate(i))
    names.push(name)
  }
  return names
}

// ---------- 计时 ----------

async function transformAll(server, files) {
  const t0 = performance.now()
  for (const f of files)
    await server.transformRequest(`/src/${f}`)
  return performance.now() - t0
}

async function runScenario(scenario, files) {
  process.env.BENCH_SCENARIO = scenario
  const t0 = performance.now()
  const server = await createServer({ root: benchRoot })
  const ready = performance.now() - t0

  const cold = await transformAll(server, files)

  // 模拟 HMR：使模块失效后重新 transform
  for (const f of files) {
    const mod = await server.moduleGraph.getModuleByUrl(`/src/${f}`)
    if (mod)
      server.moduleGraph.invalidateModule(mod)
  }
  const warm = await transformAll(server, files)

  // transformRequest 之后 close() 可能永不 settle（已知问题），fire-and-forget
  void server.close()
  return { ready, cold, warm }
}

// ---------- 主流程 ----------

const files = genFiles()
console.log(`\n样本：${files.length} 个文件（jsx/tsx 各半），每个约 15 个 JSX 元素\n`)

const scenarios = ['baseline', 'vue-inspector', 'ours']
const RUNS = Number(process.env.BENCH_RUNS || 3)
// 每个场景跑多轮取最优值，消除 JIT 预热/GC 带来的顺序偏差
const results = {}
for (const s of scenarios) {
  const runs = []
  for (let i = 0; i < RUNS; i++) {
    runs.push(await runScenario(s, files))
    global.gc?.()
  }
  results[s] = {
    cold: Math.min(...runs.map(r => r.cold)),
    warm: Math.min(...runs.map(r => r.warm)),
  }
}

const base = results.baseline
const fmt = n => n.toFixed(1).padStart(9)
const avg = total => `${(total / files.length).toFixed(2).padStart(7)} ms`
const fmtOverhead = cold => `${cold >= 0 ? '+' : ''}${cold.toFixed(1)} ms (${cold >= 0 ? '+' : ''}${(cold / base.cold * 100).toFixed(0)}%)`

console.log('场景'.padEnd(16), '冷转换总耗时', '  单文件均值', 'HMR 转换总耗时', '插件开销(冷)')
for (const s of scenarios) {
  const r = results[s]
  const overhead = s === 'baseline'
    ? '—'.padStart(9)
    : fmtOverhead(r.cold - base.cold)
  console.log(
    s.padEnd(18),
    `${fmt(r.cold)} ms`,
    avg(r.cold),
    `${fmt(r.warm)} ms`,
    overhead,
  )
}
console.log(`\nbaseline = 仅 @vitejs/plugin-vue-jsx；每场景 ${RUNS} 轮取最优；开销 = 与 baseline 的差值\n`)
process.exit(0)
