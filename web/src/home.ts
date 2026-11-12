import { api, q, type Sharing } from './api.ts'
import { app } from './app.ts'
import { openSettingsDialog, openShareDialog } from './dialogs.ts'
import { clear, closeOverlays, confirmDialog, h, icon, iconButton, openModal, promptDialog, showMenu, store, timeAgo, toast } from './dom.ts'

type Recent = { path: string; name: string; lastOpened: number; exists: boolean }
type Home = { hostName: string; recentWorkspaces: Recent[]; sharing: Sharing }
type ProjectSummary = { name: string; path: string; folder: string; mainFile: string; modified: number }
type Template = { id: string; name: string; description: string }
type Workspace = { path: string; name: string; selfIsProject: boolean; projects: ProjectSummary[]; templates: Template[] }
type Browse = {
  path: string
  parent: string | null
  entries: { name: string; path: string }[]
  shortcuts: { name: string; path: string }[]
  denied: boolean
  missing: string | null
  inICloud: boolean
}

const tildify = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~').replace('~/Library/Mobile Documents/com~apple~CloudDocs', 'iCloud Drive')

/** The host's start screen: pick a folder, then pick or create a project in it. */
export function mountHome(root: HTMLElement): () => void {
  let disposed = false
  const main = h('main', { class: 'home-main' })
  const page = h('div', { class: 'home' },
    h('header', { class: 'home-header' },
      h('h1', null, 'LaTeX Writer'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onclick: openShareDialog }, icon('share'), ' Share'),
      iconButton('settings', 'Settings', () => openSettingsDialog({ texFiles: [], onLeave: () => { } })),
    ),
    main,
  )
  clear(root)
  root.appendChild(page)
  document.title = 'LaTeX Writer'

  const fail = (err: unknown): void => toast((err as Error).message, 'error')

  async function openProject(path: string, workspace: string): Promise<void> {
    try {
      // The 'project' event from the server switches the screen for everyone, including us.
      await api('POST', '/api/host/project/open', { path, workspace })
    } catch (err) {
      fail(err)
    }
  }

  // ---- recent folders ---------------------------------------------------------------

  async function showRecents(): Promise<void> {
    store('workspace', null)
    clear(main)
    main.appendChild(h('p', { class: 'muted' }, 'Loading…'))
    let home: Home
    try {
      home = await api<Home>('GET', '/api/host/home')
    } catch (err) {
      clear(main)
      main.appendChild(h('p', { class: 'error-text' }, (err as Error).message))
      return
    }
    if (disposed) return
    clear(main)
    main.append(
      h('div', { class: 'home-title' },
        h('h2', null, 'Open a folder'),
        h('span', { class: 'row' },
          h('button', { class: 'btn', type: 'button', title: 'Pick the folder from a list in this window', onclick: () => pickFolder() }, 'Browse here…'),
          finderButton(() => store('pickerPath') ?? undefined, (path) => void showWorkspace(path)),
        ),
      ),
      h('p', { class: 'muted' }, 'Pick the folder that holds your LaTeX projects. Each project is an ordinary sub-folder with a main.tex and its PDF.'),
    )
    if (!home.recentWorkspaces.length) {
      main.appendChild(h('div', { class: 'empty-card' }, icon('folder', 28), h('p', null, 'No folders opened yet.'), h('p', { class: 'muted' }, 'Choose a folder to get started.')))
      return
    }
    main.appendChild(h('h3', { class: 'list-heading' }, 'Recent folders'))
    const list = h('ul', { class: 'card-list' })
    for (const w of home.recentWorkspaces) {
      list.appendChild(h('li', { class: `card-row ${w.exists ? '' : 'missing'}` },
        h('button', { class: 'card-main', type: 'button', disabled: !w.exists, onclick: () => void showWorkspace(w.path) },
          icon('folder', 20),
          h('span', { class: 'card-text' }, h('strong', null, w.name), h('span', { class: 'muted small' }, w.exists ? tildify(w.path) : `${tildify(w.path)} (folder not found)`)),
          h('span', { class: 'muted small' }, timeAgo(w.lastOpened)),
        ),
        iconButton('close', 'Remove from this list', async () => {
          try {
            await api('POST', '/api/host/workspace/forget', { path: w.path })
            void showRecents()
          } catch (err) {
            fail(err)
          }
        }),
      ))
    }
    main.appendChild(list)
  }

  // ---- one folder: its projects -----------------------------------------------------

  async function showWorkspace(path: string, quiet = false): Promise<void> {
    let ws: Workspace
    try {
      ws = await api<Workspace>('GET', `/api/host/workspace?${q({ path })}`)
    } catch (err) {
      // The folder may have been renamed or moved since last time; the list of folders says so.
      if (!quiet) fail(err)
      return showRecents()
    }
    if (disposed) return
    store('workspace', path)
    clear(main)
    main.append(
      h('div', { class: 'crumbs' },
        h('button', { class: 'link', type: 'button', onclick: () => void showRecents() }, icon('back', 14), ' All folders'),
      ),
      h('div', { class: 'home-title' },
        h('div', null, h('h2', null, ws.name), h('p', { class: 'muted small' }, tildify(ws.path))),
        ws.selfIsProject ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => newProject(ws) }, icon('plus'), ' New project'),
      ),
    )
    if (ws.selfIsProject) main.appendChild(h('p', { class: 'muted' }, 'This folder is itself a project.'))
    if (!ws.projects.length) {
      main.appendChild(h('div', { class: 'empty-card' }, icon('file', 28), h('p', null, 'No projects in this folder yet.'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => newProject(ws) }, 'Create the first project')))
      return
    }
    const list = h('ul', { class: 'card-list' })
    for (const p of ws.projects) {
      list.appendChild(h('li', { class: 'card-row' },
        h('button', { class: 'card-main', type: 'button', onclick: () => void openProject(p.path, ws.path) },
          icon('pdf', 20),
          h('span', { class: 'card-text' }, h('strong', null, p.name), h('span', { class: 'muted small' }, `${p.folder}/${p.mainFile}`)),
          h('span', { class: 'muted small' }, p.modified ? `edited ${timeAgo(p.modified)}` : ''),
        ),
        iconButton('more', 'More actions', (e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          showMenu(r.right - 190, r.bottom + 2, [
            { label: 'Open', onclick: () => void openProject(p.path, ws.path) },
            { label: 'Show in Finder', onclick: () => void api('POST', '/api/host/reveal', { path: p.path }).catch(fail) },
            'separator',
            {
              label: 'Move to Trash', icon: 'trash', danger: true, onclick: async () => {
                const ok = await confirmDialog({
                  title: 'Move project to Trash',
                  message: `Move "${p.name}" and all its files to the macOS Trash? You can put it back from the Trash.`,
                  confirmLabel: 'Move to Trash',
                  danger: true,
                })
                if (!ok) return
                try {
                  await api('POST', '/api/host/project/trash', { path: p.path })
                  toast(`"${p.name}" was moved to the Trash`, 'info')
                  void showWorkspace(ws.path)
                } catch (err) {
                  fail(err)
                }
              }
            },
          ])
        }),
      ))
    }
    main.appendChild(list)
  }

  function newProject(ws: Workspace): void {
    const m = openModal({ title: 'New project' })
    const name = h('input', { class: 'input', type: 'text', placeholder: 'My thesis', autocomplete: 'off', maxlength: 80 })
    let template = 'article'
    const options = h('div', { class: 'template-grid', role: 'radiogroup', 'aria-label': 'Template' })
    const renderOptions = (): void => {
      clear(options)
      for (const t of ws.templates) {
        options.appendChild(h('button', {
          class: `template ${t.id === template ? 'active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(t.id === template),
          onclick: () => { template = t.id; renderOptions() },
        }, h('strong', null, t.name), h('span', { class: 'muted small' }, t.description)))
      }
    }
    renderOptions()
    const create = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create project')
    const submit = async (): Promise<void> => {
      const v = name.value.trim()
      if (!v) return name.focus()
      create.disabled = true
      try {
        await api('POST', '/api/host/project/create', { workspace: ws.path, name: v, template })
        m.close()
      } catch (err) {
        create.disabled = false
        fail(err)
      }
    }
    m.body.appendChild(h('form', { id: 'new-project', class: 'stack', onsubmit: (e: Event) => { e.preventDefault(); void submit() } },
      h('label', { class: 'field' }, h('span', null, 'Project name'), name),
      h('div', { class: 'field' }, h('span', null, 'Start from'), options),
      h('p', { class: 'muted small' }, `Creates a folder in ${tildify(ws.path)} with main.tex. The compiled main.pdf is saved next to it.`),
    ))
    create.setAttribute('form', 'new-project')
    m.footer.append(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), create)
    name.focus()
  }

  // ---- folder picker ----------------------------------------------------------------

  /** A button that opens the native folder selection dialog. */
  function finderButton(start: () => string | undefined, onChosen: (path: string) => void): HTMLButtonElement {
    const label = h('span', null, 'Choose folder…')
    const button = h('button', { class: 'btn btn-primary', type: 'button', title: 'Open the folder selection dialog' }, icon('folder'), label)
    button.addEventListener('click', async () => {
      button.disabled = true
      label.textContent = 'Waiting for folder dialog…'
      try {
        const res = await api<{ path: string | null }>('POST', '/api/host/choose-folder', { start: start() })
        if (res.path) onChosen(res.path)
      } catch (err) {
        fail(err)
      } finally {
        button.disabled = false
        label.textContent = 'Choose folder…'
      }
    })
    return button
  }

  function pickFolder(): void {
    const m = openModal({ title: 'Choose a folder', wide: true })
    const pathEl = h('div', { class: 'picker-path' })
    const list = h('div', { class: 'picker-list' })
    const shortcuts = h('div', { class: 'picker-shortcuts' })
    const note = h('p', { class: 'muted small picker-note' })
    const choose = h('button', { class: 'btn btn-primary', type: 'button' }, 'Use this folder')
    let current: Browse | null = null

    const go = async (path?: string): Promise<void> => {
      let b: Browse
      try {
        b = await api<Browse>('GET', `/api/host/browse?${q(path ? { path } : {})}`)
      } catch (err) {
        // Whatever went wrong with that folder, never leave the picker empty: start over from home.
        if (path) return go()
        clear(list)
        list.appendChild(h('p', { class: 'error-text pad' }, (err as Error).message))
        return
      }
      if (b.missing) toast(`The folder "${b.missing.split('/').pop()}" is not there any more (renamed or moved?). Showing the nearest folder instead.`, 'info', 6000)
      current = b
      store('pickerPath', b.path)
      clear(pathEl)
      pathEl.append(
        iconButton('up', 'Up one folder', () => b.parent && void go(b.parent)),
        h('span', { class: 'grow picker-current', title: b.path }, tildify(b.path)),
        h('button', {
          class: 'btn btn-small', type: 'button', onclick: async () => {
            const name = await promptDialog({ title: 'New folder', label: `Name (in ${tildify(b.path)})`, confirmLabel: 'Create' })
            if (!name) return
            try {
              const res = await api<{ path: string }>('POST', '/api/host/mkdir', { parent: b.path, name })
              void go(res.path)
            } catch (err) {
              fail(err)
              // The folder we were in may have just been renamed or removed: refresh the view.
              void go(b.path)
            }
          }
        }, icon('folder-plus'), ' New folder'),
      )
      if (!shortcuts.childElementCount) {
        for (const s of b.shortcuts) shortcuts.appendChild(h('button', { class: 'picker-shortcut', type: 'button', onclick: () => void go(s.path) }, icon('folder'), s.name))
      }
      clear(list)
      if (b.denied) list.appendChild(h('p', { class: 'muted pad' }, 'macOS did not allow reading this folder. Allow access for Terminal in System Settings → Privacy & Security → Files and Folders.'))
      else if (!b.entries.length) list.appendChild(h('p', { class: 'muted pad' }, 'No sub-folders here.'))
      for (const e of b.entries) {
        list.appendChild(h('button', { class: 'picker-row', type: 'button', onclick: () => void go(e.path) },
          icon('folder'), h('span', { class: 'grow' }, e.name), icon('chevron', 12)))
      }
      list.scrollTop = 0
      note.textContent = b.inICloud
        ? 'This folder is in iCloud Drive. That works, but iCloud can be slow to sync while you edit; a folder outside iCloud is more reliable.'
        : ''
    }

    choose.addEventListener('click', () => {
      if (!current) return
      m.close()
      void showWorkspace(current.path)
    })
    m.body.appendChild(h('div', { class: 'picker' }, shortcuts, h('div', { class: 'picker-main' }, pathEl, list)))
    m.body.appendChild(note)
    m.footer.append(
      finderButton(() => current?.path, (path) => {
        m.close()
        void showWorkspace(path)
      }),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'),
      choose,
    )
    void go(store('pickerPath') ?? undefined)
  }

  const saved = store('workspace')
  if (saved) void showWorkspace(saved, true)
  else void showRecents()

  return () => {
    disposed = true
    closeOverlays()
  }
}

// ---- guest screens ---------------------------------------------------------------------

export function mountLogin(root: HTMLElement, message: string | null, onDone: () => void): () => void {
  const name = h('input', { class: 'input', type: 'text', placeholder: 'Your name', autocomplete: 'name', maxlength: 40, value: store('guestName') ?? '' })
  const code = h('input', { class: 'input', type: 'password', placeholder: 'Passcode', autocomplete: 'off', maxlength: 128 })
  const error = h('p', { class: 'error-text', role: 'alert' }, message ?? '')
  const button = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Join')
  const submit = async (): Promise<void> => {
    error.textContent = ''
    button.disabled = true
    try {
      const res = await api<{ user: typeof app.user }>('POST', '/api/auth/login', { passcode: code.value, name: name.value })
      store('guestName', name.value.trim() || null)
      app.user = res.user
      onDone()
    } catch (err) {
      error.textContent = (err as Error).message
      button.disabled = false
      code.select()
    }
  }
  clear(root)
  root.appendChild(h('div', { class: 'center-screen' },
    h('form', { class: 'login-card', onsubmit: (e: Event) => { e.preventDefault(); void submit() } },
      h('h1', null, 'LaTeX Writer'),
      h('p', { class: 'muted' }, 'Enter the passcode you were given to join the shared document.'),
      h('label', { class: 'field' }, h('span', null, 'Your name'), name),
      h('label', { class: 'field' }, h('span', null, 'Passcode'), code),
      error,
      button,
    )))
  document.title = 'Join · LaTeX Writer'
    ; (name.value ? code : name).focus()
  return () => { }
}

export function mountWaiting(root: HTMLElement, onLeave: () => void): () => void {
  clear(root)
  root.appendChild(h('div', { class: 'center-screen' },
    h('div', { class: 'login-card' },
      h('h1', null, 'LaTeX Writer'),
      h('p', null, `Hi ${app.user?.name ?? ''}. Waiting for the host to open a project…`),
      h('p', { class: 'muted' }, 'This page updates by itself as soon as they do.'),
      h('button', { class: 'btn', type: 'button', onclick: onLeave }, icon('logout'), ' Leave'),
    )))
  document.title = 'Waiting · LaTeX Writer'
  return () => { }
}
