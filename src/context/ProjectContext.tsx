'use client';

import { createContext, useContext, useState, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import type { ProjectSummary, SimilarityLink, FilterState, ViewType, AnalysisResult, ProjectImpact } from '@/lib/types';

interface ProjectContextType {
  // Data
  projects: ProjectSummary[];
  setProjects: (projects: ProjectSummary[]) => void;
  links: SimilarityLink[];
  impacts: ProjectImpact[];
  setImpacts: (impacts: ProjectImpact[]) => void;
  stats: Record<string, unknown> | null;
  isLoading: boolean;
  error: string | null;
  // Set of project IDs that have a successful goal extraction. Graph/Matrix views
  // filter on this; Timeline keeps the full set. Projects without goals (e.g. those
  // listed in CIOO but with no Drive folder linked) are excluded.
  signalProjectIds: Set<string>;

  // UI State
  view: ViewType;
  setView: (v: ViewType) => void;
  selected: string | null;
  setSelected: (id: string | null) => void;
  // Project focused in the Universe view (null when no Universe is open).
  focusedProjectId: string | null;
  openUniverse: (projectId: string) => void;
  closeUniverse: () => void;
  hovered: string | null;
  setHovered: (id: string | null) => void;
  threshold: number;
  setThreshold: (t: number) => void;
  filters: FilterState;
  setFilters: (f: FilterState) => void;

  // Filtered data
  filtered: ProjectSummary[];
  // Same as `filtered` but also drops projects without any goals/impacts signal.
  // Used by Graph and Matrix; Timeline still uses `filtered`.
  filteredWithSignal: ProjectSummary[];

  // Actions
  uploadFile: (file: File) => Promise<{ count: number; errors: string[] }>;
  refreshProjects: () => Promise<void>;
  analyzeProjects: (projects: ProjectSummary[], type: 'pairwise' | 'cluster') => Promise<AnalysisResult>;
  analyzeWithDocs: (projects: ProjectSummary[], urls: string[]) => Promise<AnalysisResult>;

  // Analysis cache
  analysisResults: Map<string, AnalysisResult>;

  // Session role of the logged-in user. Login is required for every page
  // (middleware.ts, Fase 5), so this is null only while rendering /login.
  role: 'admin' | 'basic' | null;
  // role === 'admin'. Use this to decide whether to disable a write control;
  // the server-side 403 is the actual protection.
  isAdmin: boolean;

  // Color theme — available to every role. Persisted in
  // localStorage; initial value comes from the inline anti-flash script in
  // layout.tsx so React hydration matches the painted DOM.
  theme: 'light' | 'dark';
  setTheme: (t: 'light' | 'dark') => void;
  toggleTheme: () => void;
}

const ProjectContext = createContext<ProjectContextType | null>(null);

export function ProjectProvider({
  children,
  role = null,
  isAdmin = false,
}: {
  children: ReactNode;
  role?: 'admin' | 'basic' | null;
  isAdmin?: boolean;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [impacts, setImpacts] = useState<ProjectImpact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<ViewType>('detail');
  const [previousView, setPreviousView] = useState<ViewType>('impact');
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.15);
  const [filters, setFilters] = useState<FilterState>({
    dds: 'All',
    gate: 'All',
    decision: 'All',
    yearFrom: null,
    yearTo: null,
    search: '',
    severity: 'All',
  });
  const [analysisResults, setAnalysisResults] = useState<Map<string, AnalysisResult>>(new Map());
  const [goalsProjectIds, setGoalsProjectIds] = useState<Set<string>>(new Set());

  // Theme is set pre-hydration by the inline script in layout.tsx, so we read
  // it from <html data-theme> on mount instead of guessing and risking a flash.
  const [theme, setThemeState] = useState<'light' | 'dark'>('dark');
  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    if (current === 'light' || current === 'dark') setThemeState(current);
  }, []);
  const setTheme = useCallback((t: 'light' | 'dark') => {
    setThemeState(t);
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('strom-theme', t); } catch { /* private mode */ }
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  // Initial fetch of impacts + which projects have successful goals.
  useEffect(() => {
    fetch('/api/impact').then(r => r.json()).then(d => d.impacts && setImpacts(d.impacts)).catch(() => {});
    fetch('/api/goals').then(r => r.json()).then(d => {
      if (!Array.isArray(d?.goals)) return;
      const ids = new Set<string>();
      for (const g of d.goals as Array<{ project_id?: string; status?: string }>) {
        if (g.project_id && g.status === 'success') ids.add(g.project_id);
      }
      setGoalsProjectIds(ids);
    }).catch(() => {});
  }, []);

  const signalProjectIds = useMemo(() => new Set(goalsProjectIds), [goalsProjectIds]);

  const filtered = useMemo(() => {
    return projects.filter(p => {
      if (filters.dds !== 'All' && p.dds !== filters.dds) return false;
      if (filters.gate !== 'All' && p.currentGate !== filters.gate) return false;
      if (filters.decision !== 'All' && p.latestDecision !== filters.decision) return false;
      if (filters.yearFrom) {
        const year = parseInt(p.lastReviewDate?.slice(0, 4));
        if (!year || year < filters.yearFrom) return false;
      }
      if (filters.yearTo) {
        const year = parseInt(p.lastReviewDate?.slice(0, 4));
        if (!year || year > filters.yearTo) return false;
      }
      if (filters.search) {
        const s = filters.search.toLowerCase();
        const match = p.name.toLowerCase().includes(s) ||
          p.projectId.toLowerCase().includes(s) ||
          p.description.toLowerCase().includes(s) ||
          p.remarks.toLowerCase().includes(s);
        if (!match) return false;
      }
      return true;
    });
  }, [projects, filters]);

  const filteredWithSignal = useMemo(
    () => filtered.filter(p => signalProjectIds.has(p.projectId)),
    [filtered, signalProjectIds]
  );

  const links = useMemo(() => {
    const globalFilteredIds = new Set(filtered.map(p => p.projectId));

    // An endpoint is eligible only if it has goals (or is the virtual GIO_SERVICES
    // aggregator). This keeps no-goal projects out of Graph/Matrix even when they
    // are referenced as a target of someone else's impact.
    const isEligible = (id: string) =>
      goalsProjectIds.has(id) ||
      (id === 'GIO_SERVICES' && (filters.dds === 'All' || filters.dds === 'GIO'));

    const matchedImpacts = impacts.filter(imp => {
      if (!isEligible(imp.sourceProjectId) || !isEligible(imp.targetProjectId)) return false;

      let isSourceVisible = globalFilteredIds.has(imp.sourceProjectId);
      let isTargetVisible = globalFilteredIds.has(imp.targetProjectId);

      if (imp.targetProjectId === 'GIO_SERVICES' && (filters.dds === 'All' || filters.dds === 'GIO')) {
        isTargetVisible = true;
      }
      if (imp.sourceProjectId === 'GIO_SERVICES' && (filters.dds === 'All' || filters.dds === 'GIO')) {
        isSourceVisible = true;
      }

      return isSourceVisible || isTargetVisible;
    });

    return matchedImpacts.map(imp => {
      let strength = 0.5;
      if (imp.severity === 'high') strength = 1.0;
      if (imp.severity === 'low') strength = 0.25;
      return {
        source: imp.sourceProjectId,
        target: imp.targetProjectId,
        strength,
        aiAnalyzed: true
      };
    });
  }, [impacts, filtered, filters.dds, goalsProjectIds]);

  const uploadFile = useCallback(async (file: File) => {
    setIsLoading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/projects/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Refresh projects after upload
      await refreshProjectsInner();
      return { count: data.count, errors: data.errors || [] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upload failed';
      setError(msg);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshProjectsInner = async () => {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (data.projects) {
      setProjects(data.projects);
      setStats(data.stats || null);
    }
    try {
      const impRes = await fetch('/api/impact');
      const impData = await impRes.json();
      if (impData.impacts) setImpacts(impData.impacts);
    } catch { /* ignore */ }
  };

  const refreshProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await refreshProjectsInner();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load projects';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const analyzeProjects = useCallback(async (projectList: ProjectSummary[], type: 'pairwise' | 'cluster') => {
    const key = projectList.map(p => p.projectId).sort().join(',') + ':' + type;
    const cached = analysisResults.get(key);
    if (cached) return cached;

    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, projects: projectList }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    setAnalysisResults(prev => new Map(prev).set(key, data.analysis));
    return data.analysis as AnalysisResult;
  }, [analysisResults]);

  const analyzeWithDocs = useCallback(async (projectList: ProjectSummary[], urls: string[]) => {
    const res = await fetch('/api/analyze/document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: projectList, urls }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.analysis as AnalysisResult;
  }, []);

  const openUniverse = useCallback((projectId: string) => {
    setPreviousView(prev => (view !== 'universe' ? view : prev));
    setFocusedProjectId(projectId);
    setView('universe');
  }, [view]);

  const closeUniverse = useCallback(() => {
    setFocusedProjectId(null);
    setView(previousView);
  }, [previousView]);

  return (
    <ProjectContext.Provider value={{
      projects, setProjects, links, impacts, setImpacts, stats, isLoading, error,
      signalProjectIds,
      view, setView, selected, setSelected, hovered, setHovered,
      focusedProjectId, openUniverse, closeUniverse,
      threshold, setThreshold, filters, setFilters,
      filtered, filteredWithSignal, uploadFile, refreshProjects,
      analyzeProjects, analyzeWithDocs, analysisResults,
      role, isAdmin,
      theme, setTheme, toggleTheme,
    }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjectContext() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProjectContext must be used within ProjectProvider');
  return ctx;
}
