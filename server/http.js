import { z } from 'zod'

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function parse(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'invalid_input')
  return result.data
}

export const uuidSchema = z.string().uuid()

// Central error handler: the only place that decides status codes and response JSON.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)
  const status = err.status || 500
  const message = status === 500 ? 'Something went wrong on the server.' : err.message
  res.status(status).json({ success: false, message, code: err.code })
}
