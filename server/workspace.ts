import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getConfig } from './config.ts'
import { HttpError, INTERNAL_DIR, sanitizeFolderName, validateEntryName } from './paths.ts'
import { readProjectSettings, writeProjectSettings } from './project.ts'
import { renderTemplate, TEMPLATES, type TemplateId } from './templates.ts'

function requireDir(input: unknown): string {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new HttpError(400, 'A folder path is required')
  const dir = path.normalize(input)
  let stat: fs.Stats
  try {
    stat = fs.statSync(dir)
  } catch {
    throw new HttpError(404, 'That folder does not exist any more')
  }
  if (!stat.isDirectory()) throw new HttpError(400, 'That is not a folder')
  return dir
}

function hasTexFile(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((n) => n.toLowerCase().endsWith('.tex'))
  } catch {
    return false
  }
}

export function isProjectDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, INTERNAL_DIR, 'project.json')) || hasTexFile(dir)
}

/** The folder itself if it exists, otherwise the closest parent that still does (home as a last resort). */
function nearestExistingDir(wanted: string): string {
  let current = path.normalize(wanted)
  for (; ;) {
    try {
      if (fs.statSync(current).isDirectory()) return current
    } catch { }
    const parent = path.dirname(current)
    if (parent === current) return os.homedir()
    current = parent
  }
}

/**
 * Lists the sub-folders of a folder for the in-app folder picker. A folder that was renamed,
 * moved or deleted is not an error here: the picker lands on the nearest folder that exists.
 */
export function browse(input?: unknown): Record<string, unknown> {
  const home = os.homedir()
  const wanted = typeof input === 'string' && path.isAbsolute(input) ? path.normalize(input) : home
  const dir = nearestExistingDir(wanted)
  const missing = dir === wanted ? null : wanted
  // Only names are read here. Looking inside each sub-folder would make macOS ask for access to
  // Documents, Desktop and Downloads just because their parent was listed.
  const entries: { name: string; path: string }[] = []
  let denied = false
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      let isDir = ent.isDirectory()
      if (ent.isSymbolicLink()) {
        try {
          isDir = fs.statSync(full).isDirectory()
        } catch {
          isDir = false
        }
      }
      if (!isDir) continue
      entries.push({ name: ent.name, path: full })
    }
  } catch {
    denied = true
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const icloud = path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs')
  const shortcuts = [
    { name: 'Home', path: home },
    { name: 'Documents', path: path.join(home, 'Documents') },
    { name: 'Desktop', path: path.join(home, 'Desktop') },
    { name: 'iCloud Drive', path: icloud },
  ].filter((s) => fs.existsSync(s.path))
  const parent = path.dirname(dir)
  return { path: dir, parent: parent === dir ? null : parent, entries, shortcuts, denied, missing, inICloud: dir.startsWith(icloud) }
}

let finderDialogOpen = false

/**
 * Shows the standard macOS "choose folder" dialog on this Mac and returns the chosen folder,
 * or null if the user cancelled.
 */

export function chooseFolderInFinder(startInput?: unknown): Promise<string | null> {
  if (finderDialogOpen) {
    throw new HttpError(409, 'The folder dialog is already open.')
  }

  const start =
    typeof startInput === 'string' && path.isAbsolute(startInput)
      ? nearestExistingDir(startInput)
      : os.homedir()

  finderDialogOpen = true

  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Choose the folder that holds your LaTeX projects"
    $dialog.SelectedPath = $env:LATEXWRITER_START

    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.SelectedPath
    }
  `

      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-STA',
          '-Command',
          script,
        ],
        {
          timeout: 15 * 60 * 1000,
          env: {
            ...process.env,
            LATEXWRITER_START: start,
          },
        },
        (err, stdout, stderr) => {
          finderDialogOpen = false

          if (!err) {
            const chosen = stdout.trim()
            return resolve(chosen || null)
          }

          console.error('Windows folder dialog failed')
          console.error('Error:', err)
          console.error('stdout:', stdout)
          console.error('stderr:', stderr)

          reject(new HttpError(
            500,
            `The folder dialog failed: ${stderr || err.message}`
          ))
        },
      )

      return
    }
    // macOS
    execFile(
      '/usr/bin/osascript',
      [
        '-e', 'on run argv',
        '-e', 'activate',
        '-e', 'set chosen to choose folder with prompt "Choose the folder that holds your LaTeX projects" default location (POSIX file (item 1 of argv))',
        '-e', 'return POSIX path of chosen',
        '-e', 'end run',
        start,
      ],
      { timeout: 15 * 60 * 1000 },
      (err, stdout, stderr) => {
        finderDialogOpen = false

        if (!err) {
          const chosen = stdout.trim()
          return resolve(chosen.length > 1 ? chosen.replace(/\/$/, '') : chosen || null)
        }

        if (/-128|User canceled/i.test(`${stderr} ${err.message}`)) {
          return resolve(null)
        }

        console.error('Finder dialog failed:', stderr || err.message)
        reject(new HttpError(500, 'The folder dialog could not be opened.'))
      },
    )
  })
}

export function makeFolder(parentInput: unknown, nameInput: unknown): string {
  const parent = requireDir(parentInput)
  const name = validateEntryName(String(nameInput ?? ''))
  const full = path.join(parent, name)
  if (fs.existsSync(full)) throw new HttpError(409, 'A folder with that name already exists')
  fs.mkdirSync(full)
  return full
}

export type ProjectSummary = { name: string; path: string; folder: string; mainFile: string; modified: number }

function summarize(dir: string): ProjectSummary {
  const settings = readProjectSettings(dir)
  let modified = 0
  try {
    modified = fs.statSync(path.join(dir, settings.mainFile)).mtimeMs
  } catch {
    try {
      modified = fs.statSync(dir).mtimeMs
    } catch { }
  }
  return { name: settings.name, path: dir, folder: path.basename(dir), mainFile: settings.mainFile, modified }
}

/** A workspace is a folder holding projects. A folder that is itself a project is listed as its only project. */
export function listWorkspace(input: unknown): Record<string, unknown> {
  const dir = requireDir(input)
  const projects: ProjectSummary[] = []
  const selfIsProject = fs.existsSync(path.join(dir, INTERNAL_DIR, 'project.json')) || fs.existsSync(path.join(dir, 'main.tex'))
  if (selfIsProject) projects.push(summarize(dir))
  else {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || !ent.isDirectory()) continue
      const full = path.join(dir, ent.name)
      if (isProjectDir(full)) projects.push(summarize(full))
    }
  }
  projects.sort((a, b) => b.modified - a.modified)
  return { path: dir, name: path.basename(dir), selfIsProject, projects, templates: TEMPLATES }
}

export function createProject(wsInput: unknown, nameInput: unknown, templateInput: unknown): string {
  const ws = requireDir(wsInput)
  const name = String(nameInput ?? '').trim()
  const folder = sanitizeFolderName(name)
  const template = TEMPLATES.find((t) => t.id === templateInput)?.id ?? ('article' as TemplateId)
  const dir = path.join(ws, folder)
  if (fs.existsSync(dir)) throw new HttpError(409, `A folder named "${folder}" already exists here`)
  fs.mkdirSync(dir)
  const files = renderTemplate(template, name, getConfig().hostName)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  writeProjectSettings(dir, { name, mainFile: 'main.tex', autoCompile: true })
  return dir
}

/** Moves a project folder to the macOS Trash. Nothing is deleted for good. */
export async function trashProject(input: unknown): Promise<void> {
  const dir = requireDir(input)
  if (!fs.existsSync(path.join(dir, INTERNAL_DIR, 'project.json'))) throw new HttpError(400, 'That folder is not a LaTeX Writer project')
  const trash = path.join(os.homedir(), '.Trash')
  const base = path.basename(dir)
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '.')
  // macOS does not let us list the Trash, so a name clash only shows up as a failed move.
  for (const name of [base, `${base} ${stamp}`]) {
    try {
      fs.renameSync(dir, path.join(trash, name))
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (!['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(code)) break
    }
  }
  // Direct access to the Trash was refused (privacy protection) or it is on another volume: ask Finder.
  await new Promise<void>((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', dir],
      { timeout: 60_000 },
      (err) => (err ? reject(new HttpError(500, 'Could not move the project to the Trash. Move the folder to the Trash in Finder instead.')) : resolve()),
    )
  })
}
