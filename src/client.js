// vite-plugin-vue-jsx-inspector 的浏览器端运行时，纯 DOM 实现，不依赖 Vue。
// `__VUE_JSX_INSPECTOR_OPTIONS__` 占位符会在插件的 load 钩子中被替换为实际配置。
const options = __VUE_JSX_INSPECTOR_OPTIONS__

const KEY_DATA = 'data-v-inspector'
const KEY_PROPS_DATA = '__v_inspector'
const KEY_IGNORE = 'data-v-inspector-ignore'

const combo = (options.toggleComboKey || '').toLowerCase().split('-').filter(Boolean)

let enabled = !!options.enabled
let current = null // { node, file, line, column }

function getData(el) {
  return el?.__vnode?.props?.[KEY_PROPS_DATA] ?? el?.getAttribute?.(KEY_DATA)
}

// ---------- UI ----------

const container = document.createElement('div')
container.setAttribute(KEY_IGNORE, 'true')
container.id = 'vue-jsx-inspector-container'

const style = document.createElement('style')
style.textContent = `
#vue-jsx-inspector-container { font-family: Arial, Helvetica, sans-serif; }
.jsx-inspector-toggle {
  position: fixed; z-index: 2147483647; cursor: pointer;
  padding: 5px 8px; border-radius: 4px; font-size: 12px;
  color: #e9e9e9; background-color: #42b883;
  box-shadow: 0 1px 3px rgba(0,0,0,.1); user-select: none;
}
.jsx-inspector-toggle.disabled { background-color: #e2c6c6; }
.jsx-inspector-overlay {
  position: fixed; z-index: 2147483646; pointer-events: none;
  background-color: #42b88325; border: 1px solid #42b88350; border-radius: 5px;
  transition: all .1s ease-in;
}
.jsx-inspector-tooltip {
  position: fixed; z-index: 2147483647; pointer-events: none;
  padding: 5px 8px; border-radius: 4px; font-size: 14px; text-align: left;
  color: #e9e9e9; background-color: #42b883; transform: translateX(-50%);
  transition: all .1s ease-in;
}
.jsx-inspector-tooltip .tip { font-size: 11px; opacity: .7; }
`
container.appendChild(style)

const toggleButton = document.createElement('div')
toggleButton.className = 'jsx-inspector-toggle'
toggleButton.textContent = 'JSX Inspector'
container.appendChild(toggleButton)

const overlay = document.createElement('div')
overlay.className = 'jsx-inspector-overlay'
overlay.style.display = 'none'
container.appendChild(overlay)

const tooltip = document.createElement('div')
tooltip.className = 'jsx-inspector-tooltip'
tooltip.style.display = 'none'
container.appendChild(tooltip)

document.body.appendChild(container)

function updateToggleButton() {
  const pos = options.toggleButtonPos.split('-')
  toggleButton.style.cssText = pos.map(p => `${p}: 15px;`).join('')
  toggleButton.classList.toggle('disabled', !enabled)
  const visibility = options.toggleButtonVisibility
  toggleButton.style.display = visibility === 'always' || (visibility === 'active' && enabled)
    ? ''
    : 'none'
}

toggleButton.addEventListener('click', (e) => {
  e.preventDefault()
  e.stopPropagation()
  toggle()
})

// ---------- 选中逻辑 ----------

function findTarget(e) {
  const path = e.composedPath ? e.composedPath() : e.path
  if (!path)
    return null
  const ignoreIndex = path.findIndex(node => node?.hasAttribute?.(KEY_IGNORE))
  const node = path.slice(ignoreIndex + 1).find(n => getData(n))
  if (!node)
    return null
  const match = getData(node)?.match(/(.+):(\d+):(\d+)$/)
  if (!match)
    return null
  return { node, file: match[1], line: match[2], column: match[3] }
}

function hideOverlay() {
  overlay.style.display = 'none'
  tooltip.style.display = 'none'
  current = null
}

function onMousemove(e) {
  const target = findTarget(e)
  if (!target) {
    hideOverlay()
    return
  }
  current = target
  const rect = target.node.getBoundingClientRect()
  overlay.style.display = ''
  overlay.style.left = `${rect.x}px`
  overlay.style.top = `${rect.y}px`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`

  tooltip.style.display = ''
  tooltip.innerHTML = ''
  const title = document.createElement('div')
  title.textContent = `${target.file}:${target.line}:${target.column}`
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.textContent = 'Click to go to the file'
  tooltip.append(title, tip)

  const margin = 10
  let x = rect.x + rect.width / 2
  let y = rect.y + rect.height + 5
  x = Math.max(margin, Math.min(x, window.innerWidth - tooltip.clientWidth - margin))
  y = Math.max(margin, Math.min(y, window.innerHeight - tooltip.clientHeight - margin))
  tooltip.style.left = `${x}px`
  tooltip.style.top = `${y}px`
}

function onClick(e) {
  const target = findTarget(e)
  if (!target)
    return
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
  hideOverlay()
  const promise = fetch(`/__open-in-editor?file=${target.file}:${target.line}:${target.column}`, {
    mode: 'no-cors',
  })
  if (options.disableInspectorOnEditorOpen)
    promise.then(disable)
}

function bindListeners() {
  const method = enabled ? 'addEventListener' : 'removeEventListener'
  document.body[method]('mousemove', onMousemove)
  document.body[method]('click', onClick, true)
  window[method]('resize', hideOverlay, true)
  window[method]('scroll', hideOverlay, true)
}

function enable() {
  if (enabled)
    return
  toggle()
}

function disable() {
  if (!enabled)
    return
  toggle()
}

function toggle() {
  enabled = !enabled
  hideOverlay()
  bindListeners()
  updateToggleButton()
}

function isKeyActive(key, e) {
  switch (key) {
    case 'shift':
    case 'control':
    case 'alt':
    case 'meta':
      return e.getModifierState(key.charAt(0).toUpperCase() + key.slice(1))
    default:
      return key === e.key.toLowerCase()
  }
}

if (combo.length) {
  document.body.addEventListener('keydown', (e) => {
    if (e.repeat || e.key === undefined)
      return
    if (e.key === 'Escape' && enabled) {
      disable()
      return
    }
    if (combo.every(key => isKeyActive(key, e)))
      toggle()
  })
}

updateToggleButton()
bindListeners()

window.__VUE_JSX_INSPECTOR__ = { enable, disable, toggle }
