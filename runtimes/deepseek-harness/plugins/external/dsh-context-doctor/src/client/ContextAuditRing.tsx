/**
 * Context Doctor's native composer control.
 * The panel deliberately uses one lightweight, mono-inspired visual language
 * in both DSH themes instead of inheriting the surrounding chat typography.
 */

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AuditUiState } from './store.ts'
import type { createAuditStore } from './store.ts'
import { NS } from './locales.ts'

export type ContextAuditRingProps =
  PropsRuntime<'conversation.input.context'>
  & PropsStore<ReturnType<typeof createAuditStore>>
  & PropsLocale<typeof NS>

const AUDIT_API = '/api/context-doctor/audit'
const FULL_SCALE = 50_000

const TONE = {
  canvas: 'var(--dsw-alias-bg-layer-2, #101722)',
  panel: 'var(--dsw-alias-bg-layer-1, #171f2b)',
  row: 'var(--dsw-alias-bg-layer-3, #1d2735)',
  border: 'var(--dsw-alias-border-l2, rgba(196, 211, 232, 0.16))',
  borderStrong: 'var(--dsw-alias-border-l3, rgba(196, 211, 232, 0.31))',
  text: 'var(--dsw-alias-label-primary, #f2f6fc)',
  muted: 'var(--dsw-alias-label-secondary, #9daabd)',
  quiet: 'var(--dsw-alias-label-tertiary, #718096)',
  mint: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #78dda0) 76%, var(--dsw-alias-label-secondary, #9daabd))',
  amber: 'var(--dsw-alias-state-warn-primary, #f6c652)',
  red: 'var(--dsw-alias-state-error-primary, #ff8592)',
  blue: 'var(--dsw-alias-brand-primary, #8ec5ff)',
} as const

const MONO = 'ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, monospace'

function healthTone(tokens: number): 'mint' | 'amber' | 'red' {
  if (tokens < 10_000) return 'mint'
  if (tokens < 30_000) return 'amber'
  return 'red'
}

function formatK(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  const value = tokens / 1000
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`
}

function updatedLabel(refreshedAt: number | null): string {
  if (refreshedAt === null) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - refreshedAt) / 1000))
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

function PulseIcon({ size = 20 }: { size?: number }): ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M3 12h4l2.05-5 3.62 10L15.2 12H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3.6 6.8C5.1 4.86 8.06 4.4 10.06 6L12 7.58 13.94 6c2-1.6 4.96-1.14 6.46.8 1.72 2.23 1.43 5.42-.66 7.29L12 21l-7.74-6.91C2.17 12.22 1.88 9.03 3.6 6.8Z" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function MetricIcon({ type }: { type: 'instructions' | 'skills' | 'tools' | 'mcp' }): ReactElement {
  if (type === 'skills') return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 5.5A3.5 3.5 0 0 1 8 4h3.5v15H8a3.5 3.5 0 0 0-3.5 1.5V5.5ZM19.5 5.5A3.5 3.5 0 0 0 16 4h-3.5v15H16a3.5 3.5 0 0 1 3.5 1.5V5.5Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" /></svg>
  if (type === 'tools') return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8.2 7-5 5 5 5M15.8 7l5 5-5 5M13.5 4l-3 16" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
  if (type === 'mcp') return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 3v6m6-6v6M7 9h10v3a5 5 0 0 1-10 0V9Zm5 8v4m-3 0h6" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5h14M5 11h14M5 17h8M18 15.5v4M16 17.5h4" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function RefreshIcon(): ReactElement {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.98-3.8M4 5v4h4M4 13a8 8 0 0 0 14.98 3.8M20 19v-4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function CheckIcon(): ReactElement {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" /><path d="m8.2 12.2 2.45 2.4 5.15-5.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function BudgetRing({ percent, color }: { percent: number; color: string }): ReactElement {
  const radius = 43
  const circumference = 2 * Math.PI * radius
  const progress = Math.max(0.035, Math.min(0.965, percent))
  return <svg width="188" height="188" viewBox="0 0 112 112" aria-hidden="true" style={{ display: 'block', transform: 'rotate(-90deg)' }}>
    <circle cx="56" cy="56" r={radius} fill="none" stroke={TONE.borderStrong} strokeWidth="5.7" />
    <circle cx="56" cy="56" r={radius} fill="none" stroke={color} strokeWidth="5.7" strokeLinecap="round" strokeDasharray={`${progress * circumference} ${circumference}`} />
  </svg>
}

/** Resident control that replaces the built-in meter just before Send. */
export function ContextAuditRing(props: ContextAuditRingProps): ReactElement {
  const { useStore, actions, sessionId } = props
  const state: AuditUiState = useStore(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const controllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    actions.setState('loading', null)
    void fetch(`${AUDIT_API}?session=${encodeURIComponent(sessionId)}`, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error(`audit ${response.status}`)
      return response.json() as Promise<{ ok: boolean; report: AuditUiState['report'] }>
    }).then(data => {
      if (controller.signal.aborted) return
      if (data.ok && data.report !== null && data.report !== undefined) actions.setReport(data.report)
      else actions.setState('error', 'empty audit response')
    }, () => {
      if (!controller.signal.aborted) actions.setState('error', 'audit transport error')
    })
  }, [actions, sessionId])

  useEffect(() => {
    refresh()
    return () => controllerRef.current?.abort()
  }, [refresh])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const report = state.report
  const instructions = report?.injected.instructions.totalTokens ?? 0
  const skills = report?.injected.skills.catalogDescriptionTokens ?? 0
  const schemas = report?.injected.tools.schemaTokens ?? 0
  const resident = instructions + skills + schemas
  const percent = resident / FULL_SCALE
  const level = state.state === 'error' ? 'red' : healthTone(resident)
  const accent = TONE[level]
  const suggestions = report?.suggestions ?? []
  const status = state.state === 'error' ? 'Audit failed' : suggestions.length ? 'Review' : 'Healthy'

  return <span data-context-doctor style={dockStyle}>
    <button type="button" onClick={() => setOpen(value => !value)} title="Context Doctor" aria-label="Context Doctor" aria-expanded={open} aria-controls={panelId} style={triggerStyle}>
      <span style={{ color: accent, display: 'inline-flex' }}><PulseIcon size={17} /></span>
      <span style={triggerLabelStyle}>Context Doctor</span>
      <span aria-hidden="true" style={{ ...triggerStatusStyle, background: accent }} />
    </button>

    {open && <section id={panelId} role="dialog" aria-label="Context Doctor" style={panelStyle}>
      <header style={headerStyle}>
        <span style={{ color: TONE.mint, display: 'inline-flex' }}><PulseIcon size={31} /></span>
        <div>
          <h2 style={titleStyle}>Context Doctor</h2>
          <p style={subtitleStyle}>Context budget audit</p>
        </div>
      </header>

      {state.state === 'error' && <div style={errorStyle}>Audit failed: {state.error}</div>}

      {report === null && state.state !== 'error' ? <div style={emptyStyle}>{state.state === 'loading' ? 'Auditing context…' : 'No audit data yet.'}</div> : report !== null && <>
        <div style={summaryStyle}>
          <div style={gaugeColumnStyle}>
            <div style={gaugeWrapStyle}>
              <BudgetRing percent={percent} color={accent} />
              <div style={gaugeCaptionStyle}>
                <strong style={{ color: accent, fontSize: 37, fontWeight: 460 }}>{Math.round(Math.min(percent, 1) * 100)}%</strong>
                <span style={gaugeGuideStyle}>of 50k</span>
              </div>
            </div>
            <span style={totalLabelStyle}>Total</span>
            <strong style={totalStyle}>{formatK(resident)}</strong>
            <span style={tokensStyle}>tokens</span>
          </div>
          <div style={metricsStyle}>
            <MetricRow type="instructions" label="Instruction chain" value={instructions} ratio={resident === 0 ? 0 : instructions / resident} color={TONE.mint} />
            <MetricRow type="skills" label="Skills catalog" value={skills} ratio={resident === 0 ? 0 : skills / resident} color={TONE.mint} />
            <MetricRow type="tools" label="Tool schemas" value={schemas} ratio={resident === 0 ? 0 : schemas / resident} color={TONE.amber} />
            <MetricRow type="mcp" label="MCP tools" value={report.injected.tools.mcp.totalTokens} ratio={resident === 0 ? 0 : report.injected.tools.mcp.totalTokens / resident} color={TONE.mint} />
          </div>
        </div>

        <div style={healthStyle}>
          <span style={{ color: accent, display: 'inline-flex' }}><CheckIcon /></span>
          <div>
            <strong style={{ ...healthTitleStyle, color: accent }}>{status}</strong>
            <p style={healthCopyStyle}>{suggestions.length ? 'Some context entries are worth reviewing before they become expensive.' : 'Your context is efficient and remains within the recommended budget.'}</p>
          </div>
        </div>

        {suggestions.length > 0 && <div style={suggestionsStyle}>
          <h3 style={suggestionsTitleStyle}>Suggestions</h3>
          <ol style={suggestionListStyle}>{suggestions.slice(0, 3).map((suggestion, index) => {
            const tone = suggestion.severity === 'high' ? TONE.red : suggestion.severity === 'medium' ? TONE.amber : TONE.mint
            return <li key={`${suggestion.severity}-${suggestion.text}`} style={suggestionStyle}>
              <span style={{ ...suggestionIndexStyle, color: tone, borderColor: tone }}>{index + 1}</span>
              <span style={suggestionCopyStyle}><strong style={{ color: tone, fontWeight: 520 }}>Review audit finding</strong><small>{suggestion.text}</small></span>
              <span aria-hidden="true" style={arrowStyle}>›</span>
            </li>
          })}</ol>
        </div>}
      </>}

      <footer style={footerStyle}>
        <span style={updatedStyle}>Last updated: {updatedLabel(state.refreshedAt)}</span>
        <button type="button" onClick={refresh} disabled={state.state === 'loading'} style={refreshStyle}><RefreshIcon />Refresh</button>
      </footer>
    </section>}
  </span>
}

function MetricRow({ type, label, value, ratio, color }: { type: 'instructions' | 'skills' | 'tools' | 'mcp'; label: string; value: number; ratio: number; color: string }): ReactElement {
  return <div style={metricRowStyle}>
    <span style={{ ...metricIconStyle, color }}><MetricIcon type={type} /></span>
    <span style={metricLabelStyle}>{label}</span>
    <span style={metricValueStyle}>{formatK(value)}</span>
    <span style={{ ...metricPercentStyle, color }}>{Math.round(ratio * 100)}%</span>
  </div>
}

const dockStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', position: 'relative', fontFamily: MONO }
const triggerStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 33, padding: '5px 10px', color: TONE.text, background: TONE.panel, border: `1px solid ${TONE.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: MONO, fontWeight: 430 }
const triggerLabelStyle: CSSProperties = { color: TONE.text, fontSize: 12, fontWeight: 430, whiteSpace: 'nowrap' }
const triggerStatusStyle: CSSProperties = { width: 8, height: 8, marginLeft: 2, borderRadius: 99, boxShadow: '0 0 0 3px color-mix(in srgb, currentColor 8%, transparent)' }
const panelStyle: CSSProperties = { position: 'absolute', zIndex: 1000, right: 0, bottom: 'calc(100% + 14px)', width: 560, maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 101px)', overflowX: 'hidden', overflowY: 'auto', color: TONE.text, background: TONE.canvas, border: `1px solid ${TONE.borderStrong}`, borderRadius: 15, boxShadow: '0 24px 62px rgba(3, 8, 18, 0.38)', textAlign: 'left', fontFamily: MONO, fontWeight: 400 }
const headerStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '34px 1fr', alignItems: 'center', columnGap: 14, padding: '24px 28px 22px', borderBottom: `1px solid ${TONE.border}` }
const titleStyle: CSSProperties = { margin: 0, color: TONE.text, fontFamily: MONO, fontSize: 23, fontWeight: 460, letterSpacing: '-0.025em', lineHeight: 1.1 }
const subtitleStyle: CSSProperties = { margin: '10px 0 0', color: TONE.muted, fontFamily: MONO, fontSize: 14, fontWeight: 400, lineHeight: 1.2 }
const errorStyle: CSSProperties = { margin: '14px 28px 0', color: TONE.red, fontSize: 13, lineHeight: 1.45 }
const emptyStyle: CSSProperties = { padding: '50px 28px', color: TONE.muted, fontSize: 14, textAlign: 'center' }
const summaryStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '42% 58%', minHeight: 305, borderBottom: `1px solid ${TONE.border}` }
const gaugeColumnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '25px 18px', borderRight: `1px solid ${TONE.border}` }
const gaugeWrapStyle: CSSProperties = { position: 'relative', width: 188, height: 188, display: 'grid', placeItems: 'center' }
const gaugeCaptionStyle: CSSProperties = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7 }
const gaugeGuideStyle: CSSProperties = { color: TONE.muted, fontSize: 13, fontWeight: 400 }
const totalLabelStyle: CSSProperties = { marginTop: 21, color: TONE.muted, fontSize: 15, fontWeight: 400 }
const totalStyle: CSSProperties = { marginTop: 8, color: TONE.text, fontSize: 34, fontWeight: 440, lineHeight: 1, letterSpacing: '-0.045em', fontVariantNumeric: 'tabular-nums' }
const tokensStyle: CSSProperties = { marginTop: 9, color: TONE.muted, fontSize: 15, fontWeight: 400 }
const metricsStyle: CSSProperties = { display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 17, padding: '26px 30px' }
const metricRowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '43px minmax(0, 1fr) auto 39px', alignItems: 'center', columnGap: 10, minHeight: 55 }
const metricIconStyle: CSSProperties = { display: 'grid', width: 41, height: 41, placeItems: 'center', border: `1px solid ${TONE.border}`, borderRadius: 8 }
const metricLabelStyle: CSSProperties = { overflow: 'hidden', color: TONE.text, fontSize: 15, fontWeight: 420, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const metricValueStyle: CSSProperties = { color: TONE.text, fontSize: 15, fontWeight: 420, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }
const metricPercentStyle: CSSProperties = { textAlign: 'right', fontSize: 15, fontWeight: 430, fontVariantNumeric: 'tabular-nums' }
const healthStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '42px 1fr', alignItems: 'start', columnGap: 12, padding: '23px 29px 25px', borderBottom: `1px solid ${TONE.border}` }
const healthTitleStyle: CSSProperties = { display: 'block', marginTop: 1, fontSize: 17, fontWeight: 470 }
const healthCopyStyle: CSSProperties = { margin: '8px 0 0', color: TONE.muted, fontSize: 14, fontWeight: 400, lineHeight: 1.5 }
const suggestionsStyle: CSSProperties = { padding: '23px 29px 22px', borderBottom: `1px solid ${TONE.border}` }
const suggestionsTitleStyle: CSSProperties = { margin: '0 0 15px', color: TONE.text, fontSize: 16, fontWeight: 440 }
const suggestionListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' }
const suggestionStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '33px minmax(0, 1fr) 15px', alignItems: 'center', columnGap: 12, padding: '11px 13px', background: TONE.row, border: `1px solid ${TONE.border}`, borderRadius: 9 }
const suggestionIndexStyle: CSSProperties = { display: 'grid', width: 29, height: 29, placeItems: 'center', border: '1px solid', borderRadius: 99, fontSize: 14, fontWeight: 460 }
const suggestionCopyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, gap: 4, fontSize: 14, lineHeight: 1.35 }
const arrowStyle: CSSProperties = { color: TONE.text, fontSize: 28, fontWeight: 300, lineHeight: 1 }
const footerStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '19px 29px 20px' }
const updatedStyle: CSSProperties = { color: TONE.quiet, fontSize: 13, fontWeight: 400, fontVariantNumeric: 'tabular-nums' }
const refreshStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 9, padding: 0, color: TONE.blue, background: 'transparent', border: 0, cursor: 'pointer', fontFamily: MONO, fontSize: 15, fontWeight: 430 }
