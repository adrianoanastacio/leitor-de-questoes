// Junta os dados de dois aparelhos (PC e tablet). Sem acesso a arquivos: só recebe e devolve objetos,
// para a mesma lógica servir no app do Windows e no do Android.
//
// Regra: em cada questão vale a alteração mais recente. Desmarcar também conta como alteração
// (fica guardado em "apagadas" com a hora), para uma questão desmarcada num aparelho não voltar
// marcada quando você importar os dados do outro.

const markTime = (m) => (m ? m.t || m.doneAt || m.revAt || 0 : 0);

// a = dados deste aparelho, b = dados que chegaram. Cada um: { marks, apagadas, cur, updated, name }
function mergeMarks(a = {}, b = {}) {
  const marks = {}, apagadas = {};
  const keys = new Set([a.marks, b.marks, a.apagadas, b.apagadas].flatMap(o => Object.keys(o || {})));
  let mudou = 0;
  for (const k of keys) {
    const cands = [];
    for (const side of [a, b]) {
      const m = side.marks?.[k];
      if (m && m.s) cands.push({ t: markTime(m), m });
      const d = side.apagadas?.[k];
      if (d) cands.push({ t: d, del: true });
    }
    // a mais recente ganha; empate entre marca e desmarca: fica a marca (não perde trabalho)
    cands.sort((x, y) => (y.t - x.t) || ((x.del ? 1 : 0) - (y.del ? 1 : 0)));
    const w = cands[0];
    if (w.del) apagadas[k] = w.t; else marks[k] = w.m;
    const antes = a.marks?.[k];
    const depois = w.del ? undefined : w.m;
    if (JSON.stringify(antes && antes.s ? antes : undefined) !== JSON.stringify(depois)) mudou++;
  }
  const bNewer = (b.updated || 0) > (a.updated || 0);
  return {
    name: a.name || b.name,
    cur: bNewer ? (b.cur ?? a.cur) : (a.cur ?? b.cur),
    marks, apagadas,
    updated: Math.max(a.updated || 0, b.updated || 0),
    mudou,
  };
}

// matérias: por id, fica a versão com "atualizada" mais recente; excluir também conta (apagadas)
function mergeMaterias(a = {}, b = {}) {
  const byId = new Map(), apagadas = { ...(a.apagadas || {}) };
  for (const [id, t] of Object.entries(b.apagadas || {})) apagadas[id] = Math.max(apagadas[id] || 0, t);
  const local = new Map((a.materias || []).map(m => [m.id, m]));
  for (const m of [...(a.materias || []), ...(b.materias || [])]) {
    if (!m || !m.id) continue;
    const old = byId.get(m.id);
    if (!old || (m.atualizada || 0) > (old.atualizada || 0)) byId.set(m.id, m);
  }
  let novas = 0, atualizadas = 0, removidas = 0;
  const materias = [];
  for (const [id, m] of byId) {
    if ((apagadas[id] || 0) > (m.atualizada || 0)) { if (local.has(id)) removidas++; continue; }
    delete apagadas[id];
    const l = local.get(id);
    if (!l) novas++; else if (JSON.stringify(l) !== JSON.stringify(m)) atualizadas++;
    materias.push(m);
  }
  // mantém a ordem deste aparelho e põe as novas no fim
  const ord = new Map((a.materias || []).map((m, i) => [m.id, i]));
  materias.sort((x, y) => (ord.get(x.id) ?? 1e9) - (ord.get(y.id) ?? 1e9));
  return { materias, apagadas, novas, atualizadas, removidas };
}

// biblioteca: une pelo fp. O caminho do arquivo é de cada aparelho, então o daqui nunca é trocado.
function mergeLibrary(local = [], incoming = []) {
  const byFp = new Map(local.map(e => [e.fp, { ...e }]));
  let novos = 0;
  for (const e of incoming) {
    if (!e || !e.fp) continue;
    const l = byFp.get(e.fp);
    if (!l) { const { path: _p, exists: _x, ...rest } = e; byFp.set(e.fp, { ...rest, path: null }); novos++; continue; }
    l.lastOpened = Math.max(l.lastOpened || 0, e.lastOpened || 0);
    l.total = Math.max(l.total || 0, e.total || 0);
    l.pages = l.pages || e.pages;
    l.name = l.name || e.name;
  }
  return { pdfs: [...byFp.values()], novos };
}

const statsOf = (marks, total) => {
  const v = Object.values(marks || {});
  return { total: total || 0, done: v.filter(m => m.s === 'feita').length, review: v.filter(m => m.s === 'revisar').length };
};

const FORMATO = 'leitor-de-questoes-dados';

const SYNC = { mergeMarks, mergeMaterias, mergeLibrary, statsOf, markTime, FORMATO };
// no PC (Node/Electron) vira módulo; no tablet (navegador) fica em window.LeitorSync
if (typeof module !== 'undefined' && module.exports) module.exports = SYNC; else globalThis.LeitorSync = SYNC;
