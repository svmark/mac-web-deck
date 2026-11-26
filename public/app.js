// Mac Web Deck — browser client. No framework, no build step.
// Structure: api() → refresh loop (deck view) → editor (draft deck, saved as a whole with its revision).
const $ = selector => document.querySelector(selector);
const grid = $('#grid'), tabs = $('#pages'), result = $('#result'), connection = $('#connection');
const pairForm = $('#pair'), editOpen = $('#edit-open'), editor = $('#editor'), deckView = $('#deck-view');

let deck = null, revision = null, pageId = localStorage.getItem('page') || null;
let running = false, pendingJob = null, serverBusy = false, editing = false;

async function api(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return data;
}
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c !== null && c !== undefined));
  return node;
};
const randomId = prefix => prefix + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);

// ---------- Deck view ----------
function render() {
  $('#deck-name').textContent = deck.title;
  document.title = deck.title;
  const page = deck.pages.find(p => p.id === pageId) || deck.pages[0];
  pageId = page.id;
  tabs.replaceChildren(...deck.pages.map(p => {
    const tab = el('button', { type: 'button', textContent: p.title, className: p.id === page.id ? 'active' : '' });
    tab.setAttribute('aria-pressed', String(p.id === page.id));
    tab.addEventListener('click', () => { pageId = p.id; localStorage.setItem('page', p.id); render(); });
    return tab;
  }));
  tabs.hidden = deck.pages.length < 2;
  const tiles = page.buttons.map(b => {
    const tile = el('button', { type: 'button', className: 'tile' });
    tile.append(iconNode(b), el('span', { className: 'label', textContent: b.label }));
    if (b.hint) tile.append(el('span', { className: 'hint', textContent: b.hint }));
    tile.addEventListener('click', () => execute(b));
    return tile;
  });
  if (!tiles.length) tiles.push(el('p', { className: 'empty', textContent: 'No buttons on this page yet. Use Edit to add some.' }));
  grid.replaceChildren(...tiles);
  updateDisabled();
}
function iconNode(b) {
  const box = el('span', { className: 'icon' });
  box.setAttribute('aria-hidden', 'true');
  const fallback = () => { box.replaceChildren(b.icon || (b.label || '?').trim().charAt(0).toUpperCase()); };
  if (b.image && !b.icon) {
    const img = el('img', { src: b.image, alt: '', loading: 'lazy' });
    img.addEventListener('error', fallback);
    box.append(img);
  } else fallback();
  return box;
}
function updateDisabled() {
  const off = running || serverBusy || editing;
  grid.querySelectorAll('.tile').forEach(t => { t.disabled = off; });
  editOpen.disabled = running || serverBusy || editing;
}

async function refresh() {
  try {
    const health = await api('/api/health');
    serverBusy = health.busy;
    if (!deck || health.revision !== revision) { const data = await api('/api/deck'); deck = data; revision = data.revision; if (!editing) render(); }
    connection.textContent = '● Connected';
    connection.className = 'ok';
    pairForm.hidden = true; editOpen.hidden = false;
    if (pendingJob) {
      const job = await api(`/api/jobs/${pendingJob}`);
      result.textContent = job.message;
      if (job.state !== 'running') { pendingJob = null; running = false; }
    }
  } catch (error) {
    connection.className = '';
    connection.textContent = error.status === 401 ? 'Not paired' : 'Disconnected';
    pairForm.hidden = error.status !== 401;
    editOpen.hidden = error.status === 401;
    if (error.status === 401 || error.status === 404) { pendingJob = null; running = false; }
    if (!editing) result.textContent = error.status === 401 ? 'Enter the pairing code shown on your Mac.' : 'Cannot reach the Mac. Check that the server is running and you are on the same Wi-Fi.';
  }
  updateDisabled();
}
async function execute(button) {
  if (running) return;
  running = true; updateDisabled();
  result.textContent = `${button.label} · sending…`;
  const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
  try { pendingJob = (await api(`/api/actions/${encodeURIComponent(button.id)}`, { requestId })).jobId; await refresh(); }
  catch (error) { running = false; result.textContent = error.status ? error.message : 'Could not confirm the request reached the Mac.'; updateDisabled(); }
}
pairForm.addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/pair', { code: $('#code').value.trim() }); $('#code').value = ''; result.textContent = 'Paired. Tap a button to run it on your Mac.'; await refresh(); }
  catch (error) { result.textContent = error.message; }
});
(async function poll() { await refresh(); setTimeout(poll, 1500); })();
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });

// ---------- Editor ----------
const LIMITS = { pages: 8, buttons: 12 };
const actionLabel = a => ({
  openApp: () => `Opens ${appName(a.bundleId)}`, openPath: () => `Opens ${a.path}`, openUrl: () => `Opens ${a.url}`,
  runShortcut: () => `Runs Shortcut “${a.name}”`, screenshot: () => 'Screenshot'
}[a.type] || (() => a.type))();
let draft = null, draftRevision = null, apps = [], editingButton = null;
const appName = id => apps.find(a => a.bundleId === id)?.name || id;
const status = $('#reorder-status'), editorPages = $('#editor-pages'), message = $('#edit-message');

editOpen.addEventListener('click', async () => {
  editOpen.disabled = true;
  try {
    const [config, appList, shortcuts] = await Promise.all([api('/api/config'), api('/api/apps').catch(() => []), api('/api/shortcuts').catch(() => [])]);
    apps = appList;
    $('#apps-list').replaceChildren(...apps.map(a => el('option', { value: `${a.name} — ${a.bundleId}` })));
    $('#shortcuts-list').replaceChildren(...shortcuts.map(name => el('option', { value: name })));
    draft = structuredClone(config.deck); draftRevision = config.revision;
    openEditor();
  } catch (error) { result.textContent = error.message; updateDisabled(); }
});
function openEditor() {
  editing = true; editor.hidden = false; deckView.hidden = true; editOpen.hidden = true; message.textContent = '';
  $('#deck-title').value = draft.title;
  editorPages.replaceChildren(...draft.pages.map(pageSection));
  syncLimits();
  $('#deck-title').focus();
}
function closeEditor() { editing = false; draft = null; editor.hidden = true; deckView.hidden = false; editOpen.hidden = false; render(); }
$('#deck-title').addEventListener('input', event => { draft.title = event.target.value; });
$('#cancel').addEventListener('click', () => closeEditor());
$('#save').addEventListener('click', async () => {
  message.textContent = 'Saving…';
  try {
    await api('/api/config', { deck: draft, revision: draftRevision });
    revision = null; closeEditor(); result.textContent = 'Saved.'; await refresh();
  } catch (error) { message.textContent = error.status ? error.message : 'Could not confirm the save. Reopen the editor to check.'; }
});
$('#add-page').addEventListener('click', () => {
  const page = { id: randomId('p'), title: `Page ${draft.pages.length + 1}`, buttons: [] };
  draft.pages.push(page);
  const section = pageSection(page);
  editorPages.append(section);
  syncLimits();
  section.querySelector('input').select(); section.querySelector('input').focus();
});

const findPage = id => draft.pages.find(p => p.id === id);
function moveItem(list, index, delta) { const [item] = list.splice(index, 1); list.splice(index + delta, 0, item); }
// Move the existing node (keeps focus on the pressed control), then announce once.
function moveNode(node, delta) {
  if (delta < 0) node.parentNode.insertBefore(node, node.previousElementSibling);
  else node.parentNode.insertBefore(node, node.nextElementSibling.nextElementSibling);
}
function syncLimits() {
  $('#add-page').disabled = draft.pages.length >= LIMITS.pages;
  editorPages.querySelectorAll('.page-editor').forEach((section, i, all) => {
    const page = findPage(section.dataset.id);
    section.querySelector('.add-button').disabled = page.buttons.length >= LIMITS.buttons;
    section.querySelector('.count').textContent = `${page.buttons.length}/${LIMITS.buttons}`;
    section.querySelector('.page-up').disabled = i === 0;
    section.querySelector('.page-down').disabled = i === all.length - 1;
    section.querySelector('.page-delete').disabled = all.length === 1;
    section.querySelectorAll('li').forEach((li, j, items) => {
      li.querySelector('.up').disabled = j === 0;
      li.querySelector('.down').disabled = j === items.length - 1;
    });
  });
}
function pageSection(page) {
  const title = el('input', { value: page.title, maxLength: 40, required: true });
  title.setAttribute('aria-label', 'Page title');
  title.addEventListener('input', () => { page.title = title.value; });
  const control = (text, className, label, onClick) => { const b = el('button', { type: 'button', textContent: text, className }); b.setAttribute('aria-label', label); b.addEventListener('click', onClick); return b; };
  const section = el('section', { className: 'page-editor' });
  section.dataset.id = page.id;
  const list = el('ol', { className: 'button-list' }, ...page.buttons.map(b => buttonRow(page, b)));
  section.append(
    el('div', { className: 'page-head' }, title, el('span', { className: 'count' }),
      control('↑', 'icon-btn page-up', `Move page ${page.title} up`, () => movePage(section, -1)),
      control('↓', 'icon-btn page-down', `Move page ${page.title} down`, () => movePage(section, 1)),
      control('Delete page', 'danger page-delete', `Delete page ${page.title}`, () => deletePage(section))),
    list,
    control('+ Add button', 'secondary add-button', `Add a button to ${page.title}`, () => openButtonDialog(page, null)));
  return section;
}
function movePage(section, delta) {
  const index = draft.pages.findIndex(p => p.id === section.dataset.id);
  moveItem(draft.pages, index, delta); moveNode(section, delta); syncLimits();
  status.textContent = `Page ${findPage(section.dataset.id).title} moved to position ${index + delta + 1} of ${draft.pages.length}`;
}
function deletePage(section) {
  const page = findPage(section.dataset.id);
  if (page.buttons.length && !confirm(`Delete page “${page.title}” and its ${page.buttons.length} buttons?`)) return;
  draft.pages = draft.pages.filter(p => p !== page); section.remove(); syncLimits();
  status.textContent = `Page ${page.title} deleted`;
}
function buttonRow(page, button) {
  const li = el('li');
  li.dataset.id = button.id;
  const control = (text, className, label, onClick) => { const b = el('button', { type: 'button', textContent: text, className }); b.setAttribute('aria-label', label); b.addEventListener('click', onClick); return b; };
  const fill = () => {
    const preview = iconNode({ ...button, image: button.action.type === 'openApp' ? `/icons/${button.action.bundleId}.png` : undefined });
    li.replaceChildren(preview,
      el('span', { className: 'row-text' }, el('strong', { textContent: button.label }), el('small', { textContent: actionLabel(button.action) })),
      control('↑', 'icon-btn up', `Move ${button.label} up`, () => moveButton(li, -1)),
      control('↓', 'icon-btn down', `Move ${button.label} down`, () => moveButton(li, 1)),
      control('Edit', 'secondary', `Edit ${button.label}`, () => openButtonDialog(currentPageOf(li), button)),
      control('Delete', 'danger', `Delete ${button.label}`, () => deleteButton(li)));
  };
  fill();
  return li;
}
const currentPageOf = li => findPage(li.closest('.page-editor').dataset.id);
function moveButton(li, delta) {
  const page = currentPageOf(li), index = page.buttons.findIndex(b => b.id === li.dataset.id);
  moveItem(page.buttons, index, delta); moveNode(li, delta); syncLimits();
  status.textContent = `${page.buttons[index + delta].label} moved to position ${index + delta + 1} of ${page.buttons.length}`;
}
function deleteButton(li) {
  const page = currentPageOf(li), button = page.buttons.find(b => b.id === li.dataset.id);
  page.buttons = page.buttons.filter(b => b !== button); li.remove(); syncLimits();
  status.textContent = `${button.label} deleted`;
}

// ---------- Button dialog ----------
const dialog = $('#button-dialog'), form = $('#button-form'), typeSelect = $('#b-type'), target = $('#b-target'), dialogError = $('#b-error');
const targetFields = {
  openApp: { label: 'App', placeholder: 'Start typing an app name', list: 'apps-list', key: 'bundleId',
    help: 'Pick from the apps installed on your Mac. The app icon is added automatically.',
    read: value => {
      const m = /—\s*([\w.-]+)$/.exec(value), typed = value.trim().toLowerCase();
      if (m) return m[1];
      // Accept a typed app name (exact, or the only app starting with it) or a raw bundle id.
      const byName = apps.filter(a => a.name.toLowerCase() === typed);
      const byPrefix = apps.filter(a => a.name.toLowerCase().startsWith(typed));
      const match = byName.length === 1 ? byName[0] : byPrefix.length === 1 ? byPrefix[0] : null;
      if (match) return match.bundleId;
      return /^[\w-]+(\.[\w-]+)+$/.test(value.trim()) ? value.trim() : '';
    },
    show: id => { const a = apps.find(x => x.bundleId === id); return a ? `${a.name} — ${a.bundleId}` : id || ''; } },
  openPath: { label: 'Folder or file', placeholder: '~/Documents', key: 'path', help: 'A path on your Mac. Start with ~/ for your home folder.', read: v => v.trim(), show: v => v || '' },
  openUrl: { label: 'Web address', placeholder: 'https://', key: 'url', type: 'url', help: 'Opens in your default browser on the Mac.', read: v => v.trim(), show: v => v || '' },
  runShortcut: { label: 'Shortcut name', placeholder: 'Shortcut name', list: 'shortcuts-list', key: 'name', help: 'A shortcut from the Shortcuts app on your Mac.', read: v => v.trim(), show: v => v || '' },
  screenshot: null
};
let targetInput = null;
function renderTarget(action) {
  const spec = targetFields[typeSelect.value];
  if (!spec) { target.replaceChildren(el('p', { className: 'help', textContent: 'Opens the macOS screenshot tool. You choose the area on the Mac.' })); targetInput = null; return; }
  targetInput = el('input', { placeholder: spec.placeholder, type: spec.type || 'text', value: spec.show(action?.type === typeSelect.value ? action[spec.key] : ''), autocomplete: 'off' });
  if (spec.list) targetInput.setAttribute('list', spec.list);
  target.replaceChildren(el('label', { className: 'field' }, spec.label, targetInput), el('p', { className: 'help', textContent: spec.help }));
}
typeSelect.addEventListener('change', () => renderTarget(null));
function openButtonDialog(page, button) {
  const pageCount = draft.pages.length;
  editingButton = { page, button };
  $('#button-dialog-title').textContent = button ? 'Edit button' : 'New button';
  $('#b-label').value = button?.label || '';
  $('#b-icon').value = button?.icon || '';
  $('#b-hint').value = button?.hint || '';
  $('#b-page').replaceChildren(...draft.pages.map(p => el('option', { value: p.id, textContent: p.title, selected: p === page, disabled: p !== page && p.buttons.length >= LIMITS.buttons })));
  $('#b-page').disabled = pageCount < 2;
  typeSelect.value = button?.action.type || 'openApp';
  $('#b-label').required = typeSelect.value !== 'openApp';
  renderTarget(button?.action);
  dialogError.textContent = '';
  dialog.returnValue = '';
  dialog.showModal();
}
form.addEventListener('submit', event => {
  if (event.submitter?.value !== 'ok') return;
  const type = typeSelect.value, spec = targetFields[type];
  const action = { type };
  if (spec) {
    action[spec.key] = spec.read(targetInput.value);
    if (!action[spec.key]) { event.preventDefault(); dialogError.textContent = type === 'openApp' ? 'Pick an app from the list.' : `${spec.label} is required.`; targetInput.focus(); return; }
    if (type === 'openPath' && !/^(\/|~\/)/.test(action.path)) { event.preventDefault(); dialogError.textContent = 'The path must start with / or ~/.'; targetInput.focus(); return; }
  }
  let label = $('#b-label').value.trim();
  if (!label && type === 'openApp') label = appName(action.bundleId);
  const { page, button } = editingButton;
  const updated = { id: button?.id || randomId('b'), label, action };
  const icon = $('#b-icon').value.trim(), hint = $('#b-hint').value.trim();
  if (icon) updated.icon = icon;
  if (hint) updated.hint = hint;
  const destination = findPage($('#b-page').value) || page;
  const section = id => editorPages.querySelector(`.page-editor[data-id="${CSS.escape(id)}"]`);
  if (button && destination === page) {
    page.buttons[page.buttons.indexOf(button)] = updated;
    const li = section(page.id).querySelector(`li[data-id="${CSS.escape(button.id)}"]`);
    const fresh = buttonRow(page, updated); li.replaceWith(fresh);
  } else {
    if (button) { page.buttons = page.buttons.filter(b => b !== button); section(page.id).querySelector(`li[data-id="${CSS.escape(button.id)}"]`).remove(); }
    destination.buttons.push(updated);
    section(destination.id).querySelector('ol').append(buttonRow(destination, updated));
  }
  syncLimits();
  status.textContent = `${updated.label} ${button ? 'updated' : 'added'}. Save to apply.`;
});
// Label is optional for apps (filled from the app name), so relax "required" for that case.
typeSelect.addEventListener('change', () => { $('#b-label').required = typeSelect.value !== 'openApp'; });
dialog.addEventListener('close', () => { $('#b-label').required = true; dialog.returnValue = ''; });
