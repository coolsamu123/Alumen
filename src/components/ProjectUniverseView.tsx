'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  Position,
  Handle,
  type Edge,
  type Node,
  type EdgeProps,
  BaseEdge,
  getBezierPath,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useProjectContext } from '@/context/ProjectContext';
import { getDDSColor, SEVERITY_COLORS } from '@/lib/constants';
import LoadingState from './LoadingState';
import EvidencePanel, { DeepDiveButton } from './EvidencePanel';
import { SourcePopover, type SourceRef } from './SourcePopover';

// ─── Data shapes (mirror /api/impact/project/universe response) ──────────────

interface PseudoNodeImpact {
  impactId: number;
  severity: string;
  direction: string;
  impactTypes: string[];
  explanations: string[];
  // citationsByExplanation[i] backs explanations[i]; absent on legacy rows
  // generated before the citation pipeline existed.
  citationsByExplanation?: SourceRef[][];
  // Parallel to explanations: the raw row's impact_type/severity that
  // produced each message. Lets the UI render per-message badges.
  impactTypeByExplanation?: string[];
  severityByExplanation?: string[];
  // Parallel: synthesised narrative ("Why this matters"). The API composes
  // it from sourceProjectName + direction + targetName + impact_type +
  // severity + summary_one_line. Falls back to '' for legacy responses.
  narrativeByExplanation?: string[];
  explanation: string;
}

interface PseudoNode {
  name: string;
  severity: string;
  impacts: PseudoNodeImpact[];
}

interface ProjectEdgeData {
  otherProjectId: string;
  otherProjectName: string;
  otherProjectDds: string;
  severity: string;
  direction: string;
  impactTypes: string[];
  explanations: string[];
  citationsByExplanation?: SourceRef[][];
  impactTypeByExplanation?: string[];
  severityByExplanation?: string[];
  // See PseudoNodeImpact.narrativeByExplanation.
  narrativeByExplanation?: string[];
  explanation: string;
  count: number;
  bidirectional: boolean;
}

interface CenterProject {
  projectId: string;
  name: string;
  dds: string;
  currentGate: string;
  costKEur: number | null;
  description: string;
}

interface UniverseResponse {
  project: CenterProject;
  gioNodes: PseudoNode[];
  ddsNodes: PseudoNode[];
  projectEdges: ProjectEdgeData[];
  stats: {
    gioCount: number;
    ddsCount: number;
    projectCount: number;
    totalImpacts: number;
  };
}

// ─── Visual constants ────────────────────────────────────────────────────────

// Severity colors are imported from constants.ts (single source of truth). Use
// SEVERITY_COLOR locally as the existing name to keep call sites unchanged.
const SEVERITY_COLOR = SEVERITY_COLORS;

const GIO_COLOR = '#a855f7';     // purple — GIO services
const GIO_GLOW = 'rgba(168, 85, 247, 0.4)';

// ─── Edge details (what the side panel shows when you click a link) ──────────

interface EdgeDetails {
  category: 'gio' | 'dds' | 'project';
  // Bare target name when category is 'gio' or 'dds' (e.g., 'Cloud Services',
  // 'Americas'). Used to feed the deep-dive endpoint.
  targetName: string;
  title: string;
  subtitle: string;
  color: string;
  severity: string;
  direction: string;
  impactTypes: string[];
  explanations: string[];
  // Parallel to explanations: per-explanation citations from the LLM.
  citationsByExplanation: SourceRef[][];
  // Parallel: per-message impact_type and severity. Lets the popover card
  // show one badge pair per "Reason for the impact" bullet.
  impactTypeByExplanation: string[];
  severityByExplanation: string[];
  // Parallel: synthesised "Why this matters" narratives. Rendered as the
  // headline for each bullet; explanations[i] becomes its Evidence companion.
  narrativeByExplanation: string[];
}

// Deduplicate explanations while preserving the citation array bound to each
// surviving entry. When the same explanation text appears more than once
// across impacts, we union their citations (deduped by doc_url) instead of
// dropping the duplicates' sources on the floor. First seen impact_type and
// severity win on collision.
function dedupExplanationsWithCitations(
  impacts: { explanations: string[]; citationsByExplanation?: SourceRef[][]; impactTypeByExplanation?: string[]; severityByExplanation?: string[]; narrativeByExplanation?: string[] }[]
): { explanations: string[]; citationsByExplanation: SourceRef[][]; impactTypeByExplanation: string[]; severityByExplanation: string[]; narrativeByExplanation: string[] } {
  const order: string[] = [];
  const citationsByText = new Map<string, SourceRef[]>();
  const seenCitationKeys = new Map<string, Set<string>>();
  const impactTypeByText = new Map<string, string>();
  const severityByText = new Map<string, string>();
  const narrativeByText = new Map<string, string>();

  for (const imp of impacts) {
    const cbe = imp.citationsByExplanation || [];
    const itbe = imp.impactTypeByExplanation || [];
    const sbe = imp.severityByExplanation || [];
    const nbe = imp.narrativeByExplanation || [];
    imp.explanations.forEach((exp, i) => {
      if (!exp) return;
      if (!citationsByText.has(exp)) {
        order.push(exp);
        citationsByText.set(exp, []);
        seenCitationKeys.set(exp, new Set());
        if (itbe[i]) impactTypeByText.set(exp, itbe[i]);
        if (sbe[i]) severityByText.set(exp, sbe[i]);
        if (nbe[i]) narrativeByText.set(exp, nbe[i]);
      }
      const dest = citationsByText.get(exp)!;
      const seen = seenCitationKeys.get(exp)!;
      for (const c of cbe[i] || []) {
        const k = `${c.doc_url}|${c.snippet}`;
        if (seen.has(k)) continue;
        seen.add(k);
        dest.push(c);
      }
    });
  }

  return {
    explanations: order,
    citationsByExplanation: order.map(exp => citationsByText.get(exp)!),
    impactTypeByExplanation: order.map(exp => impactTypeByText.get(exp) || ''),
    severityByExplanation: order.map(exp => severityByText.get(exp) || ''),
    narrativeByExplanation: order.map(exp => narrativeByText.get(exp) || ''),
  };
}

// Custom edge that draws a thicker hit-area for easier clicking + the visible stroke
function ClickableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data, markerEnd }: EdgeProps) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const stroke = (style?.stroke as string) || '#6b7280';
  const strokeWidth = (style?.strokeWidth as number) || 1.5;
  const isSelected = (data as { isSelected?: boolean } | undefined)?.isSelected;
  return (
    <>
      {/* invisible wide path for easier clicks */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={18} style={{ cursor: 'pointer' }} />
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{
        ...style,
        stroke,
        strokeWidth: isSelected ? strokeWidth + 1.5 : strokeWidth,
        filter: isSelected ? `drop-shadow(0 0 6px ${stroke})` : 'none',
        opacity: isSelected ? 1 : 0.85,
      }} />
    </>
  );
}

const edgeTypes = { clickable: ClickableEdge };

// ─── Node components ─────────────────────────────────────────────────────────

function CenterNode({ data }: { data: { project: CenterProject } }) {
  const { project } = data;
  const ddsColor = project.dds ? getDDSColor(project.dds) : '#64748b';
  return (
    <div
      className="rounded-2xl px-5 py-4 border shadow-lg relative"
      style={{
        minWidth: 260,
        background: 'radial-gradient(circle at 30% 20%, var(--surface-2) 0%, var(--surface-1) 100%)',
        borderColor: 'var(--border-strong)',
        borderTopColor: ddsColor,
        borderTopWidth: '2px',
      }}
    >
      {/* Single source handle in the center; react-flow draws to it from any angle */}
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none', top: '50%' }} />
      <div className="text-[10px] uppercase tracking-widest text-ink-muted mb-1">{project.projectId}</div>
      <div className="text-base font-bold text-ink-1 leading-snug mb-2">{project.name}</div>
      <div className="flex gap-2 flex-wrap">
        {project.dds && (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold text-white" style={{ background: ddsColor }}>
            {project.dds}
          </span>
        )}
        {project.currentGate && (
          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-accent-soft text-accent-fg border border-accent-border">
            Gate {project.currentGate}
          </span>
        )}
        {project.costKEur !== null && project.costKEur > 0 && (
          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-900/60 text-emerald-200 border border-emerald-800">
            {project.costKEur}k€
          </span>
        )}
      </div>
    </div>
  );
}

function PseudoCircleNode({ data }: { data: { label: string; sublabel?: string; color: string; glow: string; severity: string } }) {
  return (
    <div
      className="rounded-full flex flex-col items-center justify-center text-center font-semibold border-2 backdrop-blur-sm relative"
      style={{
        width: 110, height: 110,
        background: `radial-gradient(circle at 30% 25%, ${data.color}33 0%, ${data.color}11 60%, transparent 100%)`,
        borderColor: data.color,
        boxShadow: `0 0 18px ${data.glow}`,
        color: 'var(--ink-1)',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none', top: '50%' }} />
      <div className="text-[11px] leading-tight px-1.5">{data.label}</div>
      {data.sublabel && (
        <div className="text-[9px] text-ink-4 mt-0.5">{data.sublabel}</div>
      )}
      <div
        className="absolute -top-1 -right-1 w-3 h-3 rounded-full border border-line-faint"
        style={{ background: SEVERITY_COLOR[data.severity] || '#6b7280' }}
        title={`severity: ${data.severity}`}
      />
    </div>
  );
}

function ProjectSatelliteNode({ data }: { data: { label: string; sublabel: string; ddsColor: string; severity: string; onClick?: () => void } }) {
  return (
    <div
      onClick={data.onClick}
      className="rounded-lg px-3 py-2 border-2 hover:scale-105 transition-transform cursor-pointer relative"
      style={{
        minWidth: 160, maxWidth: 200,
        background: 'var(--surface-1)',
        borderColor: data.ddsColor,
        boxShadow: `0 0 14px ${data.ddsColor}44`,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none', top: '50%' }} />
      <div className="text-[11px] font-semibold text-ink-1 truncate" title={data.label}>{data.label}</div>
      <div className="flex items-center gap-1.5 mt-1">
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded text-white" style={{ background: data.ddsColor }}>
          {data.sublabel}
        </span>
        <span className="text-[9px] px-1.5 py-0.5 rounded font-semibold"
          style={{ background: `${SEVERITY_COLOR[data.severity] || '#6b7280'}33`, color: `color-mix(in srgb, ${SEVERITY_COLOR[data.severity] || '#6b7280'} 70%, var(--ink-1))` }}>
          {data.severity}
        </span>
      </div>
    </div>
  );
}

const nodeTypes = {
  center: CenterNode,
  pseudo: PseudoCircleNode,
  satellite: ProjectSatelliteNode,
};

// ─── Layout helper: distribute around center ─────────────────────────────────

interface LayoutItem<T> {
  id: string;
  payload: T;
}

function radialLayout<T>(
  items: LayoutItem<T>[],
  centerX: number, centerY: number,
  radius: number,
  startAngle: number, endAngle: number
): { id: string; x: number; y: number; payload: T }[] {
  if (items.length === 0) return [];
  if (items.length === 1) {
    const angle = (startAngle + endAngle) / 2;
    return [{
      id: items[0].id,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      payload: items[0].payload,
    }];
  }
  const span = endAngle - startAngle;
  const step = span / (items.length - 1);
  return items.map((it, i) => {
    const angle = startAngle + step * i;
    return {
      id: it.id,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      payload: it.payload,
    };
  });
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function ProjectUniverseView() {
  const { focusedProjectId, closeUniverse, openUniverse, theme } = useProjectContext();
  const [data, setData] = useState<UniverseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'reason' | 'evidence'>('reason');
  const [panelWidth, setPanelWidth] = useState(420);
  const [isResizing, setIsResizing] = useState(false);

  // Drag handle for resizable side panel. Tracks viewport-relative mouse X.
  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth - e.clientX;
      setPanelWidth(Math.min(900, Math.max(280, w)));
    };
    const onUp = () => setIsResizing(false);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizing]);

  // When a new edge is selected, reset the active tab to "reason" so the user
  // sees the explanation first, not the previously-open tab.
  useEffect(() => { setActiveTab('reason'); }, [selectedEdgeId]);

  useEffect(() => {
    if (!focusedProjectId) return;
    setLoading(true);
    setError(null);
    setSelectedEdgeId(null);
    fetch(`/api/impact/project/universe?projectId=${encodeURIComponent(focusedProjectId)}`)
      .then(async r => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || 'Failed to load Universe');
        return json as UniverseResponse;
      })
      .then(json => { setData(json); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, [focusedProjectId]);

  const { nodes, edges, edgeDetailsMap } = useMemo<{ nodes: Node[]; edges: Edge[]; edgeDetailsMap: Map<string, EdgeDetails> }>(() => {
    if (!data) return { nodes: [], edges: [], edgeDetailsMap: new Map() };

    const detailsMap = new Map<string, EdgeDetails>();
    const out: { nodes: Node[]; edges: Edge[] } = { nodes: [], edges: [] };

    const cx = 0, cy = 0;
    const RADIUS_INNER = 360;
    const RADIUS_OUTER = 580;

    // Center node
    out.nodes.push({
      id: 'center',
      type: 'center',
      position: { x: cx - 130, y: cy - 50 },
      data: { project: data.project },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      selectable: false,
    });

    // GIO nodes — upper arc (left half-top)
    const gioLayout = radialLayout(
      data.gioNodes.map(n => ({ id: `gio-${n.name}`, payload: n })),
      cx, cy, RADIUS_INNER,
      Math.PI * 1.15, Math.PI * 1.85, // upper arc
    );
    for (const item of gioLayout) {
      const node = item.payload;
      out.nodes.push({
        id: item.id,
        type: 'pseudo',
        position: { x: item.x - 55, y: item.y - 55 },
        data: { label: node.name, sublabel: 'GIO', color: GIO_COLOR, glow: GIO_GLOW, severity: node.severity },
        draggable: false,
      });

      const edgeId = `edge-${item.id}`;
      const sevColor = SEVERITY_COLOR[node.severity] || '#6b7280';
      const primary = node.impacts[0];
      out.edges.push({
        id: edgeId,
        source: 'center',
        target: item.id,
        type: 'clickable',
        animated: node.severity === 'high',
        style: { stroke: sevColor, strokeWidth: 1 + Math.min(3, node.impacts.length) },
        markerEnd: { type: MarkerType.ArrowClosed, color: sevColor, width: 14, height: 14 },
        data: { isSelected: false },
      });

      const gioExp = dedupExplanationsWithCitations(node.impacts);
      detailsMap.set(edgeId, {
        category: 'gio',
        targetName: node.name,
        title: `GIO Service · ${node.name}`,
        subtitle: `${node.impacts.length} impact relationship${node.impacts.length > 1 ? 's' : ''} between ${data.project.projectId} and this service line`,
        color: GIO_COLOR,
        severity: node.severity,
        direction: primary.direction,
        impactTypes: Array.from(new Set(node.impacts.flatMap(i => i.impactTypes))),
        explanations: gioExp.explanations,
        citationsByExplanation: gioExp.citationsByExplanation,
        impactTypeByExplanation: gioExp.impactTypeByExplanation,
        severityByExplanation: gioExp.severityByExplanation,
        narrativeByExplanation: gioExp.narrativeByExplanation,
      });
    }

    // DDS nodes — lower arc (left half-bottom)
    const ddsLayout = radialLayout(
      data.ddsNodes.map(n => ({ id: `dds-${n.name}`, payload: n })),
      cx, cy, RADIUS_INNER,
      Math.PI * 0.15, Math.PI * 0.85, // lower arc
    );
    for (const item of ddsLayout) {
      const node = item.payload;
      const ddsColor = getDDSColor(node.name);
      out.nodes.push({
        id: item.id,
        type: 'pseudo',
        position: { x: item.x - 55, y: item.y - 55 },
        data: { label: node.name, sublabel: 'DDS', color: ddsColor, glow: `${ddsColor}55`, severity: node.severity },
        draggable: false,
      });

      const edgeId = `edge-${item.id}`;
      const sevColor = SEVERITY_COLOR[node.severity] || '#6b7280';
      const primary = node.impacts[0];
      out.edges.push({
        id: edgeId,
        source: 'center',
        target: item.id,
        type: 'clickable',
        animated: node.severity === 'high',
        style: { stroke: sevColor, strokeWidth: 1 + Math.min(3, node.impacts.length) },
        markerEnd: { type: MarkerType.ArrowClosed, color: sevColor, width: 14, height: 14 },
        data: { isSelected: false },
      });

      const ddsExp = dedupExplanationsWithCitations(node.impacts);
      detailsMap.set(edgeId, {
        category: 'dds',
        targetName: node.name,
        title: `DDS Entity · ${node.name}`,
        subtitle: `${node.impacts.length} impact${node.impacts.length > 1 ? 's' : ''} on this DDS entity`,
        color: ddsColor,
        severity: node.severity,
        direction: primary.direction,
        impactTypes: Array.from(new Set(node.impacts.flatMap(i => i.impactTypes))),
        explanations: ddsExp.explanations,
        citationsByExplanation: ddsExp.citationsByExplanation,
        impactTypeByExplanation: ddsExp.impactTypeByExplanation,
        severityByExplanation: ddsExp.severityByExplanation,
        narrativeByExplanation: ddsExp.narrativeByExplanation,
      });
    }

    // Project-to-project edges — outer ring, right side
    const projLayout = radialLayout(
      data.projectEdges.map(e => ({ id: `proj-${e.otherProjectId}`, payload: e })),
      cx, cy, RADIUS_OUTER,
      -Math.PI * 0.45, Math.PI * 0.45, // right side
    );
    for (const item of projLayout) {
      const edge = item.payload;
      const ddsColor = edge.otherProjectDds ? getDDSColor(edge.otherProjectDds) : '#64748b';
      out.nodes.push({
        id: item.id,
        type: 'satellite',
        position: { x: item.x - 90, y: item.y - 25 },
        data: {
          label: edge.otherProjectName,
          sublabel: edge.otherProjectDds || '?',
          ddsColor,
          severity: edge.severity,
          onClick: () => openUniverse(edge.otherProjectId),
        },
        draggable: false,
      });

      const edgeId = `edge-${item.id}`;
      const sevColor = SEVERITY_COLOR[edge.severity] || '#6b7280';
      out.edges.push({
        id: edgeId,
        source: 'center',
        target: item.id,
        type: 'clickable',
        animated: edge.severity === 'high',
        style: { stroke: sevColor, strokeWidth: 1 + Math.min(3, edge.count) },
        markerEnd: edge.bidirectional ? undefined : { type: MarkerType.ArrowClosed, color: sevColor, width: 14, height: 14 },
        markerStart: edge.bidirectional ? { type: MarkerType.ArrowClosed, color: sevColor, width: 14, height: 14 } : undefined,
        data: { isSelected: false },
      });

      const projExpRaw = edge.explanations.length > 0
        ? edge.explanations
        : [edge.explanation].filter(Boolean);
      const projCbeRaw = edge.citationsByExplanation
        ?? projExpRaw.map(() => [] as SourceRef[]);
      const projItbeRaw = edge.impactTypeByExplanation
        ?? projExpRaw.map(() => edge.impactTypes[0] || '');
      const projSbeRaw = edge.severityByExplanation
        ?? projExpRaw.map(() => edge.severity);
      const projNbeRaw = edge.narrativeByExplanation
        ?? projExpRaw.map(() => '');
      const projExp = dedupExplanationsWithCitations([{
        explanations: projExpRaw,
        citationsByExplanation: projCbeRaw,
        impactTypeByExplanation: projItbeRaw,
        severityByExplanation: projSbeRaw,
        narrativeByExplanation: projNbeRaw,
      }]);
      detailsMap.set(edgeId, {
        category: 'project',
        targetName: edge.otherProjectId,
        title: `${edge.otherProjectName}`,
        subtitle: `${edge.otherProjectId} · ${edge.bidirectional ? 'bidirectional' : edge.direction} · ${edge.count} relation${edge.count > 1 ? 's' : ''}`,
        color: ddsColor,
        severity: edge.severity,
        direction: edge.direction,
        impactTypes: edge.impactTypes,
        explanations: projExp.explanations,
        citationsByExplanation: projExp.citationsByExplanation,
        impactTypeByExplanation: projExp.impactTypeByExplanation,
        severityByExplanation: projExp.severityByExplanation,
        narrativeByExplanation: projExp.narrativeByExplanation,
      });
    }

    return { ...out, edgeDetailsMap: detailsMap };
  }, [data, openUniverse]);

  // Apply selection visual to edges
  const decoratedEdges = useMemo(() => edges.map(e => ({
    ...e,
    data: { ...(e.data as object), isSelected: e.id === selectedEdgeId },
  })), [edges, selectedEdgeId]);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId(prev => prev === edge.id ? null : edge.id);
  }, []);

  // Clicking a node opens the same details panel as clicking its edge.
  // For pseudo (gio/dds), the corresponding edge id is `edge-${node.id}`.
  // For project satellites, trigger the navigation closure on the node.
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type !== 'pseudo' && node.type !== 'satellite') return;
    if (node.type === 'satellite') {
      const onClickFn = (node.data as { onClick?: () => void } | undefined)?.onClick;
      if (onClickFn) onClickFn();
      return;
    }
    const edgeId = `edge-${node.id}`;
    setSelectedEdgeId(prev => prev === edgeId ? null : edgeId);
  }, []);

  const selectedDetails = selectedEdgeId ? edgeDetailsMap.get(selectedEdgeId) : null;

  if (!focusedProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-muted">
        Nenhum projeto selecionado.
      </div>
    );
  }

  if (loading) return <LoadingState label="Carregando Universe..." />;
  if (error) return <div className="flex-1 flex items-center justify-center text-red-400">{error}</div>;
  if (!data) return null;

  return (
    <div className="flex-1 flex flex-col bg-surface-deep animate-fadeIn">
      {/* Top bar */}
      <div className="px-5 py-3 border-b border-line flex items-center gap-4 bg-bg">
        <button
          onClick={closeUniverse}
          className="px-3 py-1.5 rounded-md border border-line-strong text-ink-3 text-[12px] hover:bg-surface-2 transition-colors"
        >
          ← Voltar
        </button>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-widest text-ink-muted">Project Universe</div>
          <div className="text-sm font-bold text-ink-1 truncate">{data.project.name}</div>
        </div>
        <div className="flex gap-3 text-xs text-ink-4">
          <Stat label="GIO Services" value={data.stats.gioCount} color={GIO_COLOR} />
          <Stat label="DDS Entities" value={data.stats.ddsCount} color="#06b6d4" />
          <Stat label="Projects" value={data.stats.projectCount} color="#22c55e" />
        </div>
      </div>

      {/* Canvas + side panel */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative">
          <ReactFlow
            nodes={nodes}
            edges={decoratedEdges}
            edgeTypes={edgeTypes}
            nodeTypes={nodeTypes}
            onEdgeClick={onEdgeClick}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'clickable' }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
          >
            <Background gap={32} size={1} color={theme === 'light' ? '#cbd5e1' : '#1e293b'} />
            <Controls className="!bg-surface-1 !border-line-strong" showInteractive={false} />
          </ReactFlow>

          {data.stats.totalImpacts === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-surface-1/80 border border-line rounded-xl px-6 py-4 text-center">
                <div className="text-2xl mb-2">🛰️</div>
                <div className="text-sm text-ink-3 font-semibold">Sem impactos analisados ainda</div>
                <div className="text-xs text-ink-muted mt-1">Rode o Impact Analysis pra popular o universo deste projeto.</div>
              </div>
            </div>
          )}
        </div>

        {/* Drag handle (resize) */}
        <div
          onMouseDown={() => setIsResizing(true)}
          className={`w-1.5 cursor-col-resize bg-surface-2/40 hover:bg-accent/60 transition-colors shrink-0 ${isResizing ? 'bg-accent/80' : ''}`}
          title="Drag to resize"
        />

        {/* Side panel */}
        <div
          className="border-l border-line bg-bg flex flex-col shrink-0"
          style={{ width: panelWidth }}
        >
          {!selectedDetails && (
            <div className="p-5 text-xs text-ink-muted leading-relaxed overflow-y-auto">
              <div className="text-sm font-semibold text-ink-3 mb-2">How to read</div>
              <ul className="space-y-2 list-disc pl-4">
                <li><span className="text-purple-400 font-semibold">Purple</span> — GIO Service Lines impacted</li>
                <li><span className="text-cyan-400 font-semibold">DDS colors</span> — entities / divisions impacted</li>
                <li><span className="text-emerald-400 font-semibold">Right side</span> — related projects</li>
                <li>Line thickness = number of relations; color = severity.</li>
              </ul>
              <div className="mt-4 text-[11px] text-ink-muted">
                Click any line or node to see the AI explanation.
              </div>
            </div>
          )}

          {selectedDetails && (
            <>
              {/* Header removed — per-message badges in "Reason for the impact"
                  carry the severity + impact_type info that used to live here.
                  Aggregated badges duplicated information visible per-bullet. */}

              {/* Tabs */}
              <div className="flex border-b border-line shrink-0">
                <TabButton active={activeTab === 'reason'} onClick={() => setActiveTab('reason')}>Reason</TabButton>
                {focusedProjectId && (selectedDetails.category === 'gio' || selectedDetails.category === 'dds') && (
                  <TabButton active={activeTab === 'evidence'} onClick={() => setActiveTab('evidence')}>Evidence</TabButton>
                )}
              </div>

              {/* Tab body */}
              <div className="flex-1 overflow-y-auto p-5">
                {activeTab === 'reason' && (
                  <div className="animate-fadeIn">
                    <div className="text-[11px] uppercase tracking-wider text-ink-muted mb-2">Reason for the impact</div>
                    <div className="space-y-2">
                      {selectedDetails.explanations.map((exp, i) => {
                        const cites = selectedDetails.citationsByExplanation?.[i] ?? [];
                        const it = selectedDetails.impactTypeByExplanation?.[i];
                        const sv = selectedDetails.severityByExplanation?.[i];
                        const narrative = selectedDetails.narrativeByExplanation?.[i] || '';
                        const sevColor = sv ? SEVERITY_COLOR[sv] : undefined;
                        // Whenever the API gave us a narrative, surface it as the
                        // headline ("Why this matters") and demote the verbatim
                        // quote to a smaller "Evidence" companion — the goal of
                        // the read-side composer (see src/lib/impact-narrative.ts).
                        // Legacy rows without a narrative fall back to rendering
                        // the explanation alone, exactly as before.
                        const hasNarrative = narrative && narrative.trim().length > 0;
                        return (
                          <div key={i} className="text-xs text-ink-2 leading-relaxed bg-surface-1/60 border border-line rounded-md p-3 flex flex-col gap-2">
                            {hasNarrative ? (
                              <>
                                <div className="flex items-start gap-2">
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[9px] uppercase tracking-wider text-accent-text2 font-bold mb-1">Why this matters</div>
                                    <div className="text-ink-1">{narrative}</div>
                                  </div>
                                  {cites.length > 0 && <SourcePopover sources={cites} label="Sources" />}
                                </div>
                                <div className="border-t border-line/40 pt-2">
                                  <div className="text-[9px] uppercase tracking-wider text-ink-muted font-bold mb-1">Evidence</div>
                                  <div className="text-ink-4 italic leading-snug">&ldquo;{exp}&rdquo;</div>
                                </div>
                              </>
                            ) : (
                              <div className="flex items-start gap-2">
                                <div className="flex-1 min-w-0">{exp}</div>
                                {cites.length > 0 && <SourcePopover sources={cites} label="Sources" />}
                              </div>
                            )}
                            {(it || sv) && (
                              <div className="flex gap-1.5 flex-wrap pt-1 border-t border-line/40">
                                {sv && sevColor && (
                                  <Badge label={sv} bg={`${sevColor}33`} fg={sevColor} />
                                )}
                                {it && (
                                  <Badge label={it.replace(/_/g, ' ')} bg="#1e3a8a55" fg="#93c5fd" />
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {selectedDetails.explanations.length === 0 && (
                        <div className="text-xs text-ink-muted italic">No explanation on record.</div>
                      )}
                    </div>

                    {focusedProjectId && (selectedDetails.category === 'gio' || selectedDetails.category === 'dds') && (
                      <div className="mt-5">
                        <DeepDiveButton
                          projectId={focusedProjectId}
                          kind={selectedDetails.category}
                          target={selectedDetails.targetName}
                          compact={false}
                        />
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'evidence' && focusedProjectId && (selectedDetails.category === 'gio' || selectedDetails.category === 'dds') && (
                  <div className="animate-fadeIn">
                    <EvidencePanel
                      projectId={focusedProjectId}
                      highlight={selectedDetails.category}
                      compact
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors ${
        active
          ? 'text-accent-text border-b-2 border-accent-border bg-surface-1/40'
          : 'text-ink-muted hover:text-ink-3 hover:bg-surface-1/30 border-b-2 border-transparent'
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="text-ink-muted">{label}:</span>
      <span className="font-bold text-ink-2 font-mono">{value}</span>
    </div>
  );
}

function Badge({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}
