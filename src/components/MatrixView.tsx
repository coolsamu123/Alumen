'use client';

import { useMemo } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { getDDSColor } from '@/lib/constants';
import type { ProjectSummary, CIOOProject } from '@/lib/types';


export default function MatrixView() {
  const { filteredWithSignal: filtered, links, setSelected, setView } = useProjectContext();

  // Matrix projects including targets from links
  const matrixProjects = useMemo(() => {
    const base = filtered.slice(0, 50);
    const nodeIds = new Set(base.map(n => n.projectId));
    const extraNodes: ProjectSummary[] = [];
    
    links.forEach(l => {
      if (extraNodes.length + base.length >= 70) return; // limit
      if (!nodeIds.has(l.source)) {
        nodeIds.add(l.source);
        extraNodes.push({
          projectId: l.source,
          name: l.source === 'GIO_SERVICES' ? 'GIO Services' : l.source,
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
      if (!nodeIds.has(l.target) && extraNodes.length + base.length < 70) {
        nodeIds.add(l.target);
        extraNodes.push({
          projectId: l.target,
          name: l.target === 'GIO_SERVICES' ? 'GIO Services' : l.target,
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
    
    return [...base, ...extraNodes];
  }, [filtered, links]);

  // Precompute impact matrix
  const matrix = useMemo(() => {
    const m: Record<string, Record<string, number>> = {};
    for (const a of matrixProjects) {
      m[a.projectId] = {};
      for (const b of matrixProjects) {
        if (a.projectId === b.projectId) {
          m[a.projectId][b.projectId] = 1; // Self
        } else {
          const link = links.find(l => 
            (l.source === a.projectId && l.target === b.projectId) || 
            (l.source === b.projectId && l.target === a.projectId)
          );
          m[a.projectId][b.projectId] = link ? link.strength : 0;
        }
      }
    }
    return m;
  }, [matrixProjects, links]);

  // Tag cloud
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    filtered.forEach(p => p.tags.forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  return (
    <div className="flex-1 overflow-auto p-6 animate-fadeIn">
      <div className="text-[13px] text-ink-muted mb-4">
        Impact matrix — color intensity = impact severity ({matrixProjects.length} projects shown, max 70)
      </div>

      <div className="overflow-x-auto">
        <table className="border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="w-36 min-w-[140px]" />
              {matrixProjects.map(p => (
                <th key={p.projectId} className="p-1" style={{
                  writingMode: 'vertical-rl',
                  textOrientation: 'mixed',
                  transform: 'rotate(180deg)',
                  whiteSpace: 'nowrap',
                  maxWidth: 90,
                  color: 'var(--ink-4)',
                  fontWeight: 600,
                }}>
                  <span style={{ color: getDDSColor(p.dds) }}>{p.projectId.replace('PRJ00', '')}</span>
                  {' '}{p.name.slice(0, 14)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrixProjects.map(pa => (
              <tr key={pa.projectId}>
                <td className="pr-3 font-semibold text-ink-2 whitespace-nowrap text-right">
                  <span className="text-[10px] font-mono mr-1.5" style={{ color: getDDSColor(pa.dds) }}>
                    {pa.projectId.replace('PRJ00', '')}
                  </span>
                  {pa.name.length > 18 ? pa.name.slice(0, 16) + '...' : pa.name}
                </td>
                {matrixProjects.map(pb => {
                  const sim = matrix[pa.projectId]?.[pb.projectId] ?? 0;
                  const isDiag = pa.projectId === pb.projectId;
                  const bg = isDiag
                    ? '#1e3a8a'
                    : sim > 0.5 ? `rgba(59,130,246,${sim})`
                    : sim > 0.2 ? `rgba(99,102,241,${sim})`
                    : sim > 0 ? `rgba(99,102,241,0.1)`
                    : 'transparent';

                  return (
                    <td key={pb.projectId}
                      title={`${pa.name} <-> ${pb.name}: ${Math.round(sim * 100)}%`}
                      onClick={() => { setSelected(pa.projectId); setView('graph'); }}
                      className="cursor-pointer text-center transition-all hover:brightness-150"
                      style={{
                        width: 32, height: 32, minWidth: 32,
                        background: bg,
                        border: '1px solid var(--bg)',
                      }}
                    >
                      {sim > 0.15 && !isDiag && (
                        <span className="text-[9px] text-white/80 font-mono">{Math.round(sim * 100)}</span>
                      )}
                      {isDiag && <span className="text-[9px] text-accent-text2">--</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Tag cloud */}
      <div className="mt-8">
        <div className="text-[13px] text-ink-muted mb-3">Shared tags across portfolio</div>
        <div className="flex flex-wrap gap-2">
          {tagCounts.slice(0, 30).map(([tag, count]) => (
            <span key={tag}
              className="inline-block rounded-full border border-line text-ink-2"
              style={{
                background: `rgba(59,130,246,${Math.min(count / filtered.length, 0.8)})`,
                padding: `4px ${10 + count}px`,
                fontSize: 11 + Math.min(count, 5),
              }}
            >
              {tag} <span className="text-[10px] opacity-70">x{count}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
