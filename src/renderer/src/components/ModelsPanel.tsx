import { useCallback, useEffect, useState } from 'react'
import { api, type ModelInfo, type ModelKind } from '../lib/api'

interface Props {
  onToast: (text: string, kind?: 'ok' | 'err') => void
  /** Used for the options this panel cannot express as a button. */
  onSend: (text: string) => void
}

/**
 * 3D models and animations.
 *
 * The generator is deterministic — a cube is arithmetic, not a judgement call —
 * so this is a form, not a chat prompt: pressing a button writes a correct file
 * immediately, with no model call and no invented coordinates. What a generator
 * genuinely cannot do is make something *look* like a dragon, so the panel says
 * where the file is and that Blockbench is the tool for the art, rather than
 * pretending otherwise.
 *
 * Paths come from the project's Minecraft version. On 1.12 there is no geo/
 * folder and no animation JSON at all, so the panel hides those options and says
 * why instead of writing files the game never reads.
 */
export default function ModelsPanel({ onToast, onSend }: Props): JSX.Element {
  const [info, setInfo] = useState<ModelInfo | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ModelKind>('block')
  const [texture, setTexture] = useState('')
  const [skeleton, setSkeleton] = useState<'none' | 'quadruped'>('quadruped')
  const [fullCube, setFullCube] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ written: string[]; textureFile: string | null } | null>(null)

  const refresh = useCallback(async () => {
    setInfo(await api.models.info())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const legacy = info?.legacy ?? false
  const kinds: { id: ModelKind; label: string; hint: string; disabled?: boolean }[] = [
    { id: 'block', label: 'Block', hint: 'A cube (or a slab/column) with a blockstate, so it appears in the world.' },
    { id: 'item', label: 'Item', hint: 'A flat item sprite that inherits from item/generated.' },
    {
      id: 'entity',
      label: 'Mob / entity',
      hint: legacy ? 'Not available on this version — see the note below.' : 'Bedrock geometry with a parented skeleton, openable in Blockbench.',
      disabled: legacy
    },
    {
      id: 'animation',
      label: 'Mob + walk cycle',
      hint: legacy ? 'Not available on this version.' : 'The quadruped rig plus a looping walk animation.',
      disabled: legacy
    }
  ]

  async function create(): Promise<void> {
    setBusy(true)
    setResult(null)
    try {
      const res = await api.models.create({
        name,
        kind,
        texture: texture || undefined,
        skeleton: kind === 'animation' ? 'quadruped' : skeleton,
        size: kind === 'block' && !fullCube ? [16, 8, 16] : undefined
      })
      if (!res.ok) {
        onToast(res.error ?? 'could not write the model', 'err')
        return
      }
      setResult({ written: res.written ?? [], textureFile: res.textureFile ?? null })
      onToast(`Wrote ${res.written?.length ?? 0} file(s)`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const canCreate = /^[a-z0-9_]{2,48}$/.test(name) && !busy && !(legacy && (kind === 'entity' || kind === 'animation'))

  return (
    <div className="panel">
      <h2>3D models &amp; animations</h2>
      <p className="muted">
        Generates model JSON in the folder your version actually reads, then tells you which texture it expects.
        Models that are structurally wrong are invisible with no error in the log, so every file is validated before it is written.
      </p>

      {info && (
        <div className="kv">
          <div>
            <span>Version</span>
            <b>{info.mcVersion}</b>
          </div>
          <div>
            <span>Mod id</span>
            <b>{info.modId}</b>
          </div>
        </div>
      )}

      {legacy && (
        <p className="warn">
          Minecraft {info?.mcVersion} has no JSON entity models or animation files. A mob on this version is a Java class
          extending <code>ModelBase</code> with <code>ModelRenderer</code> parts, registered in the client proxy — ask the agent to write
          that instead. Blocks and items work exactly as below.
        </p>
      )}

      <div className="row wrap">
        {kinds.map((k) => (
          <button
            key={k.id}
            className={kind === k.id ? 'chip on' : 'chip'}
            disabled={k.disabled}
            title={k.hint}
            onClick={() => setKind(k.id)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="muted small">{kinds.find((k) => k.id === kind)?.hint}</p>

      <label className="field">
        <span>Name</span>
        <input
          value={name}
          placeholder={kind === 'block' ? 'ruby_block' : kind === 'item' ? 'ruby_gem' : 'ruby_golem'}
          onChange={(e) => setName(e.target.value.trim().toLowerCase())}
        />
      </label>
      <p className="muted small">
        Lowercase letters, digits and underscores. This becomes the file name, the registry id and the texture name, which is
        why it is validated rather than free text.
      </p>

      {(kind === 'block' || kind === 'item') && (
        <>
          <label className="field">
            <span>Texture</span>
            <input
              value={texture}
              placeholder={kind === 'block' ? `block/${name || 'ruby_block'}` : `item/${name || 'ruby_gem'}`}
              onChange={(e) => setTexture(e.target.value.trim())}
            />
          </label>
          <p className="muted small">
            Optional — defaults to <code>{kind}/{name || '…'}</code>. You can paste a path, a namespaced id, or the full
            assets path; it is normalised either way.
          </p>
        </>
      )}

      {kind === 'block' && (
        <label className="check">
          <input type="checkbox" checked={fullCube} onChange={(e) => setFullCube(e.target.checked)} />
          <span>
            Full cube. Uncheck for a half-height slab-style element with its own UV layout — a full-size element on a
            slab is the usual reason a custom block's texture looks stretched.
          </span>
        </label>
      )}

      {!legacy && (kind === 'entity' || kind === 'animation') && (
        <label className="check">
          <input type="checkbox" checked={skeleton === 'quadruped'} onChange={(e) => setSkeleton(e.target.checked ? 'quadruped' : 'none')} />
          <span>Quadruped skeleton — body, head, four legs, feet on the floor, head at the front.</span>
        </label>
      )}

      <button className="primary" disabled={!canCreate} onClick={() => void create()}>
        {busy ? 'Writing…' : 'Write the model files'}
      </button>

      {result && (
        <div className="card">
          <b>Written</b>
          <ul className="files">
            {result.written.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
          {result.textureFile && (
            <p className="muted small">
              The model refers to a texture that must exist at <code>{result.textureFile}</code>. Without it the block renders
              as the black-and-pink checkerboard — the model is still correct, the texture is missing.
            </p>
          )}
          {(kind === 'entity' || kind === 'animation') && (
            <p className="muted small">
              Open the <code>.geo.json</code> in Blockbench to sculpt it. The rig is structurally correct; making it look like
              a specific creature is art, not arithmetic.
            </p>
          )}
          {kind === 'animation' && (
            <p className="muted small">
              The animation file does nothing on its own — the entity's renderer or animation controller has to reference
              <code> animation.{info?.modId}.{name}.walk</code>.
            </p>
          )}
        </div>
      )}

      <details className="refs">
        <summary>Where each file goes</summary>
        <table className="table">
          <tbody>
            <tr>
              <td>Block models</td>
              <td><code>{info?.folders.blockModels}</code></td>
            </tr>
            <tr>
              <td>Item models</td>
              <td><code>{info?.folders.itemModels}</code></td>
            </tr>
            <tr>
              <td>Blockstates</td>
              <td><code>{info?.folders.blockstates}</code></td>
            </tr>
            <tr>
              <td>Entity geometry</td>
              <td>{info?.folders.geo ? <code>{info.folders.geo}</code> : <em>not used on this version</em>}</td>
            </tr>
            <tr>
              <td>Animations</td>
              <td>{info?.folders.animations ? <code>{info.folders.animations}</code> : <em>not used on this version</em>}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small">{info?.note}</p>
      </details>

      <details className="refs">
        <summary>Something more shaped than a cube</summary>
        <p className="muted small">
          A generator can build a correct rig or a block; it cannot design a creature. For anything with a silhouette, ask the
          agent, which can write multi-bone geometry, or sculpt the generated <code>.geo.json</code> in Blockbench and hand it back.
        </p>
        <button
          onClick={() =>
            onSend(
              `I want a 3D model for this mod. Ask me what the creature or block should look like, then build the geometry with make_model ` +
                `(entity + quadruped skeleton if it is a mob), write a walk animation if it moves, and tell me the texture size and file to draw. ` +
                `Check it with check_model before you say it is done.`
            )
          }
        >
          Ask the agent for a shaped model
        </button>
      </details>
    </div>
  )
}
