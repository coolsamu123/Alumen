#!/usr/bin/env node
/**
 * Fase B — conjunto de referencia (PLAN_PROMPTS_CATALOG_REVIEW.md §4).
 *
 * Tres comandos:
 *
 *   propose   escolhe 10 projetos que cobrem os casos que o plano pede
 *             (muito GIO, muito DDS, documentacao pobre, varias regioes),
 *             mais os dois nomeados, e explica cada escolha
 *
 *   template  gera data/reference-set.json PRE-PREENCHIDO com o que a v4
 *             extrai hoje. A tarefa humana passa a ser revisar e corrigir,
 *             que e onde o julgamento de negocio agrega — transcrever 10
 *             gabaritos do zero nao e
 *
 *   compare   confronta a extracao atual com o gabarito revisado e imprime
 *             precisao de alvo, papel e severidade
 *
 * O gabarito e a VERDADE; a extracao e o que se mede contra ela. Por isso o
 * template marca `reviewed: false` em cada projeto: um gabarito que ninguem
 * olhou nao e gabarito, e comparar contra ele daria uma precisao de 100% que
 * nao significa nada.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'cioo.db');
const OUT_PATH = path.join(__dirname, '..', 'data', 'reference-set.json');
const OBRIGATORIOS = ['PGM0001209', 'PRJ0019818'];
const ALVO = 10;

const db = () => new Database(DB_PATH, { readonly: true });

function carregarProjetos(conn) {
  const linhas = conn.prepare(`
    SELECT p.project_id, p.name, p.dds, g.impact_claims, g.gio_services_touched, g.dds_entities_touched,
           (SELECT COUNT(*) FROM documents_cache d
             WHERE d.project_id = p.project_id AND d.fetch_status = 'success') AS docs
    FROM projects p
    JOIN project_goals g ON g.project_id = p.project_id AND g.status = 'success'
    GROUP BY p.project_id
  `).all();

  return linhas.map(r => {
    let claims = [];
    try { claims = JSON.parse(r.impact_claims) || []; } catch { /* sem claims */ }
    const gio = claims.filter(c => c.target_kind === 'gio').length;
    const dds = claims.filter(c => c.target_kind === 'dds').length;
    return {
      projectId: r.project_id,
      name: r.name,
      owner: r.dds || '',
      docs: r.docs,
      claims,
      gio,
      dds,
      total: claims.length,
    };
  });
}

function propor(projetos) {
  const porId = new Map(projetos.map(p => [p.projectId, p]));
  const escolhidos = [];
  const motivos = new Map();

  const pegar = (p, motivo) => {
    if (!p || escolhidos.some(e => e.projectId === p.projectId)) return false;
    escolhidos.push(p);
    motivos.set(p.projectId, motivo);
    return true;
  };

  for (const id of OBRIGATORIOS) pegar(porId.get(id), 'nomeado no plano');

  const restantes = () => projetos.filter(p => !escolhidos.some(e => e.projectId === p.projectId));

  // muito GIO e muito DDS: os extremos de cada eixo exercitam fronteiras opostas
  [...restantes()].sort((a, b) => b.gio - a.gio).slice(0, 2)
    .forEach(p => pegar(p, `muito GIO (${p.gio} claims)`));
  [...restantes()].sort((a, b) => b.dds - a.dds).slice(0, 2)
    .forEach(p => pegar(p, `muito DDS (${p.dds} claims)`));

  // documentacao pobre: poucos documentos mas analise concluida — onde o
  // modelo tem menos base e mais tendencia a inventar
  [...restantes()].filter(p => p.docs > 0).sort((a, b) => a.docs - b.docs).slice(0, 2)
    .forEach(p => pegar(p, `documentacao pobre (${p.docs} doc)`));

  // varias regioes: um projeto por dono regional ainda nao representado
  const regioes = ['Americas', 'Europe', 'APAC', 'AMEI'];
  for (const reg of regioes) {
    if (escolhidos.length >= ALVO) break;
    const jaTem = escolhidos.some(p => p.owner === reg);
    if (jaTem) continue;
    const cand = restantes().filter(p => p.owner === reg).sort((a, b) => b.total - a.total)[0];
    pegar(cand, `regiao ${reg}`);
  }

  // completa com os de maior volume de claims, que dao mais o que conferir
  for (const p of [...restantes()].sort((a, b) => b.total - a.total)) {
    if (escolhidos.length >= ALVO) break;
    pegar(p, `volume (${p.total} claims)`);
  }

  return escolhidos.map(p => ({ ...p, motivo: motivos.get(p.projectId) }));
}

function cmdPropose() {
  const conn = db();
  const sel = propor(carregarProjetos(conn));
  conn.close();
  console.log(`${sel.length} projeto(s) propostos:\n`);
  for (const p of sel) {
    console.log(`  ${p.projectId}  ${String(p.name).slice(0, 46)}`);
    console.log(`      dono=${p.owner || '—'}  docs=${p.docs}  claims=${p.total} (gio ${p.gio} / dds ${p.dds})`);
    console.log(`      motivo: ${p.motivo}`);
  }
  console.log('\nGere o gabarito com:  node scripts/reference-set.cjs template');
}

function cmdTemplate() {
  if (fs.existsSync(OUT_PATH)) {
    console.error(`${OUT_PATH} ja existe — recusando sobrescrever um gabarito revisado.`);
    console.error('Apague o arquivo se quiser regerar do zero.');
    process.exit(1);
  }
  const conn = db();
  const sel = propor(carregarProjetos(conn));
  conn.close();

  const doc = {
    _comoUsar: [
      'Cada projeto traz o que a v4 extrai HOJE. Revise e corrija: apague o que',
      'estiver errado, acrescente o que faltou, ajuste papel e severidade.',
      'Depois marque reviewed: true — so projetos revisados entram na comparacao.',
    ],
    promptVersion: 4,
    geradoEm: new Date().toISOString(),
    projetos: sel.map(p => ({
      projectId: p.projectId,
      name: p.name,
      motivoDaEscolha: p.motivo,
      reviewed: false,
      esperado: p.claims.map(c => ({
        target_kind: c.target_kind,
        target: c.target,
        role: c.role,
        severity: c.severity,
        impact_type: c.impact_type,
      })),
    })),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(doc, null, 2) + '\n');
  const n = doc.projetos.reduce((a, p) => a + p.esperado.length, 0);
  console.log(`gabarito gerado: ${OUT_PATH}`);
  console.log(`  ${doc.projetos.length} projetos, ${n} entradas pre-preenchidas pela v4`);
  console.log('  todos com reviewed: false — revise antes de comparar');
}

function cmdCompare() {
  if (!fs.existsSync(OUT_PATH)) {
    console.error('sem gabarito. Rode:  node scripts/reference-set.cjs template');
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(OUT_PATH, 'utf-8'));
  const conn = db();
  const atual = new Map(carregarProjetos(conn).map(p => [p.projectId, p]));
  conn.close();

  const revisados = doc.projetos.filter(p => p.reviewed);
  const pulados = doc.projetos.length - revisados.length;
  if (!revisados.length) {
    console.error(`nenhum projeto revisado (${pulados} aguardando). Comparar agora mediria`);
    console.error('a extracao contra ela mesma — 100% sem significado.');
    process.exit(1);
  }

  const chave = (c) => `${c.target_kind}::${c.target}`;
  let alvoOk = 0, alvoFalta = 0, alvoSobra = 0;
  let papelOk = 0, papelTotal = 0, sevOk = 0, sevTotal = 0;

  console.log(`comparando ${revisados.length} projeto(s) revisado(s)` +
              (pulados ? `  (${pulados} ainda sem revisao, fora da conta)` : '') + '\n');

  for (const p of revisados) {
    const real = atual.get(p.projectId);
    if (!real) { console.log(`  ${p.projectId}: sem extracao atual`); continue; }

    const esp = new Map(p.esperado.map(c => [chave(c), c]));
    const obt = new Map(real.claims.map(c => [chave(c), c]));

    const faltando = [...esp.keys()].filter(k => !obt.has(k));
    const aMais = [...obt.keys()].filter(k => !esp.has(k));
    const comuns = [...esp.keys()].filter(k => obt.has(k));

    alvoOk += comuns.length; alvoFalta += faltando.length; alvoSobra += aMais.length;
    for (const k of comuns) {
      papelTotal++; if (esp.get(k).role === obt.get(k).role) papelOk++;
      sevTotal++; if (esp.get(k).severity === obt.get(k).severity) sevOk++;
    }

    const sinal = faltando.length || aMais.length ? '✗' : '✓';
    console.log(`  ${sinal} ${p.projectId}  esperado=${esp.size} obtido=${obt.size}` +
                `  faltando=${faltando.length} a_mais=${aMais.length}`);
    for (const k of faltando) console.log(`        faltou : ${k}`);
    for (const k of aMais)    console.log(`        a mais : ${k}`);
    for (const k of comuns) {
      const e = esp.get(k), o = obt.get(k);
      if (e.role !== o.role)         console.log(`        papel  : ${k}  esperado ${e.role} / obtido ${o.role}`);
      if (e.severity !== o.severity) console.log(`        sever. : ${k}  esperado ${e.severity} / obtido ${o.severity}`);
    }
  }

  const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '—') + '%';
  console.log('\n=== resumo ===');
  console.log(`  alvos certos     : ${alvoOk}  (faltando ${alvoFalta}, a mais ${alvoSobra})`);
  console.log(`  precisao de alvo : ${pct(alvoOk, alvoOk + alvoSobra)}`);
  console.log(`  cobertura        : ${pct(alvoOk, alvoOk + alvoFalta)}`);
  console.log(`  papel correto    : ${pct(papelOk, papelTotal)}  (${papelOk}/${papelTotal})`);
  console.log(`  severidade certa : ${pct(sevOk, sevTotal)}  (${sevOk}/${sevTotal})`);
}

const cmd = process.argv[2];
if (cmd === 'propose') cmdPropose();
else if (cmd === 'template') cmdTemplate();
else if (cmd === 'compare') cmdCompare();
else {
  console.log('uso: node scripts/reference-set.cjs <propose|template|compare>');
  process.exit(1);
}
