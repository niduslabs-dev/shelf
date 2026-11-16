// Shelf store: shared behaviour for every page. The home page's list comes
// from the JSON in #data, built at publish time. Listing text is untrusted
// (it comes from authors' listing.json), so it only ever reaches the page
// through textContent, never parsed as HTML.

const REACH_LEVELS = ['Own data', 'Some sites', 'All sites', 'Your browser'];
const REACH_STEPS = REACH_LEVELS.length;
const HIGH_REACH = 3;
const SETUP_KEY = 'shelf.setup-seen';
const COPY_RESET_MS = 2000;

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const plural = new Intl.PluralRules('en');

function seenSetup() {
  try {
    return localStorage.getItem(SETUP_KEY) === '1';
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    localStorage.setItem(SETUP_KEY, '1');
  } catch {
    // Private mode: ask again next time.
  }
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function meter(level) {
  const bar = el('span', { className: 'meter' + (level >= HIGH_REACH ? ' high' : '') });
  bar.setAttribute('aria-hidden', 'true');
  for (let step = 1; step <= REACH_STEPS; step++)
    bar.append(el('i', { className: step <= level ? 'on' : '' }));
  return bar;
}

function reachBlock(level) {
  const label = el('b', {}, [
    'Reach: ' + REACH_LEVELS[level - 1],
    el('span', { className: 'visually-hidden', textContent: `, step ${level} of ${REACH_STEPS}` }),
  ]);
  return el('div', { className: 'reach' + (level >= HIGH_REACH ? ' high' : '') }, [
    meter(level),
    label,
  ]);
}

/**
 * The setup dialog: shown on the first Install, or from the setup button.
 * Install is a real link to the stored .crx. Until the dialog has been seen,
 * the first click opens it instead; after that the link goes ahead, Helium
 * shows its own prompt, and the status line says where to look.
 */
function setupDialog() {
  const dialog = document.getElementById('setup');
  const go = document.getElementById('dlg-go');
  const status = document.getElementById('install-status');
  let pending = null;

  // A page can't see Helium's prompt or a refused install, so say what should
  // happen and offer the setup steps if it didn't.
  function announce(target) {
    if (!status) return;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'link-button';
    again.dataset.openSetup = '';
    again.textContent = 'Show the setup steps';
    const message = document.createElement('span');
    message.className = 'message';
    message.append(
      `Helium should now ask you to confirm ${target.dataset.name}, near the address bar. No prompt? The setting isn't on yet. `,
      again,
    );
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', () => status.replaceChildren());
    status.replaceChildren(message, close);
  }

  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-install], [data-open-setup]');
    if (!trigger) return;
    if (trigger.hasAttribute('data-install') && seenSetup()) {
      announce(trigger);
      return;
    }
    event.preventDefault();
    pending = trigger.hasAttribute('data-install') ? trigger : null;
    go.textContent = pending ? `Install ${pending.dataset.name}` : 'Done';
    dialog.showModal();
  });

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'done') return;
    markSeen();
    if (!pending) return;
    announce(pending);
    location.assign(pending.href);
  });

  const copy = document.getElementById('copy');
  const copyStatus = document.getElementById('copy-status');
  const flag = document.getElementById('flag');
  async function copyFlag() {
    try {
      await navigator.clipboard.writeText(flag.textContent);
      copyStatus.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren(flag);
      copyStatus.textContent = 'Selected. Press Command C to copy.';
    }
    copy.textContent = 'Copied';
    setTimeout(() => {
      copy.textContent = 'Copy';
      copyStatus.textContent = '';
    }, COPY_RESET_MS);
  }
  copy.addEventListener('click', () => void copyFlag());

  const params = new URLSearchParams(location.search);
  if (params.has('setup')) {
    params.delete('setup');
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params : ''));
    go.textContent = 'Done';
    dialog.showModal();
  }
}

/** The icon tile: the extension's own icon, or the first letter of its name. */
function icon(x) {
  const tile = el('span', { className: 'icon' });
  tile.setAttribute('aria-hidden', 'true');
  if (x.icon) tile.append(el('img', { src: `/icons/${x.id}.png`, alt: '' }));
  else tile.textContent = (x.name.trim()[0] ?? '?').toLocaleUpperCase('en');
  return tile;
}

/** One extension's row on the home page. */
function row(x) {
  const link = el('a', { href: `/e/${x.id}`, textContent: x.name });
  const who = el('div', { className: 'who' }, [
    el('h2', {}, [link]),
    el('p', { textContent: x.summary }),
    el('small', {
      textContent: `${x.author}, reviewed ${dateFormat.format(new Date(x.reviewed))}`,
    }),
  ]);
  const install = el('a', { className: 'install', href: x.crx, textContent: 'Install' });
  install.dataset.install = '';
  install.dataset.name = x.name;
  install.setAttribute('aria-label', `Install ${x.name} ${x.version}`);
  return el('li', { className: 'row' }, [
    icon(x),
    who,
    reachBlock(x.reach),
    el('div', { className: 'act' }, [install]),
  ]);
}

/** The home page list and its search. */
function homePage(listed) {
  const rows = document.getElementById('rows');
  const count = document.getElementById('count');
  const none = document.getElementById('none');
  const input = document.getElementById('q');

  document.getElementById('registry-empty').hidden = listed.length > 0;

  function render(query) {
    const q = query.trim().toLowerCase();
    const shown = listed.filter(
      (x) => !q || `${x.name} ${x.summary} ${x.author}`.toLowerCase().includes(q),
    );
    rows.replaceChildren(...shown.map(row));
    const searching = q !== '';
    document.getElementById('intro').hidden = searching;
    document.getElementById('list-title').textContent = searching
      ? `Results for “${query.trim()}”`
      : 'All extensions';
    count.textContent =
      shown.length === 0
        ? 'No extensions match'
        : `${shown.length} ${plural.select(shown.length) === 'one' ? 'extension' : 'extensions'}`;
    none.hidden = shown.length > 0 || listed.length === 0;
    if (listed.length === 0) count.textContent = '';
  }

  input.addEventListener('input', () => {
    const url = new URL(location.href);
    if (input.value.trim()) url.searchParams.set('q', input.value);
    else url.searchParams.delete('q');
    history.replaceState(null, '', url);
    render(input.value);
  });
  input.form.addEventListener('submit', (event) => event.preventDefault());
  document.getElementById('clear').addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  });
  input.value = new URLSearchParams(location.search).get('q') ?? '';
  render(input.value);
}

const data = document.getElementById('data');
if (data) homePage(JSON.parse(data.textContent));
setupDialog();
