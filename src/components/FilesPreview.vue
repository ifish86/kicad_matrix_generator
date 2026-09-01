<template>
  <div>
    <div class="row items-center q-mb-sm">
      <div class="text-subtitle2">Generated files</div>
      <q-space />
      <q-badge color="primary" text-color="white">{{ files.length }}</q-badge>
    </div>

    <q-list bordered separator class="rounded-borders bg-dark">
      <q-item v-for="f in files" :key="f.path" clickable v-ripple @click="open(f)">
        <q-item-section avatar>
          <q-icon name="insert_drive_file" color="primary" />
        </q-item-section>
        <q-item-section>
          <q-item-label>{{ shortPath(f.path) }}</q-item-label>
          <q-item-label caption>{{ formatSize(f.content) }}</q-item-label>
        </q-item-section>
        <q-item-section side>
          <q-icon name="visibility" color="grey-6" />
        </q-item-section>
      </q-item>
    </q-list>

    <q-dialog v-model="show" maximized transition-show="slide-up" transition-hide="slide-down">
      <q-card class="column full-height">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6 text-no-wrap">{{ current ? current.path : '' }}</div>
          <q-space />
          <q-btn flat round dense icon="close" v-close-popup />
        </q-card-section>
        <q-card-section class="col">
          <q-scroll-area class="fit">
            <pre class="file-content">{{ current ? current.content : '' }}</pre>
          </q-scroll-area>
        </q-card-section>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({ files: { type: Array, default: () => [] } })
const show = ref(false)
const current = ref(null)

function open(f) {
  current.value = f
  show.value = true
}

function shortPath(path) {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(1).join('/') : path
}

function formatSize(content) {
  const bytes = new Blob([content]).size
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
</script>

<style scoped>
.file-content {
  margin: 0;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
}
</style>
