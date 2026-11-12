import { execFile, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfig, SCRATCH_DIR } from './config.ts'
import { parseBibLog, parseTexLog, type LogEntry } from './logparser.ts'
import { isHiddenName } from './paths.ts'

const COMPILE_TIMEOUT_MS = 60_000

const TEX_BIN_DIRS = [
  '/Library/TeX/texbin',
  '/usr/local/texlive/2024/bin/universal-darwin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
]



export type Engine = 'pdflatex' | 'xelatex' | 'lualatex'

export type BuildResult = {
  id: number
  status: 'success' | 'error' | 'timeout' | 'cancelled' | 'failed'
  engine: Engine
  durationMs: number
  /** Changes whenever a new PDF is available; 0 when there is none. */
  pdfVersion: number
  entries: LogEntry[]
  errorCount: number
  warningCount: number
  finishedAt: number
}

export type CompilerHooks = {
  getMainFile: () => string
  /** Flush unsaved editor content to disk so the compile sees it. */
  beforeCompile: () => void
  onStatus: (status: { state: 'compiling' } | { state: 'done'; result: BuildResult }) => void
}

export function texEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }

  const extra = TEX_BIN_DIRS.filter((d) => fs.existsSync(d))

  if (extra.length > 0) {
    const separator = process.platform === 'win32' ? ';' : ':'
    env.PATH = [...extra, process.env.PATH ?? ''].join(separator)
  }

  return {
    ...env,
    // Unwrapped log lines make the log parseable.
    max_print_line: '10000',
    error_line: '254',
    half_error_line: '238',
    // TeX may only read and write inside the build folder (plus the TeX tree). Guests can edit the source.
    openin_any: 'p',
    openout_any: 'p',
  }
}

/** Picks the engine: a "% !TEX program = ..." line wins, then packages that need a Unicode engine. */
export function detectEngine(mainSource: string): Engine {
  const head = mainSource.split('\n').slice(0, 30).join('\n')
  const magic = /^\s*%\s*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)/im.exec(head)
  if (magic) {
    const p = magic[1].toLowerCase()
    if (p.includes('xe')) return 'xelatex'
    if (p.includes('lua')) return 'lualatex'
    if (p.includes('pdf')) return 'pdflatex'
  }
  const preamble = mainSource.split('\\begin{document}')[0].replace(/(^|[^\\])%.*$/gm, '$1')
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(luacode|luatextra|luatexja)\b[^}]*\}/.test(preamble)) return 'lualatex'
  if (/\\usepackage(\[[^\]]*\])?\{[^}]*\b(fontspec|unicode-math|polyglossia|xeCJK)\b[^}]*\}/.test(preamble)) return 'xelatex'
  return 'pdflatex'
}

type Manifest = Map<string, { mtimeMs: number; size: number }>

export class Compiler {
  readonly buildDir: string
  private root: string
  private hooks: CompilerHooks
  private manifest: Manifest | null = null
  private child: ChildProcess | null = null
  private childExit: Promise<void> | null = null
  private generation = 0
  private buildCounter = 0
  lastResult: BuildResult | null = null
  compiling = false

  constructor(root: string, hooks: CompilerHooks) {
    this.root = root
    this.hooks = hooks
    const id = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)
    this.buildDir = path.join(SCRATCH_DIR, id)
  }

  private jobName(): string {
    return path.basename(this.hooks.getMainFile()).replace(/\.[^.]+$/, '')
  }

  /** Where the finished PDF is written inside the project: next to the main file. */
  projectPdfRel(): string {
    const main = this.hooks.getMainFile()
    const dir = path.dirname(main)
    return (dir === '.' ? '' : dir + '/') + this.jobName() + '.pdf'
  }

  private builtPdf(): string {
    return path.join(this.buildDir, this.jobName() + '.pdf')
  }

  /** The PDF to show: the newest build, or the one already in the project before the first build. */
  currentPdf(): { file: string; version: number } | null {
    for (const file of [this.builtPdf(), path.join(this.root, this.projectPdfRel())]) {
      try {
        const st = fs.statSync(file)
        if (st.isFile() && st.size > 0) return { file, version: Math.round(st.mtimeMs) }
      } catch { }
    }
    return null
  }

  rawLog(): string {
    try {
      return fs.readFileSync(path.join(this.buildDir, this.jobName() + '.log'), 'utf8')
    } catch {
      return ''
    }
  }

  /** Copies the project into the build folder (only what changed) so aux files never touch iCloud. */
  private mirror(): void {
    const skip = this.projectPdfRel()
    if (!this.manifest) {
      fs.rmSync(this.buildDir, { recursive: true, force: true })
      this.manifest = new Map()
    }
    fs.mkdirSync(this.buildDir, { recursive: true })
    const seen = new Set<string>()
    const walk = (relDir: string): void => {
      const absDir = path.join(this.root, relDir)
      for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
        if (isHiddenName(ent.name)) continue
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name
        if (ent.isDirectory()) {
          fs.mkdirSync(path.join(this.buildDir, rel), { recursive: true })
          walk(rel)
        } else if (ent.isFile() && rel !== skip) {
          seen.add(rel)
          const st = fs.statSync(path.join(absDir, ent.name))
          const prev = this.manifest!.get(rel)
          if (!prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) {
            fs.copyFileSync(path.join(absDir, ent.name), path.join(this.buildDir, rel))
            this.manifest!.set(rel, { mtimeMs: st.mtimeMs, size: st.size })
          }
        }
        // Symlinks are skipped on purpose: they could point outside the project.
      }
    }
    walk('')
    for (const rel of [...this.manifest.keys()]) {
      if (!seen.has(rel)) {
        fs.rmSync(path.join(this.buildDir, rel), { force: true })
        this.manifest.delete(rel)
      }
    }
  }

  private async killRunning(): Promise<void> {
    const child = this.child
    if (child?.pid) {
      try {
        if (process.platform === 'win32') {
          child.kill()
        } else {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch {
        child.kill('SIGKILL')
      }
    }
    if (this.childExit) await this.childExit
  }

  /** Stops a running compile without starting a new one. */
  async cancel(): Promise<void> {
    this.generation++
    await this.killRunning()
  }

  /**
   * Compiles the project. A compile already in progress is cancelled and replaced by this one.
   * `force` reruns LaTeX even when latexmk sees no changed source (the Recompile button).
   */
  async compile(force = false): Promise<BuildResult> {
    const gen = ++this.generation
    const id = ++this.buildCounter
    this.compiling = true
    this.hooks.onStatus({ state: 'compiling' })
    await this.killRunning()
    if (gen !== this.generation) return this.result(id, 'cancelled', 'pdflatex', 0, [])

    const started = Date.now()
    let engine: Engine = 'pdflatex'
    const finish = (status: BuildResult['status'], entries: LogEntry[]): BuildResult => {
      const result = this.result(id, status, engine, Date.now() - started, entries)
      if (gen === this.generation) {
        this.compiling = false
        this.lastResult = result
        this.hooks.onStatus({ state: 'done', result })
      }
      return result
    }

    const mainRel = this.hooks.getMainFile()
    try {
      this.hooks.beforeCompile()
      if (!fs.existsSync(path.join(this.root, mainRel))) {
        return finish('failed', [{ severity: 'error', file: null, line: null, message: `The main file "${mainRel}" does not exist. Choose the main file in the project settings.` }])
      }
      this.mirror()
      engine = detectEngine(fs.readFileSync(path.join(this.buildDir, mainRel), 'utf8'))
    } catch (err) {
      return finish('failed', [{ severity: 'error', file: null, line: null, message: `Could not prepare the build: ${(err as Error).message}` }])
    }

    if (engine === 'lualatex' && getConfig().lan.enabled) {
      return finish('failed', [{
        severity: 'error', file: mainRel, line: null,
        message: 'LuaLaTeX is disabled while "Show on LAN" is on.',
        hint: 'LuaLaTeX documents can run code that reads and writes any file on this Mac, and guests can edit the document. Turn LAN sharing off to compile with LuaLaTeX, or use pdfLaTeX or XeLaTeX.',
      }])
    }

    const engineFlag = engine === 'xelatex' ? '-pdfxe' : engine === 'lualatex' ? '-pdflua' : '-pdf'
    const args = [
      '-norc', '-f', engineFlag, '-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-no-shell-escape',
      ...(force ? ['-g'] : []),
      mainRel,
    ]
    const logFile = path.join(this.buildDir, this.jobName() + '.log')
    const blgFile = path.join(this.buildDir, this.jobName() + '.blg')

    let output = ''
    let timedOut = false
    let spawnError: Error | null = null
    const child = spawn('latexmk', args, {
      cwd: this.buildDir,
      env: texEnv(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.child = child
    const collect = (chunk: Buffer): void => {
      if (output.length < 200_000) output += chunk.toString('utf8')
    }
    child.stdout!.on('data', collect)
    child.stderr!.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      void this.killRunning()
    }, COMPILE_TIMEOUT_MS)
    this.childExit = new Promise<void>((resolve) => {
      child.on('error', (err) => {
        spawnError = err
        resolve()
      })
      child.on('close', () => resolve())
    })
    await this.childExit
    clearTimeout(timer)
    if (this.child === child) {
      this.child = null
      this.childExit = null
    }

    if (gen !== this.generation) return this.result(id, 'cancelled', engine, Date.now() - started, [])
    if (spawnError) {
      const missing = (spawnError as NodeJS.ErrnoException).code === 'ENOENT'
      return finish('failed', [{
        severity: 'error', file: null, line: null,
        message: missing ? 'latexmk was not found. Is MacTeX installed?' : `Could not start latexmk: ${(spawnError as Error).message}`,
      }])
    }

    const entries: LogEntry[] = []
    const realBuild = fs.realpathSync(this.buildDir)
    const mtime = (file: string): number => {
      try {
        return fs.statSync(file).mtimeMs
      } catch {
        return 0
      }
    }
    // When nothing changed latexmk does not rerun LaTeX. The logs of the last real run still describe
    // the current sources, so they are read whether or not this invocation rewrote them.
    const hasLog = mtime(logFile) > 0
    if (hasLog) entries.push(...parseTexLog(fs.readFileSync(logFile, 'utf8'), realBuild))
    if (mtime(blgFile) > 0) entries.push(...parseBibLog(fs.readFileSync(blgFile, 'utf8'), realBuild))
    if (timedOut) {
      entries.unshift({
        severity: 'error', file: null, line: null,
        message: `Compile timed out after ${COMPILE_TIMEOUT_MS / 1000} seconds and was stopped.`,
        hint: 'This usually means an endless loop in the document, or a very large document.',
      })
      return finish('timeout', entries)
    }
    const hasErrors = entries.some((e) => e.severity === 'error')
    const tail = output.trim().split('\n').slice(-6).join(' ').slice(0, 400)
    if (!hasLog) {
      entries.push({ severity: 'error', file: null, line: null, message: 'LaTeX did not run.', detail: tail })
      return finish('failed', entries)
    }
    const builtAt = mtime(this.builtPdf())
    if (!hasErrors && child.exitCode !== 0 && builtAt < started - 2000) {
      entries.push({ severity: 'error', file: null, line: null, message: 'No PDF was produced.', detail: tail })
      return finish('error', entries)
    }
    // Only an error-free build replaces the PDF in the project folder; the last good one stays otherwise.
    const target = path.join(this.root, this.projectPdfRel())
    if (!hasErrors && builtAt > 0 && builtAt > mtime(target) && fs.existsSync(this.root)) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(this.builtPdf(), target)
      } catch (err) {
        entries.push({ severity: 'warning', file: null, line: null, message: `The PDF could not be copied into the project folder: ${(err as Error).message}` })
      }
    }
    return finish(hasErrors ? 'error' : 'success', entries)
  }

  private result(id: number, status: BuildResult['status'], engine: Engine, durationMs: number, entries: LogEntry[]): BuildResult {
    const order = { error: 0, warning: 1, info: 2 }
    const sorted = [...entries].sort((a, b) => order[a.severity] - order[b.severity])
    return {
      id, status, engine, durationMs,
      pdfVersion: this.currentPdf()?.version ?? 0,
      entries: sorted,
      errorCount: sorted.filter((e) => e.severity === 'error').length,
      warningCount: sorted.filter((e) => e.severity === 'warning').length,
      finishedAt: Date.now(),
    }
  }

  private synctex(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('synctex', args, { cwd: this.buildDir, env: texEnv(), timeout: 10_000 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })
  }

  /** Source position to PDF position (points, origin top-left). */
  async synctexView(file: string, line: number, column: number): Promise<{ page: number; h: number; v: number; width: number; height: number } | null> {
    if (!fs.existsSync(this.builtPdf())) return null
    let out: string
    try {
      out = await this.synctex(['view', '-i', `${line}:${column}:./${file}`, '-o', this.jobName() + '.pdf'])
    } catch {
      return null
    }
    const num = (key: string): number | null => {
      const m = new RegExp(`^${key}:(-?[0-9.]+)`, 'm').exec(out)
      return m ? Number(m[1]) : null
    }
    const page = num('Page')
    const h = num('h'), v = num('v'), width = num('W'), height = num('H')
    if (page === null || h === null || v === null) return null
    return { page, h, v, width: width ?? 0, height: height ?? 0 }
  }

  /** PDF position (points, origin top-left) to source position. */
  async synctexEdit(page: number, x: number, y: number): Promise<{ file: string; line: number } | null> {
    if (!fs.existsSync(this.builtPdf())) return null
    let out: string
    try {
      out = await this.synctex(['edit', '-o', `${page}:${x.toFixed(2)}:${y.toFixed(2)}:${this.jobName()}.pdf`])
    } catch {
      return null
    }
    const input = /^Input:(.*)$/m.exec(out)
    const line = /^Line:(\d+)/m.exec(out)
    if (!input || !line) return null
    const abs = path.normalize(input[1].trim())
    const rel = path.relative(fs.realpathSync(this.buildDir), abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    return { file: rel.split(path.sep).join('/'), line: Number(line[1]) }
  }

  async dispose(): Promise<void> {
    await this.cancel()
  }
}
