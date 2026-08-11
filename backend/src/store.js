import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Per-account state for the installed app.
 *
 * MoySklad hands us one access token per account when the solution is installed,
 * so the whole store is a small map keyed by accountId. A JSON file is enough —
 * mount it on a volume so installs survive redeploys.
 */
export class AccountStore {
  #path
  #data = {}
  #writing = Promise.resolve()

  constructor(path) {
    this.#path = path
  }

  async load() {
    try {
      this.#data = JSON.parse(await readFile(this.#path, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[store] read failed, starting empty:', e.message)
      this.#data = {}
    }
    return this
  }

  get(accountId) {
    return this.#data[accountId] ?? null
  }

  async put(accountId, patch) {
    this.#data[accountId] = { ...(this.#data[accountId] ?? {}), ...patch, updatedAt: new Date().toISOString() }
    await this.#flush()
    return this.#data[accountId]
  }

  async remove(accountId) {
    delete this.#data[accountId]
    await this.#flush()
  }

  /** Serialize writes so concurrent installs can't interleave and lose data. */
  #flush() {
    this.#writing = this.#writing.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true })
      const tmp = `${this.#path}.tmp`
      await writeFile(tmp, JSON.stringify(this.#data, null, 2), 'utf8')
      // Rename is atomic on the same filesystem — never leaves a half-written file.
      const { rename } = await import('node:fs/promises')
      await rename(tmp, this.#path)
    }).catch(e => console.error('[store] write failed:', e.message))
    return this.#writing
  }
}
