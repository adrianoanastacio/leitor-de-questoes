// Detector de questões em PDFs de livro didático.
// Entrada: um documento PDF.js. Saída: questões com faixas (rects) por página.
// Coordenadas em pontos PDF, origem no canto superior esquerdo (y cresce para baixo).

const CAPTION_RE = /^(FIGURA|Figura|FIG\.?|Fig\.|TABELA|Tabela)\s+([A-Z]{0,3}\s?\d+(?:[.\-]\d+)*)/;
const FIG_REF_RE = /(?:FIGURA|Figura|FIG\.?|Fig\.)\s+([A-Z]{0,3}\s?\d+(?:[.\-]\d+)*)/g;
const SECTION_RE = /^(Se[cç][aã]o|Section)\s+\d|^\d+(\.\d+)+\s+\p{Lu}/u;
const CONTEXT_RE = /\b(?:nos|nas|para os|para as|use .{0,40}? nos|exerc[ií]cios|problemas|quest[õo]es)\b.{0,30}?\b(?:problemas|exerc[ií]cios|quest[õo]es)\s+(?:de\s+)?(\d{1,3})\s*(?:a|até|-|–|e)\s*(\d{1,3})/i;

// Formatos de numeração testados; fica o que gerar a maior sequência 1,2,3…
const PATTERNS = [
  { id: 'n.', re: /^[•·◦]*\s*(\d{1,3})\.(?!\d)/ },
  { id: 'n)', re: /^[•·◦]*\s*(\d{1,3})\)/ },
  { id: 'palavra n', re: /^(?:Quest[ãa]o|Exerc[ií]cio|Problema)\s*(\d{1,3})\b/i },
  // capítulo.número, como no Sadiku ("6.1", "6.2"…); o número da questão é o segundo
  { id: 'c.n', re: /^[•·◦*]*\s*(\d{1,2})\.(\d{1,3})\.?(?![\d,])/, g: 2 },
];
// item que é só o número da questão ("56.", "6.12")
const NUM_ITEM_RE = /^(?:\d{1,3}[.)]|\d{1,2}\.\d{1,3}\.?)$/;

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mode = (a) => { const m = new Map(); let best = null, bc = 0; for (const v of a) { const c = (m.get(v) || 0) + 1; m.set(v, c); if (c > bc) { bc = c; best = v; } } return best; };
const normFig = (s) => s.replace(/\s+/g, '').toUpperCase();

async function readPage(pdf, pn) {
  const page = await pdf.getPage(pn);
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim() || !(it.height > 0.5)) continue;
    // viewport.transform converte do espaço PDF para o espaço da tela (y para baixo)
    const [a, b, c, d, e, f] = it.transform;
    const x = vp.transform[0] * e + vp.transform[2] * f + vp.transform[4];
    const y = vp.transform[1] * e + vp.transform[3] * f + vp.transform[5];
    const h = it.height;
    // texto fora da área visível (página recortada) não conta
    if (y < 0 || y - h > H || x + it.width < 0 || x > W) continue;
    items.push({ s: it.str, x, y, w: it.width, h, x1: x + it.width, top: y - h, bottom: y + 0.22 * h, f: it.fontName });
  }
  return { pn, W, H, items };
}

// Procura a calha entre colunas: faixa vertical no meio da página quase sem texto.
function findGutter(items, W) {
  const lo = Math.floor(W * 0.3), hi = Math.ceil(W * 0.7);
  const cov = new Float64Array(hi - lo + 1);
  const add = (x0, x1, h) => { const a = Math.max(lo, Math.floor(x0)), b = Math.min(hi, Math.ceil(x1)); for (let x = a; x <= b; x++) cov[x - lo] += h; };
  for (const it of items) add(it.x, it.x1, it.h);
  // o número da questão ("56.") e o texto dela formam um bloco só: o vão entre eles não é calha
  for (const it of items) {
    if (!NUM_ITEM_RE.test(it.s.trim())) continue;
    let nx = null;
    for (const o of items) if (o !== it && Math.abs(o.y - it.y) < it.h * 0.5 && o.x >= it.x1 - 0.5 && o.x - it.x1 < it.h * 2.5 && (nx === null || o.x < nx)) nx = o.x;
    if (nx !== null) add(it.x1, nx, it.h);
  }
  let max = 0, min = Infinity; for (const v of cov) { max = Math.max(max, v); min = Math.min(min, v); }
  if (max === 0 || min > max * 0.25) return null;            // meio da página coberto: 1 coluna
  // núcleo: trecho mais longo com cobertura perto do mínimo
  const T = min + max * 0.03;
  let best = null, start = -1;
  for (let i = 0; i <= cov.length; i++) {
    const ok = i < cov.length && cov[i] <= T;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) { if (!best || i - start > best.len) best = { a: lo + start, b: lo + i - 1, len: i - start }; start = -1; }
  }
  if (!best) return null;
  const split = (best.a + best.b) / 2;
  const left = items.filter(i => i.x1 <= split), right = items.filter(i => i.x >= split);
  if (left.length < items.length * 0.15 || right.length < items.length * 0.15) return null;
  // bordas reais das colunas: direita da coluna esquerda e esquerda da coluna direita
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  // (texto de verdade, com mais de 4 caracteres, sempre conta: uma única linha comprida
  // numa coluna cheia de figuras define a borda)
  const long = (i) => i.s.trim().length > 4;
  const gL = Math.max(pct(left.map(i => i.x1), 0.97), ...left.filter(long).map(i => i.x1));
  const gR = Math.min(pct(right.map(i => i.x), 0.03), ...right.filter(long).map(i => i.x));
  if (!(gR - gL >= 4)) return { gx0: split - 1.5, gx1: split + 1.5, split };
  return { gx0: gL + 0.8, gx1: gR - 0.8, split };
}

function buildLines(items, tol) {
  const sorted = [...items].sort((p, q) => p.y - q.y || p.x - q.x);
  const lines = [];
  for (const it of sorted) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(it.y - L.y) <= tol) { L.items.push(it); } else lines.push({ y: it.y, items: [it] });
  }
  for (const L of lines) {
    L.items.sort((p, q) => p.x - q.x);
    L.x0 = Math.min(...L.items.map(i => i.x));
    L.x1 = Math.max(...L.items.map(i => i.x1));
    L.top = Math.min(...L.items.map(i => i.top));
    L.bottom = Math.max(...L.items.map(i => i.bottom));
    L.text = L.items.map(i => i.s).join(' ').replace(/\s+/g, ' ').trim();
    L.h = Math.max(...L.items.map(i => i.h));
  }
  return lines;
}

export async function detectQuestions(pdf, { onProgress } = {}) {
  const pages = [];
  for (let pn = 1; pn <= pdf.numPages; pn++) {
    pages.push(await readPage(pdf, pn));
    onProgress?.(pn / pdf.numPages * 0.8);
  }

  // Fonte e tamanho do corpo do texto por página (o PDF.js renomeia fontes por página)
  const bodyFonts = new Map();
  for (const p of pages) {
    const fc = new Map();
    for (const it of p.items) fc.set(it.f, (fc.get(it.f) || 0) + it.s.length);
    bodyFonts.set(p.pn, [...fc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]);
  }
  const bodyH = median(pages.flatMap(p => p.items.filter(i => i.f === bodyFonts.get(p.pn)).map(i => i.h))) || 9;
  const tol = Math.max(1.5, bodyH * 0.36);
  const isBody = (it) => it.f === bodyFonts.get(it.pn);
  for (const p of pages) for (const it of p.items) it.pn = p.pn;

  // Cabeçalho/rodapé corrido: linha mais alta (ou mais baixa) de cada página,
  // isolada do resto e na mesma altura na maioria das páginas. O "cabeçalho" pode ter
  // até 3 linhas coladas (ex.: carimbo do site + título corrido com o número da página).
  const letters = (t) => t.replace(/[^\p{L}]/gu, '').toLowerCase();
  const edgeY = (which) => {
    const rows = [];
    for (const p of pages) {
      const ls = buildLines(p.items, tol).sort((a, b) => a.y - b.y);
      if (ls.length < 3) continue;
      if (which === 'bottom') ls.reverse();
      const inZone = (L) => which === 'top' ? L.y < p.H * 0.12 : L.y > p.H * 0.88;
      const gapOf = (a, b) => which === 'top' ? b.top - a.bottom : a.top - b.bottom;
      let k = 0;
      while (k < 2 && k + 2 < ls.length && inZone(ls[k + 1]) && gapOf(ls[k], ls[k + 1]) <= bodyH * 1.5) k++;
      const a = ls[k], b = ls[k + 1];
      if (inZone(ls[0]) && inZone(a) && gapOf(a, b) > bodyH * 1.5) rows.push({ pn: p.pn, y: a.y, text: ls.slice(0, k + 1).map(L => L.text).join(' ') });
    }
    // cabeçalho/rodapé de verdade tem número de página ou repete o mesmo texto em várias páginas
    const texts = rows.map(r => r.text);
    const looksLikeHead = (t) => /(^|\s)\d{1,4}(\s|$)/.test(t) || texts.filter(x => letters(x) && letters(x) === letters(t)).length >= 2;
    const ok = rows.filter(r => looksLikeHead(r.text));
    const m = mode(ok.map(r => Math.round(r.y)));
    const hits = ok.filter(r => Math.abs(r.y - m) < 3);
    if (hits.length < Math.max(2, pages.length * 0.5)) return null;
    // vale para as páginas onde foi achado e para as que têm uma linha "de cabeçalho" nessa altura
    // (página recortada, sem cabeçalho, fica inteira)
    const set = new Set(hits.map(r => r.pn));
    for (const p of pages) {
      if (set.has(p.pn)) continue;
      if (buildLines(p.items, tol).some(L => Math.abs(L.y - m) < 3 && (/(^|\s)\d{1,4}(\s|$)/.test(L.text) || texts.some(x => letters(x) && letters(x).includes(letters(L.text)) && letters(L.text).length > 3)))) set.add(p.pn);
    }
    return { y: m, pages: set };
  };
  const head = pages.length > 1 ? edgeY('top') : null;
  const foot = pages.length > 1 ? edgeY('bottom') : null;

  // Listas no formato "Exercício 1" / "Questão 2" com o rótulo sozinho na linha e sempre na
  // margem esquerda (listas de professor feitas em LaTeX): a página é de uma coluna só, mesmo
  // quando os itens (a), (b), (c) ficam lado a lado e parecem formar colunas
  const LABEL_RE = /^(?:Quest[ãa]o|Exerc[ií]cio|Problema)\s*\d{1,3}\s*[:.)]?$/i;
  const labelLines = [];
  for (const p of pages) for (const L of buildLines(p.items, tol)) if (LABEL_RE.test(L.text)) labelLines.push({ L, W: p.W });
  const singleColumn = labelLines.length >= 2 && labelLines.every(({ L, W }) => L.x0 < W * 0.35);

  // Título do documento ("LISTA 7", "Lista de Exercícios 3") no alto da 1ª página: vira o nome da lista
  const TITLE_RE = /^lista\s*(?:de\s+exerc[ií]cios\s*)?(?:n[º°o.]?\s*)?\d{1,3}\b/i;
  let docTitle = null;
  if (pages.length) for (const L of buildLines(pages[0].items, tol)) if (L.y < pages[0].H * 0.3 && TITLE_RE.test(L.text)) { docTitle = L.text.match(TITLE_RE)[0]; break; }

  // ---- 1. Layout: cabeçalho/rodapé, colunas, barreiras de largura total, ordem de leitura
  const units = [];      // unidades de fluxo na ordem de leitura
  let segId = 0;         // faixa horizontal da página (entre barreiras de largura total)
  const captions = [];
  const pageInfo = [];
  const gridAt = new Map();   // páginas em grade → x do número da coluna da direita
  for (const p of pages) {
    // número de página: só dígitos, na borda da página e sozinho na sua linha
    const isPageNum = (i) => /^\d{1,4}$/.test(i.s.trim()) && (i.y > p.H * 0.93 || i.y < p.H * 0.07)
      && !p.items.some(o => o !== i && o.s.trim() && Math.abs(o.y - i.y) < bodyH * 1.5);
    let top = head?.pages.has(p.pn) ? head.y + 3 : p.H * 0.03, bot = foot?.pages.has(p.pn) ? foot.y - 3 : p.H * 0.975;
    for (const i of p.items) if (isPageNum(i)) { if (i.y > p.H / 2) bot = Math.min(bot, i.top - 2); else top = Math.max(top, i.y + 2); }
    // número de página solto no topo ou no pé também sai
    const items = p.items.filter(i => i.y > top && i.y < bot && !isPageNum(i));
    // página "em grade" (questão n à esquerda e n+1 à direita, na mesma altura, em várias linhas,
    // como nas listas digitadas do Zill): é uma coluna só com células; assim uma questão de
    // largura inteira no meio da grade não é cortada ao meio pela calha
    const numOf = (i) => { const m = i.s.trim().match(/^(?:\d{1,2}\.)?(\d{1,3})[.)]?$/); return m && NUM_ITEM_RE.test(i.s.trim()) ? +m[1] : null; };
    const nums = items.map(i => [i, numOf(i)]).filter(([, n]) => n != null);
    const gridX = [];
    for (const [a, na] of nums) { const b = nums.find(([b, nb]) => a.x1 < p.W * 0.45 && b.x > a.x1 + p.W * 0.25 && nb === na + 1 && Math.abs(b.y - a.y) < tol); if (b) gridX.push(b[0]); }
    // formato dos números da grade ("12." ou "6.12"): título "7.2 Exercícios" não é questão
    const gridPlain = gridX.length && gridX.every(i => /^\d{1,3}[.)]$/.test(i.s.trim()));
    if (gridX.length >= 2) gridAt.set(p.pn, median(gridX.map(i => i.x)));
    const g = singleColumn ? null : findGutter(items, p.W);
    const info = { pn: p.pn, W: p.W, H: p.H, gutter: g, cols: [], barriers: [] };
    pageInfo.push(info);
    const xMin = Math.min(...items.map(i => i.x), p.W * 0.1), xMax = Math.max(...items.map(i => i.x1), p.W * 0.9);

    let cols, barrierLines = [];
    if (g) {
      const all = buildLines(items, tol);
      // linha de largura total: algo dentro da calha E conteúdo dos dois lados dela
      // (números de questão pendurados na calha não contam)
      for (const L of all) {
        if (!(L.x0 < g.gx0 - 5 && L.x1 > g.gx1 + 5)) continue;
        const crosses = L.items.some(i => i.x < g.gx0 + 1 && i.x1 > g.gx1 - 1);
        const inside = L.items.some(i => i.x < g.gx1 - 1 && i.x1 > g.gx0 + 1 && i.s.trim().length > 4);
        // letra grande de verdade (chave "{" de equação também vem com altura grande, mas não é título)
        const bigLetters = L.items.filter(i => i.h >= bodyH * 1.4).reduce((s, i) => s + (i.s.match(/\p{L}/gu) || []).length, 0);
        const big = bigLetters >= 3 && L.items.some(i => i.x1 <= g.split) && L.items.some(i => i.x >= g.split);
        if (crosses || inside || big) barrierLines.push(L);
      }
      // título grande numa coluna só, com a outra coluna vazia nessa altura: também divide a página
      // (no Sadiku a faixa cinza de "Problemas abrangentes" cobre as duas colunas, mas o texto fica à esquerda)
      for (const L of all) {
        if (barrierLines.includes(L) || L.h < bodyH * 1.25 || L.items.some(isBody)) continue;
        if ((L.text.match(/\p{L}/gu) || []).length < 4) continue;
        const leftSide = L.x1 <= g.split, rightSide = L.x0 >= g.split;
        if (!leftSide && !rightSide) continue;
        const pad = bodyH * 0.8;
        const other = items.some(i => (leftSide ? i.x >= g.split : i.x1 <= g.split) && i.bottom > L.top - pad && i.top < L.bottom + pad);
        if (!other) barrierLines.push(L);
      }
      // página em grade: questão à esquerda sem par à direita ocupa a largura toda (da linha do
      // número até a próxima questão), como uma questão comprida no meio de uma lista em pares
      const gx = gridAt.get(p.pn);
      if (gx != null) {
        const isNum = (i) => gridPlain ? /^\d{1,3}[.)]$/.test(i.s.trim()) : NUM_ITEM_RE.test(i.s.trim());
        const numAt = (L, side) => L.items.some(i => isNum(i) && (side === 'L' ? i.x < xMin + bodyH * 2 : Math.abs(i.x - gx) < 4));
        for (let k = 0; k < all.length; k++) {
          const L = all[k];
          if (!numAt(L, 'L') || all.some(R => Math.abs(R.y - L.y) < bodyH * 1.5 && numAt(R, 'R'))) continue;
          // o alto da fórmula do número (1ª linha dos casos, numerador) vem antes, na mesma faixa
          for (let j = k - 1; j >= 0; j--) {
            const M = all[j];
            if (numAt(M, 'L') || numAt(M, 'R') || CONTEXT_RE.test(M.text) || L.y - M.y > bodyH * 2.2) break;
            if (!barrierLines.includes(M)) barrierLines.push(M);
          }
          let end = k + 1;
          while (end < all.length && !numAt(all[end], 'L') && !numAt(all[end], 'R') && !CONTEXT_RE.test(all[end].text)) end++;
          const nextY = end < all.length ? all[end].y : Infinity;
          for (let j = k; j < end; j++) {
            const M = all[j];
            if (j > k && nextY - M.y < bodyH * 1.2) break;     // já é o alto da fórmula da próxima linha
            if (!barrierLines.includes(M)) barrierLines.push(M);
          }
        }
      }
      barrierLines.sort((a, b) => a.top - b.top);
      const lIt = items.filter(i => (i.x + i.x1) / 2 < g.split), rIt = items.filter(i => (i.x + i.x1) / 2 >= g.split);
      cols = [
        { side: 'L', x0: xMin - 3, x1: Math.min(g.split, Math.max(g.gx0, ...lIt.filter(i => i.x1 < g.gx1).map(i => i.x1)) + 2), lo: -Infinity, hi: g.split },
        { side: 'R', x0: Math.max(g.split, Math.min(g.gx1, ...rIt.map(i => i.x)) - 2), x1: xMax + 3, lo: g.split, hi: Infinity },
      ];
      // vão largo sem texto entre as colunas costuma ter figura (que não é texto): divide pelo meio
      if (cols[1].x0 - cols[0].x1 > 30) { const m = (g.gx0 + g.gx1) / 2; cols[0].x1 = m - 1.5; cols[1].x0 = m + 1.5; cols[0].hi = cols[1].lo = m; }
    } else cols = [{ side: 'C', x0: xMin - 3, x1: xMax + 3, lo: -Infinity, hi: Infinity }];
    info.cols = cols;

    // agrupa linhas de barreira próximas em blocos
    const blocks = [];
    for (const L of barrierLines) {
      const B = blocks[blocks.length - 1];
      if (B && L.top - B.bottom < bodyH * 1.6) { B.lines.push(L); B.bottom = Math.max(B.bottom, L.bottom); }
      else blocks.push({ lines: [L], top: L.top, bottom: L.bottom });
    }
    info.barriers = blocks.map(b => ({ top: b.top, bottom: b.bottom }));
    const inBarrier = new Set(blocks.flatMap(b => b.lines.flatMap(L => L.items)));

    // com cabeçalho corrido, a faixa começa logo abaixo dele (sem pegar o pé das letras do cabeçalho)
    let yCursor = head?.pages.has(p.pn) ? top - 0.5 : top - 4;
    const segs = [];
    for (const B of blocks) { segs.push({ top: yCursor, bottom: B.top - 3 }); segs.push({ barrier: B }); yCursor = B.bottom + 3; }
    segs.push({ top: yCursor, bottom: bot + 2 });

    for (const s of segs) {
      segId++;
      if (s.barrier) {
        const lines = s.barrier.lines;
        units.push({ pn: p.pn, seg: segId, side: 'F', x0: xMin - 3, x1: xMax + 3, top: s.barrier.top - 2, bottom: s.barrier.bottom + 2, lines, full: true });
        continue;
      }
      for (const c of cols) {
        const its = items.filter(i => !inBarrier.has(i) && i.y >= s.top && i.y <= s.bottom + 1 && (i.x + i.x1) / 2 >= c.lo && (i.x + i.x1) / 2 < c.hi);
        if (!its.length) continue;
        const lines = buildLines(its, tol);
        units.push({ pn: p.pn, seg: segId, side: c.side, x0: c.x0, x1: c.x1, top: s.top, bottom: s.bottom, lines });
      }
    }
  }

  // Linhas com várias questões lado a lado viram "células" separadas
  const CELL_RE = /^[•·◦*]*\s*(?:\d{1,3}[.)](?!\d)|\d{1,2}\.\d{1,3}\.?(?![\d,]))/;
  for (const u of units) {
    const gx = gridAt.get(u.pn);   // página em grade: o número da direita fica sempre nessa posição
    const out = [];
    for (const L of u.lines) {
      const cuts = [0];
      for (let k = 1; k < L.items.length; k++) {
        const it = L.items[k], prev = L.items[k - 1];
        if (CELL_RE.test(it.s.trim()) && (it.x - prev.x1 > bodyH * 1.4 || (gx != null && Math.abs(it.x - gx) < 3 && it.x - prev.x1 > bodyH * 0.3))) cuts.push(k);
      }
      if (cuts.length === 1 || !CELL_RE.test(L.items[0].s.trim())) { out.push(L); continue; }
      cuts.forEach((c, j) => {
        const its = L.items.slice(c, cuts[j + 1] ?? L.items.length);
        const cell = { y: L.y, items: its, x0: its[0].x, x1: Math.max(...its.map(i => i.x1)), top: L.top, bottom: L.bottom, h: L.h,
          text: its.map(i => i.s).join(' ').replace(/\s+/g, ' ').trim(), cellX0: its[0].x - 3, rowY: L.y };
        if (j > 0) cell.isCell = true;
        out.push(cell);
      });
      for (let j = 0; j < out.length - 1; j++) if (out[j].rowY === L.y && out[j + 1].rowY === L.y) out[j].cellX1 = out[j + 1].cellX0 - 3;
    }
    u.lines = out;
  }

  // Recuo do texto por coluna (moda do x inicial das linhas do corpo)
  for (const u of units) {
    // recuo do texto corrido: x inicial mais comum, pesado pela quantidade de texto da linha
    // (assim equações centralizadas e rótulos de figura, que têm pouco texto, não decidem)
    const w = new Map();
    for (const L of u.lines) if (Math.abs(L.h - bodyH) < bodyH * 0.2) { const k = Math.round(L.x0); w.set(k, (w.get(k) || 0) + L.text.length); }
    let best = null, bw = -1; for (const [k, v] of w) if (v > bw) { bw = v; best = k; }
    u.textIndent = best ?? u.x0;
    u.leftEdge = Math.min(...u.lines.map(L => L.x0));
  }

  // Lista global de linhas na ordem de leitura
  const flow = [];
  units.forEach((u, ui) => {
    u.lines.sort((a, b) => a.top - b.top);
    for (const L of u.lines) { L.ui = ui; L.pn = u.pn; flow.push(L); }
  });

  // Legendas de figura: item que casa com FIGURA X e não está no meio de uma frase
  for (const L of flow) {
    L.items.forEach((it, k) => {
      const m = it.s.trim().match(CAPTION_RE);
      if (!m) return;
      const prev = L.items[k - 1];
      if (prev && it.x - prev.x1 < 12) return; // referência no meio do texto
      captions.push({ label: normFig(m[2]), raw: m[0], pn: L.pn, ui: L.ui, x0: it.x, x1: it.x1, top: it.top, bottom: it.bottom, line: L });
    });
  }

  // ---- 2. Candidatos a início de questão
  const charsInBody = (L) => { let b = 0, t = 0; for (const i of L.items) { t += i.s.length; if (isBody(i)) b += i.s.length; } return t ? b / t : 0; };
  let bestPat = null;
  for (const P of PATTERNS) {
    const cands = [];
    for (const L of flow) {
      const u = units[L.ui];
      const m = L.text.match(P.re);
      if (!m) continue;
      if (!L.isCell && L.x0 > u.leftEdge + Math.max(25, bodyH * 3)) continue; // número precisa estar na margem
      if (L.h < bodyH * 0.8) continue;                          // rótulo de figura (fonte pequena)
      cands.push({ L, n: +m[P.g || 1], chap: P.g ? +m[1] : null, m });
    }
    const acc = acceptSequence(readingOrder(cands, units));
    if (!bestPat || acc.length > bestPat.acc.length) bestPat = { P, acc };
  }
  // número que o livro imprimiu sem o ponto ("78" em vez de "78."): se falta exatamente um
  // número na sequência, procura entre as duas questões vizinhas uma linha que comece só com
  // ele, na margem e na mesma fonte dos outros números da página
  if (bestPat && !bestPat.P.g) {
    const acc = bestPat.acc, flowIdx = new Map(flow.map((L, i) => [L, i]));
    const numFont = new Map(); for (const c of acc) numFont.set(c.L.pn, c.L.items[0].f);
    for (let k = acc.length - 2; k >= 0; k--) {
      const a = acc[k], b = acc[k + 1];
      if (b.n !== a.n + 2) continue;
      const want = a.n + 1;
      for (let i = flowIdx.get(a.L) + 1; i < flowIdx.get(b.L); i++) {
        const L = flow[i], it = L.items[0], u = units[L.ui];
        if (!it || it.s.trim() !== String(want)) continue;
        if (numFont.has(L.pn) && it.f !== numFont.get(L.pn)) continue;
        if (!L.isCell && L.x0 > u.leftEdge + Math.max(25, bodyH * 3)) continue;
        if (L.h < bodyH * 0.8 || L.items.length < 2) continue;
        const m = [it.s.trim(), String(want)];
        acc.splice(k + 1, 0, { L, n: want, chap: null, m });
        break;
      }
    }
  }
  const starts = new Map(); // linha -> candidato aceito
  // numeração recomeça → nova lista; a ordem é a de leitura (por linha em páginas em grade)
  { let sr = -1, prev = null; (bestPat?.acc || []).forEach((c, k) => { if (prev === null || c.n <= prev) sr++; prev = c.n; c.series = sr; c.order = k; starts.set(c.L, c); }); }
  // marca as faixas da página que estão "em grade" (questões lado a lado, lidas por linha)
  {
    const acc = bestPat?.acc || [];
    for (const c of acc) {
      const u = units[c.L.ui]; if (u.side !== 'L') continue;
      if (acc.some(d => { const v = units[d.L.ui]; return v.side === 'R' && v.pn === u.pn && v.seg === u.seg && Math.abs(d.L.y - c.L.y) < 4 && d.n === c.n + 1; }))
        u.pairs = (u.pairs || 0) + 1;
    }
    for (const u of units) if (u.side === 'L' && u.pairs >= 2) for (const v of units) if (v.pn === u.pn && v.seg === u.seg) v.grid = true;
  }

  // ---- 3. Títulos (encerram a questão anterior e dão nome às seções)
  for (let fi = 0; fi < flow.length; fi++) {
    const L = flow[fi];
    if (starts.has(L)) continue;
    const u = units[L.ui];
    const t = L.text;
    if (t.length < 3 || t.length > 90) continue;
    // logo depois de um rótulo sozinho ("Exercício 5") vem o enunciado, não um título
    const prevL = flow[fi - 1];
    if (prevL && starts.has(prevL) && LABEL_RE.test(prevL.text) && prevL.pn === L.pn) continue;
    // frase comprida não é título (contando "Q U E S T Õ E S" como uma palavra só)
    const words = L.items.map(i => /^(\S )+\S$/.test(i.s.trim()) ? i.s.replace(/ /g, '') : i.s).join(' ').trim().split(/\s+/).length;
    if (!SECTION_RE.test(t) && words > 12) continue;
    if (CAPTION_RE.test(t)) continue;
    if (/^[(]?\d{1,3}[.)]\s/.test(t) || /[=<>≤≥−+]/.test(t)) continue;  // questão ou fórmula, não título
    if (/^\(?[a-z]\)/i.test(t)) continue;                                  // item (a), (b)…
    if ((t.match(/\p{L}/gu) || []).length < 3) continue;                   // precisa ter letras de verdade
    // e ao menos uma palavra (pedaço de equação tipo "i 30 e A, t 7 0" não é título)
    const collapsed = L.items.map(i => /^(\S )+\S$/.test(i.s.trim()) ? i.s.replace(/ /g, '') : i.s).join(' ');
    if (!/\p{L}{3,}/u.test(collapsed)) continue;
    if (/[.:;]$/.test(t) && t.split(/\s+/).length > 5) continue;         // frase, não título
    if (L.h < bodyH * 0.75) continue;
    const caps = t.replace(/[^\p{L}]/gu, '');
    const allCaps = caps.length >= 6 && caps === caps.toUpperCase();
    const nonBody = charsInBody(L) < 0.3;
    if (!(allCaps || nonBody)) continue;
    if (!allCaps && L.h < bodyH * 0.9) continue;
    // "Seção 7.2 …" pode vir recuado (dentro de uma faixa com marcador, como no Sadiku)
    if (!u.full && L.x0 > u.leftEdge + (SECTION_RE.test(t) ? bodyH * 3 : 6)) continue;
    L.heading = true;
    L.isSection = SECTION_RE.test(t);
    // títulos espaçados tipo "E X E R C Í C I O S"
    L.headingText = L.items.map(i => /^(\S )+\S$/.test(i.s.trim()) ? i.s.replace(/ /g, '') : i.s).join(' ').replace(/\s+/g, ' ').trim();
  }

  // título de seção quebrado em duas linhas ("Seção 7.5 Resposta a um degrau de um" / "circuito RC")
  for (const u of units) {
    for (let j = 0; j + 1 < u.lines.length; j++) {
      const L = u.lines[j], N = u.lines[j + 1];
      if (!L.heading || !L.isSection || N.heading || starts.has(N)) continue;
      if (N.x0 > L.x0 - 3 && N.x0 < L.x1 && N.top - L.bottom < bodyH * 0.7 && Math.abs(N.h - L.h) < 1 && charsInBody(N) < 0.3 && N.text.length < 60)
        L.headingText += ' ' + N.text;
    }
  }

  // ---- 4. Parágrafos soltos (recuados à esquerda do texto) e contexto compartilhado
  for (const L of flow) {
    if (starts.has(L) || L.heading) continue;
    if (CAPTION_RE.test(L.text)) continue;   // legenda fica com a questão que mostra a figura
    const u = units[L.ui];
    const colW = u.x1 - u.x0;
    // parágrafo solto começa na margem dos números; linha que só fica à esquerda do recuo dos
    // subitens (a., b.) mas à direita do número ainda é texto da questão
    const outdent = L.x0 < u.textIndent - 4 && L.x0 < u.leftEdge + bodyH * 0.8;
    const wideBody = charsInBody(L) > 0.7 && Math.abs(L.h - bodyH) < bodyH * 0.25 && (L.x1 - L.x0) > colW * 0.5;
    // "Nos Problemas 19-42, use…": instrução que vale para um intervalo de questões
    const ctxLine = CONTEXT_RE.test(L.text) && L.x0 <= u.leftEdge + 6 && !/^\d/.test(L.text);
    // nas listas com rótulo ("Exercício 1"), tudo até o próximo rótulo é da questão
    if (ctxLine || (!singleColumn && outdent && wideBody && u.textIndent - u.leftEdge > 4)) {
      L.loose = true;
      const m = L.text.match(CONTEXT_RE);
      if (m) L.contextRange = [+m[1], +m[2]];
    }
  }

  // Número centrado numa fórmula alta (chave de casos, fração): "1. f(x) = {" fica no meio da
  // fórmula e a parte de cima dela (1ª linha dos casos, numerador) vem antes, no fluxo.
  // Devolve o topo da fórmula quando ela é simétrica em torno da linha do número.
  function formulaTop(u, li, st) {
    const L = u.lines[li];
    const after = L.text.slice(st.m[0].length).trim();
    const looksFormula = after.length <= 14 || /^[^=]{0,10}=/.test(after) || /[={(]\s*$/.test(after) || L.items.some(i => i.h >= bodyH * 1.6);
    const cx0 = L.cellX0 ?? u.x0, cx1 = L.cellX1 ?? u.x1;
    const numX1 = L.items[0].x1;
    // altura "visível" das letras (a do PDF.js é o corpo inteiro da fonte); chaves e
    // parênteses grandes não contam, porque o glifo deles pende abaixo da linha de base
    const part = (P) => {
      const over = P.items.filter(i => i.x < cx1 && i.x1 > cx0);
      const its = over.filter(i => /[\p{L}\p{N}=<>≤≥+\-−∞]/u.test(i.s) && !/^[(){}\[\]|\u23A7-\u23AD]$/.test(i.s.trim()));
      if (!its.length) return null;
      const wide = over.some(i => i.x < cx0 - 1 || i.x1 > cx1 + 2);   // linha que atravessa a célula
      const full = its.filter(i => i.h >= bodyH * 0.8);      // linha de base só das letras de tamanho normal
      return { wide, t: its.map(i => i.s).join(' '), top: Math.min(...its.map(i => i.y - 0.75 * i.h)), bottom: Math.max(...its.map(i => i.y + 0.22 * i.h)), x0: Math.min(...its.map(i => i.x)),
        b0: full.length ? Math.min(...full.map(i => i.y)) : null, b1: full.length ? Math.max(...full.map(i => i.y)) : null };
    };
    const me = part(L) || { top: L.top, bottom: L.bottom };
    const stopAt = (P, p) => starts.has(P) || P.heading || P.loose || p.wide || CAPTION_RE.test(P.text) || p.x0 < numX1 + 2;
    const C = []; let ceil = null;            // linhas entre a questão anterior e esta
    for (let k = li - 1; k >= 0 && C.length < 8; k--) {
      const P = u.lines[k], p = part(P); if (!p) continue;
      if (stopAt(P, p)) { ceil = p; break; }
      C.unshift(p);
    }
    if (!C.length) return null;
    const D = []; let floor = null;           // linhas abaixo, até a próxima questão
    for (let k = li + 1; k < u.lines.length && D.length < 8; k++) {
      const P = u.lines[k], p = part(P); if (!p) continue;
      if (stopAt(P, p)) { floor = p; break; }
      D.push(p);
    }
    // a fórmula é um bloco: por dentro as linhas se encostam; nas pontas há folga
    const span = (arr) => { let g = -Infinity; for (let i = 0; i + 1 < arr.length; i++) g = Math.max(g, arr[i + 1].top - arr[i].bottom); return g; };
    let best = null;
    // pedaço de fórmula: curto e sem palavras (numerador "nπ", linha "0, −2 < x < −1")
    const mathy = (x) => x.t.replace(/\s+/g, '').length <= 16 && !/\p{L}{3,}/u.test(x.t.replace(/\b(sen|cos|tg|cotg|sec|cossec|senh|cosh|tgh|ln|log|exp|lim|arc\w*)\b/g, ''));
    for (let a = 0; a < C.length; a++) {
      const upBlk = C.slice(a);
      if (!looksFormula && !upBlk.every(mathy)) continue;
      const gapUp = (a > 0 ? upBlk[0].top - C[a - 1].bottom : ceil ? upBlk[0].top - ceil.bottom : Infinity);
      for (let b = -1; b < D.length; b++) {
        const blk = [...upBlk, me, ...D.slice(0, b + 1)];
        const inner = span(blk);
        const next = b + 1 < D.length ? D[b + 1] : floor;
        const gapDown = next ? next.top - blk[blk.length - 1].bottom : Infinity;
        if (gapUp < inner + bodyH * 0.1 || gapDown < inner + bodyH * 0.1) continue;
        const top = Math.min(...blk.map(x => x.top));
        // simetria em torno do eixo da fórmula (um pouco acima da linha de base do número),
        // medida pelas linhas de base: numerador/denominador, 1ª/última linha dos casos
        const bs = blk.filter(x => x.b0 != null);
        if (!bs.length) continue;
        const axis = L.items[0].y - bodyH * 0.25;     // linha de base do próprio número
        const d = Math.abs((axis - Math.min(...bs.map(x => x.b0))) - (Math.max(...bs.map(x => x.b1)) - axis));
        const prevB = a > 0 ? C[a - 1].b1 : ceil?.b1;
        // a faixa começa um pouco acima da fórmula, sem invadir a linha de base da linha anterior
        const cut = Math.max(top - 2.5, prevB != null ? Math.min(prevB + 1.5, top - 0.5) : -Infinity);
        if (d < bodyH * 0.9 && (!best || d < best.d)) best = { top: cut, d };
      }
    }
    return best ? best.top : null;
  }

  // ---- 5. Percorre o fluxo montando as faixas
  const questions = [];
  const contexts = [];
  let cur = null, curGroup = docTitle, curSection = null, series = 0;
  const openRect = (q, u, top, L) => { q.rects.push({ pn: u.pn, ui: units.indexOf(u), x0: L?.cellX0 ?? u.x0, x1: L?.cellX1 ?? u.x1, top, bottom: u.bottom }); };
  let rowGroup = [];  // questões abertas na mesma linha (células lado a lado)
  const closeRect = (q, y) => { const r = q?.rects[q.rects.length - 1]; if (r && r.bottom > y) r.bottom = y; };

  for (let ui = 0; ui < units.length; ui++) {
    const u = units[ui];
    let openedHere = false, lastLine = null;
    // em grade, a questão não continua da coluna esquerda para o topo da direita
    if (u.grid && cur && !cur.isContext) { cur = null; rowGroup = []; }
    for (let li = 0; li < u.lines.length; li++) {
      const L = u.lines[li];
      const st = starts.get(L);
      const stop = st || L.heading || (L.loose && !(cur && cur.isContext));
      const sameRow = st && L.isCell && cur && openedHere && cur.rowY === L.rowY;
      let lift = st ? formulaTop(u, li, st) : null;
      // primeira célula de uma linha com várias questões: a faixa da linha começa no topo da
      // fórmula mais alta entre elas
      if (st && !sameRow && L.rowY != null) {
        for (let j = li + 1; j < u.lines.length && u.lines[j].rowY === L.rowY; j++) {
          const sj = starts.get(u.lines[j]); if (!sj) continue;
          const lj = formulaTop(u, j, sj);
          if (lj != null) lift = Math.min(lift ?? L.top - 2.5, lj);
        }
      }
      let boundary = lift ?? L.top - 2.5;
      if (stop && !sameRow) {
        if (cur && openedHere) {
          if (lift == null && lastLine) boundary = Math.min(L.y - L.h * 0.85, Math.max(L.top - 1, lastLine.bottom + 0.3));
          for (const q of rowGroup) closeRect(q, boundary);
          closeRect(cur, boundary);
        }
        rowGroup = [];
        cur = null; openedHere = false;
      }
      if (sameRow) { rowGroup.push(cur); boundary = Math.min(cur.rects[cur.rects.length - 1].top, lift ?? Infinity); }
      if (L.heading) {
        // "7.1 Exercícios" parece seção, mas se ainda não há grupo vira o nome da lista
        if (L.isSection && curGroup) curSection = L.headingText; else { curGroup = L.headingText; curSection = null; }
        continue;
      }
      if (st) {
        series = st.series;
        const after = L.text.slice(st.m[0].length).trim();
        const diff = (after.match(/^(\|{1,3}|[•]{1,3})/) || [])[1] || (st.m[0].match(/[•·*]+/) || [''])[0];
        cur = { n: st.n, num: st.chap != null ? `${st.chap}.${st.n}` : String(st.n), rowY: L.rowY, series, order: st.order, group: curGroup, section: curSection, difficulty: diff ? diff.length : 0, rects: [], lines: [], figures: [], context: null };
        questions.push(cur);
        openRect(cur, u, boundary, L);
        openedHere = true;
        cur.lines.push(L); lastLine = L;
        continue;
      }
      if (L.loose && !cur) {
        cur = { isContext: true, range: L.contextRange || null, rects: [], lines: [L], series };
        contexts.push(cur);
        openRect(cur, u, L.top - 2.5);
        openedHere = true;
        continue;
      }
      if (cur) {
        if (!openedHere) { openRect(cur, u, u.full ? u.top : Math.min(u.top + 0, L.top - 2.5)); openedHere = true; }
        if (rowGroup.length && !cur.isContext) {
          // linha que passa por várias células lado a lado: cada pedaço vai para a sua questão
          for (const q of [...rowGroup, cur]) {
            const r = q.rects[q.rects.length - 1];
            const its = L.items.filter(i => (i.x + i.x1) / 2 >= r.x0 && (i.x + i.x1) / 2 < r.x1);
            if (its.length) q.lines.push({ ...L, items: its, x0: its[0].x, text: its.map(i => i.s).join(' ').replace(/\s+/g, ' ').trim() });
          }
        } else cur.lines.push(L);
        lastLine = L;
      }
    }
  }

  questions.sort((a, b) => a.order - b.order);

  // ---- 6. Pós-processamento: rótulos, texto, figuras referenciadas, contexto
  const groupsBySeries = new Map();
  // texto de cada questão = o que está dentro das faixas dela (as faixas já foram ajustadas:
  // linha de cima dos casos, células lado a lado, largura inteira…)
  for (const q of questions) {
    const parts = [];
    for (const r of q.rects) {
      const u = units[r.ui]; if (!u) continue;
      for (const L of u.lines) {
        const its = L.items.filter(i => { const cx = (i.x + i.x1) / 2, cy = i.y - i.h * 0.3; return cx >= r.x0 && cx < r.x1 && cy >= r.top && cy < r.bottom; });
        if (its.length) parts.push(its.length === L.items.length ? L : { ...L, orig: L, items: its, x0: its[0].x, text: its.map(i => i.s).join(' ').replace(/\s+/g, ' ').trim() });
      }
    }
    if (parts.length) {
      const ls = [...new Set(parts)];
      const k = ls.findIndex(L => starts.has(L.orig ?? L));    // o texto começa pelo número da questão
      if (k > 0) ls.unshift(...ls.splice(k, 1));
      q.lines = ls;
    }
  }
  for (const q of questions) {
    q.text = q.lines.map(L => L.text).join(' ').replace(/\s+-\s+/g, '').replace(/\s+/g, ' ');
    if (!groupsBySeries.has(q.series)) groupsBySeries.set(q.series, q.group);
    q.seriesName = prettify(groupsBySeries.get(q.series) || `Lista ${q.series + 1}`);
    q.groupName = prettify(q.group || q.seriesName);
    q.key = `${q.series}:${q.n}`;
    q.subitems = [...new Set(q.lines.filter(L => Math.abs(L.x0 - units[L.ui].textIndent) < 10 || starts.has(L.orig ?? L)).map(L => (L.text.match(/^(?:\d{1,3}\.\s*(?:\|+\s*)?)?\(?([a-h])[.)]\s/) || [])[1]).filter(Boolean))];
    // figuras citadas no texto
    const refs = new Set();
    for (const m of (q.lines.map(L => L.text).join(' ')).matchAll(FIG_REF_RE)) refs.add(normFig(m[1]));
    q.figRefs = [...refs];
    for (const lab of refs) {
      const cap = captions.find(c => c.label === lab);
      if (!cap) continue;
      const inside = q.rects.some(r => r.pn === cap.pn && cap.x0 >= r.x0 - 2 && cap.x1 <= r.x1 + 2 && cap.top >= r.top - 2 && cap.bottom <= r.bottom + 2);
      if (inside) continue;
      q.figures.push({ label: lab, ...figureRegion(cap, units, captions, bodyH, isBody) });
    }
    q.rects = q.rects.filter(r => r.bottom - r.top > 3).map(({ ui, ...r }) => r);
    delete q.lines;
  }
  for (const c of contexts) {
    if (!c.range) continue;
    for (const q of questions) if (q.series === c.series && q.n >= c.range[0] && q.n <= c.range[1]) q.context = { text: c.lines.map(L => L.text).join(' '), rects: c.rects.map(({ ui, ...r }) => r) };
  }

  onProgress?.(1);
  return {
    pattern: bestPat?.P.id || null,
    bodyH,
    pages: pageInfo,
    questions,
    captions: captions.map(({ line, ...c }) => c),
  };
}

// Ordem de leitura dos candidatos. Em páginas "em grade" (1 | 2 na mesma linha, 3 | 4 na
// seguinte, como no Zill), lê por linha; nas outras, desce a coluna esquerda e depois a direita.
function readingOrder(cands, units) {
  const groups = new Map();
  cands.forEach((c, i) => { const u = units[c.L.ui]; const k = u.pn + ':' + u.seg; if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ c, i, u }); });
  const out = [];
  for (const g of groups.values()) {
    const left = g.filter(x => x.u.side === 'L'), right = g.filter(x => x.u.side === 'R');
    let paired = 0;
    for (const a of left) if (right.some(b => Math.abs(b.c.L.y - a.c.L.y) < 4 && b.c.n === a.c.n + 1)) paired++;
    const grid = left.length >= 2 && paired >= 2 && paired >= left.length * 0.4;
    if (grid) g.sort((a, b) => (Math.abs(a.c.L.y - b.c.L.y) < 4 ? a.c.L.x0 - b.c.L.x0 : a.c.L.y - b.c.L.y));
    else g.sort((a, b) => a.i - b.i);
    out.push(...g.map(x => x.c));
  }
  return out;
}

// Aceita candidatos que formam sequência 1,2,3… (permite recomeço em 1 e pequenos saltos)
function acceptSequence(cands) {
  const acc = [];
  let prev = null;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i], n = c.n;
    const next = cands.slice(i + 1, i + 4).map(x => x.n);
    const confirmed = next.includes(n + 1) || next.includes(n + 2);
    let ok = false;
    if (prev === null) ok = n === 1 || confirmed;
    else if (n === prev + 1) ok = true;
    else if (n === 1 && confirmed) ok = true;
    else if (n > prev + 1 && n <= prev + 4 && confirmed) ok = true;
    if (ok) { acc.push(c); prev = n; }
  }
  return acc;
}

// Região de uma figura a partir da legenda: sobe até a linha de texto corrido mais próxima
function figureRegion(cap, units, captions, bodyH, isBody) {
  const u = units[cap.ui];
  const sameRow = captions.filter(c => c.pn === cap.pn && c.ui === cap.ui && Math.abs(c.top - cap.top) < 3).sort((a, b) => a.x0 - b.x0);
  const idx = sameRow.indexOf(cap);
  const prev = sameRow[idx - 1], next = sameRow[idx + 1];
  const x0 = prev ? (prev.x1 + cap.x0) / 2 : u.x0;
  const x1 = next ? next.x0 - 2 : u.x1;
  const colW = u.x1 - u.x0;
  let top = u.top;
  for (const L of u.lines) {
    if (L.bottom >= cap.top - 1) continue;
    if (L.x1 < x0 || L.x0 > x1) continue;
    const body = L.items.filter(isBody).reduce((s, i) => s + i.s.length, 0) / Math.max(1, L.items.reduce((s, i) => s + i.s.length, 0));
    const isText = Math.abs(L.h - bodyH) < bodyH * 0.15 && (body > 0.5 || L.heading) && ((L.x1 - L.x0) > colW * 0.35 || Math.abs(L.x0 - u.textIndent) < 1.5);
    if (isText) top = Math.max(top, L.bottom + 1.5);
  }
  return { pn: cap.pn, x0, x1, top, bottom: cap.bottom + 3, splitWithPrev: !!prev, splitWithNext: !!next };
}

function prettify(s) {
  if (!s) return s;
  const t = s.trim();
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters && letters === letters.toUpperCase()) return t.charAt(0) + t.slice(1).toLowerCase();
  return t;
}
