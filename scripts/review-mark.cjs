#!/usr/bin/env node
/**
 * Marca um projeto do gabarito como revisado, opcionalmente ajustando entradas.
 *
 *   node scripts/review-mark.cjs PGM0001209                      → aprova como está
 *   node scripts/review-mark.cjs PGM0001209 --sev 3=low          → corrige severidade
 *   node scripts/review-mark.cjs PGM0001209 --target 2=HHC        → corrige o alvo
 *   node scripts/review-mark.cjs PGM0001209 --role 2=risk_owner  → corrige papel
 *   node scripts/review-mark.cjs PGM0001209 --drop 2             → remove a entrada
 *
 * Os índices são os que aparecem na revisão, começando em 1.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'reference-set.json');
const ROLES = ['primary_provider', 'downstream_consumer', 'regional_executor', 'risk_owner', 'blocked_by'];
const SEVS = ['high', 'low'];

const [, , projectId, ...args] = process.argv;
if (!projectId) {
  console.error('uso: node scripts/review-mark.cjs <PROJECT_ID> [--sev N=high|low] [--role N=papel] [--drop N]');
  process.exit(1);
}

// Lidos do fonte em vez de importados: este script roda com node puro, fora do
// bundle do Next, e target-catalog.ts e TypeScript.
function nomesCanonicos(constName) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'target-catalog.ts'), 'utf-8');
  const m = src.match(new RegExp(constName + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const'));
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}
const CANON = {
  gio: nomesCanonicos('CANONICAL_GIO_NAMES'),
  dds: nomesCanonicos('CANONICAL_DDS_NAMES'),
};
const isCanonical = (kind, nome) => (CANON[kind] || []).includes(nome);

const doc = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
const proj = doc.projetos.find(p => p.projectId === projectId);
if (!proj) { console.error(`projeto ${projectId} nao esta no gabarito`); process.exit(1); }

const dropar = [];
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  const val = args[i + 1];
  if (!['--sev', '--role', '--drop', '--target'].includes(flag)) continue;
  i++;
  if (flag === '--drop') { dropar.push(parseInt(val, 10) - 1); continue; }
  const [nRaw, novo] = String(val).split('=');
  const idx = parseInt(nRaw, 10) - 1;
  const alvo = proj.esperado[idx];
  if (!alvo) { console.error(`entrada ${nRaw} nao existe`); process.exit(1); }
  if (flag === '--target') {
    // O nome tem de existir no catalogo: gravar um alvo que a normalizacao nao
    // reconhece cria um gabarito impossivel de acertar.
    if (!isCanonical(alvo.target_kind, novo)) {
      console.error(`alvo ${novo} nao e canonico para kind=${alvo.target_kind}`);
      process.exit(1);
    }
    console.log(`  ${nRaw}. alvo ${alvo.target} -> ${novo}`);
    alvo.target = novo;
    continue;
  }
  if (flag === '--sev') {
    if (!SEVS.includes(novo)) { console.error(`severidade invalida: ${novo}`); process.exit(1); }
    console.log(`  ${nRaw}. ${alvo.target}: severidade ${alvo.severity} -> ${novo}`);
    alvo.severity = novo;
  } else {
    if (!ROLES.includes(novo)) { console.error(`papel invalido: ${novo}`); process.exit(1); }
    console.log(`  ${nRaw}. ${alvo.target}: papel ${alvo.role} -> ${novo}`);
    alvo.role = novo;
  }
}

// De tras para frente, para os indices nao deslizarem sob os pes.
for (const idx of dropar.sort((a, b) => b - a)) {
  const alvo = proj.esperado[idx];
  if (!alvo) { console.error(`entrada ${idx + 1} nao existe`); process.exit(1); }
  console.log(`  ${idx + 1}. ${alvo.target}: removida`);
  proj.esperado.splice(idx, 1);
}

proj.reviewed = true;
proj.reviewedAt = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');

const feitos = doc.projetos.filter(p => p.reviewed).length;
console.log(`\n${projectId} marcado como revisado — ${feitos}/${doc.projetos.length} projetos prontos.`);
