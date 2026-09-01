// Packages a generated project into a downloadable ZIP archive, including the
// 3D models referenced by the selected footprints and the company logo.

import JSZip from 'jszip'
import { modelEntriesFor } from './footprints.js'
import logoUrl from '../assets/logo/logo.png?url'

/**
 * @param {object} project result of generateProject() — { files, summary }
 * @param {object} registry parsed footprint registry
 * @param {object} config normalized config
 */
export async function buildZip(project, registry, config, options = {}) {
  const { includeModels = true, includeLogo = true } = options
  const zip = new JSZip()

  for (const f of project.files) {
    zip.file(f.path, f.content)
  }

  if (includeModels) {
    const entries = modelEntriesFor(registry, config)
    await Promise.all(
      entries.map(async (e) => {
        try {
          const res = await fetch(e.url)
          if (!res.ok) return
          const blob = await res.blob()
          zip.file(`${config.name}/${e.path}`, blob)
        } catch {
          // missing model is non-fatal
        }
      })
    )
  }

  if (includeLogo) {
    try {
      const res = await fetch(logoUrl)
      if (res.ok) {
        const blob = await res.blob()
        zip.file(`${config.name}/logo.png`, blob)
      }
    } catch {
      // ignore
    }
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
