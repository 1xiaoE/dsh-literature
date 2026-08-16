/**
 * Unified JSON-safe output helper for every literature_* tool.
 *
 * The harness validates tool outputs against a STRICT lossless-JSON boundary
 * (dsh-session isJsonValue): undefined properties, NaN/±Infinity, -0, sparse
 * arrays, BigInt, Date objects, functions, symbols and non-plain class
 * instances are all rejected — a rejected output surfaces as
 * "value is not lossless JSON" AFTER the tool already wrote to SQLite.
 *
 * Rules enforced here (single shared implementation, no per-tool hacks):
 * - undefined            → object property omitted; array element → null
 * - NaN / ±Infinity      → null
 * - -0                   → 0 (JSON.stringify would emit "0", but the strict
 *                           boundary rejects negative zero explicitly)
 * - BigInt               → string
 * - Date                 → ISO string
 * - function / symbol    → omitted (object) / null (array)
 * - class instance       → flattened to a plain object (own enumerable
 *                           string keys), so the strict boundary accepts it
 * - sparse arrays        → holes become null
 * - circular references  → explicit Error (a bug in the tool, never silent)
 */
export function jsonSafe<T>(value: T): T {
  const seen = new WeakSet<object>()
  const visit = (v: unknown): unknown => {
    if (v === null) return null
    const t = typeof v
    switch (t) {
      case 'undefined':
        return undefined
      case 'boolean':
      case 'string':
        return v
      case 'number': {
        if (!Number.isFinite(v)) return null // NaN / ±Infinity
        return Object.is(v, -0) ? 0 : v // strict boundary rejects -0
      }
      case 'bigint':
        return String(v)
      case 'function':
      case 'symbol':
        return undefined
      case 'object': {
        if (v instanceof Date) return v.toISOString()
        if (typeof v === 'object' && seen.has(v)) throw new Error('jsonSafe: circular reference in tool output')
        seen.add(v as object)
        try {
          if (Array.isArray(v)) {
            const out: unknown[] = []
            for (let i = 0; i < v.length; i += 1) {
              const c = visit(v[i])
              out.push(c === undefined ? null : c) // holes/undefined → null
            }
            return out
          }
          // plain object OR class instance: flatten own enumerable string keys
          const obj = v as Record<string, unknown>
          const out: Record<string, unknown> = {}
          for (const k of Object.keys(obj)) {
            const c = visit(obj[k])
            if (c !== undefined) out[k] = c
          }
          return out
        } finally {
          if (typeof v === 'object' && v !== null) seen.delete(v)
        }
      }
      /* v8 ignore next -- typeof exhaustiveness */
      default:
        return undefined
    }
  }
  const result = visit(value)
  return (result === undefined ? {} : result) as T
}

/** Deep-check helper for tests: no undefined / NaN / ±Infinity / -0 anywhere. */
export function assertLosslessJsonSafe(v: unknown, path = 'root'): void {
  if (v === null || v === undefined) {
    if (v === undefined) throw new Error(`${path} is undefined`)
    return
  }
  const t = typeof v
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${path} is non-finite (${v})`)
    if (Object.is(v, -0)) throw new Error(`${path} is -0`)
    return
  }
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new Error(`${path} is ${t}`)
  }
  if (v instanceof Date) throw new Error(`${path} is a Date`)
  if (t === 'object') {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) {
        if (!(i in v)) throw new Error(`${path}[${i}] is a sparse hole`)
        assertLosslessJsonSafe(v[i], `${path}[${i}]`)
      }
      return
    }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`${path} is a non-plain object (${proto?.constructor?.name ?? '?'})`)
    }
    for (const k of Object.keys(v)) {
      assertLosslessJsonSafe((v as Record<string, unknown>)[k], `${path}.${k}`)
    }
  }
}
