import { ref } from 'vue'
import Hello from './Hello.jsx'

export default {
  setup() {
    const count = ref(0)
    return () => (
      <div class="app">
        <h1>vue-jsx-inspector playground</h1>
        <Hello msg={`count: ${count.value}`} />
        <button onClick={() => count.value++}>increment</button>
      </div>
    )
  },
}
