import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type CompatibilityNote,
  type RenderEngineInfo,
  type RendererInfo,
  type ShaderCatalogue,
  type ShaderPackInfo,
  type UseCase
} from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
  /** Hand the choice to the agent, which has the catalogue as a tool. */
  onSend: (text: string) => void
  /** Jump to Clips, where footage becomes a look reference. */
  onRecordLook: () => void
}

const WEIGHT_ORDER: Record<ShaderPackInfo['weight'], number> = { light: 0, medium: 1, heavy: 2, extreme: 3 }

const ENGINE_KIND_LABEL: Record<RenderEngineInfo['kind'], string> = {
  'pack-loader': 'Loads shader packs',
  perf: 'Performance renderer',
  sdk: 'Rendering SDK for mods',
  instancing: 'Instancing engine',
  legacy: 'Legacy (pre-Iris)'
}

/**
 * The shader catalogue, as a list you pick from.
 *
 * Two sections, and the split is the point: **shader packs** are what the player
 * installs, **rendering engines** are what mod code is written against. They are
 * routinely conflated — most "best Minecraft shaders" lists mix Sodium and
 * OptiFine in with Complementary and BSL — and a mod author who believes Sodium
 * is a shader API wastes an afternoon. So the panel never presents one mixed
 * list, and each engine carries the specific misconception it attracts.
 *
 * Selection is local and does nothing on its own; "Ask the agent" sends the
 * chosen ids, so the recommendation comes from the same catalogue the list is
 * built from rather than from the model's memory of what is popular.
 */
export default function ShaderPanel({ onToast, onSend, onRecordLook }: Props): JSX.Element {
  const [cat, setCat] = useState<ShaderCatalogue | null>(null)
  const [error, setError] = useState('')
  const [useCase, setUseCase] = useState<UseCase>('looks')
  const [chosen, setChosen] = useState<string[]>([])
  const [notes, setNotes] = useState<CompatibilityNote[]>([])
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [tab, setTab] = useState<'recommend' | 'packs' | 'engines'>('recommend')
  const [renderer, setRenderer] = useState<RendererInfo | null>(null)

  const load = useCallback(async () => {
    try {
      const [res, rend] = await Promise.all([api.shaders.catalogue(), api.renderer.capabilities()])
      setCat(res)
      setRenderer(rend)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(
    (id: string) => {
      setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
    },
    []
  )

  /** Re-check conflicts whenever the selection changes. */
  useEffect(() => {
    if (!chosen.length) {
      setNotes([])
      return
    }
    void (async () => {
      const res = await api.shaders.check(chosen)
      setNotes(res.notes ?? [])
    })()
  }, [chosen])

  const rec = cat?.recommendations?.[useCase]
  const availPacks = cat?.available.packs ?? []
  const availEngines = cat?.available.engines ?? []
  const allPacks = cat?.all.packs ?? []
  const allEngines = cat?.all.engines ?? []
  const unavailablePacks = allPacks.filter((p) => !availPacks.some((a) => a.id === p.id))
  const unavailableEngines = allEngines.filter((e) => !availEngines.some((a) => a.id === e.id))

  const chosenNames = [...chosen].map((id) => {
    const bare = id.replace(/^engine:/, '')
    return (
      allPacks.find((p) => p.id === bare)?.name ?? allEngines.find((e) => e.id === bare)?.name ?? bare
    )
  })

  const nameOf = (id: string): string => {
    const bare = id.replace(/^engine:/, '')
    return allPacks.find((p) => p.id === bare)?.name ?? allEngines.find((e) => e.id === bare)?.name ?? bare
  }

  return (
    <div>
      <p className="muted small">
        Two different things, deliberately not mixed: a <b>shader pack</b> is what the player installs and a mod
        cannot ship it; a <b>rendering engine</b> is what mod code is written against, and most of the popular ones
        are not shader APIs at all. Pick from either list, or let the recommendation pick for you.
      </p>

      {error && <p className="warn">{error}</p>}

      {cat && (
        <p className="muted small">
          Showing <b>{cat.mcVersion}</b> · {cat.loader}. {availPacks.length} of {allPacks.length} packs and{' '}
          {availEngines.length} of {allEngines.length} engines apply here.
        </p>
      )}

      <div className="row wrap">
        {(
          [
            ['recommend', 'Recommended'],
            ['packs', `Shader packs (${availPacks.length})`],
            ['engines', `Rendering engines (${availEngines.length})`]
          ] as const
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'chip on' : 'chip'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'recommend' && cat && (
        <>
          <label className="field">
            <span>What are you after?</span>
            <select value={useCase} onChange={(e) => setUseCase(e.target.value as UseCase)}>
              {(Object.keys(cat.useCases) as UseCase[]).map((u) => (
                <option key={u} value={u}>
                  {cat.useCases[u]}
                </option>
              ))}
            </select>
          </label>

          {rec && rec.picks.length === 0 && (
            <p className="warn">
              Nothing in the catalogue applies to {rec.mcVersion} on {rec.loader}. That is a real answer, not a gap —
              ask the agent what this version can do instead.
            </p>
          )}

          {rec?.picks.map((p, i) => (
            <div key={p.id} className="card">
              <div className="row wrap">
                <b>
                  {i + 1}. {p.name}
                </b>
                <span className="chip">{p.kind === 'pack' ? 'shader pack' : 'rendering engine'}</span>
              </div>
              <p className="muted small">{p.why}</p>
              <p className="muted small">
                <b>Do this:</b> {p.action}
              </p>
              <button className={chosen.includes(p.id) ? 'chip on' : 'chip'} onClick={() => toggle(p.id)}>
                {chosen.includes(p.id) ? 'Selected' : 'Select'}
              </button>
            </div>
          ))}

          {rec?.avoid && <p className="warn">{rec.avoid}</p>}
        </>
      )}

      {tab === 'packs' && (
        <>
          <p className="muted small">
            Ordered by rough download volume. Weight is the cost: a <b>heavy</b> pack is a 60 fps card on a 1440p
            screen, an <b>extreme</b> one is not. The player installs these — a mod can point at one in its docs, it
            cannot bundle one.
          </p>
          {[...availPacks]
            .sort((a, b) => WEIGHT_ORDER[a.weight] - WEIGHT_ORDER[b.weight] || b.popularity - a.popularity)
            .map((p) => (
              <div key={p.id} className="card">
                <div className="row wrap">
                  <b>{p.name}</b>
                  <span className="chip">{p.weight}</span>
                  <span className="chip">{p.style}</span>
                  <span className="chip">{p.runsOn.join(' / ')}</span>
                </div>
                <p className="muted small">
                  {p.author} · lowest GPU worth trying: {p.minGpu}
                </p>
                <p className="small">{p.bestFor}</p>
                <p className="muted small">{p.caveat}</p>
                <div className="row wrap">
                  <button className={chosen.includes(p.id) ? 'chip on' : 'chip'} onClick={() => toggle(p.id)}>
                    {chosen.includes(p.id) ? 'Selected' : 'Select'}
                  </button>
                  <a href={p.url} target="_blank" rel="noreferrer">
                    <button className="chip">Page</button>
                  </a>
                </div>
              </div>
            ))}

          {unavailablePacks.length > 0 && (
            <>
              <button className="chip" onClick={() => setShowUnavailable((v) => !v)}>
                {showUnavailable ? 'Hide' : 'Show'} {unavailablePacks.length} that will not run here
              </button>
              {showUnavailable &&
                unavailablePacks.map((p) => (
                  <div key={p.id} className="card">
                    <div className="row wrap">
                      <b>{p.name}</b>
                      <span className="chip">{p.weight}</span>
                      <span className="chip">not for {cat?.mcVersion}</span>
                    </div>
                    <p className="muted small">{p.caveat}</p>
                  </div>
                ))}
            </>
          )}
        </>
      )}

      {tab === 'engines' && (
        <>
          <p className="muted small">
            What mod code actually builds on, or has to tolerate. The line under each name is the thing people
            usually get wrong about it.
          </p>
          {availEngines.map((e) => (
            <div key={e.id} className="card">
              <div className="row wrap">
                <b>{e.name}</b>
                <span className="chip">{ENGINE_KIND_LABEL[e.kind]}</span>
                <span className="chip">{e.dependOn ? 'mod may depend on it' : 'player installs it'}</span>
              </div>
              <p className="small">{e.gives}</p>
              <p className="warn small">{e.misread}</p>
              <p className="muted small">
                {e.versions.min}
                {e.versions.max ? `–${e.versions.max}` : '+'} · {e.loaders.join(' / ')} · {e.cost}
              </p>
              {e.needs?.length ? <p className="muted small">Needs: {e.needs.join(', ')}</p> : null}
              {e.conflicts?.length ? <p className="muted small">Conflicts: {e.conflicts.join(', ')}</p> : null}
              <div className="row wrap">
                <button className={chosen.includes(`engine:${e.id}`) ? 'chip on' : 'chip'} onClick={() => toggle(`engine:${e.id}`)}>
                  {chosen.includes(`engine:${e.id}`) ? 'Selected' : 'Select'}
                </button>
                <a href={e.url} target="_blank" rel="noreferrer">
                  <button className="chip">Page</button>
                </a>
              </div>
            </div>
          ))}

          {unavailableEngines.length > 0 && (
            <>
              <button className="chip" onClick={() => setShowUnavailable((v) => !v)}>
                {showUnavailable ? 'Hide' : 'Show'} {unavailableEngines.length} that do not support this version
              </button>
              {showUnavailable &&
                unavailableEngines.map((e) => (
                  <div key={e.id} className="card">
                    <div className="row wrap">
                      <b>{e.name}</b>
                      <span className="chip">{ENGINE_KIND_LABEL[e.kind]}</span>
                      <span className="chip">
                        {e.versions.min}
                        {e.versions.max ? `–${e.versions.max}` : '+'}
                      </span>
                    </div>
                    <p className="muted small">{e.misread}</p>
                  </div>
                ))}
            </>
          )}
        </>
      )}

      {chosen.length > 0 && (
        <div className="card">
          <b>Your selection ({chosen.length})</b>
          <p className="muted small">{chosenNames.join(' + ')}</p>
          {notes.length === 0 ? (
            <p className="muted small">No conflicts found between these.</p>
          ) : (
            <ul className="files">
              {notes.map((n, i) => (
                <li key={i} className={n.severity === 'error' ? 'warn' : 'muted small'}>
                  {n.severity === 'error' ? 'Error: ' : 'Note: '}
                  {n.message}
                </li>
              ))}
            </ul>
          )}
          <div className="row wrap">
            <button onClick={() => setChosen([])}>Clear</button>
            <button
              className="primary"
              onClick={() =>
                onSend(
                  `I picked these for my mod (Minecraft ${cat?.mcVersion ?? ''}): ${chosenNames.join(', ')}. ` +
                    `Call recommend_shaders with the closest use case for what I am building and check this set against it, ` +
                    `then tell me what I have to do myself — which of these the player installs, and which ones my code can rely on. ` +
                    `Do not claim photorealism if the answer depends on a shader pack.`
                )
              }
            >
              Ask the agent about this set
            </button>
          </div>
        </div>
      )}

      {renderer && (
        <details className="refs">
          <summary>What this version can and cannot do</summary>
          <p className="muted small">
            <b>{renderer.mcVersion}</b> · {renderer.support.apiLabel} · {renderer.support.shadingLanguage}
          </p>
          <p className="muted small">
            <b>How shaders load:</b> {renderer.support.howShadersLoad}
          </p>
          <p className={renderer.verdict.achievable ? 'muted small' : 'warn'}>
            <b>Photorealistic:</b> {renderer.verdict.achievable ? 'possible' : 'not from mod code'}. {renderer.verdict.how}
          </p>
          <p className="muted small">
            <b>Can</b>
          </p>
          <ul className="files">
            {renderer.support.stage.can.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="muted small">
            <b>Cannot</b>
          </p>
          <ul className="files">
            {renderer.support.stage.cannot.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <ul className="files">
            {renderer.support.constraints.map((c) => (
              <li key={c} className="muted small">
                {c}
              </li>
            ))}
          </ul>
          <button
            onClick={() =>
              onSend(
                `I want a custom renderer or shader effect for this mod (Minecraft ${renderer.mcVersion}). ` +
                  `Call renderer_capabilities first and tell me in one sentence what is actually reachable here and what is not. ` +
                  `Then ask me what the effect should look like, write it for the API this version has, and do not claim photorealism if it needs a shader pack.`
              )
            }
          >
            Ask the agent for a shader or renderer
          </button>
        </details>
      )}

      <div className="card">
        <b>Match a look you have seen</b>
        <p className="muted small">
          Record 30 seconds of footage that looks the way you want — your own game with a pack on, or anything you have
          captured — then analyse it as a <b>look reference</b>. The analysis names the light, water and colour it can
          actually see, says which parts your mod can own (textures, models, PBR maps) and which parts the player has to
          install as a pack. Vanilla Minecraft is rasterised; true path tracing is not something mod code adds.
        </p>
        <button onClick={onRecordLook}>Record a look reference</button>
      </div>

      <div className="row wrap">
        <button
          onClick={() =>
            onSend(
              `Call recommend_shaders for: ${(cat?.useCases[useCase] ?? useCase).toLowerCase()}. ` +
                `Then explain the picks in your own words — what the player installs versus what I code against — and ask me which one I want before writing anything.`
            )
          }
        >
          Ask the agent for a recommendation
        </button>
        <button
          onClick={() => {
            void (async () => {
              await load()
              onToast('Catalogue reloaded')
            })()
          }}
        >
          Reload catalogue
        </button>
      </div>
    </div>
  )
}
