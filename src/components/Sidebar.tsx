'use client';

import { useMemo, useState, useEffect } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { getDDSColor, getGateColor, getDecisionColor, ADMIN_ONLY_TITLE } from '@/lib/constants';
import type { CIOOService } from '@/lib/types';

export default function Sidebar() {
  const { filtered, links, selected, projects, setProjects, isAdmin } = useProjectContext();
  
  const [allServices, setAllServices] = useState<CIOOService[]>([]);
  const [searchService, setSearchService] = useState('');
  
  useEffect(() => {
    fetch('/api/services')
      .then(res => res.json())
      .then(data => {
        if (data.services) setAllServices(data.services);
      })
      .catch(() => {});
  }, []);

  const selectedProject = useMemo(() => {
    if (!selected) return null;
    return projects.find(p => p.projectId === selected) || null;
  }, [selected, projects]);

  /**
   * Optimistic write with rollback. The optimistic half was already here; the
   * rollback wasn't — a failed request used to leave the edit on screen, so
   * the change looked saved until the next refresh silently dropped it. That
   * became reachable the moment basic users existed: POST
   * /api/projects/:id/services is admin-only (middleware.ts), so for them
   * every edit would have been a phantom success.
   */
  const persistServices = async (updated: CIOOService[]) => {
    if (!selectedProject) return;
    const previous = selectedProject.services || [];
    const withUpdate = { ...selectedProject, services: updated };
    setProjects(projects.map(p => p.projectId === selectedProject.projectId ? withUpdate : p));

    const rollback = () => {
      const restored = { ...selectedProject, services: previous };
      setProjects(projects.map(p => p.projectId === selectedProject.projectId ? restored : p));
    };

    try {
      const res = await fetch(`/api/projects/${selectedProject.projectId}/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ services: updated })
      });
      if (!res.ok) rollback();
    } catch {
      rollback();
    }
  };

  const handleAddService = async (service: CIOOService) => {
    if (!selectedProject || !isAdmin) return;
    const currentServices = selectedProject.services || [];
    if (currentServices.some(s => s.id === service.id)) return;
    await persistServices([...currentServices, service]);
  };

  const handleRemoveService = async (serviceId: string) => {
    if (!selectedProject || !isAdmin) return;
    const currentServices = selectedProject.services || [];
    await persistServices(currentServices.filter(s => s.id !== serviceId));
  };

  const suggestedServices = useMemo(() => {
    if (!selectedProject || searchService) return [];
    
    // Basic AI-like suggestion logic: Match keywords
    const tags = selectedProject.tags || [];
    const keywords = [selectedProject.name, ...tags, selectedProject.description].join(' ').toLowerCase();
    
    return allServices.filter(s => {
      const sName = s.name.toLowerCase();
      const sDomain = s.domain.toLowerCase();
      
      if (selectedProject.services?.some((cs) => cs.id === s.id)) return false;
      
      return keywords.includes(sDomain) || 
             (keywords.includes('cloud') && sDomain.includes('cloud')) ||
             (keywords.includes('infra') && sDomain.includes('infra')) ||
             (keywords.includes('security') && sDomain.includes('security')) ||
             (sName.split('-').some((part: string) => part.trim().length > 3 && keywords.includes(part.trim().toLowerCase())));
    }).slice(0, 5);
  }, [selectedProject, allServices, searchService]);

  const searchedServices = useMemo(() => {
    if (!searchService.trim()) return [];
    const s = searchService.toLowerCase();
    return allServices.filter(svc => 
      !selectedProject?.services?.some((cs) => cs.id === svc.id) &&
      (svc.name.toLowerCase().includes(s) || svc.domain.toLowerCase().includes(s) || svc.owner.toLowerCase().includes(s))
    ).slice(0, 10);
  }, [allServices, searchService, selectedProject]);

  const ddsCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    filtered.forEach(p => { counts[p.dds || '(empty)'] = (counts[p.dds || '(empty)'] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  const gateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    filtered.forEach(p => { counts[p.currentGate || '(empty)'] = (counts[p.currentGate || '(empty)'] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  const decisionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    filtered.forEach(p => { counts[p.latestDecision || '(empty)'] = (counts[p.latestDecision || '(empty)'] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  const totalCost = useMemo(() =>
    filtered.reduce((sum, p) => sum + (p.costKEur || 0), 0),
    [filtered]
  );

  const subappAnalyzedCount = useMemo(() => {
    return filtered.filter(p => p.subappAnalyzed).length;
  }, [filtered]);

  const aiPoweredCount = useMemo(() => {
    return filtered.filter(p => p.iaEmbedded && p.iaEmbedded !== 'Not identified').length;
  }, [filtered]);

  return (
    <>
      {/* Selected Project Properties & Services - Left Panel */}
      {selectedProject && (
        <div className="w-72 border-l border-line bg-surface overflow-y-auto flex flex-col shrink-0 shadow-[-10px_0_15px_-5px_rgba(0,0,0,0.3)] z-10">
          <div className="p-4 flex-1">
            <div className="text-[10px] text-accent-text2 font-bold tracking-widest mb-1.5">SELECTED PROJECT</div>
            <div className="text-sm font-bold text-ink-1 leading-tight mb-1">{selectedProject.name}</div>
            <div className="text-[10px] text-ink-4 font-mono mb-2">{selectedProject.projectId}</div>
            {/* Provenance. An initiative has no gate, DDS or cost by nature —
                without this the panel reads as a project with missing data. */}
            {selectedProject.source && selectedProject.source !== 'excel' && (
              <div className="mb-4">
                <span
                  className={`px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide ${
                    selectedProject.source === 'initiative'
                      ? 'bg-amber-900/40 text-amber-300'
                      : 'bg-blue-900/40 text-blue-300'
                  }`}
                  title={selectedProject.source === 'initiative'
                    ? 'Pasta do Drive com documentos, sem projeto no CDIO'
                    : 'Pasta PRJ encontrada no Drive, sem linha na planilha CDIO'}
                >
                  {selectedProject.source === 'initiative' ? 'INICIATIVA' : 'DRIVE'}
                </span>
              </div>
            )}
            {selectedProject.source === 'excel' && <div className="mb-4" />}
            
            <div className="text-[10px] text-purple-400 font-bold tracking-widest mb-2 border-t border-line pt-4">SERVICES</div>
            
            {/* Current Services */}
            <div className="mb-4">
              {(!selectedProject.services || selectedProject.services.length === 0) && (
                <div className="text-xs text-ink-muted italic">No services added.</div>
              )}
              {selectedProject.services?.map((svc) => (
                <div key={svc.id} className="flex justify-between items-center bg-surface-2 rounded px-2.5 py-2 mb-2 group">
                  <div className="flex-1 min-w-0 pr-2">
                    <div className="text-[11px] font-semibold text-ink-2 truncate">{svc.name}</div>
                    <div className="text-[9px] text-ink-4 mt-0.5">{svc.domain} • {svc.owner}</div>
                  </div>
                  {/* Editing this list writes to an admin-only endpoint, so
                      non-admins get the list read-only: the remove affordance
                      stays visible but disabled rather than vanishing. */}
                  <button
                    onClick={() => handleRemoveService(svc.id)}
                    disabled={!isAdmin}
                    className="text-red-400 hover:text-red-300 opacity-0 group-hover:opacity-100 px-1 disabled:text-ink-muted/60 disabled:cursor-not-allowed"
                    title={!isAdmin ? ADMIN_ONLY_TITLE : 'Remove'}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {/* Search / Add Services */}
            <div className="relative mb-3">
              <input
                type="text"
                placeholder={isAdmin ? 'Search or add service...' : 'Search service...'}
                value={searchService}
                onChange={e => setSearchService(e.target.value)}
                className="w-full bg-surface-deep border border-line-strong text-ink-2 rounded px-3 py-2 text-xs focus:outline-none focus:border-accent-border"
              />
            </div>

            {/* Suggestions or Search Results */}
            {(searchService ? searchedServices : suggestedServices).length > 0 && (
              <div className="mb-2">
                <div className="text-[9px] text-ink-muted mb-1.5 uppercase font-semibold tracking-wider">{searchService ? 'SEARCH RESULTS' : 'AI SUGGESTIONS'}</div>
                {(searchService ? searchedServices : suggestedServices).map((svc) => (
                  <div
                    key={svc.id}
                    className={`flex justify-between items-center border border-line rounded px-2.5 py-2 mb-1.5 bg-surface-1/50 transition-colors ${isAdmin ? 'hover:bg-surface-2 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
                    onClick={() => handleAddService(svc)}
                    title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
                  >
                    <div className="flex-1 min-w-0 pr-2">
                      <div className="text-[10px] font-semibold text-ink-3 truncate">{svc.name}</div>
                      <div className="text-[9px] text-ink-muted mt-0.5">{svc.domain}</div>
                    </div>
                    <button
                      disabled={!isAdmin}
                      className="text-accent-text2 font-bold text-sm hover:text-accent-text disabled:text-ink-muted/60 disabled:cursor-not-allowed"
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="w-52 border-l border-line p-4 bg-surface overflow-y-auto flex flex-col gap-5 shrink-0 z-0">
        {/* KPIs */}
      <div>
        <div className="text-[10px] text-ink-muted font-bold tracking-widest mb-3">PORTFOLIO KPIs</div>
        {[
          ['Projects', filtered.length],
          ['Total Cost', `${(totalCost / 1000).toFixed(1)}M€`],
          ['Connections', links.length],
          ['Avg Reviews', (filtered.length > 0 ? (filtered.reduce((s, p) => s + p.reviewCount, 0) / filtered.length).toFixed(1) : '0')],
          ['AI Analyzed', subappAnalyzedCount],
          ['AI Powered', aiPoweredCount],
        ].map(([k, v]) => (
          <div key={String(k)} className="mb-2.5">
            <div className="text-[10px] text-ink-muted">{k}</div>
            <div className="text-xl font-bold text-ink-1 font-mono">{v}</div>
          </div>
        ))}
      </div>

      {/* By DDS */}
      <div>
        <div className="text-[10px] text-ink-muted font-bold tracking-widest mb-2.5">BY DDS</div>
        {ddsCounts.slice(0, 10).map(([dds, count]) => (
          <div key={dds} className="mb-2">
            <div className="flex justify-between text-[11px] mb-1">
              <span style={{ color: getDDSColor(dds) }}>● {dds}</span>
              <span className="text-ink-muted">{count}</span>
            </div>
            <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{
                width: `${(count / filtered.length) * 100}%`,
                background: getDDSColor(dds)
              }} />
            </div>
          </div>
        ))}
      </div>

      {/* By Gate */}
      <div>
        <div className="text-[10px] text-ink-muted font-bold tracking-widest mb-2.5">BY GATE</div>
        {gateCounts.slice(0, 8).map(([gate, count]) => (
          <div key={gate} className="mb-2">
            <div className="flex justify-between text-[11px] mb-1">
              <span style={{ color: getGateColor(gate) }}>● Gate {gate}</span>
              <span className="text-ink-muted">{count}</span>
            </div>
            <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{
                width: `${(count / filtered.length) * 100}%`,
                background: getGateColor(gate)
              }} />
            </div>
          </div>
        ))}
      </div>

      {/* By Decision */}
      <div>
        <div className="text-[10px] text-ink-muted font-bold tracking-widest mb-2.5">DECISIONS</div>
        {decisionCounts.map(([decision, count]) => (
          <div key={decision} className="flex justify-between text-[11px] mb-1.5">
            <span style={{ color: getDecisionColor(decision) }}>● {decision}</span>
            <span className="text-accent-text2 font-semibold">{count}</span>
          </div>
        ))}
      </div>
    </div>
    </>
  );
}
