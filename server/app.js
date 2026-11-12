import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { api } from './routes.js'
import { errorHandler } from './http.js'

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  // Behind nginx on the same host: req.ip is the real client address (per-IP live model cap).
  app.set('trust proxy', 'loopback')
  app.use(express.json({ limit: '50kb' }))
  app.use('/api', api)
  if (existsSync(distDir)) {
    app.use(express.static(distDir))
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
      res.sendFile(path.join(distDir, 'index.html'))
    })
  }
  app.use(errorHandler)
  return app
}
