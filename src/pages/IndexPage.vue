<template>
  <q-layout view="hHh lpR fFf">
    <q-header elevated class="bg-dark">
      <q-toolbar class="q-px-md q-py-sm">
        <div class="logo-chip q-mr-md">
          <img :src="logo" alt="Company logo" />
        </div>
        <q-toolbar-title>
          <div class="text-weight-bold text-subtitle1">KiCad Matrix Generator</div>
          <div class="text-caption text-grey-5">Switch &amp; WS2812 RGB LED matrix boards</div>
        </q-toolbar-title>
        <q-space />
        <q-btn
          unelevated
          color="primary"
          icon="download"
          label="Generate &amp; Download"
          :loading="downloading"
          @click="download"
        />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page class="q-pa-md bg-dark-page">
        <div class="row q-col-gutter-md">
          <!-- Config -->
          <div class="col-12 col-md-5 col-lg-4">
            <q-card class="q-pa-md">
              <div class="text-subtitle1 text-weight-bold q-mb-sm">Board configuration</div>

              <q-input v-model="config.name" label="Project name" outlined dense class="q-mb-sm">
                <template #append><q-icon name="edit" /></template>
              </q-input>

              <div class="text-caption text-grey-5 q-mb-xs">Board type</div>
              <q-btn-toggle
                v-model="config.type"
                spread
                no-caps
                unelevated
                toggle-color="primary"
                color="grey-8"
                text-color="white"
                :options="[
                  { label: 'Switches', value: 'switches' },
                  { label: 'LEDs', value: 'leds' },
                  { label: 'Hybrid', value: 'hybrid' }
                ]"
                class="q-mb-md full-width"
              />

              <div class="row q-col-gutter-sm q-mb-sm">
                <div class="col-6">
                  <q-input v-model.number="config.rows" type="number" label="Rows" outlined dense min="1" max="16" />
                </div>
                <div class="col-6">
                  <q-input v-model.number="config.cols" type="number" label="Columns" outlined dense min="1" max="24" />
                </div>
              </div>

              <q-separator class="q-my-md" />

              <template v-if="hasSwitches">
                <q-select
                  v-model="config.switchFootprint"
                  outlined
                  dense
                  label="Switch footprint"
                  :options="switchOptions"
                  map-options
                  emit-value
                  class="q-mb-sm"
                />
                <div class="row q-col-gutter-sm q-mb-sm">
                  <div class="col-6">
                    <q-input v-model.number="config.keyPitch" type="number" step="0.01" label="Key pitch (mm)" outlined dense />
                  </div>
                  <div class="col-6">
                    <q-input v-model.number="config.diodeOffset" type="number" step="0.01" label="Diode offset (mm)" outlined dense />
                  </div>
                </div>
              </template>

              <template v-if="hasLeds">
                <q-select
                  v-model="config.ledFootprint"
                  outlined
                  dense
                  label="LED footprint"
                  :options="ledOptions"
                  map-options
                  emit-value
                  class="q-mb-sm"
                />
                <div class="row q-col-gutter-sm q-mb-sm">
                  <div class="col-6">
                    <q-input v-model.number="config.ledPitch" type="number" step="0.01" label="LED pitch (mm)" outlined dense />
                  </div>
                  <div class="col-6">
                    <q-input v-model.number="config.ledOffset" type="number" step="0.01" label="LED offset (mm)" outlined dense />
                  </div>
                </div>
              </template>

              <q-separator class="q-my-md" />

              <div class="row q-col-gutter-sm q-mb-sm">
                <div class="col-6">
                  <q-input v-model.number="config.margin" type="number" step="0.1" label="Board margin (mm)" outlined dense />
                </div>
                <div class="col-6">
                  <q-input v-model.number="config.thickness" type="number" step="0.1" label="Board thickness (mm)" outlined dense />
                </div>
              </div>
              <q-input v-model="config.silkText" label="Silkscreen title" outlined dense class="q-mb-sm" />

              <div class="q-mb-sm">
                <q-toggle v-model="config.includeModels" label="Include 3D models" dense />
                <q-toggle v-model="config.includeLogo" label="Include company logo" dense />
              </div>
            </q-card>
          </div>

          <!-- Preview + result -->
          <div class="col-12 col-md-7 col-lg-8">
            <q-card class="q-pa-md q-mb-md">
              <div class="row items-center q-mb-sm">
                <div class="text-subtitle1 text-weight-bold">Layout preview</div>
                <q-space />
                <q-chip v-if="layout" dense outline color="primary" icon="straighten">
                  {{ layout.width.toFixed(1) }} × {{ layout.height.toFixed(1) }} mm
                </q-chip>
              </div>
              <BoardPreview :layout="layout" />
              <div class="row q-gutter-sm q-mt-sm">
                <q-chip v-if="hasSwitches" dense square color="teal-9" text-color="white">Switches: {{ keys }}</q-chip>
                <q-chip v-if="hasLeds" dense square color="amber-8" text-color="black">LEDs: {{ leds }}</q-chip>
                <q-chip v-if="hasSwitches" dense square color="blue-grey-6" text-color="white">Diodes: {{ keys }}</q-chip>
                <q-chip v-if="generated" dense square color="primary" text-color="white">{{ generated.summary.nets }} nets</q-chip>
              </div>
            </q-card>

            <q-card class="q-pa-md">
              <q-banner v-if="genError" dense class="bg-red-1 text-red-9 q-mb-md">
                <template #avatar><q-icon name="warning" color="red-8" /></template>
                {{ genError }}
              </q-banner>
              <FilesPreview :files="generated ? generated.files : []" />
            </q-card>
          </div>
        </div>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<script setup>
import { reactive, ref, computed, watch } from 'vue'
import { useQuasar } from 'quasar'
import logo from '../assets/logo/logo.png'
import BoardPreview from '../components/BoardPreview.vue'
import FilesPreview from '../components/FilesPreview.vue'
import { buildRegistry, buildSymbolLibrary, SWITCH_FOOTPRINTS, LED_FOOTPRINTS } from '../kicad/footprints.js'
import { normalizeConfig, generateProject, computeLayout } from '../kicad/generator.js'
import { buildZip, downloadBlob } from '../kicad/zip.js'

const $q = useQuasar()
const registry = buildRegistry()
const symlib = buildSymbolLibrary()

const config = reactive({
  name: 'my_keyboard',
  type: 'hybrid',
  rows: 4,
  cols: 5,
  switchFootprint: SWITCH_FOOTPRINTS[0].name,
  ledFootprint: LED_FOOTPRINTS[0].name,
  keyPitch: 19.05,
  ledPitch: 19.05,
  ledOffset: 5.08,
  diodeOffset: 6.35,
  margin: 5,
  thickness: 1.6,
  silkText: 'My Board',
  includeModels: true,
  includeLogo: true
})

const switchOptions = SWITCH_FOOTPRINTS.map((f) => ({ label: f.label, value: f.name }))
const ledOptions = LED_FOOTPRINTS.map((f) => ({ label: f.label, value: f.name }))

const hasSwitches = computed(() => config.type === 'switches' || config.type === 'hybrid')
const hasLeds = computed(() => config.type === 'leds' || config.type === 'hybrid')
const keys = computed(() => (hasSwitches.value ? config.rows * config.cols : 0))
const leds = computed(() => (hasLeds.value ? config.rows * config.cols : 0))

const layout = computed(() => computeLayout(config, registry))

const generated = ref(null)
const genError = ref('')
const downloading = ref(false)

function generatePreview() {
  try {
    generated.value = generateProject(config, registry, symlib)
    genError.value = ''
  } catch (e) {
    // e.g. a matrix too large for a single schematic sheet — say so rather
    // than leaving the preview mysteriously empty
    generated.value = null
    genError.value = e.message || 'Generation failed'
  }
}

let timer = null
watch(
  config,
  () => {
    clearTimeout(timer)
    timer = setTimeout(generatePreview, 250)
  },
  { deep: true }
)

async function download() {
  downloading.value = true
  try {
    const normalized = normalizeConfig(config)
    const project = generateProject(normalized, registry, symlib)
    generated.value = project
    genError.value = ''
    const blob = await buildZip(project, registry, normalized, {
      includeModels: config.includeModels,
      includeLogo: config.includeLogo
    })
    downloadBlob(blob, `${normalized.name}.zip`)
    $q.notify({
      type: 'positive',
      message: `${normalized.name}.zip generated (${project.files.length} files)`
    })
  } catch (e) {
    $q.notify({ type: 'negative', message: e.message || 'Generation failed' })
  } finally {
    downloading.value = false
  }
}

generatePreview()
</script>

<style scoped>
.logo-chip {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.logo-chip img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  padding: 3px;
}
</style>
