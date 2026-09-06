/* This belongs to the test website. It does not implement the extension. */
const byId = id => document.getElementById(id);
const logNode = byId('log');
function log(value) {
  const line = `${new Date().toISOString()} ${JSON.stringify(value)}`;
  if (logNode) logNode.textContent = (line + '\n' + logNode.textContent).slice(0, 30000);
}
async function upload(files) {
  for (const file of files) {
    try {
      const target = byId('failUpload')?.checked ? '/fail' : '/upload';
      const res = await fetch(target, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
      log({ operation: 'raw-upload', status: res.status, result: await res.json() });
    } catch { log({ operation: 'raw-upload', error: 'connection-or-navigation-failed' }); }
  }
}
function handleInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
  const files = Array.from(input.files || []);
  log({ event: 'change', control: input.id || 'anonymous', isTrusted: event.isTrusted,
    fileCount: files.length, sizes: files.map(file => file.size), directory: input.webkitdirectory });
  if (input.id === 'reset') input.value = '';
  if (input.id === 'remove') input.remove();
  if (byId('autoUpload')?.checked) void upload(files);
  if (byId('navigate')?.checked) location.assign('/done.html');
}
document.addEventListener('change', handleInput);
byId('hiddenButton')?.addEventListener('click', () => byId('hidden').click());
byId('dynamicButton')?.addEventListener('click', () => {
  const input = document.createElement('input'); input.type = 'file';
  input.id = `dynamic-${crypto.randomUUID()}`; input.setAttribute('aria-label', '动态创建文件输入');
  byId('dynamicArea').append(input);
});
byId('syntheticButton')?.addEventListener('click', () => {
  const dt = new DataTransfer(); dt.items.add(new File(['synthetic-not-a-real-selection\n'], 'synthetic.txt', { type: 'text/plain' }));
  const input = byId('synthetic'); input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
const drop = byId('dropZone');
drop?.addEventListener('dragover', event => event.preventDefault());
drop?.addEventListener('drop', event => {
  event.preventDefault(); // This is the website's handler, not an extension interception.
  const files = Array.from(event.dataTransfer?.files || []);
  log({ event: 'drop', isTrusted: event.isTrusted, fileCount: files.length, sizes: files.map(file => file.size) });
  if (byId('dropChange').checked) {
    const input = byId('synthetic'); const dt = new DataTransfer();
    files.forEach(file => dt.items.add(file)); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (byId('autoUpload')?.checked) void upload(files);
});
byId('routeButton')?.addEventListener('click', () => {
  history.pushState({}, '', `/apply/student-example?token=DUMMY_ONLY#stage2`);
  byId('routeStatus').textContent = location.href;
});
for (const [hostId, mode] of [['openShadow', 'open'], ['closedShadow', 'closed']]) {
  const host = byId(hostId); if (!host) continue;
  const root = host.attachShadow({ mode });
  const label = document.createElement('label'); label.textContent = `${mode} Shadow DOM 文件输入 `;
  const input = document.createElement('input'); input.type = 'file'; input.id = `${mode}-shadow-input`;
  input.addEventListener('change', event => {
    log({ event: 'shadow-change', mode, isTrusted: event.isTrusted, fileCount: input.files.length });
    if (byId('autoUpload')?.checked) void upload(Array.from(input.files));
  });
  label.append(input); root.append(label);
}
const cross = byId('crossFrame');
if (cross) cross.src = `http://127.0.0.1:${location.port === '8765' ? '8766' : '8765'}/frame.html`;
byId('clearLog')?.addEventListener('click', () => { logNode.textContent = ''; });
log({ operation: 'page-ready', origin: location.origin, note: 'Use synthetic fixtures only.' });
