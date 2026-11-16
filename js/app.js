/* PDF Creator — convert uploaded files to PDF and merge them in the order the user confirms.
   Everything runs in the browser; no file leaves the device. */
'use strict';

const VERSION = '0.2.0';
const { PDFDocument } = PDFLib;

// A4 in PDF points (1pt = 1/72 inch) and in CSS px at 96dpi
const A4 = { w: 595.28, h: 841.89 };
const PX = { w: 794, h: 1123, margin: 56 };
const IMG_MARGIN = 24;           // pt around photos on A4 pages
const RENDER_SCALE = 2;          // canvas scale for Word/Excel/text pages

const $ = (s) => document.querySelector(s);
const state = { items: [], sort: 'suggested', result: null, seq: 0 };

/* ---------- lazy libraries ---------- */
const loaded = {};
function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  return loaded[src];
}
const libs = {
  pdfjs: async () => {
    await loadScript('vendor/pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    return pdfjsLib;
  },
  mammoth: () => loadScript('vendor/mammoth.browser.min.js'),
  xlsx: () => loadScript('vendor/xlsx.full.min.js'),
  html2canvas: () => loadScript('vendor/html2canvas.min.js'),
};

/* ---------- file types ---------- */
const TYPES = {
  pdf:   { label: 'PDF',   exts: ['pdf'] },
  image: { label: 'Image', exts: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'jfif'] },
  docx:  { label: 'Word',  exts: ['docx'] },
  xlsx:  { label: 'Excel', exts: ['xlsx', 'xls', 'csv', 'ods'] },
  txt:   { label: 'Text',  exts: ['txt', 'md', 'log'] },
  html:  { label: 'Web page', exts: ['html', 'htm'] },
};
function ext(name) { const m = /\.([^.]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; }
function detectType(file) {
  const e = ext(file.name);
  for (const [k, t] of Object.entries(TYPES)) if (t.exts.includes(e)) return k;
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/')) return 'txt';
  if (e === 'doc') return 'bad-doc';
  return 'bad';
}
const BADGE = { pdf: 'PDF', image: 'IMG', docx: 'DOC', xlsx: 'XLS', txt: 'TXT', html: 'WEB', bad: '?', 'bad-doc': 'DOC' };

/* ---------- order suggestion ---------- */
// Lower group = earlier in the PDF. First matching rule wins.
const RULES = [
  { g: 0, re: /\b(cover|title|front|first)\b/i, why: 'Cover page goes first' },
  { g: 1, re: /\b(index|contents?|toc|summary|checklist)\b/i, why: 'Index / summary near the start' },
  { g: 2, re: /\b(application|form|letter|request|proposal|covering|main)\b/i, why: 'Main document before attachments' },
  { g: 4, re: /\b(kyc|aadha+r|pan ?card|pan|passport|voter|licen[cs]e|photo|id ?proof|address ?proof|selfie)\b/i, why: 'ID / KYC after the main document' },
  { g: 5, re: /\b(annex(ure)?|appendix|enclosure|attachment|supporting|schedule|exhibit)\b/i, why: 'Annexures go last' },
  { g: 6, re: /\b(last|end|back|declaration|undertaking|signature)\b/i, why: 'Closing page goes last' },
];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cleanName = (n) => n.replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ');

function classify(item) {
  const n = cleanName(item.name);
  for (const r of RULES) if (r.re.test(n)) return { group: r.g, why: r.why };
  const num = /(?:^|\D)(\d{1,3})(?:\D|$)/.exec(n);
  if (num) return { group: 3, why: 'Numbered ' + Number(num[1]) + ' in its name' };
  return { group: 3, why: null };
}
function suggestedOrder(items) {
  return [...items].sort((a, b) => {
    const ca = classify(a), cb = classify(b);
    if (ca.group !== cb.group) return ca.group - cb.group;
    return collator.compare(cleanName(a.name), cleanName(b.name)) || a.added - b.added;
  });
}
const TYPE_RANK = { pdf: 0, docx: 1, xlsx: 2, txt: 3, html: 3, image: 4 };
function applySort(kind) {
  state.sort = kind;
  const it = state.items;
  if (kind === 'suggested') state.items = suggestedOrder(it);
  else if (kind === 'name') state.items = [...it].sort((a, b) => collator.compare(a.name, b.name));
  else if (kind === 'upload') state.items = [...it].sort((a, b) => a.added - b.added);
  else if (kind === 'date') state.items = [...it].sort((a, b) => a.file.lastModified - b.file.lastModified || a.added - b.added);
  else if (kind === 'type') state.items = [...it].sort((a, b) =>
    (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) || collator.compare(a.name, b.name));
  document.querySelectorAll('.sort').forEach((b) => b.classList.toggle('active', b.dataset.sort === kind));
  renderList();
}
function askText() {
  const n = state.items.length;
  if (state.sort === 'suggested') {
    const hints = state.items.map(classify).filter((c) => c.why).length;
    return hints
      ? `I've suggested an order for your ${n} files based on their names (cover and main documents first, ID proofs and annexures last). Drag ☰ or use the arrows to change it, then tap Create PDF.`
      : `I've arranged your ${n} files by name, with numbers in natural order (2 before 10). Drag ☰ or use the arrows to change it, then tap Create PDF.`;
  }
  return 'Pages will appear in this order. Drag ☰ or use the arrows to change it, then tap Create PDF.';
}

/* ---------- adding files ---------- */
// fileList: picked/dropped files (saved to the basket here), or records already in the basket
async function addFiles(fileList, fromBasket) {
  const files = [...fileList];
  if (!files.length) return;
  let recs = fromBasket ? files : [];
  if (!fromBasket) {
    try { recs = await Basket.add(files); }
    catch { recs = files.map((f) => ({ key: Basket.newKey(), blob: f, name: f.name, lastModified: f.lastModified })); }
  }
  for (const r of recs) {
    const file = r.blob instanceof File ? r.blob : new File([r.blob], r.name, { type: r.type || r.blob.type, lastModified: r.lastModified });
    state.items.push({ id: ++state.seq, key: r.key, added: state.seq, file, name: file.name, type: detectType(file), pages: null, thumb: null, error: null });
  }
  if (state.sort === 'custom') renderList(); else applySort(state.sort);
  show('order');
  const bad = files.filter((f) => detectType(f).startsWith('bad'));
  if (bad.length) toast(`${bad.length} file(s) can't be converted and will be skipped`);
  // fill in thumbnails and page counts in the background
  for (const item of state.items) if (!item.thumbDone) { item.thumbDone = true; makeThumb(item).then(renderList).catch(() => {}); }
}

// remember the order across reloads (each share from another app reloads the page)
const ORDER_KEY = 'pdf-creator.order';
function saveOrder() {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify({ sort: state.sort, keys: state.items.map((i) => i.key) })); } catch {}
}
async function restoreBasket() {
  let recs = [];
  try { recs = await Basket.all(); } catch { return; }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); } catch {}
  if (saved && saved.sort === 'custom') {
    // keep the user's order; newly shared files go to the end
    const pos = new Map(saved.keys.map((k, i) => [k, i]));
    recs.sort((a, b) => (pos.get(a.key) ?? 1e9 + a.added) - (pos.get(b.key) ?? 1e9 + b.added));
    state.sort = 'custom';
    document.querySelectorAll('.sort').forEach((b) => b.classList.remove('active'));
  } else if (saved && saved.sort) {
    state.sort = saved.sort;
    document.querySelectorAll('.sort').forEach((b) => b.classList.toggle('active', b.dataset.sort === saved.sort));
  }
  await addFiles(recs, true);
}

async function makeThumb(item) {
  if (item.type === 'image') {
    item.thumb = URL.createObjectURL(item.file);
    item.pages = 1;
  } else if (item.type === 'pdf') {
    const pdfjs = await libs.pdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await item.file.arrayBuffer()) }).promise;
    item.pages = doc.numPages;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const scale = 120 / vp.width;
    const v = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = v.width; c.height = v.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    item.thumb = c.toDataURL('image/jpeg', 0.7);
    doc.destroy();
  }
}

/* ---------- list UI ---------- */
const ICON = {
  grip: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function size(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }

function renderList() {
  const list = $('#list');
  const n = state.items.length;
  list.innerHTML = state.items.map((it, i) => {
    const bad = it.type.startsWith('bad');
    const label = bad ? 'Not supported' : TYPES[it.type].label;
    const pages = it.pages ? ` · ${it.pages} page${it.pages > 1 ? 's' : ''}` : '';
    const c = classify(it);
    let why = '';
    if (bad) why = `<span class="why bad">${it.type === 'bad-doc' ? 'Old .doc — save as .docx or PDF' : 'Will be skipped'}</span>`;
    else if (it.error) why = `<span class="why bad">${esc(it.error)}</span>`;
    else if (state.sort === 'suggested' && c.why) why = `<span class="why">${esc(c.why)}</span>`;
    const thumb = it.thumb ? `<img src="${it.thumb}" alt="">` : (BADGE[it.type] || '?');
    const tcls = bad ? 'bad' : it.type;
    return `<li class="item${it.error ? ' error' : ''}" data-id="${it.id}">
      <div class="handle" title="Drag to reorder" aria-label="Drag to reorder">${ICON.grip}</div>
      <div class="pos">${i + 1}</div>
      <div class="thumb t-${tcls}">${thumb}</div>
      <div class="meta">
        <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="info">${label} · ${size(it.file.size)}${pages}</div>
        ${why}
      </div>
      <div class="acts">
        <button data-act="up" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button data-act="down" aria-label="Move down" ${i === n - 1 ? 'disabled' : ''}>${ICON.down}</button>
      </div>
      <button class="del" data-act="del" aria-label="Remove">${ICON.x}</button>
    </li>`;
  }).join('');
  $('#askText').textContent = n ? askText() : '';
  const good = state.items.filter((i) => !i.type.startsWith('bad'));
  $('#barCount').textContent = `${good.length} file${good.length === 1 ? '' : 's'}`;
  const known = good.every((i) => i.pages);
  const total = good.reduce((s, i) => s + (i.pages || 0), 0);
  $('#barPages').textContent = good.length ? (known ? `${total} page${total === 1 ? '' : 's'}` : `${total}+ pages`) : '';
  $('#btnCreate').disabled = !good.length;
  saveOrder();
  if (!n) show('add');
}

function move(id, delta) {
  const i = state.items.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.items.length) return;
  [state.items[i], state.items[j]] = [state.items[j], state.items[i]];
  markCustom();
  renderList();
}
function markCustom() {
  state.sort = 'custom';
  document.querySelectorAll('.sort').forEach((b) => b.classList.remove('active'));
}

$('#list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.item').dataset.id);
  if (btn.dataset.act === 'up') move(id, -1);
  else if (btn.dataset.act === 'down') move(id, 1);
  else if (btn.dataset.act === 'del') {
    const it = state.items.find((x) => x.id === id);
    if (it && it.thumb && it.thumb.startsWith('blob:')) URL.revokeObjectURL(it.thumb);
    if (it) Basket.remove(it.key).catch(() => {});
    state.items = state.items.filter((x) => x.id !== id);
    renderList();
  }
});

// drag to reorder (mouse + touch) via the grip handle
(function dragReorder() {
  const list = $('#list');
  let drag = null;
  list.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.handle');
    if (!h) return;
    e.preventDefault();
    const li = h.closest('.item');
    drag = { li, startY: e.clientY, pointerId: e.pointerId };
    h.setPointerCapture(e.pointerId);
    li.classList.add('dragging');
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { li } = drag;
    const siblings = [...list.children].filter((x) => x !== li);
    let before = null;
    for (const s of siblings) {
      const r = s.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { before = s; break; }
    }
    if (before !== li.nextElementSibling) list.insertBefore(li, before);
    // auto-scroll near the edges
    if (e.clientY < 70) window.scrollBy(0, -12);
    else if (e.clientY > innerHeight - 110) window.scrollBy(0, 12);
  });
  const end = () => {
    if (!drag) return;
    drag.li.classList.remove('dragging');
    const order = [...list.children].map((li) => Number(li.dataset.id));
    const before = state.items.map((x) => x.id).join();
    state.items = order.map((id) => state.items.find((x) => x.id === id));
    if (state.items.map((x) => x.id).join() !== before) markCustom();
    drag = null;
    renderList();
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
})();

/* ---------- conversion ---------- */
function options() {
  return {
    pageMode: document.querySelector('input[name=pageMode]:checked').value,
    maxPx: document.querySelector('input[name=quality]:checked').value === 'high' ? 2480 : 1600,
    jpegQ: document.querySelector('input[name=quality]:checked').value === 'high' ? 0.88 : 0.72,
  };
}

// Photos are redrawn through a canvas so phone EXIF rotation is respected and size is capped.
async function imageToJpeg(file, maxPx, q) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img); img.onerror = () => rej(new Error('Image could not be read'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w0 = bmp.width, h0 = bmp.height;
  const k = Math.min(1, maxPx / Math.max(w0, h0));
  const w = Math.round(w0 * k), h = Math.round(h0 * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return { bytes: await canvasJpeg(c, q), w0, h0 };
}
function canvasJpeg(c, q) {
  return new Promise((res, rej) => c.toBlob(async (b) => b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('Canvas export failed')), 'image/jpeg', q));
}

async function addImage(out, item, opt) {
  const { bytes, w0, h0 } = await imageToJpeg(item.file, opt.maxPx, opt.jpegQ);
  const img = await out.embedJpg(bytes);
  if (opt.pageMode === 'original') {
    // keep the photo's proportions; ~150 dpi page size
    const w = w0 * 72 / 150, h = h0 * 72 / 150;
    const page = out.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    return 1;
  }
  const landscape = w0 > h0;
  const pw = landscape ? A4.h : A4.w, ph = landscape ? A4.w : A4.h;
  const k = Math.min((pw - 2 * IMG_MARGIN) / w0, (ph - 2 * IMG_MARGIN) / h0);
  const w = w0 * k, h = h0 * k;
  const page = out.addPage([pw, ph]);
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  return 1;
}

async function addPdf(out, item) {
  const bytes = await item.file.arrayBuffer();
  let src;
  try { src = await PDFDocument.load(bytes, { ignoreEncryption: true }); }
  catch { throw new Error('PDF is damaged or password-protected'); }
  if (src.isEncrypted) {
    // pdf-lib can't copy encrypted content correctly; render pages as images instead
    return addPdfAsImages(out, bytes);
  }
  const pages = await out.copyPages(src, src.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  return pages.length;
}
async function addPdfAsImages(out, bytes) {
  const pdfjs = await libs.pdfjs();
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise; }
  catch { throw new Error('PDF is password-protected'); }
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 2 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const img = await out.embedJpg(await canvasJpeg(c, 0.85));
    out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  const n = doc.numPages; doc.destroy();
  return n;
}

/* Word / Excel / text: build HTML, lay it out at A4 width off-screen, pick page breaks that
   don't cut through a line, table row or picture, then snapshot each page. */
async function fileToHtml(item) {
  const t = item.type;
  if (t === 'docx') {
    await libs.mammoth();
    const r = await mammoth.convertToHtml({ arrayBuffer: await item.file.arrayBuffer() });
    return r.value || '<p><i>(This document is empty)</i></p>';
  }
  if (t === 'xlsx') {
    await libs.xlsx();
    const wb = XLSX.read(await item.file.arrayBuffer(), { type: 'array', cellDates: true });
    return wb.SheetNames.map((name) => {
      const html = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
      const body = /<table[\s\S]*<\/table>/i.exec(html);
      return `<div class="sheet-title">${esc(name)}</div>${body ? body[0] : '<p><i>(empty sheet)</i></p>'}`;
    }).join('<div style="height:18px"></div>');
  }
  if (t === 'html') {
    const doc = new DOMParser().parseFromString(await item.file.text(), 'text/html');
    doc.querySelectorAll('script,iframe,object,embed,link,meta').forEach((n) => n.remove());
    return doc.body.innerHTML;
  }
  // plain text
  const text = await item.file.text();
  return text.split(/\r?\n/).map((l) => `<div class="line">${esc(l)}</div>`).join('');
}

async function addHtmlDoc(out, item) {
  const [html] = await Promise.all([fileToHtml(item), libs.html2canvas()]);
  const stage = $('#stage');
  const contentW = PX.w - 2 * PX.margin;
  stage.innerHTML = `<div class="doc" style="width:${contentW}px">${html}</div>`;
  const doc = stage.firstElementChild;
  await waitImages(doc);

  // wide tables: widen the layout box, then shrink it to fit the page
  const fullW = Math.max(contentW, doc.scrollWidth);
  doc.style.width = fullW + 'px';
  const k = contentW / fullW;                     // shrink factor
  const pageH = (PX.h - 2 * PX.margin) / k;       // usable page height in layout px
  const totalH = doc.scrollHeight;

  // candidate break points = bottoms of leaf blocks
  const top0 = doc.getBoundingClientRect().top;
  const cuts = [...doc.querySelectorAll('p,li,tr,h1,h2,h3,h4,h5,h6,img,.line,.sheet-title,pre,blockquote,hr,div:not(:has(*))')]
    .map((el) => el.getBoundingClientRect().bottom - top0)
    .filter((y) => y > 0)
    .sort((a, b) => a - b);
  const breaks = [0];
  while (breaks[breaks.length - 1] + pageH < totalH) {
    const start = breaks[breaks.length - 1];
    const limit = start + pageH;
    let best = 0;
    for (const y of cuts) { if (y <= limit && y > start + pageH * 0.4) best = y; if (y > limit) break; }
    breaks.push(best || limit);
  }
  breaks.push(totalH);

  // move the content into a page-sized window and snapshot each slice
  stage.innerHTML = '';
  const view = document.createElement('div');
  view.className = 'page-view';
  view.style.width = fullW + 'px';
  view.appendChild(doc);
  stage.appendChild(view);
  let count = 0;
  for (let i = 0; i < breaks.length - 1; i++) {
    const y0 = breaks[i], h = Math.max(1, breaks[i + 1] - y0);
    if (h < 2 && i > 0) continue;
    view.style.height = Math.ceil(h) + 'px';
    doc.style.marginTop = -y0 + 'px';
    const shot = await html2canvas(view, { scale: RENDER_SCALE * k, backgroundColor: '#fff', logging: false, useCORS: true });
    const pageC = document.createElement('canvas');
    pageC.width = PX.w * RENDER_SCALE; pageC.height = PX.h * RENDER_SCALE;
    const ctx = pageC.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageC.width, pageC.height);
    ctx.drawImage(shot, PX.margin * RENDER_SCALE, PX.margin * RENDER_SCALE);
    const img = await out.embedJpg(await canvasJpeg(pageC, 0.9));
    out.addPage([A4.w, A4.h]).drawImage(img, { x: 0, y: 0, width: A4.w, height: A4.h });
    count++;
  }
  stage.innerHTML = '';
  return count;
}
function waitImages(root) {
  return Promise.all([...root.querySelectorAll('img')].map((img) =>
    img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; })));
}

async function createPdf() {
  const items = state.items.filter((i) => !i.type.startsWith('bad'));
  if (!items.length) return;
  const opt = options();
  const out = await PDFDocument.create();
  out.setTitle(outName());
  out.setCreator('PDF Creator');
  out.setProducer('PDF Creator ' + VERSION);
  const failed = [];
  busy(true, 'Creating your PDF…');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    it.error = null;
    busy(true, `Converting ${i + 1} of ${items.length}`, it.name, i / items.length);
    await nextFrame();
    try {
      let n;
      if (it.type === 'pdf') n = await addPdf(out, it);
      else if (it.type === 'image') n = await addImage(out, it, opt);
      else n = await addHtmlDoc(out, it);
      it.pages = n;
    } catch (err) {
      console.error(it.name, err);
      it.error = err.message || 'Could not convert';
      failed.push(it);
    }
  }
  busy(true, 'Saving PDF…', '', 1);
  await nextFrame();
  const pageCount = out.getPageCount();
  if (!pageCount) { busy(false); renderList(); toast('Nothing could be converted'); return; }
  const bytes = await out.save();
  busy(false);
  if (state.result) URL.revokeObjectURL(state.result.url);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  state.result = { blob, url: URL.createObjectURL(blob), name: outName() + '.pdf' };
  $('#doneMeta').textContent = `${state.result.name} · ${pageCount} page${pageCount === 1 ? '' : 's'} · ${size(blob.size)}`;
  const warn = $('#doneWarn');
  if (failed.length) {
    warn.innerHTML = `<b>Skipped ${failed.length} file${failed.length > 1 ? 's' : ''}:</b><ul>${failed.map((f) => `<li>${esc(f.name)} — ${esc(f.error)}</li>`).join('')}</ul>`;
    warn.classList.remove('hidden');
  } else warn.classList.add('hidden');
  const file = new File([blob], state.result.name, { type: 'application/pdf' });
  $('#btnShare').classList.toggle('hidden', !(navigator.canShare && navigator.canShare({ files: [file] })));
  renderList();
  show('done');
}
function outName() {
  return ($('#outName').value.trim() || 'Merged').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-');
}
// let the progress overlay repaint; the timeout keeps going when the app is in the background
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 60); });

/* ---------- screens & helpers ---------- */
function show(name) {
  ['add', 'order', 'done'].forEach((s) => $('#screen' + s[0].toUpperCase() + s.slice(1)).classList.toggle('active', s === name));
  $('#bar').classList.toggle('hidden', name !== 'order');
  $('#btnReset').classList.toggle('hidden', name === 'add');
  window.scrollTo({ top: 0 });
}
function busy(on, title, sub, frac) {
  $('#busy').classList.toggle('hidden', !on);
  if (!on) return;
  $('#busyTitle').textContent = title || 'Working…';
  $('#busySub').textContent = sub || '';
  $('#busyBar').style.width = Math.round((frac || 0) * 100) + '%';
}
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}
function reset() {
  state.items.forEach((it) => it.thumb && it.thumb.startsWith('blob:') && URL.revokeObjectURL(it.thumb));
  state.items = []; state.sort = 'suggested';
  Basket.clear().catch(() => {});
  document.querySelectorAll('.sort').forEach((b) => b.classList.toggle('active', b.dataset.sort === 'suggested'));
  $('#fileInput').value = '';
  renderList();
  show('add');
}

/* ---------- wiring ---------- */
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#cameraInput').addEventListener('change', (e) => {
  // camera photos all arrive as "image.jpg" — give each a unique, ordered name
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const files = [...e.target.files].map((f, i) => new File([f], `Scan ${stamp}${i ? '-' + i : ''}.jpg`, { type: f.type || 'image/jpeg', lastModified: Date.now() }));
  addFiles(files); e.target.value = '';
});
$('#btnCamera').addEventListener('click', () => $('#cameraInput').click());
$('#btnAddMore').addEventListener('click', () => $('#fileInput').click());
$('#btnScanMore').addEventListener('click', () => $('#cameraInput').click());
document.querySelector('.sorts').addEventListener('click', (e) => {
  const b = e.target.closest('.sort'); if (b) applySort(b.dataset.sort);
});
$('#btnCreate').addEventListener('click', () => createPdf().catch((err) => { busy(false); console.error(err); toast('Something went wrong: ' + err.message); }));
$('#btnDownload').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = state.result.url; a.download = state.result.name;
  document.body.appendChild(a); a.click(); a.remove();
});
$('#btnOpen').addEventListener('click', () => window.open(state.result.url, '_blank'));
$('#btnShare').addEventListener('click', async () => {
  const file = new File([state.result.blob], state.result.name, { type: 'application/pdf' });
  try { await navigator.share({ files: [file], title: state.result.name }); } catch { /* cancelled */ }
});
$('#btnBack').addEventListener('click', () => show('order'));
$('#btnNew').addEventListener('click', reset);
$('#btnReset').addEventListener('click', () => {
  if (state.items.length && !confirm('Remove all files and start over?')) return;
  reset();
});

// drag & drop files anywhere on the page
const dz = $('#dropZone');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) dz.classList.remove('over'); }));
document.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

// offline support + receiving shared files
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// on start: bring back files from the basket (including any just shared from another app)
(async () => {
  const params = new URLSearchParams(location.search);
  const shared = params.get('shared');
  if (shared !== null) history.replaceState(null, '', location.pathname);
  await restoreBasket();
  if (shared !== null) {
    const n = Number(shared);
    toast(n ? `Added ${n} shared file${n > 1 ? 's' : ''}. Share more, or check the order.` : 'Nothing to add. Share a file, not a link.');
  }
})();

// show install hint on Android Chrome before the app is installed
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('#installCard').classList.remove('hidden'); });
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => {});
  installEvt = null;
  $('#installCard').classList.add('hidden');
});
window.addEventListener('appinstalled', () => $('#installCard').classList.add('hidden'));
