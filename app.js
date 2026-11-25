// Interface do Leitor de Questões (app Windows). Tudo roda localmente; o processo principal
// cuida dos arquivos (window.api, definido em preload.js).
import * as pdfjsLib from './pdf.min.mjs';
import { detectQuestions } from './detector.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

const DET_VERSION = 'd7'; // mude quando o detector mudar, para refazer o cache
const api = window.api;
const WEB = !!api.isWeb; // versão do tablet (navegador)
const SHOW = WEB ? 'Abrir' : 'Mostrar na pasta';
const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const icon = (name, cls = '') => { const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('class', 'i ' + cls); const u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s; };
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null && c !== false) n.append(c);
  return n;
};
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const REASONS = ['Errei', 'Travei', 'Conferir'];
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// toast com uma ação opcional ({ label, fn })
let toastTimer;
function toast(msg, action) {
  const t = $('#toast'); $('#toastMsg').textContent = msg;
  const b = $('#toastAct'); b.hidden = !action; t.classList.toggle('has-undo', !!action);
  if (action) { b.textContent = action.label; b.onclick = () => { action.fn(); t.classList.remove('on'); }; }
  t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), action ? 5000 : 2200);
}
const undoAction = (fn) => ({ label: 'Desfazer', fn });

// ---------- estado ----------
const S = {
  pdf: null, fp: null, name: '', path: null, det: null, questions: [], byKey: new Map(), pageEls: new Map(),
  marks: {}, libFilter: 'all', layout: ls.get('pdfLayout', 'compacto'), view: 'pdfs', viewArg: null,
  queue: null, sel: null, cur: null, hotKey: null, barKey: null, whyOpen: null, query: '', opening: false,
  // matérias: lista salva, biblioteca em memória, fila entre PDFs (mq) e filtros das telas novas
  mats: [], lib: [], mq: null, mqNav: false, rvTok: 0, pdfsFilter: 'all', showArch: false, mrevSec: 'all', mrevWhy: 'all', mrevFocus: null,
  prova: { n: 10, nf: true, rv: true, f: false, off: new Set(), timer: 0 },
};

// ---------- abrir PDF ----------
$('#openBtn').addEventListener('click', openDialog);
async function openDialog() {
  try { const r = await api.openPdfDialog(); if (r) await openPdf(r.data, r.name, r.path); }
  catch (e) { toast('Não consegui abrir esse arquivo.'); }
}
async function openPath(p, key = null, opts = {}) {
  try { const r = await api.readPdf(p); await openPdf(r.data, r.name, r.path, key, opts); }
  catch { toast('Não encontrei o arquivo. Ele foi movido ou apagado?'); showView('pdfs'); }
}
api.onOpenPath((p) => openPath(p));
['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, (e) => { e.preventDefault(); document.querySelector('.dropzone')?.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, (e) => { e.preventDefault(); document.querySelector('.dropzone')?.classList.remove('over'); }));
window.addEventListener('drop', async (e) => {
  const f = [...(e.dataTransfer?.files || [])].find(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf'); if (!f) return;
  const p = api.pathForFile(f);
  if (p) openPath(p);
  else if (api.importFile) { const r = await api.importFile(f); openPdf(r.data, r.name, r.path); }
  else openPdf(new Uint8Array(await f.arrayBuffer()), f.name, null);
});

async function openPdf(data, name, path, wantKey = null, opts = {}) {
  if (S.opening) return; S.opening = true;
  try {
    if (!S.mqNav) S.mq = null; // abrir outro PDF por fora sai da fila da matéria
    closeAsk();
    await flushMarks();
    S.view = 'book'; S.viewArg = null; $('#view').hidden = true;
    document.querySelectorAll('#navp button').forEach(b => { if (b.dataset.nav === 'book') b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    const pagesEl = $('#pages'); pagesEl.replaceChildren(el('div', { class: 'loading' }, el('div', { class: 'thinking', text: 'Abrindo o PDF…' })));
    hideBar();
    let pdf;
    try { pdf = await pdfjsLib.getDocument({ data }).promise; }
    catch { pagesEl.replaceChildren(el('div', { class: 'loading', text: 'Não consegui abrir esse arquivo como PDF.' })); return; }
    Object.assign(S, { pdf, name, path, fp: pdf.fingerprints?.[0] || name, det: null, questions: [], byKey: new Map(), sel: null, cur: null });
    shotCache.clear(); hiCache.clear();
    document.title = `${name.replace(/\.pdf$/i, '')} · Leitor de Questões`;
    const saved = await api.loadMarks(S.fp);
    S.marks = cleanMarks(saved?.marks);
    await buildPages();
    // detecção: usa o cache se já rodou para este PDF
    let det = await api.loadDetection(S.fp, DET_VERSION);
    if (!det) {
      const prog = (p) => $('#libBody').replaceChildren(el('div', { class: 'libempty' }, el('div', { class: 'thinking', text: `Procurando questões… ${Math.round(p * 100)}%` })));
      prog(0);
      const t0 = performance.now();
      det = await detectQuestions(pdf, { onProgress: prog });
      det.ms = performance.now() - t0;
      await api.saveDetection(S.fp, DET_VERSION, det);
    }
    S.det = det;
    S.questions = det.questions;
    S.questions.forEach((q, i) => { q.i = i; q.label = labelOf(q); q.where = whereOf(q); q.norm = norm(q.label + ' ' + q.text); S.byKey.set(q.key, q); });
    S.queue = makeQueue('all');
    S.cur = wantKey && S.byKey.has(wantKey) ? wantKey : S.byKey.has(saved?.cur) ? saved.cur : S.questions[0]?.key || null;
    await api.touchPdf({ fp: S.fp, path, name, pages: pdf.numPages, total: S.questions.length });
    await loadLib();
    saveStats();
    for (const pe of S.pageEls.values()) if (pe.rendered) trimPage(pe); else drawBands(pe.pn);
    renderAll();
    if (S.cur) setTimeout(() => goTo(S.byKey.get(S.cur), false), 60);
    if (opts.ask !== false) maybeAskMat();
  } finally { S.opening = false; }
}
function cleanMarks(m) { const out = {}; for (const [k, v] of Object.entries(m || {})) if (v && v.s) { const { f, ...rest } = v; out[k] = rest; } return out; }
function labelOf(q) {
  // lista que já escreve "Exercício 3" / "Problema 3" antes do número: usa a mesma palavra
  const own = (q.text.match(/^(Quest[ãa]o|Exerc[ií]cio|Problema)\s*\d/i) || [])[1];
  if (own) return `${own.charAt(0).toUpperCase() + own.slice(1).toLowerCase()} ${q.num || q.n}`;
  const g = (q.groupName || q.seriesName || '').toLowerCase();
  const sing = /problem/.test(g) ? 'Problema' : /exerc/.test(g) ? 'Exercício' : 'Questão';
  return `${sing} ${q.num || q.n}`;
}
function whereOf(q) { return [q.groupName || q.seriesName, q.section].filter(Boolean).join(' · '); }

// ---------- páginas ----------
let io;
async function buildPages() {
  const pagesEl = $('#pages'); pagesEl.replaceChildren();
  S.pageEls.clear();
  io?.disconnect();
  io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) renderPage(S.pageEls.get(+e.target.dataset.pn)); }, { root: $('#viewer'), rootMargin: '1200px 0px' });
  for (let pn = 1; pn <= S.pdf.numPages; pn++) {
    const page = await S.pdf.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const canvas = el('canvas');
    const bands = el('div', { class: 'bands' });
    const div = el('div', { class: 'page', 'data-pn': pn, style: `aspect-ratio:${vp.width}/${vp.height}` }, canvas, bands, el('span', { class: 'pno', text: pn }));
    pagesEl.append(div);
    const pe = { pn, page, W: vp.width, H: vp.height, div, canvas, bands, rendered: false, scale: 0 };
    S.pageEls.set(pn, pe);
    io.observe(div);
  }
  updateRoomy();
}
function updateRoomy() {
  const first = S.pageEls.get(1); if (!first) return;
  const side = ($('#viewer').clientWidth - first.div.clientWidth) / 2;
  $('#pages').classList.toggle('roomy', side >= 96);
}
async function renderPage(pe) {
  if (!pe) return;
  const w = pe.div.clientWidth; if (!w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const scale = (w * dpr) / pe.W;
  if (pe.rendered && Math.abs(scale - pe.scale) / scale < 0.15) return;
  if (pe.task) { try { pe.task.cancel(); } catch {} }
  const vp = pe.page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  pe.task = pe.page.render({ canvas: c, canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp });
  try { await pe.task.promise; } catch { return; }
  pe.task = null;
  pe.div.replaceChild(c, pe.canvas); pe.canvas = c;
  pe.rendered = true; pe.scale = scale;
  if (S.det) trimPage(pe);
}
let rzT;
const relayout = () => { clearTimeout(rzT); rzT = setTimeout(() => { updateRoomy(); for (const pe of S.pageEls.values()) if (pe.rendered) renderPage(pe); if (S.barKey) placeBar(S.barKey); }, 200); };
new ResizeObserver(relayout).observe($('#viewer'));
const zoomEl = $('#zoom');
zoomEl.value = ls.get('zoom', 100);
$('#pages').style.setProperty('--zoom', zoomEl.value / 100);
zoomEl.addEventListener('input', () => { $('#pages').style.setProperty('--zoom', zoomEl.value / 100); ls.set('zoom', +zoomEl.value); relayout(); });

function inkBox(canvas, s, r, { trimX = false } = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const X0 = Math.max(0, Math.floor(r.x0 * s)), X1 = Math.min(canvas.width, Math.ceil(r.x1 * s));
  const Y0 = Math.max(0, Math.floor(r.top * s)), Y1 = Math.min(canvas.height, Math.ceil(r.bottom * s));
  const w = X1 - X0, h = Y1 - Y0; if (w <= 2 || h <= 2) return null;
  const d = ctx.getImageData(X0, Y0, w, h).data;
  let top = -1, bot = -1, left = w, right = -1;
  for (let y = 0; y < h; y++) {
    let ink = false;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i] < 225 || d[i + 1] < 225 || d[i + 2] < 225) { ink = true; if (!trimX) break; if (x < left) left = x; if (x > right) right = x; }
    }
    if (ink) { if (top < 0) top = y; bot = y; }
  }
  if (top < 0) return null;
  const pad = 3;
  return {
    x0: trimX ? Math.max(r.x0, (X0 + left) / s - pad) : r.x0,
    x1: trimX ? Math.min(r.x1, (X0 + right + 1) / s + pad) : r.x1,
    top: Math.max(r.top, (Y0 + top) / s - pad), bottom: Math.min(r.bottom, (Y0 + bot + 1) / s + pad),
  };
}
function trimPage(pe) {
  for (const q of S.questions) for (const r of q.rects) {
    if (r.pn !== pe.pn || r.trimmed) continue;
    const b = inkBox(pe.canvas, pe.scale, r);
    r.trimmed = true;
    if (b) { r.top = b.top; r.bottom = b.bottom; } else r.empty = true;
  }
  drawBands(pe.pn);
}

// ---------- faixas, etiquetas e barra de ações ----------
const firstRect = (q) => q.rects.find(r => !r.empty) || q.rects[0];
const pct = (pe, r) => `left:${r.x0 / pe.W * 100}%;top:${r.top / pe.H * 100}%;width:${(r.x1 - r.x0) / pe.W * 100}%;height:${(r.bottom - r.top) / pe.H * 100}%`;
function drawBands(pn) {
  const pe = S.pageEls.get(pn); if (!pe) return;
  const keepBar = S.barKey && firstRect(S.byKey.get(S.barKey))?.pn === pn;
  pe.bands.replaceChildren();
  for (const q of S.questions) {
    const m = S.marks[q.key];
    const st = m?.s ? ' st-' + m.s : '';
    for (const r of q.rects) {
      if (r.pn !== pn || r.empty) continue;
      pe.bands.append(el('div', { class: `band ${q.i % 2 ? 'b' : 'a'}${st}${S.sel === q.key ? ' sel' : ''}${S.hotKey === q.key ? ' hot' : ''}`, 'data-key': q.key, style: pct(pe, r) }));
    }
    const fr = firstRect(q);
    if (m?.s && fr && fr.pn === pn) {
      const leftSide = (fr.x0 + fr.x1) / 2 < pe.W / 2;
      pe.bands.append(el('div', { class: `tag ${m.s} ${leftSide ? 'L' : 'R'}`, 'data-key': q.key, style: `left:${(leftSide ? fr.x0 : fr.x1) / pe.W * 100}%;top:${fr.top / pe.H * 100}%` },
        el('span', { text: m.s === 'feita' ? '✓' : '↻' }), el('span', { class: 'tx', text: m.s === 'feita' ? 'Feita' : (m.r || 'Revisar') })));
    }
    for (const f of q.figures) if (f.pn === pn) pe.bands.append(el('div', { class: 'figlink' + (S.hotKey === q.key ? ' on' : ''), 'data-fig': q.key, style: pct(pe, f) }));
  }
  if (keepBar) placeBar(S.barKey);
}

const bar = el('div', { class: 'qbar', role: 'toolbar' });
bar.addEventListener('pointerdown', (e) => e.stopPropagation());
function placeBar(key) {
  const q = S.byKey.get(key); if (!q) return hideBar();
  const r = firstRect(q); const pe = S.pageEls.get(r.pn);
  const m = S.marks[q.key] || {};
  const btn = (cls, ic, tx, fn, pressed, title) => el('button', { class: cls, 'aria-pressed': pressed === undefined ? undefined : String(!!pressed), title, 'aria-label': title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic), tx ? el('span', { class: 'tx', text: tx }) : null);
  const kids = [
    el('span', { class: 'lbl', title: q.label }, el('span', { class: 'full', text: q.label }), el('span', { class: 'short', text: q.num || q.n }), q.difficulty ? el('em', { text: '|'.repeat(q.difficulty), title: 'Dificuldade indicada pelo livro' }) : null),
    btn('b-feita', 'check', 'Feita', () => toggleDone(q), m.s === 'feita', 'Marcar como feita (F)'),
    btn('b-revisar', 'review', m.s === 'revisar' ? (m.r || 'Revisar') : 'Revisar', () => toggleReview(q), m.s === 'revisar', 'Revisar depois (V)'),
  ];
  if (S.whyOpen === q.key && m.s === 'revisar') {
    kids.push(el('span', { class: 'why' }, el('span', { text: 'Por quê?' }),
      ...REASONS.map(r => el('button', { 'aria-pressed': String(m.r === r), onclick: (e) => { e.stopPropagation(); setReason(q, m.r === r ? null : r); } }, r)),
      el('button', { title: 'Tirar da revisão', 'aria-label': 'Tirar da revisão', onclick: (e) => { e.stopPropagation(); S.whyOpen = null; setStatus(q, null); } }, '✕')));
  }
  kids.push(el('span', { class: 'sep' }), btn('', 'copy', '', () => copyShot(q), undefined, 'Copiar print da questão (P)'));
  bar.replaceChildren(...kids);
  const roomy = $('#pages').classList.contains('roomy');
  const leftSide = (r.x0 + r.x1) / 2 < pe.W / 2;
  bar.className = 'qbar' + (roomy ? ' v ' + (leftSide ? 'L' : 'R') : '');
  bar.style.left = (roomy ? (leftSide ? r.x0 : r.x1) : Math.min(r.x1, pe.W - 4)) / pe.W * 100 + '%';
  bar.style.top = r.top / pe.H * 100 + '%';
  bar.style.marginLeft = '0px';
  if (bar.parentNode !== pe.bands) pe.bands.append(bar);
  bar.hidden = false;
  S.barKey = key;
  document.querySelectorAll('.tag.hide').forEach(t => t.classList.remove('hide'));
  if (roomy) document.querySelector(`.tag[data-key="${CSS.escape(key)}"]`)?.classList.add('hide');
  if (!roomy) requestAnimationFrame(() => {
    const pr = pe.div.getBoundingClientRect(), br = bar.getBoundingClientRect();
    bar.style.marginLeft = br.left < pr.left + 4 ? (pr.left + 4 - br.left) + 'px' : '0px';
  });
}
function hideBar() { bar.hidden = true; S.barKey = null; document.querySelectorAll('.tag.hide').forEach(t => t.classList.remove('hide')); }
function setHot(key) {
  if (key === S.hotKey) return;
  document.querySelectorAll('.band.hot').forEach(b => b.classList.remove('hot'));
  document.querySelectorAll('.figlink.on').forEach(b => b.classList.remove('on'));
  S.hotKey = key;
  if (!key) return;
  document.querySelectorAll(`.band[data-key="${key}"]`).forEach(b => b.classList.add('hot'));
  document.querySelectorAll(`.figlink[data-fig="${key}"]`).forEach(b => b.classList.add('on'));
}
let leaveT;
const restBar = () => { setHot(null); if (S.sel) { if (S.barKey !== S.sel) placeBar(S.sel); } else hideBar(); };
$('#pages').addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  if (bar.contains(e.target)) { clearTimeout(leaveT); return; }
  const b = e.target.closest('.band');
  if (b) { clearTimeout(leaveT); setHot(b.dataset.key); if (S.barKey !== b.dataset.key) { S.whyOpen = null; placeBar(b.dataset.key); } return; }
  clearTimeout(leaveT); leaveT = setTimeout(restBar, 650);
});
$('#pages').addEventListener('pointerleave', (e) => { if (e.pointerType === 'touch') return; clearTimeout(leaveT); leaveT = setTimeout(restBar, 650); });
$('#pages').addEventListener('click', (e) => { const b = e.target.closest('.band'); if (b) select(b.dataset.key, { scroll: false }); });
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.band, .qbar, .side, .toast, .top, .player, .view, .menu, .backdrop, .ask')) return;
  if (S.sel) { const k = S.sel; S.sel = null; refreshKey(k); hideBar(); }
});
function select(key, { scroll = true } = {}) {
  const q = S.byKey.get(key); if (!q) return;
  const prev = S.sel; S.sel = key; S.cur = key; scheduleSave();
  if (S.queue && !S.queue.keys.includes(key)) S.queue = makeQueue('all');
  if (S.mq) { const j = S.mq.items.findIndex(x => x.fp === S.fp && x.key === key); if (j >= 0) S.mq.i = j; else S.mq = null; }
  if (prev && prev !== key) refreshKey(prev);
  refreshKey(key);
  if (S.view !== 'book') showView('book');
  if (scroll) goTo(q);
  placeBar(key);
  renderPlayer();
}
function refreshKey(key) { const q = S.byKey.get(key); if (!q) return; for (const pn of new Set(q.rects.map(r => r.pn))) drawBands(pn); }
function goTo(q, flash = true) {
  if (!q) return;
  const r = firstRect(q); const pe = S.pageEls.get(r.pn);
  const y = pe.div.offsetTop + (r.top / pe.H) * pe.div.clientHeight - 90;
  $('#viewer').scrollTo({ top: y, behavior: flash && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
  $('#side').classList.remove('open');
  if (flash) setTimeout(() => document.querySelectorAll(`.band[data-key="${q.key}"]`).forEach(b => { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }), 350);
}
const toggleDetect = $('#toggleDetect');
function applyDetect(on) { toggleDetect.setAttribute('aria-pressed', String(on)); $('#pages').classList.toggle('show-detect', on); ls.set('showDetect', on); }
applyDetect(ls.get('showDetect', true));
toggleDetect.addEventListener('click', () => applyDetect(toggleDetect.getAttribute('aria-pressed') !== 'true'));

// ---------- marcações ----------
const isDone = (k) => S.marks[k]?.s === 'feita';
const isRev = (k) => S.marks[k]?.s === 'revisar';
const doneAt = (k) => S.marks[k]?.doneAt || S.marks[k]?.t || 0;
function toggleDone(q) { setStatus(q, isDone(q.key) ? null : 'feita'); }
function toggleReview(q) {
  if (isRev(q.key)) { S.whyOpen = S.whyOpen === q.key ? null : q.key; if (S.barKey === q.key) placeBar(q.key); else setStatus(q, null); }
  else { S.whyOpen = q.key; setStatus(q, 'revisar'); }
}
function setStatus(q, s) {
  const prev = S.marks[q.key] ? { ...S.marks[q.key] } : null;
  if (!s) delete S.marks[q.key];
  else {
    const now = Date.now(); const m = { ...(prev || {}) };
    if (s === 'feita') { m.s = 'feita'; m.doneAt = now; if (prev?.s === 'revisar') m.fromReview = prev.r || 'sim'; delete m.r; }
    if (s === 'revisar') { m.s = 'revisar'; m.revAt = now; delete m.doneAt; delete m.fromReview; }
    m.t = now; S.marks[q.key] = m;
  }
  if (s !== 'revisar' && S.whyOpen === q.key) S.whyOpen = null;
  afterChange(q);
  const msg = s === 'feita' ? `${q.label} feita` : s === 'revisar' ? 'Adicionada a Para revisar' : `${q.label} desmarcada`;
  toast(msg, undoAction(() => { if (prev) S.marks[q.key] = prev; else delete S.marks[q.key]; afterChange(q); }));
}
function setReason(q, r) {
  const m = S.marks[q.key]; if (!m) return;
  if (r) m.r = r; else delete m.r;
  m.t = Date.now();
  if (S.whyOpen === q.key && r) S.whyOpen = null;
  afterChange(q);
}
function afterChange(q) {
  if (S.byKey.has(q.key)) S.cur = q.key; // a questão que você acabou de marcar vira a atual
  scheduleSave();
  refreshKey(q.key);
  if (S.barKey === q.key) placeBar(q.key);
  renderLibrary(); renderPlayer(); rerenderView();
}
// grava as marcações (e a questão atual) no arquivo do PDF
let saveT = null;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(flushMarks, 400); }
async function flushMarks() {
  if (saveT) { clearTimeout(saveT); saveT = null; }
  if (!S.fp || !S.det) return;
  try { await api.saveMarks(S.fp, S.marks, { name: S.name, cur: S.cur }); saveStats(); } catch { toast('Não consegui salvar as marcações. Confira a pasta dos dados.'); }
}
function saveStats() {
  if (!S.fp) return;
  const keys = S.questions.map(q => q.key);
  api.setStats(S.fp, { total: keys.length, done: keys.filter(isDone).length, review: keys.filter(isRev).length }).catch(() => {});
}
window.addEventListener('beforeunload', () => { if (saveT) flushMarks(); });

// ---------- listas ----------
function sections() {
  const out = [], seen = new Map();
  for (const q of S.questions) {
    const name = q.groupName || q.seriesName; const id = `sec:${q.series}:${name}`;
    if (!seen.has(id)) { const s = { id, name, keys: [] }; seen.set(id, s); out.push(s); }
    seen.get(id).keys.push(q.key);
  }
  return out;
}
function listKeys(id) {
  const all = S.questions.map(q => q.key);
  if (id === 'all') return all;
  if (id === 'revisar') return all.filter(isRev);
  if (id.startsWith('revisar:')) { const r = id.slice(8); return all.filter(k => isRev(k) && S.marks[k].r === r); }
  if (id === 'feitas') return all.filter(isDone).sort((a, b) => doneAt(b) - doneAt(a));
  if (id.startsWith('sec:')) return sections().find(s => s.id === id)?.keys || [];
  return all;
}
function listName(id) {
  if (id === 'all') return 'Capítulo inteiro';
  if (id === 'revisar') return 'Para revisar';
  if (id.startsWith('revisar:')) return id.slice(8);
  if (id === 'feitas') return 'Feitas';
  if (id.startsWith('sec:')) return id.split(':').slice(2).join(':');
  return id;
}
function makeQueue(id) { return { id, name: listName(id), keys: listKeys(id) }; }
function hashHue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const COVERS = {
  revisar: ['#ff9b52', '#b9400b', 'review'], Errei: ['#ff7a7a', '#a61b1b', null], Travei: ['#ffc94d', '#a8590a', null], Conferir: ['#70b6ff', '#1d4fc4', null],
  feitas: ['#4ee39a', '#0b6b5b', 'check'], all: ['#8b9bff', '#3a2ea8', 'book'],
};
function coverColors(id) {
  if (COVERS[id]) return COVERS[id];
  if (id.startsWith('revisar:')) return COVERS[id.slice(8)];
  const h = hashHue(id); return [`hsl(${h} 62% 58%)`, `hsl(${(h + 45) % 360} 58% 26%)`, null];
}
function coverEl(id, cls = 'cover') {
  const [a, b, ic] = coverColors(id);
  const c = el('div', { class: cls, style: `background:linear-gradient(135deg, ${a}, ${b})` });
  if (ic) c.append(icon(ic));
  else if (id.startsWith('revisar:')) c.append(el('span', { text: id.slice(8)[0] }));
  else { const ns = listKeys(id).map(k => S.byKey.get(k).n); c.append(el('span', { text: ns.length ? `${Math.min(...ns)}–${Math.max(...ns)}` : '' })); c.classList.add('text'); }
  return c;
}

// ---------- telas ----------
document.querySelectorAll('#navp button').forEach(b => b.addEventListener('click', () => { showView(b.dataset.nav); $('#side').classList.remove('open'); if (b.dataset.nav === 'search') $('#q').focus(); }));
function showView(name, arg = null) {
  if (name === 'book' && !S.pdf) name = 'pdfs';
  S.view = name; S.viewArg = arg;
  document.querySelectorAll('#navp button').forEach(b => { if (b.dataset.nav === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const v = $('#view');
  if (name === 'book') { v.hidden = true; v.replaceChildren(); renderLibrary(); return; }
  v.hidden = false; v.scrollTop = 0;
  rerenderView();
  renderLibrary();
}
async function rerenderView() {
  const v = $('#view');
  if (S.view === 'book') return;
  const tok = ++S.rvTok; // telas que leem arquivos: só a última renderização vale
  if (S.view === 'pdfs') { const st = v.scrollTop; const node = await renderPdfs(); if (tok !== S.rvTok) return; v.replaceChildren(node); v.scrollTop = st; return; }
  if (S.view === 'materia' || S.view === 'mrev') {
    const st = v.scrollTop;
    const node = S.view === 'materia' ? await renderMateria(S.viewArg) : await renderMatReview(S.viewArg);
    if (tok !== S.rvTok) return;
    v.replaceChildren(node); v.scrollTop = st; return;
  }
  if (S.view === 'home') { const st = v.scrollTop; v.replaceChildren(renderHome()); v.scrollTop = st; lazyThumbs(v); return; }
  if (!S.det) { v.replaceChildren(el('div', { class: 'empty-big' }, el('b', { text: 'Abra um PDF primeiro' }), 'Use Abrir PDF ou arraste o arquivo para a janela.')); return; }
  const st = v.scrollTop;
  if (S.view === 'search') v.replaceChildren(renderSearch());
  else if (S.view === 'list') v.replaceChildren(...renderList(S.viewArg));
  v.scrollTop = st;
  lazyThumbs(v);
}
$('#q').addEventListener('input', (e) => { S.query = e.target.value; if (S.view !== 'search') showView('search'); else rerenderView(); });
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#view .trow')?.click(); });

// Meus PDFs: biblioteca de arquivos e pasta dos dados
async function renderPdfs() {
  const [lib0, cfg] = await Promise.all([api.library(), api.settings()]);
  S.lib = lib0;
  const fid = S.pdfsFilter;
  const lib = fid === 'all' ? lib0 : fid === '__sem' ? lib0.filter(e => !matsOfFp(e.fp).length) : lib0.filter(e => matById(fid)?.pdfs.some(p => p.fp === e.fp));
  const wrap = el('div', { class: 'libview' });
  wrap.append(el('header', {},
    el('div', {}, el('h1', { text: 'Meus PDFs' }), el('p', { class: 'lede', text: 'Os livros e listas que você já abriu, com o progresso de cada um. ' + (WEB ? 'As marcações ficam guardadas neste aparelho.' : 'As marcações ficam salvas em arquivos no seu computador.') })),
    el('div', { class: 'row' },
      api.pickPdfs ? el('button', { class: 'pillbtn dark', onclick: addPdfs }, icon('download'), 'Trazer vários PDFs') : null,
      el('button', { class: 'pillbtn green', onclick: openDialog }, icon('plus'), 'Abrir PDF'))));
  const nMiss = lib0.filter(e => !e.exists).length;
  if (WEB && nMiss) wrap.append(el('div', { class: 'datacard sync misscard' },
    el('p', {}, el('b', { text: `${plural(nMiss, 'PDF está', 'PDFs estão')} sem o arquivo neste aparelho. ` }), 'As marcações já estão aqui; falta só o arquivo. Toque abaixo e escolha os PDFs (pode marcar vários de uma vez, inclusive pelo Google Drive no menu ☰ do seletor). Cada um se liga sozinho às suas marcações.'),
    el('div', { class: 'row' }, el('button', { class: 'minibtn', onclick: addPdfs }, icon('download'), 'Escolher os PDFs…'))));
  if (lib0.length && (activeMats().length || fid !== 'all')) {
    const chip = (id, t, cor) => el('button', { class: 'fchip', 'aria-pressed': String(fid === id), onclick: () => { S.pdfsFilter = fid === id ? 'all' : id; rerenderView(); } }, cor ? el('i', { class: 'dot', style: `background:${cor}` }) : null, t);
    const nSem = lib0.filter(e => !matsOfFp(e.fp).length).length;
    wrap.append(el('div', { class: 'pfilters' }, chip('all', `Todos (${lib0.length})`), ...activeMats().map(m => chip(m.id, m.nome, m.cor)), nSem ? chip('__sem', `Sem matéria (${nSem})`) : null));
  }
  if (!lib.length && lib0.length) wrap.append(el('div', { class: 'empty-big' }, el('b', { text: 'Nenhum PDF aqui' }), 'Escolha outro filtro acima.'));
  else if (!lib.length) {
    wrap.append(el('div', { class: 'drop dropzone' },
      el('strong', { text: 'Arraste um PDF para a janela' }),
      el('button', { class: 'pillbtn green', onclick: openDialog }, 'Escolher arquivo'),
      el('span', { class: 'note', text: 'Funciona melhor com PDFs que têm texto (não escaneados), como capítulos de Stewart, Knight e Halliday.' })));
  } else {
    const grid = el('div', { class: 'pdfgrid' });
    for (const e of lib) {
      const st = e.stats || {}; const tot = st.total || e.total || 0;
      const dPct = tot ? (st.done || 0) / tot * 100 : 0, rPct = tot ? (st.review || 0) / tot * 100 : 0;
      const h = hashHue(e.fp || e.name || '');
      const cover = el('div', { class: 'cover', style: `background:linear-gradient(150deg, hsl(${h} 60% 52%), hsl(${(h + 50) % 360} 55% 22%))` }, el('span', { class: 't', text: e.name.replace(/\.pdf$/i, '') }));
      const card = el('div', { class: 'pdfcard' + (e.exists ? '' : ' missing'), role: 'button', tabindex: '0', title: e.path || e.name,
        onclick: () => e.exists ? openPath(e.path) : openDialog(),
        oncontextmenu: (ev) => { ev.preventDefault(); pdfMatMenu({ x: ev.clientX, y: ev.clientY }, e); },
        onkeydown: (ev) => { if (ev.key === 'Enter') e.exists ? openPath(e.path) : openDialog(); } },
        cover,
        el('div', {}, el('b', { text: e.name.replace(/\.pdf$/i, '') }),
          el('small', { text: tot ? `${st.done || 0} de ${tot} feitas${st.review ? ` · ${st.review} a revisar` : ''}` : 'ainda sem questões' }),
          e.exists ? el('small', { text: 'aberto ' + agoLong(e.lastOpened) }) : el('span', { class: 'miss', text: 'Arquivo não encontrado. Clique para localizar.' })),
        el('div', { class: 'bar2' }, el('i', { style: `width:${dPct}%;background:var(--accent)` }), el('i', { style: `width:${rPct}%;background:var(--review)` })),
        el('button', { class: 'rm', title: 'Tirar da lista (as marcações continuam salvas)', 'aria-label': 'Tirar da lista', onclick: async (ev) => { ev.stopPropagation(); await api.removePdf(e.fp); await loadLib(); renderLibrary(); rerenderView(); } }, icon('x')),
        el('button', { class: 'rm pm', title: 'Matérias deste PDF', 'aria-label': 'Matérias deste PDF', onclick: (ev) => { ev.stopPropagation(); pdfMatMenu(ev.currentTarget, e); } }, icon('folder')),
        el('div', { class: 'mbadges' }, ...matsOfFp(e.fp).map(m => el('span', { class: 'mbadge', title: m.nome, style: `background:${m.cor};color:${inkFor(m.cor)}`, text: m.sigla || siglaOf(m.nome) }))));
      grid.append(card);
    }
    wrap.append(el('section', {}, el('h2', { text: 'Abertos recentemente' }), grid));
  }
  wrap.append(el('section', {}, el('h2', { text: 'Seus dados' }), el('div', { class: 'datacard' },
    el('p', { text: WEB ? 'As marcações, as matérias e uma cópia de cada PDF ficam guardadas dentro do Chrome deste aparelho. Use Exportar dados para ter backup ou levar para o PC. Se apagar os dados do Chrome ou desinstalar o app, isso some junto.' : 'As marcações (feitas, revisar e motivos) e a lista de PDFs ficam nesta pasta. Escolha uma pasta dentro do OneDrive ou do Google Drive para ter backup e usar em mais de um computador.' }),
    WEB ? null : el('code', { text: cfg.dataDir }),
    WEB ? null : el('div', { class: 'row' },
      el('button', { class: 'minibtn', onclick: async () => { const d = await api.chooseDataDir(); if (d) { toast('Pasta dos dados alterada'); await Promise.all([loadMats(), loadLib()]); if (S.fp) S.marks = cleanMarks((await api.loadMarks(S.fp))?.marks); renderAll(); } } }, icon('folder'), 'Mudar pasta…'),
      el('button', { class: 'minibtn', onclick: () => api.openDataDir() }, 'Abrir pasta'))),
    el('div', { class: 'datacard sync' },
      el('p', {}, el('b', { text: 'Levar para outro aparelho. ' }), 'Exporte num aparelho e importe no outro (pelo Google Drive, WhatsApp ou cabo). Ao importar, o app junta tudo: em cada questão vale a marcação mais recente, e o que você desmarcou continua desmarcado. Os PDFs em si não vão junto, só as marcações, as matérias e a lista.'),
      el('div', { class: 'row' },
        el('button', { class: 'minibtn', onclick: exportData }, icon('upload'), 'Exportar dados…'),
        el('button', { class: 'minibtn', onclick: importData }, icon('download'), 'Importar dados…')))));
  if (!matchMedia('(hover: none)').matches) wrap.append(el('section', {}, el('h2', { text: 'Atalhos' }), el('div', { class: 'kbd' },
    ...[['J', 'próxima questão'], ['K', 'questão anterior'], ['F', 'marcar como feita'], ['V', 'revisar depois'], ['P', 'copiar print'], ['Ctrl+O', 'abrir PDF'], ['Esc', 'voltar ao livro']].map(([k, t]) => el('span', {}, el('b', { text: k }), t)))));
  return wrap;
}
function agoLong(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400); return d === 1 ? 'ontem' : `há ${d} dias`;
}

// ---------- biblioteca (lateral) ----------
// em cima as matérias; embaixo as listas e seções do PDF aberto
function renderLibrary() {
  const f = S.det ? S.libFilter : 'mats';
  const fbtn = (id, t) => el('button', { class: 'fchip', 'aria-pressed': String(S.libFilter === id), onclick: () => { S.libFilter = S.libFilter === id ? 'all' : id; renderLibrary(); } }, t);
  $('#libFilters').replaceChildren(...(S.det ? [fbtn('mats', 'Matérias'), fbtn('lists', 'Listas'), fbtn('secs', 'Seções')] : []));
  const rows = [];
  const showMats = f === 'all' || f === 'mats', showPdf = S.det && f !== 'mats';
  if (showMats) {
    if (showPdf) rows.push(el('div', { class: 'lsec', text: 'Matérias' }));
    for (const m of activeMats()) {
      const st = matStats(m), pv = provaInfo(m);
      const cur = (S.view === 'materia' || S.view === 'mrev') && S.viewArg === m.id;
      rows.push(el('button', { class: 'lrow', 'aria-current': String(cur), title: m.nome,
        onclick: () => { showView('materia', m.id); $('#side').classList.remove('open'); },
        oncontextmenu: (e) => { e.preventDefault(); matMenu({ x: e.clientX, y: e.clientY }, m); } },
        matCover(m), el('div', { style: 'min-width:0' }, el('b', { class: S.mq?.matId === m.id ? 'now' : '', text: m.nome }),
          el('small', { text: `Matéria · ${plural(st.np, 'PDF', 'PDFs')}${pv && pv.n >= 0 ? ' · ' + pv.txt.toLowerCase() : ''}` })),
        st.review ? el('span', { class: 'cnt rv', title: `${st.review} para revisar`, text: st.review }) : null));
    }
    const sem = semMateria().length;
    if (sem && S.mats.length) rows.push(el('button', { class: 'lrow', 'aria-current': String(S.view === 'materia' && S.viewArg === '__sem'), onclick: () => { showView('materia', '__sem'); $('#side').classList.remove('open'); } },
      matCover(null), el('div', { style: 'min-width:0' }, el('b', { text: 'Sem matéria' }), el('small', { text: `${plural(sem, 'PDF esperando', 'PDFs esperando')} uma matéria` }))));
    if (!activeMats().length) rows.push(el('button', { class: 'lrow', onclick: () => openMatEditor() },
      el('div', { class: 'cover nomat add' }, icon('plus')), el('div', { style: 'min-width:0' }, el('b', { text: 'Criar uma matéria' }), el('small', { text: 'Junte livros, listas e provas' }))));
  }
  if (showPdf) {
    if (f === 'all') rows.push(el('div', { class: 'lsec', title: S.name, text: 'Este PDF · ' + stripPdf(S.name) }));
    const rev = listKeys('revisar'), done = listKeys('feitas');
    const row = (id, title, sub, extra) => el('button', {
      class: 'lrow', 'aria-current': String(S.view === 'list' && S.viewArg === id),
      onclick: () => { showView('list', id); $('#side').classList.remove('open'); },
    }, coverEl(id), el('div', { style: 'min-width:0' }, el('b', { class: S.queue?.id === id && !S.mq ? 'playing' : '', text: title }), el('small', { text: sub })), extra ? el('span', { class: 'cnt', text: extra }) : null);
    if (f !== 'secs') {
      rows.push(row('revisar', 'Para revisar', `Lista · ${rev.length} ${rev.length === 1 ? 'questão' : 'questões'}`));
      for (const r of REASONS) { const n = listKeys('revisar:' + r).length; if (n) rows.push(row('revisar:' + r, r, `Revisar · ${n}`)); }
      rows.push(row('feitas', 'Feitas', `Histórico · ${done.length}`));
    }
    if (f !== 'lists') for (const s of sections()) {
      const d = s.keys.filter(isDone).length;
      rows.push(row(s.id, s.name, `Seção · ${s.keys.length} questões`, `${d}/${s.keys.length}`));
    }
    if (!S.questions.length) rows.push(el('div', { class: 'libempty' }, el('b', { text: 'Nenhuma questão encontrada' }), 'Se o PDF for escaneado (sem texto), a detecção não tem o que ler.'));
  }
  $('#libBody').replaceChildren(...rows);
}
$('#newMat').addEventListener('click', () => openMatEditor());

function trackRow(q, i, listId, opts = {}) {
  const m = S.marks[q.key] || {};
  const thumb = el('div', { class: 'thumb', 'data-thumb': q.key });
  const status = m.s === 'feita' ? el('span', { class: 'spill feita', text: m.fromReview ? 'Feita · saiu da revisão' : 'Feita' })
    : m.s === 'revisar' ? el('span', { class: 'spill revisar', text: m.r || 'Revisar' }) : el('span', { class: 'spill', text: 'Falta' });
  const reasonEdit = listId?.startsWith('revisar') ? el('span', { class: 'stcell' }, ...REASONS.map(r => el('button', { class: 'spill', 'aria-pressed': String(m.r === r), onclick: (e) => { e.stopPropagation(); setReason(q, m.r === r ? null : r); } }, r))) : null;
  const when = opts.when ? new Date(doneAt(q.key)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ago(m.s === 'revisar' ? m.revAt : m.doneAt);
  const acts = el('span', { class: 'acts' },
    el('button', { class: 'iconbtn', title: m.s === 'feita' ? 'Desmarcar' : 'Marcar como feita', 'aria-label': m.s === 'feita' ? 'Desmarcar' : 'Marcar como feita', onclick: (e) => { e.stopPropagation(); toggleDone(q); } }, icon(m.s === 'feita' ? 'undo' : 'check')),
    el('button', { class: 'iconbtn', title: 'Copiar print', 'aria-label': 'Copiar print', onclick: (e) => { e.stopPropagation(); copyShot(q); } }, icon('copy')));
  return el('div', { class: 'trow' + (S.cur === q.key ? ' cur' : ''), role: 'button', tabindex: '0', onclick: () => play(listId, q.key), onkeydown: (e) => { if (e.key === 'Enter') play(listId, q.key); } },
    el('span', { class: 'num' }, el('span', { text: i + 1 }), icon('play', 'fill')),
    el('span', { class: 'ttl' }, thumb, el('span', { style: 'min-width:0' }, el('b', { text: q.label }), el('small', { text: q.where }))),
    reasonEdit || el('span', { class: 'stcell' }, status),
    el('span', { class: 'c-dd' }, q.difficulty ? el('span', { class: 'dd', title: 'Dificuldade do livro' }, ...Array.from({ length: q.difficulty }, () => el('i'))) : null),
    el('span', { class: 'when' }, el('span', { class: 'wtx', text: when || '' }), acts));
}
function lazyThumbs(root) {
  const thumbs = root.querySelectorAll('[data-thumb]'); if (!thumbs.length) return;
  const obs = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) {
      obs.unobserve(e.target);
      const q = S.byKey.get(e.target.dataset.thumb);
      shotFor(q).then(b => { const img = el('img', { alt: '' }); img.src = URL.createObjectURL(b); e.target.replaceChildren(img); }).catch(() => {});
    }
  }, { root, rootMargin: '200px' });
  thumbs.forEach(t => obs.observe(t));
}
function thead() {
  return el('div', { class: 'thead' }, el('span', { class: 'c-num', text: '#', style: 'text-align:right' }), el('span', { text: 'Questão' }), el('span', { class: 'c-st', text: 'Estado' }), el('span', { class: 'c-dd', text: 'Nível' }), el('span', { class: 'c-when', text: 'Quando', style: 'text-align:right' }));
}
function play(listId, key) {
  S.mq = null;
  S.queue = makeQueue(listId || 'all');
  if (!S.queue.keys.includes(key)) S.queue = makeQueue('all');
  select(key);
  renderLibrary();
}
function startList(id) {
  const ks = listKeys(id); if (!ks.length) return;
  play(id, id === 'feitas' ? ks[0] : (ks.find(k => !isDone(k)) || ks[0]));
}
function renderList(id) {
  const keys = listKeys(id); const qs = keys.map(k => S.byKey.get(k));
  const [a] = coverColors(id);
  const kind = id.startsWith('sec:') ? 'Seção do livro' : id === 'feitas' ? 'Histórico' : 'Lista';
  const done = keys.filter(isDone).length;
  const subParts = [el('b', { text: S.name }), ` · ${keys.length} ${keys.length === 1 ? 'questão' : 'questões'}`];
  if (id.startsWith('sec:')) subParts.push(` · ${done} feitas`);
  if (id === 'revisar') { const rs = REASONS.map(r => [r, listKeys('revisar:' + r).length]).filter(x => x[1]); if (rs.length) subParts.push(' · ' + rs.map(([r, n]) => `${r} ${n}`).join(', ')); }
  const hero = el('div', { class: 'vhero', style: `--hero:${a}` }, coverEl(id, 'cover bigcover'),
    el('div', { class: 'meta' }, el('span', { class: 'eyebrow', text: kind }), el('h1', { text: listName(id) }), el('div', { class: 'sub' }, ...subParts)));
  const act = el('div', { class: 'vact' });
  if (keys.length) act.append(el('button', { class: 'playbig', title: 'Estudar esta lista', 'aria-label': 'Estudar esta lista', onclick: () => startList(id) }, icon('play', 'fill')));
  if (id.startsWith('revisar') && keys.length) {
    const lay = (v, t) => el('button', { 'aria-pressed': String(S.layout === v), onclick: () => { S.layout = v; ls.set('pdfLayout', v); rerenderView(); } }, t);
    act.append(el('button', { class: 'pillbtn dark', id: 'genPdf', onclick: () => exportPdf(qs.map(q => ({ q, m: S.marks[q.key] || {}, shot: (s) => shotCanvas(q, s) })), S.name) }, icon('file'), `Gerar PDF (${keys.length})`),
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Disposição do PDF' }, lay('compacto', 'Compacto'), lay('pagina', 'Uma por página')),
      el('span', { class: 'vnote', id: 'pdfNote', text: 'Com as figuras anexadas.' }));
  }
  if (id === 'feitas' && keys.length) act.append(sparkline(keys));
  const tracks = el('div', { class: 'tracks' }, thead());
  if (!keys.length) {
    tracks.replaceChildren(el('div', { class: 'empty-big' }, el('b', { text: id === 'feitas' ? 'Nenhuma questão feita ainda' : 'Esta lista está vazia' }),
      id === 'feitas' ? 'Marque ✓ na barra da questão ou no botão central lá embaixo.' : 'Passe o mouse numa questão do livro e clique em ↻ para mandá-la para cá.'));
  } else if (id === 'feitas') {
    const dayKey = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    const today = dayKey(Date.now()); let cur = null;
    qs.forEach((q, i) => {
      const d = dayKey(doneAt(q.key));
      if (d !== cur) { cur = d; tracks.append(el('div', { class: 'daysep', text: d === today ? 'Hoje' : d === today - 864e5 ? 'Ontem' : new Date(d).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }) })); }
      tracks.append(trackRow(q, i, id, { when: true }));
    });
  } else qs.forEach((q, i) => tracks.append(trackRow(q, i, id)));
  return [hero, act, tracks];
}
function sparkline(keys) {
  const dayKey = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const today = dayKey(Date.now()), DAY = 864e5;
  const per = new Map(); for (const k of keys) { const d = dayKey(doneAt(k)); per.set(d, (per.get(d) || 0) + 1); }
  const days = Array.from({ length: 14 }, (_, i) => today - (13 - i) * DAY);
  const max = Math.max(1, ...days.map(d => per.get(d) || 0));
  const fmt = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return el('div', { class: 'spark', style: 'flex:1 1 240px' },
    el('div', { class: 'vnote' }, el('b', { text: per.get(today) || 0, style: 'color:var(--ink)' }), ' hoje · ', el('b', { text: days.slice(7).reduce((a, d) => a + (per.get(d) || 0), 0), style: 'color:var(--ink)' }), ' nos últimos 7 dias'),
    el('div', { class: 'bars', role: 'img', 'aria-label': 'Questões feitas por dia nos últimos 14 dias' }, ...days.map(d => { const n = per.get(d) || 0; return el('i', { class: n ? '' : 'zero', title: `${fmt(d)}: ${n}`, style: `height:${n ? Math.max(10, n / max * 100) : 6}%` }); })),
    el('div', { class: 'axis' }, el('span', { text: fmt(days[0]) }), el('span', { text: 'hoje' })));
}
function renderHome() {
  const h = new Date().getHours();
  const greet = h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const wrap = el('div', { class: 'home' }, el('h1', { text: greet }));
  const act = activeMats();
  const recent = act.map(m => ({ m, e: lastPdfOf(m) })).filter(x => x.e).sort((a, b) => (b.e.lastOpened || 0) - (a.e.lastOpened || 0)).slice(0, 6);
  if (recent.length) wrap.append(el('section', {}, el('h2', { text: 'Continuar de onde parou' }), el('div', { class: 'tiles' },
    ...recent.map(({ m, e }) => el('button', { class: 'tile', onclick: () => continueMat(m) }, matCover(m), el('span', {}, m.nome, el('small', { text: stripPdf(e.name) })), el('span', { class: 'pmini' }, icon('play', 'fill')))))));
  const arch = S.mats.filter(m => m.arquivada);
  wrap.append(el('section', {},
    el('div', { class: 'h2row' }, el('h2', { text: 'Suas matérias' }), arch.length ? el('button', { class: 'linkbtn', onclick: () => { S.showArch = !S.showArch; rerenderView(); } }, S.showArch ? 'Esconder arquivadas' : `Ver arquivadas (${arch.length})`) : null),
    el('div', { class: 'shelf mshelf' }, ...act.map(matCard),
      el('button', { class: 'card newmat', onclick: () => openMatEditor() }, el('div', { class: 'cover nomat add' }, icon('plus')), el('span', {}, el('b', { text: 'Nova matéria' }), el('small', { text: 'Junte livros, listas e provas' }))))));
  if (S.showArch && arch.length) wrap.append(el('section', {}, el('h2', { text: 'Arquivadas' }), el('div', { class: 'shelf mshelf' }, ...arch.map(matCard))));
  const sem = semMateria();
  if (sem.length && S.mats.length) wrap.append(el('div', { class: 'sembanner' }, matCover(null), el('span', {}, el('b', { text: `${plural(sem.length, 'PDF ainda sem matéria', 'PDFs ainda sem matéria')}` }), el('small', { text: sem.slice(0, 4).map(e => stripPdf(e.name)).join(' · ') + (sem.length > 4 ? ' …' : '') })),
    el('button', { class: 'pillbtn', onclick: () => showView('materia', '__sem') }, 'Organizar')));
  if (S.det) wrap.append(...renderPdfHome());
  return wrap;
}
function renderPdfHome() {
  const rev = listKeys('revisar'), done = listKeys('feitas'), n = S.questions.length;
  const nextKey = (() => { const c = S.byKey.get(S.cur); const start = c ? c.i : 0; for (let i = 0; i < n; i++) { const q = S.questions[(start + i) % n]; if (!S.marks[q.key]) return q.key; } return null; })();
  const tile = (id, title, sub, fn) => el('button', { class: 'tile', onclick: fn }, coverEl(id), el('span', {}, title, sub ? el('small', { text: sub }) : null), el('span', { class: 'pmini' }, icon('play', 'fill')));
  const tiles = el('div', { class: 'tiles' });
  if (nextKey) { const q = S.byKey.get(nextKey); tiles.append(tile('all', `Continuar: ${q.label}`, q.where, () => play('all', nextKey))); }
  tiles.append(tile('revisar', 'Para revisar', `${rev.length} ${rev.length === 1 ? 'questão' : 'questões'}`, () => showView('list', 'revisar')));
  tiles.append(tile('feitas', 'Feitas', `${done.length} no total`, () => showView('list', 'feitas')));
  for (const s of sections().slice(0, 5)) tiles.append(tile(s.id, s.name, `${s.keys.filter(isDone).length} de ${s.keys.length} feitas`, () => showView('list', s.id)));
  const shelf = el('div', { class: 'shelf' }, ...sections().map(s => el('button', { class: 'card', onclick: () => showView('list', s.id) }, coverEl(s.id), el('span', {}, el('b', { text: s.name }), el('small', { text: `${s.keys.length} questões · ${s.keys.filter(isDone).length} feitas` })), el('span', { class: 'pmini', onclick: (e) => { e.stopPropagation(); startList(s.id); } }, icon('play', 'fill')))));
  const map = el('div', { class: 'mapgrid' });
  for (const s of sections()) {
    const chips = el('div', { class: 'chips' });
    for (const k of s.keys) {
      const q = S.byKey.get(k), m = S.marks[k] || {};
      chips.append(el('button', { class: `chip${m.s === 'feita' ? ' done' : ''}${m.s === 'revisar' ? ' review' : ''}${S.cur === k ? ' cur' : ''}`, title: `${q.label}\n${q.text.replace(/^\S+\s*(\|+\s*)?/, '').slice(0, 100)}…`, onclick: () => play(s.id, k) },
        String(q.n), q.difficulty ? el('span', { class: 'dd' }, ...Array.from({ length: q.difficulty }, () => el('i'))) : null));
    }
    map.append(el('div', {}, el('h3', { text: s.name }), chips));
  }
  const figs = S.questions.reduce((a, q) => a + q.figures.length, 0), ctx = S.questions.filter(q => q.context).length;
  return [
    el('h2', { class: 'pdfh', text: 'Este PDF · ' + stripPdf(S.name) }), tiles,
    el('section', {}, el('h2', { text: 'Seções do PDF' }), shelf),
    el('section', {}, el('h2', { text: 'Mapa das questões' }), map),
    el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:var(--accent)' }), 'feita'), el('span', {}, el('i', { style: 'background:rgba(255,143,69,.18);box-shadow:inset 0 0 0 1.5px var(--review)' }), 'revisar'), el('span', {}, '••• dificuldade do livro')),
    el('div', { class: 'statline' }, el('b', { text: n }), ` questões em ${S.pdf.numPages} páginas`, S.det.ms ? `, achadas em ${Math.round(S.det.ms)} ms` : '', figs ? ` · ${figs} figuras anexadas` : '', ctx ? ` · ${ctx} com instrução comum` : '')];
}
function renderSearch() {
  const q = norm(S.query.trim());
  const wrap = el('div', { class: 'home' });
  if (!q) {
    wrap.append(el('h1', { text: 'Buscar' }), el('h2', { text: 'Navegar por lista' }),
      el('div', { class: 'browse' }, ...[['revisar', 'Para revisar'], ['feitas', 'Feitas'], ...sections().map(s => [s.id, s.name])].map(([id, name]) => {
        const [a, b] = coverColors(id); const ks = listKeys(id);
        return el('button', { class: 'bcard', style: `background:linear-gradient(135deg, ${a}, ${b})`, onclick: () => showView('list', id) }, el('span', { text: name }), el('i', { text: ks.length }));
      })));
    return wrap;
  }
  // "12", "p 12" ou "6.12" (capítulo.número, como no Sadiku)
  const num = q.match(/^(?:(?:ex|exercicio|problema|questao|q|p)\.?\s*)?(?:(\d{1,2})\.)?(\d{1,3})$/);
  const hits = S.questions.filter(x => num ? (num[1] ? x.num === `${+num[1]}.${+num[2]}` : x.n === +num[2]) : x.norm.includes(q)).slice(0, 80);
  wrap.append(el('h2', { text: hits.length ? `Resultados para “${S.query.trim()}”` : `Nada encontrado para “${S.query.trim()}”` }));
  if (hits.length) { const t = el('div', { class: 'tracks', style: 'padding:0' }, thead()); hits.forEach((x, i) => t.append(trackRow(x, i, 'all'))); wrap.append(t); }
  return wrap;
}
function ago(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return Math.round(s / 60) + ' min';
  if (s < 86400) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' d';
}

// ---------- tocando agora ----------
function renderPlayer() {
  const q = S.byKey.get(S.cur);
  const art = $('#npArt'), txt = $('#npTxt');
  if (!q) return;
  const m = S.marks[q.key] || {};
  txt.replaceChildren(el('b', { text: q.label }), el('small', { text: S.mq ? [stripPdf(S.name), q.where].filter(Boolean).join(' · ') : q.where }));
  if (art.dataset.key !== q.key) {
    art.dataset.key = q.key; art.classList.remove('blank'); art.replaceChildren();
    shotFor(q).then(b => { if (art.dataset.key !== q.key) return; const img = el('img', { alt: '' }); img.src = URL.createObjectURL(b); art.replaceChildren(img); }).catch(() => {});
  }
  $('#pDone').setAttribute('aria-pressed', String(m.s === 'feita'));
  $('#pDone').title = m.s === 'feita' ? 'Feita. Clique para desmarcar (F)' : 'Marcar como feita (F)';
  $('#pRev').classList.toggle('revon', m.s === 'revisar');
  $('#pRev').title = m.s === 'revisar' ? `Na revisão${m.r ? ' (' + m.r + ')' : ''}. Clique para tirar (V)` : 'Revisar depois (V)';
  const mq = S.mq;
  const keys = mq ? mq.items : S.queue?.keys?.length ? S.queue.keys : S.questions.map(x => x.key);
  const n = keys.length, pos = mq ? mq.i : Math.max(0, keys.indexOf(q.key));
  const stops = []; let run = null;
  keys.forEach((k, i) => {
    const s = mq ? mqStatus(k) : isDone(k) ? 'feita' : isRev(k) ? 'revisar' : null;
    const c = s === 'feita' ? '#3ad688' : s === 'revisar' ? '#ff8f45' : 'rgba(255,255,255,.16)';
    if (run && run.c === c) run.b = i + 1; else { if (run) stops.push(run); run = { c, a: i, b: i + 1 }; }
  });
  if (run) stops.push(run);
  $('#ptrack').style.background = `linear-gradient(90deg, ${stops.map(r => `${r.c} ${(r.a / n * 100).toFixed(3)}% ${(r.b / n * 100).toFixed(3)}%`).join(', ')})`;
  const knob = $('#pknob'); knob.style.left = ((pos + .5) / n * 100) + '%'; knob.classList.add('show');
  $('#pCtx').textContent = mq ? mqCtx() : `${S.queue?.name || 'Capítulo inteiro'} · ${pos + 1}`;
  $('#pCtx').title = mq ? mq.name : '';
  $('#pTot').textContent = n;
  $('#pbar').setAttribute('aria-valuenow', pos + 1); $('#pbar').setAttribute('aria-valuemax', n);
}
function step(d) {
  if (S.mq) { gotoMq(S.mq.i + d); return; }
  const keys = S.queue?.keys?.length ? S.queue.keys : S.questions.map(x => x.key);
  if (!keys.length) return;
  let i = keys.indexOf(S.cur);
  if (i < 0) { const c = S.byKey.get(S.cur); i = c ? keys.findIndex(k => S.byKey.get(k).i >= c.i) - (d > 0 ? 1 : 0) : -1; }
  select(keys[Math.max(0, Math.min(keys.length - 1, i + d))]);
}
function shuffle() {
  if (S.mq) {
    const left = S.mq.items.map((x, i) => i).filter(i => i !== S.mq.i && mqStatus(S.mq.items[i]) !== 'feita');
    if (!left.length) { toast('Todas as questões desta lista já estão feitas'); return; }
    gotoMq(left[Math.floor(Math.random() * left.length)]); return;
  }
  const keys = (S.queue?.keys || []).filter(k => !isDone(k) && k !== S.cur);
  const pool = keys.length ? keys : S.questions.map(q => q.key).filter(k => !isDone(k) && k !== S.cur);
  if (!pool.length) { toast('Todas as questões desta lista já estão feitas'); return; }
  select(pool[Math.floor(Math.random() * pool.length)]);
}
$('#pPrev').addEventListener('click', () => step(-1));
$('#pNext').addEventListener('click', () => step(1));
$('#pShuffle').addEventListener('click', shuffle);
$('#pDone').addEventListener('click', () => { const q = S.byKey.get(S.cur); if (q) toggleDone(q); });
$('#pRev').addEventListener('click', () => { const q = S.byKey.get(S.cur); if (!q) return; if (isRev(q.key)) setStatus(q, null); else { S.whyOpen = q.key; setStatus(q, 'revisar'); } });
$('#tPrint').addEventListener('click', () => { const q = S.byKey.get(S.cur); if (q) copyShot(q); });
$('#npTxt').addEventListener('click', () => { if (S.cur) select(S.cur); });
$('#npArt').addEventListener('click', () => { if (S.cur) select(S.cur); });
$('#pbar').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  if (S.mq) { gotoMq(Math.min(S.mq.items.length - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * S.mq.items.length)))); return; }
  const keys = S.queue?.keys || []; if (!keys.length) return;
  select(keys[Math.min(keys.length - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * keys.length)))]);
});
$('#pbar').addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); step(1); } if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); } });
$('#toggleSide').addEventListener('click', () => $('#side').classList.toggle('open'));
function renderAll() { renderLibrary(); renderPlayer(); rerenderView(); }

// teclado
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.menu') && e.key === 'Escape') { closeMenu(); return; }
  if (document.querySelector('.backdrop')) { if (e.key === 'Escape') closeModal(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openDialog(); return; }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === 'Escape') { if (document.activeElement === $('#q')) $('#q').blur(); if (S.view !== 'book' && S.pdf) showView('book'); else if (S.sel) { const k = S.sel; S.sel = null; refreshKey(k); hideBar(); } return; }
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey || !S.questions.length) return;
  const k = e.key.toLowerCase();
  if (k === 'j') { e.preventDefault(); step(1); return; }
  if (k === 'k') { e.preventDefault(); step(-1); return; }
  const q = S.byKey.get(S.sel || S.barKey || S.cur); if (!q) return;
  const map = { f: () => toggleDone(q), v: () => { S.whyOpen = q.key; setStatus(q, isRev(q.key) ? null : 'revisar'); }, p: () => copyShot(q) };
  if (map[k]) { e.preventDefault(); map[k](); }
});

// ---------- recortes ----------
const hiCache = new Map();
async function pageCanvasAt(pn, scale) {
  const k = pn + '@' + scale;
  if (hiCache.has(k)) return hiCache.get(k);
  const p = (async () => {
    const pe = S.pageEls.get(pn);
    const vp = pe.page.getViewport({ scale });
    const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await pe.page.render({ canvas: c, canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
    return c;
  })();
  hiCache.set(k, p);
  if (hiCache.size > 6) hiCache.delete(hiCache.keys().next().value);
  return p;
}
function whiteGap(c, s, r, xa, xb) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const X0 = Math.max(0, Math.floor(xa * s)), X1 = Math.min(c.width, Math.ceil(xb * s));
  const Y0 = Math.floor(r.top * s), Y1 = Math.ceil(r.bottom * s);
  if (X1 - X0 < 3) return null;
  const d = ctx.getImageData(X0, Y0, X1 - X0, Y1 - Y0).data, w = X1 - X0, h = Y1 - Y0;
  let best = null, start = -1;
  for (let x = 0; x <= w; x++) {
    let white = x < w;
    for (let y = 0; white && y < h; y++) { const i = (y * w + x) * 4; if (d[i] < 225 || d[i + 1] < 225 || d[i + 2] < 225) white = false; }
    if (white && start < 0) start = x;
    if (!white && start >= 0) { if (!best || x - start > best.len) best = { a: start, len: x - start }; start = -1; }
  }
  return best && best.len >= 3 ? (X0 + best.a + best.len / 2) / s : null;
}
async function shotCanvas(q, s, pageAt = pageCanvasAt) {
  const pieces = [];
  for (const r of q.rects) {
    if (r.empty) continue;
    const c = await pageAt(r.pn, s);
    const b = inkBox(c, s, r, { trimX: true }); if (b) pieces.push({ c, b });
  }
  for (const f of q.figures) {
    const c = await pageAt(f.pn, s);
    const r = { ...f };
    if (f.splitWithPrev) { const g = whiteGap(c, s, r, f.x0 - 12, f.x0 + 40); if (g) r.x0 = g; }
    if (f.splitWithNext) { const g = whiteGap(c, s, r, f.x1 - 40, f.x1 + 12); if (g) r.x1 = g; }
    const b = inkBox(c, s, r, { trimX: true }); if (b) pieces.push({ c, b, label: `Figura ${f.label} (impressa em outro ponto da página)` });
  }
  if (q.context) for (const r of q.context.rects) {
    const c = await pageAt(r.pn, s);
    const b = inkBox(c, s, r, { trimX: true }); if (b) pieces.push({ c, b, label: 'Instrução que vale para esta questão' });
  }
  if (!pieces.length) throw new Error('vazio');
  const pw = (p) => Math.round((p.b.x1 - p.b.x0) * s), ph = (p) => Math.round((p.b.bottom - p.b.top) * s);
  const k = s / 2.5, labelH = Math.round(34 * k), gap = Math.round(16 * k), margin = Math.round(20 * k);
  const W = Math.max(...pieces.map(pw)) + margin * 2;
  const H = pieces.reduce((a, p) => a + ph(p) + gap + (p.label ? labelH : 0), 0) + margin * 2 - gap;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  let y = margin;
  for (const p of pieces) {
    if (p.label) { ctx.fillStyle = '#5c6a64'; ctx.font = `600 ${Math.round(17 * k)}px "Segoe UI", system-ui, sans-serif`; ctx.fillText(p.label, margin, y + Math.round(20 * k)); y += labelH; }
    ctx.drawImage(p.c, p.b.x0 * s, p.b.top * s, pw(p), ph(p), margin, y, pw(p), ph(p));
    y += ph(p) + gap;
  }
  return out;
}
const toBlob = (c, type = 'image/png', q) => new Promise(res => c.toBlob(res, type, q));
const shotCache = new Map();
function shotFor(q) { if (!shotCache.has(q.key)) shotCache.set(q.key, shotCanvas(q, 2.5).then(c => toBlob(c))); return shotCache.get(q.key); }
async function copyShot(q) {
  try {
    const bytes = new Uint8Array(await (await shotFor(q)).arrayBuffer());
    const ok = await api.copyImage(bytes);
    const fname = `${S.name.replace(/\.pdf$/i, '')} - ${q.label}.png`;
    toast(ok ? `Print do ${q.label} copiado` : 'Não consegui copiar o print', { label: 'Salvar como…', fn: async () => { const p = await api.savePng(fname, bytes); if (p) toast(WEB ? 'Print salvo em Downloads' : 'Print salvo', { label: SHOW, fn: () => api.showInFolder(p) }); } });
  } catch { toast('Não consegui gerar o print desta questão'); }
}

// ---------- PDF de revisão ----------
// src = lista de { q, m, shot(s), where? } ou função que a monta (a da matéria abre os outros PDFs)
async function exportPdf(src, title) {
  const btn = $('#genPdf'), note = $('#pdfNote');
  if (!btn) return;
  btn.disabled = true;
  const label = btn.lastChild.textContent;
  let list = [];
  try {
    if (typeof src === 'function') btn.lastChild.textContent = 'Preparando…';
    list = typeof src === 'function' ? await src() : src;
    if (!list.length) { toast('Não achei as questões. Abra os PDFs uma vez e tente de novo.'); return; }
    const bytes = await buildReviewPdf(list, S.layout, (i) => { btn.lastChild.textContent = `Montando ${i} de ${list.length}…`; }, title);
    const date = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
    const p = await api.savePdf(`Revisão - ${stripPdf(title)} - ${date}.pdf`, bytes);
    if (p) { toast(WEB ? 'PDF de revisão salvo em Downloads' : 'PDF de revisão salvo', { label: SHOW, fn: () => api.showInFolder(p) }); if (note) note.textContent = WEB ? 'Salvo na pasta Downloads do aparelho.' : 'Salvo em ' + p; }
  } catch { toast('Não consegui montar o PDF.'); }
  finally { list.cleanup?.(); btn.disabled = false; btn.lastChild.textContent = label; }
}
async function buildReviewPdf(list, layout, onStep, title = S.name) {
  const PW = 595.28, PH = 841.89, M = 42, CW = PW - 2 * M, s = 2.6, ZOOM = 1.3;
  const F = '"Segoe UI", system-ui, sans-serif';
  const pages = []; let cur, y;
  const newPage = () => { cur = { imgs: [] }; pages.push(cur); y = M; };
  const place = async (canvas, gapAfter, zoom = 1) => {
    let dw = Math.min(CW, canvas.width / s * zoom), dh = canvas.height * dw / canvas.width;
    if (y + dh > PH - M && cur.imgs.length) newPage();
    if (dh > PH - 2 * M) { dh = PH - 2 * M; dw = canvas.width * dh / canvas.height; }
    const jpg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer());
    cur.imgs.push({ jpg, w: canvas.width, h: canvas.height, x: M, y, dw, dh });
    y += dh + gapAfter;
  };
  newPage();
  const reasons = REASONS.map(r => [r, list.filter(it => it.m?.r === r).length]).filter(x => x[1]);
  const cover = document.createElement('canvas'); cover.width = Math.round(CW * s); cover.height = Math.round(150 * s / 2);
  { const c = cover.getContext('2d'); c.scale(s / 2, s / 2); c.fillStyle = '#fff'; c.fillRect(0, 0, CW * 2, 150);
    c.fillStyle = '#1e965a'; c.fillRect(0, 0, 10, 112);
    c.fillStyle = '#111'; c.font = `700 44px ${F}`; c.fillText('Lista de revisão', 30, 48);
    c.fillStyle = '#5c6a64'; c.font = `400 24px ${F}`;
    c.fillText(`${stripPdf(title)} · ${new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })} · ${list.length} ${list.length === 1 ? 'questão' : 'questões'}`, 30, 86);
    if (reasons.length) c.fillText(reasons.map(([r, n]) => `${r}: ${n}`).join('   '), 30, 116);
    c.fillStyle = '#d3dbd7'; c.fillRect(0, 146, CW * 2, 2); }
  await place(cover, 22);
  let i = 0;
  for (const it of list) {
    const q = it.q;
    onStep?.(++i);
    if (layout === 'pagina' && i > 1) newPage();
    const shot = await it.shot(s);
    const m = it.m || {};
    const qWhere = it.where ?? q.where;
    const headH = 64, W = Math.max(shot.width, Math.round(CW * s / ZOOM));
    const block = document.createElement('canvas'); block.width = W; block.height = headH + shot.height;
    const c = block.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, block.height);
    c.fillStyle = '#111'; c.font = `700 28px ${F}`; c.fillText(q.label, 20, 34);
    const lw = c.measureText(q.label).width;
    c.fillStyle = '#5c6a64'; c.font = `400 20px ${F}`;
    let where = qWhere; const maxW = W - lw - 60 - (m.r ? 160 : 0);
    while (where && c.measureText(where).width > maxW) where = where.slice(0, -2);
    if (where !== qWhere) where = where.trimEnd() + '…';
    c.fillText(where, 20 + lw + 16, 34);
    if (m.r) {
      c.font = `700 18px ${F}`;
      const tw = c.measureText(m.r).width + 28, x = W - tw - 20;
      c.fillStyle = '#e06a1c'; roundRect(c, x, 12, tw, 30, 15); c.fill();
      c.fillStyle = '#fff'; c.fillText(m.r, x + 14, 33);
    }
    c.fillStyle = '#e3e9e6'; c.fillRect(20, 52, W - 40, 2);
    c.drawImage(shot, 0, headH);
    await place(block, layout === 'pagina' ? 0 : 26, ZOOM);
  }
  return writePdf(pages, PW, PH);
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
// escritor de PDF mínimo: páginas A4 com imagens JPEG
function writePdf(pages, PW, PH) {
  const enc = new TextEncoder(); const chunks = []; let len = 0; const offs = [];
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
  const f = (n) => (Math.round(n * 100) / 100).toString();
  let next = 3; const plan = pages.map(p => ({ page: next++, content: next++, imgs: p.imgs.map(() => next++) }));
  const total = next - 1;
  const obj = (id, ...parts) => { offs[id] = len; push(`${id} 0 obj\n`); parts.forEach(push); push('\nendobj\n'); };
  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${plan.map(p => p.page + ' 0 R').join(' ')}] >>`);
  pages.forEach((p, pi) => {
    const P = plan[pi];
    const xo = p.imgs.map((_, k) => `/Im${k} ${P.imgs[k]} 0 R`).join(' ');
    obj(P.page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(PW)} ${f(PH)}] /Resources << /XObject << ${xo} >> >> /Contents ${P.content} 0 R >>`);
    const content = p.imgs.map((im, k) => `q ${f(im.dw)} 0 0 ${f(im.dh)} ${f(im.x)} ${f(PH - im.y - im.dh)} cm /Im${k} Do Q`).join('\n');
    obj(P.content, `<< /Length ${enc.encode(content).length} >>\nstream\n`, content, '\nendstream');
    p.imgs.forEach((im, k) => obj(P.imgs[k], `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpg.length} >>\nstream\n`, im.jpg, '\nendstream'));
  });
  const xref = len;
  let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id++) x += String(offs[id]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// tablet: escolhe vários PDFs de uma vez e liga cada um às marcações que vieram do outro aparelho
async function addPdfs() {
  let files;
  try { files = await api.pickPdfs(); } catch { files = null; }
  if (!files?.length) return;
  let ligados = 0, novos = 0, erros = 0;
  for (const [i, f] of files.entries()) {
    toast(`Guardando ${i + 1} de ${files.length}: ${stripPdf(f.name)}`);
    try {
      const r = await api.importFile(f);
      const task = pdfjsLib.getDocument({ data: r.data }); const doc = await task.promise;
      const fp = doc.fingerprints?.[0] || r.name;
      const res = await api.attachPdf({ fp, path: r.path, name: r.name, pages: doc.numPages });
      task.destroy?.();
      if (res === 'ligado') ligados++; else novos++;
    } catch (err) { erros++; console.warn("addPdfs", f.name, err); }
  }
  await loadLib(); renderLibrary(); rerenderView();
  toast([ligados && `${plural(ligados, 'PDF ligado', 'PDFs ligados')} às marcações`, novos && `${plural(novos, 'PDF novo', 'PDFs novos')}`, erros && `${erros} não abriu`].filter(Boolean).join(' · ') || 'Nada mudou');
}

// ---------- levar os dados para outro aparelho ----------
async function exportData() {
  await flushMarks();
  try { const p = await api.exportData(); if (p) toast(WEB ? (p === 'compartilhado' ? 'Dados enviados' : 'Dados salvos em Downloads') : 'Dados exportados', WEB ? undefined : { label: SHOW, fn: () => api.showInFolder(p) }); }
  catch { toast('Não consegui exportar os dados.'); }
}
async function importData() {
  await flushMarks();
  let r;
  try { r = await api.importData(); } catch { toast('Não consegui importar os dados.'); return; }
  if (!r) return;
  if (r.erro) { toast(r.erro); return; }
  await Promise.all([loadMats(), loadLib()]);
  if (S.fp) S.marks = cleanMarks((await api.loadMarks(S.fp))?.marks);
  renderAll(); rerenderView();
  const partes = [];
  if (r.marcacoes) partes.push(`${plural(r.marcacoes, 'questão atualizada', 'questões atualizadas')} em ${plural(r.pdfs, 'PDF', 'PDFs')}`);
  if (r.pdfsNovos) partes.push(plural(r.pdfsNovos, 'PDF novo na lista', 'PDFs novos na lista'));
  if (r.materiasNovas) partes.push(plural(r.materiasNovas, 'matéria nova', 'matérias novas'));
  if (r.materiasAtualizadas) partes.push(plural(r.materiasAtualizadas, 'matéria atualizada', 'matérias atualizadas'));
  if (r.materiasRemovidas) partes.push(plural(r.materiasRemovidas, 'matéria excluída', 'matérias excluídas'));
  toast(partes.length ? 'Importado: ' + partes.join(' · ') : 'Nada novo: os dois aparelhos já estavam iguais', { label: 'Ok', fn: () => {} });
}

// ---------- matérias (playlists de PDFs) ----------
// Uma matéria junta PDFs (livros, listas, provas) da mesma disciplina. Fica em biblioteca.json → materias.
// As marcações continuam por PDF; a matéria só guarda quais PDFs fazem parte e em que seção.
const MAT_COLORS = [['#3b7ddd', '#ffffff', 'Azul'], ['#e3a72f', '#1c1300', 'Âmbar'], ['#c4527f', '#ffffff', 'Rosa'], ['#7a6cf0', '#ffffff', 'Roxo'], ['#2f9e6b', '#ffffff', 'Verde'], ['#d5544a', '#ffffff', 'Vermelho'], ['#2aa6b8', '#04181c', 'Ciano'], ['#6d7873', '#ffffff', 'Cinza']];
const DEFAULT_SECS = ['Livros', 'Listas', 'Provas e simulados'];
const inkFor = (cor) => (MAT_COLORS.find(c => c[0] === cor) || [cor, '#ffffff'])[1];
const matById = (id) => S.mats.find(m => m.id === id);
const matsOfFp = (fp) => S.mats.filter(m => m.pdfs.some(p => p.fp === fp));
const activeMats = () => S.mats.filter(m => !m.arquivada);
const libEntry = (fp) => S.lib.find(e => e.fp === fp);
const stripPdf = (n) => (n || '').replace(/\.pdf$/i, '');
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function fixMat(m) { return { ...m, secoes: Array.isArray(m.secoes) ? m.secoes : [], pdfs: Array.isArray(m.pdfs) ? m.pdfs.filter(p => p && p.fp) : [] }; }
async function loadMats() { try { const l = await api.materias(); S.mats = Array.isArray(l) ? l.filter(m => m && m.id).map(fixMat) : []; } catch { S.mats = []; } }
async function loadLib() { try { S.lib = await api.library(); } catch { S.lib = S.lib || []; } return S.lib; }
async function saveMats(msg, undo) {
  try { await api.saveMaterias(S.mats); } catch { toast('Não consegui salvar as matérias. Confira a pasta dos dados.'); return false; }
  if (msg) toast(msg, undo ? undoAction(undo) : undefined);
  renderLibrary(); rerenderView();
  return true;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
function siglaOf(nome) {
  const ws = (nome || '').trim().split(/\s+/).filter(w => w && !/^(de|da|do|das|dos|e|a|o|para|em)$/i.test(w));
  let out = '';
  for (const w of ws) {
    const r = ROMAN[w.toLowerCase()];
    out += r ? String(r) : /^\d+$/.test(w) ? w : w[0];
    if (out.length >= 3) break;
  }
  return out.toUpperCase().slice(0, 3);
}
function provaInfo(m) {
  if (!m?.prova) return null;
  const d = new Date(m.prova + 'T00:00:00'); if (isNaN(d)) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const n = Math.round((d - t) / 864e5);
  const txt = n === 0 ? 'Prova hoje' : n === 1 ? 'Prova amanhã' : n > 1 ? `Prova em ${n} dias` : `Prova foi em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`;
  return { n, txt, soon: n >= 0 && n <= 7 };
}
function matCover(m, cls = 'cover') {
  if (!m) return el('div', { class: cls + ' nomat' }, icon('file'));
  return el('div', { class: cls + ' mcover', style: `background:${m.cor || '#6d7873'};color:${inkFor(m.cor)}` }, el('span', { text: m.sigla || siglaOf(m.nome) || '?' }));
}
function pdfStats(e) {
  if (e.fp === S.fp && S.det) { const ks = S.questions.map(q => q.key); return { total: ks.length, done: ks.filter(isDone).length, review: ks.filter(isRev).length }; }
  const st = e.stats || {}; return { total: st.total || e.total || 0, done: st.done || 0, review: st.review || 0 };
}
function matStats(m) {
  const ents = m.pdfs.map(p => libEntry(p.fp)).filter(Boolean);
  const o = { np: ents.length, total: 0, done: 0, review: 0 };
  for (const e of ents) { const s = pdfStats(e); o.total += s.total; o.done += s.done; o.review += s.review; }
  o.pct = o.total ? Math.round(o.done / o.total * 100) : 0;
  return o;
}
const semMateria = () => S.lib.filter(e => !matsOfFp(e.fp).length);

// sugestão de matéria pelo nome do arquivo: palavras em comum com o nome da matéria e dos PDFs dela
// (zill, bussab, itens separados…). Palavras genéricas como "lista" e "prova" contam pouco; a sigla
// da matéria também vale (P1_C4_2025 → C4).
const WEAKW = new Set(['lista', 'listas', 'prova', 'provas', 'fixacao', 'revisao', 'gabarito', 'simulado', 'resolvida', 'resolvidos']);
const STOPW = new Set(['exercicios', 'exercicio', 'texto', 'pdf', 'cap', 'capitulo', 'problemas', 'problema', 'questoes', 'questao', 'para', 'com', 'dos', 'das', 'secao', 'enunciados']);
const rawToks = (s) => norm(stripPdf(s || '')).split(/[^a-z0-9]+/).filter(Boolean);
function toks(s) { return new Set(rawToks(s).filter(t => t.length >= 3 && !STOPW.has(t) && !/^\d+$/.test(t))); }
function matScore(m, name) {
  const want = toks(name);
  const have = toks(m.nome);
  for (const p of m.pdfs) { const e = libEntry(p.fp); if (e && e.name !== name) for (const t of toks(e.name)) have.add(t); }
  let n = 0; for (const t of want) if (have.has(t)) n += WEAKW.has(t) ? 0.4 : 1;
  const sg = (m.sigla || '').toLowerCase();
  if (sg.length >= 2 && /\d/.test(sg) && rawToks(name).includes(sg)) n += 1;
  return n >= 1 ? n : 0;
}
function bestMat(name) { let best = null, sc = 0; for (const m of activeMats()) { const s = matScore(m, name); if (s > sc) { sc = s; best = m; } } return best; }
function guessSec(secs, name) {
  if (!secs?.length) return null;
  const n = norm(name || '');
  const find = (re) => secs.find(s => re.test(norm(s)));
  if (/prova|simulado|gabarito|^p\d|^pf|_p\d|teste/.test(n)) return find(/prova|simulad|teste/) || null;
  if (/lista|fixacao|^af\d/.test(n)) return find(/lista/) || null;
  return find(/livro|texto|teoria/) || secs[0];
}

// continuar de onde parou: o PDF da matéria aberto por último, na questão em que você estava
function lastPdfOf(m) { return m.pdfs.map(p => libEntry(p.fp)).filter(e => e && e.exists).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0] || null; }
async function continueMat(m) {
  const e = lastPdfOf(m);
  if (!e) { toast('Nenhum PDF desta matéria foi encontrado no computador.'); return; }
  S.mq = null;
  if (e.fp === S.fp && S.det) { showView('book'); if (S.cur) select(S.cur); return; }
  await openPath(e.path, null, { ask: false });
}
async function continueLabel(m) {
  const e = lastPdfOf(m); if (!e) return null;
  if (e.fp === S.fp && S.det) { const q = S.byKey.get(S.cur); return `${stripPdf(e.name)} · ${q ? q.label : 'início'}`; }
  try {
    const [mk, det] = await Promise.all([api.loadMarks(e.fp), api.loadDetection(e.fp, DET_VERSION)]);
    const q = det?.questions?.find(x => x.key === mk?.cur);
    return `${stripPdf(e.name)}${q ? ' · ' + labelOf(q) : ''}`;
  } catch { return stripPdf(e.name); }
}
// marcações e detecção de cada PDF da matéria (a detecção só existe para PDFs já abertos nesta versão)
async function matData(m) {
  const ents = m.pdfs.map(p => ({ p, e: libEntry(p.fp) })).filter(x => x.e);
  return Promise.all(ents.map(async ({ p, e }) => {
    if (e.fp === S.fp && S.det) return { e, sec: p.sec, marks: S.marks, det: S.det };
    const [mk, det] = await Promise.all([api.loadMarks(e.fp).catch(() => null), api.loadDetection(e.fp, DET_VERSION).catch(() => null)]);
    return { e, sec: p.sec, marks: cleanMarks(mk?.marks), det };
  }));
}
function qInfo(d, key) {
  const q = d.det?.questions?.find(x => x.key === key);
  return q ? { label: labelOf(q), where: whereOf(q), i: q.i ?? d.det.questions.indexOf(q) } : { label: 'Questão ' + String(key).split(':').pop(), where: '', i: 0 };
}

// ---------- menus e janelas ----------
function closeMenu() { document.querySelector('.menu')?.remove(); }
function openMenu(anchor, items) {
  closeMenu();
  const menu = el('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) { menu.append(el('div', { class: 'msep' })); continue; }
    if (it.head) { menu.append(el('div', { class: 'mhead', text: it.head })); continue; }
    menu.append(el('button', { role: it.checked === undefined ? 'menuitem' : 'menuitemcheckbox', 'aria-checked': it.checked === undefined ? undefined : String(!!it.checked), class: it.danger ? 'danger' : '', onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick(); } },
      it.color ? el('i', { class: 'sw', style: `background:${it.color}` }) : null, el('span', { text: it.label }), it.checked ? icon('check', 'ck') : null));
  }
  document.body.append(menu);
  const pt = !anchor.getBoundingClientRect;
  const r = pt ? { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y } : anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = pt ? r.left : r.right - mw;
  if (x + mw > innerWidth - 8) x = innerWidth - mw - 8;
  if (x < 8) x = 8;
  let y = r.bottom + (pt ? 2 : 6); if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.querySelector('button')?.focus();
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
function closeModal() { document.querySelector('.backdrop')?.remove(); }
function openModal(node) {
  closeModal(); closeMenu();
  const b = el('div', { class: 'backdrop', onpointerdown: (e) => { if (e.target === b) closeModal(); } }, node);
  document.body.append(b);
  return b;
}

function matMenu(anchor, m) {
  openMenu(anchor, [
    { label: 'Editar matéria…', onClick: () => openMatEditor(m) },
    { label: 'Escolher PDFs…', onClick: () => openMatEditor(m, { focusPdfs: true }) },
    { label: m.arquivada ? 'Desarquivar' : 'Arquivar (fim do semestre)', onClick: () => { m.arquivada = !m.arquivada; m.atualizada = Date.now(); saveMats(m.arquivada ? `${m.nome} arquivada` : `${m.nome} voltou para a lateral`, () => { m.arquivada = !m.arquivada; saveMats(); }); } },
    { sep: true },
    { label: 'Excluir matéria', danger: true, onClick: () => {
      const i = S.mats.indexOf(m); if (i < 0) return;
      S.mats.splice(i, 1);
      if ((S.view === 'materia' || S.view === 'mrev') && S.viewArg === m.id) showView('home');
      saveMats(`${m.nome} excluída. Os PDFs e as marcações continuam.`, () => { S.mats.splice(i, 0, m); saveMats(); });
    } },
  ]);
}
function addPdfToMat(m, fp, name) {
  if (m.pdfs.some(p => p.fp === fp)) return;
  const prev = m.pdfs.map(p => ({ ...p }));
  m.pdfs.push({ fp, sec: guessSec(m.secoes, name || libEntry(fp)?.name) });
  m.atualizada = Date.now();
  saveMats(`Adicionado a ${m.nome}`, () => { m.pdfs = prev; saveMats(); });
}
function removePdfFromMat(m, fp) {
  const prev = m.pdfs.map(p => ({ ...p }));
  m.pdfs = m.pdfs.filter(p => p.fp !== fp); m.atualizada = Date.now();
  saveMats(`Tirado de ${m.nome}`, () => { m.pdfs = prev; saveMats(); });
}
function pdfMatMenu(anchor, entry) {
  const items = [{ head: 'Matérias deste PDF' }];
  for (const m of activeMats()) { const on = m.pdfs.some(p => p.fp === entry.fp); items.push({ label: m.nome, color: m.cor, checked: on, onClick: () => on ? removePdfFromMat(m, entry.fp) : addPdfToMat(m, entry.fp, entry.name) }); }
  items.push({ sep: true }, { label: 'Nova matéria…', onClick: () => openMatEditor(null, { preselect: entry.fp }) });
  if (entry.exists && !WEB) items.push({ label: 'Mostrar na pasta', onClick: () => api.showInFolder(entry.path) });
  openMenu(anchor, items);
}
function pdfRowMenu(anchor, e, m) {
  if (!m) return pdfMatMenu(anchor, e);
  const items = [];
  const p = m.pdfs.find(x => x.fp === e.fp);
  if (m.secoes.length && p) {
    items.push({ head: 'Seção nesta matéria' });
    for (const s of m.secoes) items.push({ label: s, checked: p.sec === s, onClick: () => { p.sec = s; m.atualizada = Date.now(); saveMats(); } });
    items.push({ sep: true });
  }
  items.push({ label: 'Tirar desta matéria', onClick: () => removePdfFromMat(m, e.fp) });
  items.push({ label: 'Outras matérias…', onClick: () => setTimeout(() => pdfMatMenu(anchor, e), 0) });
  if (e.exists && !WEB) items.push({ label: 'Mostrar na pasta', onClick: () => api.showInFolder(e.path) });
  openMenu(anchor, items);
}

// ---------- perguntar a matéria ao abrir um PDF novo ----------
function closeAsk() { document.querySelector('.ask')?.remove(); }
function dismissAsk(fp) { const d = ls.get('matDispensados', []); if (!d.includes(fp)) { d.push(fp); ls.set('matDispensados', d.slice(-500)); } closeAsk(); }
function maybeAskMat() {
  closeAsk();
  if (!S.fp || matsOfFp(S.fp).length || ls.get('matNaoPerguntar', false) || ls.get('matDispensados', []).includes(S.fp)) return;
  const fp = S.fp, name = S.name;
  const sug = bestMat(name);
  const others = activeMats().filter(m => m !== sug);
  const pick = (m) => { closeAsk(); addPdfToMat(m, fp, name); };
  const card = el('section', { class: 'ask', role: 'dialog', 'aria-label': 'Escolher a matéria deste PDF' },
    el('button', { class: 'iconbtn x', 'aria-label': 'Fechar', title: 'Fechar', onclick: () => dismissAsk(fp) }, icon('x')),
    el('div', { class: 'ask-h' }, el('b', { text: 'Em qual matéria fica este PDF?' }), el('small', { text: `${stripPdf(name)} · ${plural(S.questions.length, 'questão encontrada', 'questões encontradas')}` })),
    sug ? el('button', { class: 'ask-sug', onclick: () => pick(sug) }, matCover(sug), el('span', {}, el('b', { text: sug.nome }), el('small', { text: 'Sugerida pelo nome do arquivo' }))) : null,
    el('div', { class: 'ask-chips' },
      ...others.map(m => el('button', { class: 'mchip', onclick: () => pick(m) }, el('i', { style: `background:${m.cor}` }), m.nome)),
      el('button', { class: 'mchip new', onclick: () => { closeAsk(); openMatEditor(null, { preselect: fp }); } }, icon('plus'), activeMats().length ? 'Nova matéria' : 'Criar a primeira matéria')),
    el('div', { class: 'ask-f' },
      el('label', {}, el('input', { type: 'checkbox', onchange: (e) => ls.set('matNaoPerguntar', e.target.checked) }), 'Não perguntar de novo'),
      el('button', { class: 'minibtn', onclick: () => dismissAsk(fp) }, 'Agora não')));
  document.body.append(card);
}

// ---------- criar e editar matéria ----------
function openMatEditor(m = null, opts = {}) {
  const isNew = !m;
  const d = {
    cor: m?.cor || MAT_COLORS[S.mats.length % MAT_COLORS.length][0],
    secoes: [...(m ? m.secoes : DEFAULT_SECS)],
    sel: new Map((m?.pdfs || []).map(p => [p.fp, p.sec ?? null])),
    siglaEdit: !!(m?.sigla && m.sigla !== siglaOf(m.nome)),
    filtro: '',
  };
  if (opts.preselect && !d.sel.has(opts.preselect)) d.sel.set(opts.preselect, guessSec(d.secoes, libEntry(opts.preselect)?.name));
  const nameIn = el('input', { class: 'inp', type: 'text', value: m?.nome || '', placeholder: 'Ex.: Cálculo IV', maxlength: '60', 'aria-label': 'Nome da matéria' });
  const siglaIn = el('input', { class: 'inp', type: 'text', value: m?.sigla || siglaOf(m?.nome || ''), maxlength: '3', 'aria-label': 'Sigla da capa' });
  const provaIn = el('input', { class: 'inp', type: 'date', value: m?.prova || '', 'aria-label': 'Data da prova' });
  const cover = el('div', { class: 'cover bigcover mcover' });
  const paint = () => { cover.style.background = d.cor; cover.style.color = inkFor(d.cor); cover.replaceChildren(el('span', { text: (siglaIn.value || siglaOf(nameIn.value) || '?').toUpperCase() })); };
  const swatches = el('div', { class: 'swatches', role: 'group', 'aria-label': 'Cor da capa' }, ...MAT_COLORS.map(([c, , nm]) => el('button', { type: 'button', title: nm, 'aria-label': nm, 'aria-pressed': String(d.cor === c), style: `background:${c}`, onclick: (e) => { d.cor = c; swatches.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); paint(); } })));
  let nameT; nameIn.addEventListener('input', () => { if (!d.siglaEdit) siglaIn.value = siglaOf(nameIn.value); paint(); clearTimeout(nameT); nameT = setTimeout(() => renderPicks(true), 250); });
  siglaIn.addEventListener('input', () => { d.siglaEdit = !!siglaIn.value; paint(); });

  const secWrap = el('div', { class: 'secchips' });
  const secIn = el('input', { class: 'inp', type: 'text', placeholder: 'Nova seção', maxlength: '40', 'aria-label': 'Nova seção' });
  const addSec = () => { const v = secIn.value.trim(); if (v && !d.secoes.includes(v)) { d.secoes.push(v); secIn.value = ''; renderSecs(); renderPicks(false); } };
  secIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSec(); } });
  function renderSecs() {
    secWrap.replaceChildren(...d.secoes.map(s => el('span', { class: 'secchip' }, s, el('button', { type: 'button', title: `Tirar a seção ${s}`, 'aria-label': `Tirar a seção ${s}`, onclick: () => { d.secoes = d.secoes.filter(x => x !== s); for (const [fp, v] of d.sel) if (v === s) d.sel.set(fp, null); renderSecs(); renderPicks(false); } }, icon('x')))),
      d.secoes.length ? '' : el('small', { class: 'vnote', text: 'Sem seções: os PDFs ficam numa lista corrida.' }));
  }

  const pickBox = el('div', { class: 'pdfpick' });
  const pickCount = el('small');
  const sugBtn = el('button', { type: 'button', class: 'minibtn', hidden: true, onclick: () => { for (const e of lastSug) d.sel.set(e.fp, guessSec(d.secoes, e.name)); renderPicks(true); } });
  let order = null, lastSug = [];
  const filtIn = el('input', { class: 'inp', type: 'search', placeholder: 'Filtrar sua biblioteca', 'aria-label': 'Filtrar PDFs' });
  filtIn.addEventListener('input', () => { d.filtro = filtIn.value; renderPicks(); });
  // resort: reordena (selecionados e sugeridos em cima); marcar uma caixa não mexe na ordem, para a lista não pular
  function renderPicks(resort = true) {
    const st = pickBox.scrollTop;
    const pseudo = { nome: nameIn.value, sigla: siglaIn.value, pdfs: [...d.sel.keys()].map(fp => ({ fp })) };
    const f = norm(d.filtro.trim());
    const rows = S.lib.filter(e => !f || norm(e.name).includes(f)).map(e => ({ e, on: d.sel.has(e.fp), sc: d.sel.has(e.fp) ? 0 : matScore(pseudo, e.name) }));
    if (resort || !order) { rows.sort((a, b) => (b.on - a.on) || (b.sc - a.sc) || ((b.e.lastOpened || 0) - (a.e.lastOpened || 0))); order = rows.map(r => r.e.fp); }
    else { const ix = new Map(order.map((fp, i) => [fp, i])); rows.sort((a, b) => (ix.get(a.e.fp) ?? 1e9) - (ix.get(b.e.fp) ?? 1e9)); }
    lastSug = rows.filter(r => r.sc > 0).map(r => r.e);
    sugBtn.hidden = !lastSug.length; sugBtn.textContent = `Marcar ${plural(lastSug.length, 'sugerido', 'sugeridos')}`;
    pickBox.replaceChildren(...rows.map(({ e, on, sc }) => {
      const others = matsOfFp(e.fp).filter(x => x !== m);
      const tag = sc > 0 ? el('small', { class: 'sug', text: 'Sugerido: nome parecido' }) : el('small', { text: others.length ? 'Em ' + others.map(x => x.nome).join(', ') : 'Sem matéria' });
      const secSel = el('select', { 'aria-label': `Seção de ${e.name}`, disabled: !on || !d.secoes.length ? true : undefined, onclick: (ev) => ev.stopPropagation(), onchange: (ev) => d.sel.set(e.fp, ev.target.value || null) },
        el('option', { value: '', text: d.secoes.length ? 'Sem seção' : '—' }), ...d.secoes.map(s => el('option', { value: s, text: s, selected: on && d.sel.get(e.fp) === s ? true : undefined })));
      const cb = el('input', { type: 'checkbox', checked: on ? true : undefined, 'aria-label': e.name, onchange: (ev) => { if (ev.target.checked) d.sel.set(e.fp, guessSec(d.secoes, e.name)); else d.sel.delete(e.fp); renderPicks(false); } });
      return el('label', { class: 'pick' + (on ? ' on' : '') }, cb, el('span', { style: 'min-width:0' }, el('b', { text: stripPdf(e.name), title: e.name }), tag), secSel);
    }));
    if (!rows.length) pickBox.append(el('div', { class: 'libempty', text: S.lib.length ? 'Nenhum PDF com esse nome.' : 'Abra alguns PDFs primeiro: eles aparecem aqui para você escolher.' }));
    pickCount.textContent = plural(d.sel.size, 'selecionado', 'selecionados');
    pickBox.scrollTop = resort ? 0 : st;
  }

  const save = async () => {
    const nome = nameIn.value.trim();
    if (!nome) { nameIn.focus(); toast('Dê um nome para a matéria'); return; }
    const sigla = (siglaIn.value.trim() || siglaOf(nome) || '?').toUpperCase().slice(0, 3);
    const order = m ? m.pdfs.map(p => p.fp).filter(fp => d.sel.has(fp)) : [];
    for (const fp of d.sel.keys()) if (!order.includes(fp)) order.push(fp);
    const pdfs = order.map(fp => { const s = d.sel.get(fp); return { fp, sec: s && d.secoes.includes(s) ? s : null }; });
    const now = Date.now();
    closeModal();
    if (isNew) {
      const nm = { id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 6), nome, sigla, cor: d.cor, prova: provaIn.value || null, secoes: d.secoes, pdfs, arquivada: false, criada: now, atualizada: now };
      S.mats.push(nm);
      await saveMats(`Matéria ${nome} criada`);
      if (!(opts.preselect && S.view === 'book')) showView('materia', nm.id);
    } else {
      Object.assign(m, { nome, sigla, cor: d.cor, prova: provaIn.value || null, secoes: d.secoes, pdfs, atualizada: now });
      await saveMats('Matéria salva');
    }
  };
  const box = el('section', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'Nova matéria' : 'Editar matéria' },
    el('header', {}, el('h2', { text: isNew ? 'Nova matéria' : 'Editar matéria' }), el('button', { class: 'iconbtn', 'aria-label': 'Fechar', title: 'Fechar (Esc)', onclick: closeModal }, icon('x'))),
    el('div', { class: 'mbody' },
      el('div', { class: 'mcol' },
        el('div', { class: 'edtop' }, cover, el('div', { class: 'fld' }, 'Cor da capa', swatches)),
        el('label', { class: 'fld' }, 'Nome', nameIn),
        el('div', { class: 'row2' }, el('label', { class: 'fld narrow' }, 'Sigla', siglaIn), el('label', { class: 'fld' }, el('span', {}, 'Data da prova ', el('small', { text: '(opcional)' })), provaIn)),
        el('div', { class: 'fld' }, el('span', {}, 'Seções ', el('small', { text: 'separam livros, listas e provas' })), secWrap, el('div', { class: 'secadd' }, secIn, el('button', { type: 'button', class: 'minibtn', onclick: addSec }, icon('plus'), 'Seção')))),
      el('div', { class: 'mcol pdfs' }, el('div', { class: 'pickhead' }, el('span', { text: 'PDFs da matéria' }), el('span', { class: 'pickact' }, pickCount, sugBtn)), filtIn, pickBox)),
    el('footer', {}, el('button', { class: 'pillbtn dark', onclick: closeModal }, 'Cancelar'), el('button', { class: 'pillbtn green', onclick: save }, isNew ? 'Criar matéria' : 'Salvar')));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); } });
  paint(); renderSecs(); renderPicks();
  openModal(box);
  (opts.focusPdfs ? filtIn : nameIn).focus();
}

// ---------- página da matéria ----------
async function renderMateria(id) {
  await loadLib();
  const sem = id === '__sem';
  const m = sem ? null : matById(id);
  if (!sem && !m) return el('div', { class: 'empty-big' }, el('b', { text: 'Matéria não encontrada' }), 'Ela pode ter sido excluída.');
  const ents = sem ? semMateria().map(e => ({ e, sec: null })) : m.pdfs.map(p => ({ e: libEntry(p.fp), sec: p.sec })).filter(x => x.e);
  const st = sem ? null : matStats(m), pv = sem ? null : provaInfo(m);
  const sub = sem
    ? [el('b', { text: plural(ents.length, 'PDF', 'PDFs') }), ' que ainda não estão em nenhuma matéria']
    : [el('b', { text: plural(st.np, 'PDF', 'PDFs') }), ` · ${st.total} questões · ${st.done} feitas (${st.pct}%)`, st.review ? el('span', { class: 'rvtx', text: ` · ${st.review} para revisar` }) : null];
  const hero = el('div', { class: 'vhero', style: `--hero:${sem ? '#6d7873' : m.cor}` }, matCover(m, 'cover bigcover'),
    el('div', { class: 'meta' }, el('span', { class: 'eyebrow', text: sem ? 'Organizar' : m.arquivada ? 'Matéria arquivada' : 'Matéria' }), el('h1', { text: sem ? 'Sem matéria' : m.nome }),
      el('div', { class: 'sub' }, ...sub, pv ? el('span', { class: 'pvchip' + (pv.soon ? ' soon' : ''), text: pv.txt }) : null)));
  const act = el('div', { class: 'vact' });
  if (sem) {
    act.append(el('span', { class: 'vnote', text: 'Use ⋯ num PDF para colocá-lo numa matéria.' }), el('button', { class: 'pillbtn green', onclick: () => openMatEditor() }, icon('plus'), 'Nova matéria'));
  } else {
    if (st.np) {
      const contTx = el('span', { class: 'ctx', text: '…' });
      act.append(el('button', { class: 'playbig', title: 'Continuar de onde parou', 'aria-label': 'Continuar de onde parou', onclick: () => continueMat(m) }, icon('play', 'fill')),
        el('div', { class: 'cont' }, el('small', { text: 'Continuar' }), contTx));
      continueLabel(m).then(t => { contTx.textContent = t || 'nenhum PDF desta matéria foi encontrado no computador'; });
    }
    act.append(
      el('button', { class: 'pillbtn dark' + (st.review ? ' rv' : ''), onclick: () => showView('mrev', m.id) }, icon('review'), st.review ? `Revisar ${st.review}` : 'Revisão'),
      el('button', { class: 'pillbtn dark', title: 'Sorteia questões de todos os PDFs da matéria', onclick: () => { S.mrevFocus = 'prova'; showView('mrev', m.id); } }, icon('shuffle'), 'Modo prova'),
      el('span', { class: 'grow' }),
      el('button', { class: 'iconbtn big', title: 'Escolher PDFs da matéria', 'aria-label': 'Escolher PDFs da matéria', onclick: () => openMatEditor(m, { focusPdfs: true }) }, icon('plus')),
      el('button', { class: 'iconbtn big', title: 'Mais opções', 'aria-label': 'Mais opções da matéria', onclick: (e) => matMenu(e.currentTarget, m) }, icon('more', 'fill')));
  }
  const tracks = el('div', { class: 'tracks' }, el('div', { class: 'thead prow' }, el('span', { class: 'c-num', text: '#', style: 'text-align:right' }), el('span', { text: 'PDF' }), el('span', { class: 'c-st', text: 'Progresso' }), el('span', { class: 'c-dd', text: 'Revisar' }), el('span', { class: 'c-when', text: 'Aberto', style: 'text-align:right' })));
  if (!ents.length) tracks.append(el('div', { class: 'empty-big' }, el('b', { text: sem ? 'Tudo organizado' : 'Nenhum PDF nesta matéria' }), sem ? 'Todos os PDFs já estão em alguma matéria.' : 'Clique em + para escolher PDFs da sua biblioteca.'));
  const groups = [];
  if (sem || !m.secoes.length) groups.push({ name: null, items: ents });
  else {
    for (const s of m.secoes) groups.push({ name: s, items: ents.filter(x => x.sec === s) });
    const rest = ents.filter(x => !m.secoes.includes(x.sec)); if (rest.length) groups.push({ name: 'Sem seção', items: rest });
  }
  let i = 0;
  for (const g of groups) {
    if (!g.items.length) continue;
    if (g.name) tracks.append(el('div', { class: 'msec' }, el('span', { text: g.name }), el('small', { text: plural(g.items.length, 'PDF', 'PDFs') })));
    for (const { e } of g.items) tracks.append(pdfRow(e, ++i, m));
  }
  return el('div', { class: 'matview' }, hero, act, tracks);
}
function pdfRow(e, i, m) {
  const s = pdfStats(e); const dp = s.total ? s.done / s.total * 100 : 0, rp = s.total ? s.review / s.total * 100 : 0;
  const open = () => e.exists ? openPath(e.path, null, { ask: false }) : openDialog();
  return el('div', { class: 'trow prow' + (e.fp === S.fp ? ' cur' : '') + (e.exists ? '' : ' missing'), role: 'button', tabindex: '0', title: e.path || e.name, onclick: open, onkeydown: (ev) => { if (ev.key === 'Enter') open(); }, oncontextmenu: (ev) => { ev.preventDefault(); pdfRowMenu({ x: ev.clientX, y: ev.clientY }, e, m); } },
    el('span', { class: 'num' }, el('span', { text: i }), icon('play', 'fill')),
    el('span', { class: 'ttl' }, el('span', { class: 'doc', style: `--c:${m ? m.cor : '#6d7873'}` }, el('i'), el('i'), el('i')),
      el('span', { style: 'min-width:0' }, el('b', { text: stripPdf(e.name) }), el('small', { text: e.exists ? (s.total ? plural(s.total, 'questão', 'questões') : 'nenhuma questão detectada') : 'Arquivo não encontrado. Clique para localizar.' }))),
    el('span', { class: 'c-st pgr' }, el('span', { class: 'bar2' }, el('i', { style: `width:${dp}%;background:var(--accent)` }), el('i', { style: `width:${rp}%;background:var(--review)` })), el('small', { text: `${s.done}/${s.total}` })),
    el('span', { class: 'c-dd rvn' + (s.review ? ' on' : ''), text: s.review ? String(s.review) : '—' }),
    el('span', { class: 'when' }, el('span', { class: 'wtx', text: agoLong(e.lastOpened) }),
      el('span', { class: 'acts' }, el('button', { class: 'iconbtn', title: 'Opções do PDF', 'aria-label': 'Opções do PDF', onclick: (ev) => { ev.stopPropagation(); pdfRowMenu(ev.currentTarget, e, m); } }, icon('more', 'fill')))));
}
function matCard(m) {
  const st = matStats(m), pv = provaInfo(m);
  return el('button', { class: 'card mcard', onclick: () => showView('materia', m.id), oncontextmenu: (e) => { e.preventDefault(); matMenu({ x: e.clientX, y: e.clientY }, m); } },
    el('div', { class: 'cover mcover', style: `background:${m.cor};color:${inkFor(m.cor)}` }, el('span', { text: m.sigla || siglaOf(m.nome) || '?' }), pv && pv.n >= 0 ? el('em', { class: 'pv' + (pv.soon ? ' soon' : ''), text: pv.txt }) : null),
    el('span', {}, el('b', { text: m.nome }), el('span', { class: 'bar2' }, el('i', { style: `width:${st.pct}%;background:var(--accent)` })),
      el('small', {}, `${plural(st.np, 'PDF', 'PDFs')} · ${st.pct}% feitas`, st.review ? el('span', { class: 'rvtx', text: ` · ${st.review} a revisar` }) : null)),
    el('span', { class: 'pmini', title: 'Continuar de onde parou', onclick: (e) => { e.stopPropagation(); continueMat(m); } }, icon('play', 'fill')));
}

// ---------- revisão da matéria e modo prova ----------
async function renderMatReview(id) {
  const m = matById(id);
  if (!m) return el('div', { class: 'empty-big' }, el('b', { text: 'Matéria não encontrada' }));
  await loadLib();
  const data = await matData(m);
  const items = [];
  data.forEach((d, pi) => {
    for (const [key, mk] of Object.entries(d.marks || {})) if (mk.s === 'revisar') {
      const qi = qInfo(d, key);
      items.push({ fp: d.e.fp, path: d.e.path, exists: d.e.exists, pdf: stripPdf(d.e.name), sec: d.sec, key, label: qi.label, where: qi.where, r: mk.r, at: mk.revAt || mk.t || 0, ord: pi * 1e5 + qi.i });
    }
  });
  items.sort((a, b) => a.ord - b.ord);
  const secs = m.secoes.filter(s => items.some(x => x.sec === s));
  const fsec = secs.includes(S.mrevSec) ? S.mrevSec : 'all';
  const fr = REASONS.includes(S.mrevWhy) ? S.mrevWhy : 'all';
  const shown = items.filter(x => (fsec === 'all' || x.sec === fsec) && (fr === 'all' || x.r === fr));
  const playable = shown.filter(x => x.exists);
  const hero = el('div', { class: 'vhero' }, matCover(m, 'cover bigcover'),
    el('div', { class: 'meta' }, el('span', { class: 'eyebrow' }, el('button', { class: 'crumb', onclick: () => showView('materia', m.id) }, m.nome), ' › Revisão'),
      el('h1', { text: items.length ? plural(items.length, 'questão para revisar', 'questões para revisar') : 'Nada para revisar' }),
      el('div', { class: 'sub', text: `de ${plural(data.length, 'PDF', 'PDFs')} da matéria` })));
  hero.style.setProperty('--hero', m.cor);
  const act = el('div', { class: 'vact' });
  if (playable.length) {
    const lay = (v, t) => el('button', { 'aria-pressed': String(S.layout === v), onclick: () => { S.layout = v; ls.set('pdfLayout', v); rerenderView(); } }, t);
    act.append(el('button', { class: 'playbig', title: 'Revisar em sequência', 'aria-label': 'Revisar em sequência', onclick: () => startMq({ name: `Revisar · ${m.nome}`, matId: m.id, items: playable }) }, icon('play', 'fill')),
      el('button', { class: 'pillbtn dark', id: 'genPdf', onclick: () => exportPdf(() => matEntries(playable), `${m.nome}`) }, icon('file'), `Gerar PDF (${playable.length})`),
      el('div', { class: 'seg', role: 'group', 'aria-label': 'Disposição do PDF' }, lay('compacto', 'Compacto'), lay('pagina', 'Uma por página')),
      el('span', { class: 'vnote', id: 'pdfNote', text: 'Junta as questões de todos os PDFs, com as figuras.' }));
  }
  const fchip = (v, t, cur, set) => el('button', { class: 'fchip', 'aria-pressed': String(cur === v), onclick: () => { set(cur === v ? 'all' : v); rerenderView(); } }, t);
  const chips = el('div', { class: 'chipsrow' },
    ...secs.map(s => fchip(s, s, fsec, (v) => { S.mrevSec = v; })),
    ...REASONS.filter(r => items.some(x => x.r === r)).map(r => fchip(r, r, fr, (v) => { S.mrevWhy = v; })));
  const tracks = el('div', { class: 'tracks' }, el('div', { class: 'thead' }, el('span', { class: 'c-num', text: '#', style: 'text-align:right' }), el('span', { text: 'Questão' }), el('span', { class: 'c-st', text: 'Motivo' }), el('span', { class: 'c-dd', text: '' }), el('span', { class: 'c-when', text: 'Marcada', style: 'text-align:right' })));
  if (!shown.length) tracks.append(el('div', { class: 'empty-big' }, el('b', { text: items.length ? 'Nada com esse filtro' : 'Nenhuma questão para revisar' }), items.length ? 'Tire o filtro acima para ver todas.' : 'Marque ↻ nas questões dos PDFs desta matéria e elas aparecem aqui juntas.'));
  shown.forEach((x, i) => {
    const go = () => { const j = playable.indexOf(x); if (j >= 0) startMq({ name: `Revisar · ${m.nome}`, matId: m.id, items: playable, at: j }); else toast('Arquivo não encontrado. Abra o PDF de novo pelo Meus PDFs.'); };
    tracks.append(el('div', { class: 'trow' + (x.fp === S.fp && x.key === S.cur ? ' cur' : ''), role: 'button', tabindex: '0', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
      el('span', { class: 'num' }, el('span', { text: i + 1 }), icon('play', 'fill')),
      el('span', { class: 'ttl' }, el('span', { class: 'doc', style: `--c:${m.cor}` }, el('i'), el('i'), el('i')), el('span', { style: 'min-width:0' }, el('b', { text: x.label }), el('small', { text: [x.pdf, x.where].filter(Boolean).join(' · ') }))),
      el('span', { class: 'stcell' }, el('span', { class: 'spill revisar', text: x.r || 'Revisar' })),
      el('span', { class: 'c-dd' }),
      el('span', { class: 'when' }, el('span', { class: 'wtx', text: agoLong(x.at) }))));
  });
  const main = el('div', { class: 'mrev-main' }, hero, act, secs.length || REASONS.some(r => items.some(x => x.r === r)) ? chips : null, tracks);
  const node = el('div', { class: 'mrev' }, main, provaPanel(m, data));
  if (S.mrevFocus === 'prova') { S.mrevFocus = null; requestAnimationFrame(() => node.querySelector('.prova')?.scrollIntoView({ block: 'nearest' })); }
  return node;
}
function provaPanel(m, data) {
  const P = S.prova;
  const avail = data.filter(d => d.det?.questions?.length && d.e.exists);
  const pool = () => {
    const out = [];
    for (const d of avail) {
      if (P.off.has(d.e.fp)) continue;
      for (const q of d.det.questions) {
        const s = d.marks?.[q.key]?.s;
        if ((!s && P.nf) || (s === 'revisar' && P.rv) || (s === 'feita' && P.f)) out.push({ fp: d.e.fp, path: d.e.path, pdf: stripPdf(d.e.name), key: q.key });
      }
    }
    return out;
  };
  const cnt = el('small', { class: 'vnote' });
  const upd = () => { const n = pool().length; cnt.textContent = n ? `${plural(n, 'questão', 'questões')} no sorteio` : 'Nenhuma questão com esses filtros'; };
  const seg = el('div', { class: 'seg' }, ...[5, 10, 20, 0].map(n => el('button', { 'aria-pressed': String(P.n === n), onclick: (e) => { P.n = n; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, n ? String(n) : 'Todas')));
  const ck = (k, t) => el('label', { class: 'ckl' }, el('input', { type: 'checkbox', checked: P[k] ? true : undefined, onchange: (e) => { P[k] = e.target.checked; upd(); } }), t);
  const pdfs = el('div', { class: 'pdflist' }, ...data.map(d => {
    const ok = avail.includes(d);
    const left = ok ? d.det.questions.filter(q => !d.marks?.[q.key]).length : 0;
    return el('label', { class: 'ckl' + (ok ? '' : ' off'), title: ok ? d.e.name : 'Abra este PDF uma vez para o app achar as questões' },
      el('input', { type: 'checkbox', disabled: ok ? undefined : true, checked: ok && !P.off.has(d.e.fp) ? true : undefined, onchange: (e) => { if (e.target.checked) P.off.delete(d.e.fp); else P.off.add(d.e.fp); upd(); } }),
      el('span', { text: stripPdf(d.e.name) }), el('small', { text: ok ? `${left} sem marca` : 'abrir uma vez' }));
  }));
  const timer = el('select', { 'aria-label': 'Cronômetro', onchange: (e) => { P.timer = +e.target.value; } }, ...[[0, 'Sem cronômetro'], [30, '30 min'], [60, '1 hora'], [90, '1h30'], [120, '2 horas'], [180, '3 horas']].map(([v, t]) => el('option', { value: v, text: t, selected: P.timer === v ? true : undefined })));
  const start = () => {
    const p = pool();
    if (!p.length) { toast('Nenhuma questão com esses filtros'); return; }
    for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    startMq({ name: `Modo prova · ${m.nome}`, matId: m.id, items: P.n ? p.slice(0, P.n) : p, prova: true, mins: P.timer });
  };
  upd();
  return el('aside', { class: 'prova', 'aria-label': 'Modo prova' },
    el('h2', {}, icon('shuffle'), 'Modo prova'),
    el('p', { text: 'Sorteia questões de vários PDFs da matéria, como um simulado. J e K passam de uma para outra, mesmo entre PDFs, e o que você marcar fica salvo em cada PDF.' }),
    el('div', { class: 'fld' }, 'Quantas questões', seg),
    el('div', { class: 'fld' }, 'Sortear entre', ck('nf', 'Ainda não feitas'), ck('rv', 'Para revisar'), ck('f', 'Já feitas (refazer)')),
    el('div', { class: 'fld' }, 'De quais PDFs', pdfs),
    el('label', { class: 'fld' }, 'Cronômetro', timer),
    cnt,
    el('button', { class: 'pillbtn green', onclick: start }, icon('play', 'fill'), 'Começar'));
}

// fila que atravessa PDFs (revisão da matéria e modo prova)
const mqStatus = (it) => (it.fp === S.fp && S.det ? S.marks : (S.mq?.st.get(it.fp) || {}))[it.key]?.s;
async function startMq({ name, matId, items, prova = false, mins = 0, at = 0 }) {
  if (!items.length) { toast('Nada para estudar nessa lista'); return; }
  const st = new Map();
  for (const fp of new Set(items.map(x => x.fp))) if (fp !== S.fp) { try { st.set(fp, cleanMarks((await api.loadMarks(fp))?.marks)); } catch { st.set(fp, {}); } }
  S.mq = { name, matId, items, i: at, st, prova, endsAt: mins ? Date.now() + mins * 60000 : 0, timeUp: false };
  await gotoMq(at);
}
async function gotoMq(i) {
  const mq = S.mq; if (!mq) return;
  if (i >= mq.items.length) { finishMq(); return; }
  mq.i = Math.max(0, i);
  const it = mq.items[mq.i];
  if (it.fp === S.fp && S.det) { if (S.view !== 'book') showView('book'); select(it.key); return; }
  if (S.fp) mq.st.set(S.fp, { ...S.marks });
  const path = libEntry(it.fp)?.path || it.path;
  if (!path) { toast('Não encontrei o arquivo desta questão'); return; }
  S.mqNav = true;
  try { await openPath(path, it.key, { ask: false }); } finally { S.mqNav = false; }
  if (S.mq === mq && S.fp === it.fp) select(it.key);
}
function endMq() { S.mq = null; renderPlayer(); renderLibrary(); }
function finishMq() {
  const mq = S.mq; if (!mq) return;
  const n = mq.items.length, d = mq.items.filter(x => mqStatus(x) === 'feita').length, r = mq.items.filter(x => mqStatus(x) === 'revisar').length;
  toast(`${mq.prova ? 'Fim do simulado' : 'Fim da lista'}: ${d} de ${n} feitas${r ? `, ${r} para revisar` : ''}`, { label: 'Sair da lista', fn: endMq });
}
function mqCtx() {
  const mq = S.mq; let t = `${mq.name} · ${mq.i + 1}`;
  if (mq.endsAt) { const ms = Math.max(0, mq.endsAt - Date.now()); t = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')} · ${t}`; }
  return t;
}
setInterval(() => {
  const mq = S.mq; if (!mq?.endsAt) return;
  $('#pCtx').textContent = mqCtx();
  if (!mq.timeUp && Date.now() >= mq.endsAt) { mq.timeUp = true; toast('O tempo do simulado acabou', { label: 'Ver resultado', fn: finishMq }); }
}, 1000);

// questões de vários PDFs para o PDF de revisão da matéria
async function matEntries(items) {
  const docs = new Map(), opened = [];
  const out = [];
  for (const it of items) {
    if (!docs.has(it.fp)) {
      if (it.fp === S.fp && S.pdf) docs.set(it.fp, { pageAt: pageCanvasAt, det: S.det, marks: S.marks });
      else {
        try {
          const r = await api.readPdf(libEntry(it.fp)?.path || it.path);
          const pdf = await pdfjsLib.getDocument({ data: r.data }).promise; opened.push(pdf);
          const [det, mk] = await Promise.all([api.loadDetection(it.fp, DET_VERSION), api.loadMarks(it.fp)]);
          docs.set(it.fp, { pageAt: docPageAt(pdf), det, marks: cleanMarks(mk?.marks) });
        } catch { docs.set(it.fp, null); }
      }
    }
    const d = docs.get(it.fp); if (!d?.det) continue;
    const q = d.det.questions.find(x => x.key === it.key); if (!q) continue;
    const qq = { ...q, label: labelOf(q), where: whereOf(q) };
    out.push({ q: qq, m: d.marks[it.key] || {}, where: [it.pdf, qq.where].filter(Boolean).join(' · '), shot: (s) => shotCanvas(qq, s, d.pageAt) });
  }
  out.cleanup = () => opened.forEach(p => { try { p.destroy(); } catch {} });
  return out;
}
function docPageAt(pdf) {
  const cache = new Map();
  return (pn, scale) => {
    const k = pn + '@' + scale;
    if (!cache.has(k)) {
      cache.set(k, (async () => {
        const page = await pdf.getPage(pn); const vp = page.getViewport({ scale });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await page.render({ canvas: c, canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp }).promise;
        return c;
      })());
      if (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    return cache.get(k);
  };
}

// ---------- início ----------
(async () => {
  await Promise.all([loadMats(), loadLib()]);
  renderLibrary();
  const pending = await api.pendingPdf().catch(() => null);
  if (pending) return openPath(pending);
  const last = S.lib.find(x => x.exists);
  if (last) openPath(last.path, null, { ask: false }); else showView(S.mats.length ? 'home' : 'pdfs');
})();
