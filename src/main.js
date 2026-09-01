import { createApp } from 'vue'
import { Quasar, Notify, Dialog, Loading, LocalStorage } from 'quasar'

// Import icon libraries
import '@quasar/extras/material-icons/material-icons.css'
import '@quasar/extras/material-icons-outlined/material-icons-outlined.css'

// Import Quasar css
import 'quasar/src/css/index.sass'

import App from './App.vue'

const app = createApp(App)

app.use(Quasar, {
  plugins: {
    Notify,
    Dialog,
    Loading,
    LocalStorage
  },
  config: {
    dark: true,
    brand: {
      primary: '#26a69a',
      secondary: '#4db6ac',
      accent: '#9c27b0',
      dark: '#10141c',
      'dark-page': '#0b0e14',
      positive: '#21ba45',
      negative: '#c10015',
      info: '#31ccec',
      warning: '#f2c037'
    },
    notify: {}
  }
})

app.mount('#q-app')
