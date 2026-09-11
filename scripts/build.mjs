// 构建发布产物：dist/index.js + dist/index.d.ts + dist/client.js
import { execSync } from 'node:child_process'
import fs from 'node:fs'

fs.rmSync('dist', { recursive: true, force: true })
execSync('pnpm exec tsc -p tsconfig.build.json', { stdio: 'inherit' })
// 运行时客户端代码以原始字符串形式注入浏览器，需随包分发
fs.copyFileSync('src/client.js', 'dist/client.js')
console.log('build done: dist/index.js, dist/index.d.ts, dist/client.js')
