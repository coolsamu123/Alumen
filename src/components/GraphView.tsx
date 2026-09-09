'use client';

import { useRef, useState, useEffect, useMemo } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { useForceLayout } from '@/hooks/useForceLayout';
import { getDDSColor, getGateColor, getDecisionColor } from '@/lib/constants';
import AIAnalysisPanel from './AIAnalysisPanel';
import type { ProjectSummary, CIOOProject } from '@/lib/types';

export default function GraphView() {
  const { filteredWithSignal: filtered, links, selected, setSelected, hovered, setHovered } = useProjectContext();
  const graphRef = useRef<HTMLDivElement>(null);
  const [graphSize, setGraphSize] = useState({ w: 900, h: 560 });

  // Nodes logic including missing targets from links (like GIO_SERVICES)
  const nodes = useMemo(() => {
    const baseNodes = filtered.slice(0, 150);
    const nodeIds = new Set(baseNodes.map(n => n.projectId));
    
    const extraNodes: ProjectSummary[] = [];
    links.forEach(l => {
      if (!nodeIds.has(l.source)) {
        nodeIds.add(l.source);
        extraNodes.push({
          projectId: l.source,
          name: l.source === 'GIO_SERVICES' ? 'GIO Services & Infrastructure' : l.source,
          dds: l.source === 'GIO_SERVICES' ? 'GIO' : 'Unknown',
          currentGate: '-',
          latestDecision: '-',
          // Pseudo-node (GIO_SERVICES / an unresolved target), not a real
          // project row — provenance is meaningless here.
          source: 'excel' as const,
          costKEur: 0,
          description: '',
          remarks: '',
          reviewCount: 0,
          lastReviewDate: '',
          linkPositions: '',
          linkFolder: '',
          linkCIOO: '',
          tags: [] as string[],
          history: [] as CIOOProject[]
        });
      }
      if (!nodeIds.has(l.target)) {
        nodeIds.add(l.target);
        extraNodes.push({
          projectId: l.target,
          name: l.target === 'GIO_SERVICES' ? 'GIO Services & Infrastructure' : l.target,
          dds: l.target === 'GIO_SERVICES' ? 'GIO' : 'Unknown',
          currentGate: '-',
          latestDecision: '-',
          // Pseudo-node (GIO_SERVICES / an unresolved target), not a real
          // project row — provenance is meaningless here.
          source: 'excel' as const,
          costKEur: 0,
          description: '',
          remarks: '',
          reviewCount: 0,
          lastReviewDate: '',
          linkPositions: '',
          linkFolder: '',
          linkCIOO: '',
          tags: [] as string[],
          history: [] as CIOOProject[]
        });
      }
    });
    
    return [...baseNodes, ...extraNodes];
  }, [filtered, links]);

  useEffect(() => {
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      // Skip when hidden (display:none → 0×0) so the force layout doesn't
      // reset the moment the user switches away from this tab.
      if (width === 0 || height === 0) return;
      setGraphSize({ w: width, h: height });
    });
    if (graphRef.current) obs.observe(graphRef.current);
    return () => obs.disconnect();
  }, []);

  const positions = useForceLayout(nodes, links, graphSize.w, graphSize.h);

  const selectedProject = selected ? nodes.find(p => p.projectId === selected) : null;
  const relatedProjects = selectedProject
    ? links
        .filter(l => l.source === selected || l.target === selected)
        .map(l => ({
          project: nodes.find(p => p.projectId === (l.source === selected ? l.target : l.source)),
          strength: l.strength,
        }))
        .filter(r => r.project)
        .sort((a, b) => b.strength - a.strength)
    : [];

  return (
    <div ref={graphRef} className="flex-1 relative overflow-hidden animate-fadeIn">
      <svg width="100%" height="100%" className="absolute inset-0">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow2">
            <feGaussianBlur stdDeviation="8" result="coloredBlur" />
            <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Links */}
        {links.map((link, i) => {
          const a = positions[link.source], b = positions[link.target];
          if (!a || !b) return null;
          const isHighlighted = selected && (link.source === selected || link.target === selected);
          const opacity = selected ? (isHighlighted ? 0.9 : 0.05) : Math.max(0.1, link.strength * 0.8);
          return (
            <line key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              style={{ stroke: isHighlighted ? 'var(--accent-text-2)' : 'var(--accent-border)' }}
              strokeWidth={isHighlighted ? 2.5 : link.strength * 3}
              strokeOpacity={opacity}
              filter={isHighlighted ? 'url(#glow)' : undefined}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map(p => {
          const pos = positions[p.projectId];
          if (!pos) return null;
          const isSelected = selected === p.projectId;
          const isHovered = hovered === p.projectId;
          const isRelated = selected && relatedProjects.some(r => r.project?.projectId === p.projectId);
          const dimmed = selected && !isSelected && !isRelated;
          const r = 20 + Math.min((p.costKEur || 0) / 300, 18);
          const color = getDDSColor(p.dds);

          return (
            <g key={p.projectId}
              transform={`translate(${pos.x},${pos.y})`}
              style={{ cursor: 'pointer', opacity: dimmed ? 0.15 : 1, transition: 'opacity 0.3s' }}
              onClick={() => setSelected(selected === p.projectId ? null : p.projectId)}
              onMouseEnter={() => setHovered(p.projectId)}
              onMouseLeave={() => setHovered(null)}
            >
              {(isSelected || isHovered) && (
                <circle r={r + 12} fill="none" stroke={color} strokeWidth="2" strokeOpacity="0.4" filter="url(#glow2)" />
              )}

              {/* Node circle */}
              <circle r={r} fill={`${color}22`} stroke={color} strokeWidth={isSelected ? 2.5 : 1.5} />

              {/* Decision indicator */}
              <circle r={4} cx={r - 4} cy={-r + 4}
                fill={getDecisionColor(p.latestDecision)} />

              {/* ID */}
              <text textAnchor="middle" dy="0.35em" fontSize={9} fontWeight={600} fill={color} fontFamily="monospace">
                {p.projectId.replace('PRJ00', '')}
              </text>

              {/* Name below */}
              <text textAnchor="middle" dy={r + 14} fontSize={9} fontWeight={500} style={{ pointerEvents: 'none', fill: 'var(--ink-4)' }}>
                {p.name.length > 20 ? p.name.slice(0, 18) + '...' : p.name}
              </text>

              {/* Gate badge */}
              <rect x={-14} y={-r - 14} width={28} height={12} rx={6}
                fill={getGateColor(p.currentGate)} opacity={0.9} />
              <text x={0} y={-r - 5} textAnchor="middle" fontSize={8} fill="white" fontWeight={600}>
                G{p.currentGate}
              </text>
            </g>
          );
        })}
      </svg>

      {/* DDS Legend */}
      <div className="absolute bottom-4 left-4 flex flex-col gap-1.5">
        <div className="text-[10px] text-ink-muted font-bold tracking-widest mb-1">DDS</div>
        {Array.from(new Set(nodes.map(p => p.dds))).filter(Boolean).slice(0, 12).map(dds => (
          <div key={dds} className="flex items-center gap-2 text-[11px] text-ink-4">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: getDDSColor(dds) }} />
            {dds}
          </div>
        ))}
      </div>

      {/* Selected project panel */}
      {selectedProject && (
        <div className="absolute top-4 right-4 w-80 max-h-[calc(100%-2rem)] overflow-y-auto bg-surface-1 border border-line rounded-xl p-5 animate-fadeIn">
          <div className="flex justify-between items-start mb-3">
            <div>
              <div className="text-[10px] text-ink-muted font-mono mb-1">{selectedProject.projectId}</div>
              <div className="text-sm font-bold text-ink-1 leading-snug">{selectedProject.name}</div>
            </div>
            <button onClick={() => setSelected(null)} className="text-ink-muted hover:text-ink-3 text-lg leading-none">x</button>
          </div>

          <div className="flex gap-1.5 mb-3 flex-wrap">
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold"
              style={{ background: `${getGateColor(selectedProject.currentGate)}22`, color: `color-mix(in srgb, ${getGateColor(selectedProject.currentGate)} 70%, var(--ink-1))` }}>
              Gate {selectedProject.currentGate}
            </span>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold"
              style={{ background: `${getDDSColor(selectedProject.dds)}22`, color: `color-mix(in srgb, ${getDDSColor(selectedProject.dds)} 70%, var(--ink-1))` }}>
              {selectedProject.dds}
            </span>
            {selectedProject.latestDecision && (
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold"
                style={{ background: `${getDecisionColor(selectedProject.latestDecision)}22`, color: `color-mix(in srgb, ${getDecisionColor(selectedProject.latestDecision)} 70%, var(--ink-1))` }}>
                {selectedProject.latestDecision}
              </span>
            )}
          </div>

          {selectedProject.description && (
            <div className="text-xs text-ink-4 leading-relaxed mb-3">{selectedProject.description}</div>
          )}

          <div className="grid grid-cols-2 gap-2 mb-4">
            <div className="bg-surface-2 rounded-lg p-2">
              <div className="text-[10px] text-ink-muted">Cost</div>
              <div className="text-xs font-semibold text-ink-2">{selectedProject.costKEur ? `${selectedProject.costKEur}k€` : 'N/A'}</div>
            </div>
            <div className="bg-surface-2 rounded-lg p-2">
              <div className="text-[10px] text-ink-muted">Reviews</div>
              <div className="text-xs font-semibold text-ink-2">{selectedProject.reviewCount}</div>
            </div>
          </div>

          {/* Tags */}
          {selectedProject.tags.length > 0 && (
            <div className="mb-4">
              <div className="text-[10px] text-ink-muted font-semibold mb-1.5">TAGS</div>
              <div className="flex flex-wrap gap-1">
                {selectedProject.tags.map(t => (
                  <span key={t} className="px-2 py-0.5 rounded text-[9px] text-ink-4 bg-surface-2 border border-line-strong">{t}</span>
                ))}
              </div>
            </div>
          )}

          {/* Related projects */}
          {relatedProjects.length > 0 && (
            <div className="mb-4">
              <div className="text-[10px] text-ink-muted font-semibold mb-2">RELATED ({relatedProjects.length})</div>
              {relatedProjects.slice(0, 8).map(({ project: rp, strength }) => rp && (
                <div key={rp.projectId}
                  onClick={() => setSelected(rp.projectId)}
                  className="bg-surface-2 rounded-lg p-2 mb-1.5 cursor-pointer flex items-center gap-2.5 hover:bg-surface-3/80 transition-colors"
                >
                  <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: getDDSColor(rp.dds) }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-semibold text-ink-2 truncate">{rp.name}</div>
                    <div className="text-[10px] text-ink-muted">{rp.dds} · G{rp.currentGate}</div>
                  </div>
                  <div className="text-[11px] font-bold text-accent-text2">{Math.round(strength * 100)}%</div>
                </div>
              ))}
            </div>
          )}

          {/* AI Analysis */}
          <AIAnalysisPanel
            project={selectedProject}
            relatedProjects={relatedProjects.map(r => r.project!).filter(Boolean)}
          />
        </div>
      )}
    </div>
  );
}
