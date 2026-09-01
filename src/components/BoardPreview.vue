<template>
  <svg
    class="board-preview"
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="xMidYMid meet"
    role="img"
    aria-label="Board layout preview"
  >
    <rect class="board" :x="pad" :y="pad" :width="boardW" :height="boardH" rx="2" />
    <g v-if="layout">
      <!-- switches -->
      <g v-for="s in layout.switches" :key="'sw' + s.ref">
        <rect class="switch" :x="px(s.x) - 3" :y="py(s.y) - 3" width="6" height="6" rx="1" />
        <circle class="switch-dot" :cx="px(s.x)" :cy="py(s.y)" r="1.1" />
        <text class="ref" :x="px(s.x)" :y="py(s.y) - 3.6">{{ s.ref }}</text>
      </g>
      <!-- LEDs -->
      <g v-for="l in layout.leds" :key="'led' + l.ref">
        <rect class="led" :x="px(l.x) - 2.5" :y="py(l.y) - 2.5" width="5" height="5" rx="0.5" />
        <text class="ref-led" :x="px(l.x)" :y="py(l.y) + 1.2">{{ l.snake }}</text>
      </g>
      <!-- diodes -->
      <g v-for="d in layout.diodes" :key="'d' + d.ref">
        <rect class="diode" :x="px(d.x) - 1.3" :y="py(d.y) - 0.8" width="2.6" height="1.6" />
      </g>
    </g>
  </svg>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({ layout: { type: Object, default: null } })

const pad = 8
const W = computed(() => (props.layout ? props.layout.width + pad * 2 : 100))
const H = computed(() => (props.layout ? props.layout.height + pad * 2 : 100))
const boardW = computed(() => (props.layout ? props.layout.width : 84))
const boardH = computed(() => (props.layout ? props.layout.height : 84))

function px(x) {
  return pad + (x - props.layout.bounds.minX)
}
function py(y) {
  return pad + (props.layout.bounds.maxY - y)
}
</script>

<style scoped>
.board-preview {
  width: 100%;
  height: auto;
  max-height: 480px;
  display: block;
}
.board {
  fill: rgba(38, 166, 154, 0.08);
  stroke: #26a69a;
  stroke-width: 0.3;
}
.switch {
  fill: #1c2536;
  stroke: #26a69a;
  stroke-width: 0.18;
}
.switch-dot {
  fill: #2c3e50;
  stroke: #4db6ac;
  stroke-width: 0.12;
}
.led {
  fill: #f9d423;
  stroke: #b8860b;
  stroke-width: 0.15;
}
.diode {
  fill: #7a8797;
  stroke: #4a5568;
  stroke-width: 0.1;
}
.ref {
  font-size: 1.6px;
  fill: #9fb3c8;
  text-anchor: middle;
}
.ref-led {
  font-size: 1.5px;
  fill: #6d4c00;
  text-anchor: middle;
}
</style>
