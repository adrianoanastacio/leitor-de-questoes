// Ponte do Leitor de Questões para o navegador (versão do tablet).
// Faz o papel do main.js + store.js do PC: guarda marcações, matérias, lista de PDFs, cache da detecção e
// uma cópia de cada PDF no armazenamento interno do Chrome (IndexedDB), dentro do próprio aparelho.
// Nada é enviado para a internet. A junção de dados entre aparelhos é a mesma do PC (sync.js).
(() => {
  const SY = globalThis.LeitorSync;

  // ---------- IndexedDB: "kv" guarda objetos (JSON), "files" guarda os PDFs ----------
  const DB = new Promise((res, rej) => {
    const r = indexedDB.open('leitor-de-questoes', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  function tx(store, mode, fn) {
    return DB.then(db => new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Sem espaço no aparelho?'));
    }));
  }
  const kvGet = (k, fb) => tx('kv', 'readonly', s => s.get(k)).then(v => (v === undefined ? fb : v));
  const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
  const kvDel = (k) => tx('kv', 'readwrite', s => s.delete(k));
  const kvKeys = (prefix) => tx('kv', 'readonly', s => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')));
  const fileGet = (k) => tx('files', 'readonly', s => s.get(k));
  const fileSet = (k, v) => tx('files', 'readwrite', s => s.put(v, k));
  const fileHas = (k) => tx('files', 'readonly', s => s.count(k)).then(n => n > 0);
  const clone = (o) => JSON.parse(JSON.stringify(o ?? null));

  navigator.storage?.persist?.().catch(() => {}); // pede ao Android para não apagar os dados quando faltar espaço

  // ---------- biblioteca ----------
  const libData = () => kvGet('biblioteca', { pdfs: [] });
  const lib = async () => (await libData()).pdfs || [];
  const writeLib = async (pdfs) => kvSet('biblioteca', { ...(await libData()), pdfs: clone(pdfs) });
  async function getLibrary() {
    const l = await lib();
    const out = await Promise.all(l.map(async e => ({ ...e, exists: !!e.path && await fileHas(e.path) })));
    return out.sort((x, y) => (y.lastOpened || 0) - (x.lastOpened || 0));
  }
  async function touchPdf(entry) {
    if (!entry?.fp) return null;
    const l = await lib();
    const i = l.findIndex(e => e.fp === entry.fp);
    const merged = { ...(i >= 0 ? l[i] : {}), ...entry, lastOpened: Date.now() };
    if (!entry.path && i >= 0) merged.path = l[i].path;
    if (i >= 0) l[i] = merged; else l.push(merged);
    await writeLib(l);
    return merged;
  }
  async function setStats(fp, stats) {
    const l = await lib(); const e = l.find(x => x.fp === fp); if (!e) return false;
    e.stats = stats; await writeLib(l); return true;
  }
  async function removePdf(fp) { await writeLib((await lib()).filter(e => e.fp !== fp)); return true; }

  // ---------- matérias ----------
  const matData = async () => { const d = await kvGet('materias', {}); return { materias: Array.isArray(d.materias) ? d.materias : [], apagadas: d.apagadas || {} }; };
  async function saveMaterias(list) {
    if (!Array.isArray(list)) return false;
    const prev = await matData(), now = Date.now();
    const ids = new Set(list.map(m => m.id));
    const apagadas = { ...prev.apagadas };
    for (const m of prev.materias) if (!ids.has(m.id)) apagadas[m.id] = now;
    for (const id of ids) delete apagadas[id];
    await kvSet('materias', { materias: clone(list), apagadas, updated: now });
    return true;
  }

  // ---------- marcações ----------
  const loadMarks = (fp) => kvGet('marks:' + fp, { marks: {} });
  async function saveMarks(fp, marks, meta = {}) {
    const prev = await loadMarks(fp), now = Date.now(), cur = clone(marks || {});
    const apagadas = { ...(prev.apagadas || {}) };
    for (const k of Object.keys(prev.marks || {})) if (!cur[k]) apagadas[k] = now;
    for (const k of Object.keys(cur)) delete apagadas[k];
    await kvSet('marks:' + fp, { ...clone(meta), fp, marks: cur, apagadas, updated: now });
    return true;
  }

  // ---------- exportar / importar ----------
  async function exportPackage() {
    const marcacoes = {};
    for (const k of await kvKeys('marks:')) {
      const d = await kvGet(k, null);
      if (d && d.fp) marcacoes[d.fp] = { name: d.name, cur: d.cur, marks: d.marks || {}, apagadas: d.apagadas || {}, updated: d.updated || 0 };
    }
    const pdfs = (await lib()).map(({ path: _p, exists: _x, ...e }) => e);
    return { formato: SY.FORMATO, versao: 1, exportado: Date.now(), origem: 'Tablet', pdfs, marcacoes, materias: await matData() };
  }
  async function importPackage(pkg) {
    if (!pkg || pkg.formato !== SY.FORMATO || !pkg.marcacoes) throw new Error('Este arquivo não é uma exportação do Leitor de Questões.');
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    await kvSet('backup:' + stamp, await exportPackage());
    const old = (await kvKeys('backup:')).sort();
    for (const k of old.slice(0, Math.max(0, old.length - 5))) await kvDel(k);

    const res = { marcacoes: 0, pdfs: 0, pdfsNovos: 0, materiasNovas: 0, materiasAtualizadas: 0, materiasRemovidas: 0, origem: pkg.origem || '' };
    const merged = SY.mergeLibrary(await lib(), pkg.pdfs || []);
    res.pdfsNovos = merged.novos;
    const byFp = new Map(merged.pdfs.map(e => [e.fp, e]));
    for (const [fp, inc] of Object.entries(pkg.marcacoes)) {
      const m = SY.mergeMarks(await loadMarks(fp), inc);
      if (m.mudou) { res.marcacoes += m.mudou; res.pdfs++; }
      await kvSet('marks:' + fp, { name: m.name, cur: m.cur, fp, marks: m.marks, apagadas: m.apagadas, updated: m.updated });
      const e = byFp.get(fp);
      if (e) e.stats = SY.statsOf(m.marks, e.stats?.total || e.total);
    }
    await writeLib(merged.pdfs);
    const mm = SY.mergeMaterias(await matData(), pkg.materias || {});
    await kvSet('materias', { materias: mm.materias, apagadas: mm.apagadas, updated: Date.now() });
    Object.assign(res, { materiasNovas: mm.novas, materiasAtualizadas: mm.atualizadas, materiasRemovidas: mm.removidas });
    return res;
  }

  // ---------- arquivos: escolher, guardar, baixar ----------
  // o seletor precisa abrir dentro do toque do usuário, por isso input.click() acontece já na chamada
  function pickFile(accept) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; if (accept) inp.accept = accept; inp.style.display = 'none';
      let done = false;
      const fin = (v) => { if (!done) { done = true; inp.remove(); resolve(v); } };
      inp.addEventListener('change', () => fin(inp.files?.[0] || null));
      inp.addEventListener('cancel', () => fin(null));
      document.body.append(inp);
      inp.click();
    });
  }
  async function hashOf(bytes) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // guarda uma cópia do PDF dentro do app, para abrir de novo sem procurar o arquivo
  async function importFile(f) {
    const data = new Uint8Array(await f.arrayBuffer());
    const key = 'pdf:' + await hashOf(data);
    if (!await fileHas(key)) await fileSet(key, { blob: new Blob([data], { type: 'application/pdf' }), name: f.name });
    return { data, name: f.name, path: key };
  }
  async function readPdf(p) {
    const rec = await fileGet(p);
    if (!rec) throw new Error('PDF não encontrado neste aparelho');
    return { path: p, name: rec.name, data: new Uint8Array(await rec.blob.arrayBuffer()) };
  }
  function download(name, bytes, type) {
    name = name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // nomes com acento podem virar "download" em alguns Chrome
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none';
    document.body.append(a); a.click(); setTimeout(() => a.remove(), 1000);
    setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
    return url;
  }
  async function shareOrDownload(name, bytes, type) {
    const file = new File([bytes], name, { type });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return 'compartilhado'; }
      catch (e) { if (e?.name === 'AbortError') return null; }
    }
    return download(name, bytes, type);
  }
  async function copyImage(bytes) {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]); return true; }
    catch { return false; }
  }

  let openCb = null;
  window.api = {
    isWeb: true,
    openPdfDialog: () => pickFile('application/pdf,.pdf').then(f => (f ? importFile(f) : null)),
    importFile,
    readPdf,
    pendingPdf: async () => null,
    pathForFile: () => null,
    onOpenPath: (cb) => { openCb = cb; },

    library: getLibrary, touchPdf, setStats, removePdf,
    materias: async () => (await matData()).materias, saveMaterias,
    loadMarks, saveMarks,
    loadDetection: (fp, ver) => kvGet(`det:${fp}:${ver}`, null),
    saveDetection: (fp, ver, det) => kvSet(`det:${fp}:${ver}`, clone(det)),

    savePdf: async (name, bytes) => download(name, bytes, 'application/pdf'),
    savePng: async (name, bytes) => download(name, bytes, 'image/png'),
    copyImage,
    showInFolder: async (p) => { if (typeof p === 'string' && p.startsWith('blob:')) window.open(p, '_blank'); },

    settings: async () => ({ dataDir: 'Dentro do Chrome deste aparelho' }),
    chooseDataDir: async () => null,
    openDataDir: async () => null,

    exportData: async () => {
      const date = new Date().toLocaleDateString('pt-BR').replace(/\//g, '-');
      return shareOrDownload(`Leitor de Questões - dados - ${date}.json`, JSON.stringify(await exportPackage()), 'application/json');
    },
    importData: async () => {
      // sem filtro: o Android nem sempre reconhece .json e deixaria o arquivo cinza no seletor; o app confere depois de ler
      const f = await pickFile('');
      if (!f) return null;
      try { return await importPackage(JSON.parse(await f.text())); }
      catch (e) { return { erro: e instanceof SyntaxError ? 'O arquivo está corrompido ou não é JSON.' : e.message }; }
    },
  };
})();
