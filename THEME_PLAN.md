# Plano — Tema Light + Toggle (Strom)

> **Atualização 2026-09-14 — revisão do tema.** Partes deste plano foram substituídas:
> - **Três temas:** `dark` passou a ser o Graphite (grafite quase neutro), `light` foi refeito com superfícies em níveis (`--surface-sunken`), e entrou o `dim` (escuro de contraste médio). O toggle virou o `ThemeMenu`, com as opções System/Light/Dark/Dim. "System" é gravado como ausência de `strom-theme`.
> - **Remapeamento `[data-theme="light"] .bg-purple-900\/40 {…}` removido.** Ele era uma lista branca, e 122 usos escapavam dela. Agora `tailwind.config.ts` serve a paleta Tailwind via variáveis `--pal-*` e espelha a escala no light (900→100, 200→800; 500–700 ficam iguais).
> - **Opacidade sobre tokens:** `bg-surface-2/50` etc. não eram gerados. Os tokens agora passam por `color-mix(... <alpha-value> ...)`.
> - **Tags:** o componente `<Tag tone>` usa os tons semânticos `--tone-{tech,vendor,data,dds,gio,neutral,ok,warn,bad,info}-{fg,bg,bd}`.
> - **Cores categóricas (DDS/Gate/Decision/Severity) em texto** passam por `categoryText()`. `--cat-mix` é calibrado por tema para ≥ 4,5:1. Nas arestas do React Flow, usar `severityStroke()`.

Objetivo: oferecer ao usuário (admin ou público) a escolha entre tema **dark** (atual) e **light**, com toggle no header e persistência por browser.

Caminho escolhido: **A — Token refactor**. Default: respeita `prefers-color-scheme` do SO.

---

## 1. Arquitetura

**Semântica** em vez de cor literal. Componentes consomem tokens — nunca classes Tailwind crus de `gray-*` / hex literais.

### Tokens (definidos em `src/app/globals.css`)

| Token | Dark | Light | Uso |
|---|---|---|---|
| `--bg` | `#0a0e1a` | `#f5f7fa` | body |
| `--surface` | `#0d1117` | `#ffffff` | header, toolbar, sidebar |
| `--surface-1` | `#111827` | `#ffffff` | cards |
| `--surface-2` | `#1f2937` | `#eef1f5` | hover, selected card |
| `--surface-3` | `#374151` | `#dde2e8` | buttons, chips |
| `--surface-deep` | `#030712` | `#f8fafc` | inputs, inset |
| `--ink-1` | `#f3f4f6` | `#0f172a` | títulos |
| `--ink-2` | `#e5e7eb` | `#1e293b` | subtítulos |
| `--ink-3` | `#d1d5db` | `#334155` | corpo |
| `--ink-4` | `#9ca3af` | `#475569` | secundário |
| `--ink-muted` | `#6b7280` | `#64748b` | labels, hints |
| `--ink-faint` | `#4b5563` | `#94a3b8` | metadata sutil |
| `--border` | `#1f2937` | `#e2e8f0` | bordas suaves |
| `--border-strong` | `#374151` | `#cbd5e1` | separadores |
| `--border-faint` | `#111827` | `#eef2f6` | divisores extra-sutis |
| `--accent` | `#2563eb` | `#2563eb` | botão primário |
| `--accent-hover` | `#1d4ed8` | `#1d4ed8` | hover do primário |
| `--accent-soft` | `rgba(59,130,246,.18)` | `rgba(37,99,235,.10)` | fill de badge / aba ativa |
| `--accent-text` | `#93c5fd` | `#1d4ed8` | texto azul em fundo neutro |
| `--accent-text-2` | `#60a5fa` | `#2563eb` | azul secundário |
| `--accent-border` | `#3b82f6` | `#3b82f6` | focus / selected border |

**Mantidos iguais** entre temas (cores semânticas):
- Severidade: red (`#ef4444`), amber (`#f59e0b`), green (`#22c55e`)
- GIO: purple (`#a855f7`)
- DDS: cyan (`#06b6d4`)

Pequenos ajustes de opacidade entram nos chips quando o fundo muda — não precisa de tokens novos.

### Tailwind aliases (em `tailwind.config.ts`)

```ts
colors: {
  bg:      "var(--bg)",
  surface: { DEFAULT, 1, 2, 3, deep } → vars
  ink:     { 1, 2, 3, 4, muted, faint } → vars
  line:    { DEFAULT, strong, faint } → vars
  accent:  { DEFAULT, hover, fg, soft, text, text2, border } → vars
}
```

Componentes passam a usar `bg-surface-1`, `text-ink-muted`, `border-line`, `text-accent-text`, etc. Adicionar um tema futuro vira só um novo bloco `[data-theme="…"]`.

---

## 2. Estado de tema

### Boot anti-flash (`src/app/layout.tsx`)

Script inline no `<head>` antes da hidratação:

```js
(function(){
  var t = localStorage.getItem('strom-theme');
  if (t !== 'light' && t !== 'dark') {
    t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
```

### React state (`src/context/ProjectContext.tsx`)

Adiciona ao contexto:
- `theme: 'light' | 'dark'` — lido de `document.documentElement.dataset.theme` no mount
- `setTheme(t)` — atualiza state, atributo no `<html>` e localStorage
- `toggleTheme()` — atalho

### Toggle UI (`src/components/Header.tsx`)

Botão ☀ / ☾ posicionado antes do separador `| Admin`. Visível pra **todos** os usuários (público + admin), porque preferência visual não é função restrita.

---

## 3. Refactor (codemod)

Script `/tmp/strom-theme-codemod.sh` faz substituição sed nas ~50 files de `src/components/` e `src/app/`.

### Mapeamento

| De (atual) | Para (token) |
|---|---|
| `bg-gray-950` | `bg-surface-deep` |
| `bg-gray-900` | `bg-surface-1` |
| `bg-gray-800` | `bg-surface-2` |
| `bg-gray-700` / `bg-gray-600` | `bg-surface-3` |
| `border-gray-800` | `border-line` |
| `border-gray-700` / `border-gray-600` | `border-line-strong` |
| `border-gray-900` | `border-line-faint` |
| `divide-gray-800` | `divide-line` |
| `text-gray-50` / `text-gray-100` | `text-ink-1` |
| `text-gray-200` | `text-ink-2` |
| `text-gray-300` | `text-ink-3` |
| `text-gray-400` | `text-ink-4` |
| `text-gray-500` | `text-ink-muted` |
| `text-gray-600` / `text-gray-700` | `text-ink-faint` |
| `placeholder-gray-500` | `placeholder-ink-muted` |
| `bg-blue-700` | `bg-accent-hover` |
| `bg-blue-600` / `bg-blue-500` | `bg-accent` |
| `bg-blue-400` | `bg-accent-text2` |
| `bg-blue-900/X` / `bg-blue-800/X` | `bg-accent-soft` |
| `text-blue-100` / `text-blue-200` | `text-accent-fg` |
| `text-blue-300` | `text-accent-text` |
| `text-blue-400` | `text-accent-text2` |
| `border-blue-500/700/800` | `border-accent-border` |
| `ring-blue-500/X` | `ring-accent-border/X` |

Opacity modifiers (`/30`, `/50`, etc.) preservados.

### Hex literais em `style={…}` e `bg-[#…]`

Segunda passada (manual + scripted) nos 8 arquivos identificados:

| Hex | Frequência | Contexto típico | Substituição |
|---|---|---|---|
| `#0a0e1a` | 17 | body bg em `style={}` | `var(--bg)` |
| `#0d1117` | 11 | header/toolbar bg | `var(--surface)` |
| `#1f2937` | 16 | divisores, hover bg | `var(--surface-2)` ou `var(--border)` (case-by-case) |
| `#374151` | 6 | borders, chips | `var(--surface-3)` / `var(--border-strong)` |
| `#111827` | 4 | scrollbar, sidebar bg | `var(--surface-1)` |
| `#6b7280` | 13 | text muted | `var(--ink-muted)` |
| `#9ca3af` / `#94a3b8` | 16 | text secundário | `var(--ink-4)` |
| `#e2e8f0` / `#f1f5f9` | 21 | text alto contraste | `var(--ink-2)` / `var(--ink-1)` |
| `#64748b` / `#475569` | 23 | text muted | `var(--ink-muted)` / `var(--ink-4)` |
| `#1e293b` / `#0f172a` | 6 | scoped backgrounds | `var(--surface-1)` |
| `#60a5fa` / `#2563eb` / `#1d4ed8` / `#3b82f6` | 16 | blue accents | `var(--accent-text-2)` / `var(--accent)` / `var(--accent-hover)` / `var(--accent-border)` |

Cores semânticas (red/amber/green/purple/cyan) **ficam literais** — são consistentes entre temas e qualquer ajuste fino entra direto no token.

### Outliers tratados à mão

- `ring-gray-400/30` (1x) → `ring-ink-4/30`
- `bg-blue-950/20` e `bg-blue-950/30` (2x) → `bg-accent-soft`
- `Header.tsx:25` ainda tem `bg-[#0d1117]` → vira `bg-surface`
- Body color do `globals.css` migrou para `var(--ink-2)` no body selector

---

## 4. Componentes especiais

### `GraphView.tsx` (force-directed canvas)

Nós e arestas são desenhados via D3/canvas com cores em JS. Vou ler `theme` do contexto e ajustar a paleta dos nós/links em função do tema (linhas em `--ink-faint` no dark, `--ink-4` no light; nós mantêm cor de DDS).

### `TimelineView.tsx` / `DetailView.tsx`

Inspeção pós-codemod — provavelmente ficam ok porque usam só Tailwind. Anoto qualquer ajuste à mão.

### `Sidebar.tsx`, `Toolbar.tsx`

Mesma coisa. Esses são os que mais consomem `bg-[#hex]` arbitrários — segunda passada de migração já cobre.

### Admin views (`src/app/admin/*`)

Não estavam no scan inicial. Vou rodar o mesmo codemod lá depois.

---

## 5. Etapas (status)

| # | Etapa | Status |
|---|---|---|
| 1 | Tokens CSS em `globals.css` | ✅ feito |
| 2 | `tailwind.config.ts` com aliases | ✅ feito |
| 3 | Script anti-flash em `layout.tsx` | ✅ feito |
| 4 | `theme` no `ProjectContext` | ✅ feito |
| 5 | Codemod (Tailwind grays/blues) | ✅ rodado em 50 files |
| 6 | Migrar hex literais (`style={}` + `bg-[#…]`) | ✅ feito |
| 7 | Codemod em `src/app/admin/` | ✅ feito |
| 8 | Tema-aware no `GraphView` + Universe Background | ✅ feito |
| 9 | Toggle ☀/☾ em `Header.tsx` | ✅ feito |
| 10 | Lint + `tsc --noEmit` | ✅ passou |
| 11 | QA visual em cada view (dark + light) | ⏳ próximo passo (manual) |

---

## 6. Critério de pronto

- `grep -rE "(bg|text|border)-(gray|blue)-[0-9]" src/` → vazio (exceto admin se decidirmos não migrar)
- `grep -rE "bg-\[#" src/` → vazio fora de cores semânticas
- Toggle ☀/☾ visível no header em ambos os modos (público + admin)
- Recarregar a página mantém o tema escolhido (localStorage)
- Primeira visita sem preferência: respeita `prefers-color-scheme` do SO
- Cada view renderiza sem áreas "pretas em branco" ou "branco em preto" no light
- `tsc --noEmit` passa

---

## 7. Rollback

Tudo num único commit. Se algo quebrar:

```bash
git revert <hash>
```

E os arquivos voltam ao estado pré-tema. Tokens estão isolados em `globals.css` e `tailwind.config.ts` — não há mudança de schema, API, ou contrato externo.
