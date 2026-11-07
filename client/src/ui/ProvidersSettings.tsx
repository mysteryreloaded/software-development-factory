// The 🔌 Providers tab: the three built-in coding agents (read-only) and the office's custom providers (#113), each
// an OpenAI-compatible endpoint run through OpenCode. Add/edit/delete/check all go through server/swarm.ts's
// /api/providers routes; the API key never comes back from the server, so it's write-only here too.
import { useEffect, useId, useState } from 'react';
import { api, type BuiltInProvider, type ProviderFields } from '../api';
import { useStore } from '../store';
import type { CustomProvider, ProviderCheckResult } from '../../../shared/types';
import { confirmDialog } from './Confirm';

type CustomProviderView = CustomProvider & { hasKey: true };

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function CheckResult({ result }: { result: ProviderCheckResult }) {
  if (!result.reachable) return <p className="term-error small">Not reachable: {result.error}</p>;
  if (result.error) return <p className="term-error small">{result.error}</p>;
  if (result.modelListed === false) return <p className="term-error small">Reachable, but its model isn't listed.</p>;
  return <p className="small">✅ Reachable, model listed.</p>;
}

/** The add/edit form: required endpoint, key and model; optional name, context window and max output tokens. */
function ProviderForm({ editing, onDone, onCancel }: { editing: CustomProviderView | null; onDone: () => void; onCancel: () => void }) {
  const id = useId();
  const [name, setName] = useState(editing?.name ?? '');
  const [baseURL, setBaseURL] = useState(editing?.baseURL ?? '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(editing?.model ?? '');
  const [contextLimit, setContextLimit] = useState(editing?.contextLimit ? String(editing.contextLimit) : '');
  const [outputLimit, setOutputLimit] = useState(editing?.outputLimit ? String(editing.outputLimit) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<ProviderCheckResult | null>(null);

  const urlOk = isHttpUrl(baseURL);
  const keyOk = editing ? true : apiKey.trim() !== '';
  const modelOk = model.trim() !== '';
  const canSave = urlOk && keyOk && modelOk;
  const canCheck = urlOk && modelOk && (editing ? apiKey.trim() !== '' : keyOk);

  const fields = (): ProviderFields => ({
    name: name.trim() || model.trim(),
    baseURL: baseURL.trim(),
    model: model.trim(),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    // On edit, an emptied limit must clear it (null), not leave the current one (undefined, dropped by JSON).
    contextLimit: contextLimit.trim() ? Number(contextLimit) : editing ? null : undefined,
    outputLimit: outputLimit.trim() ? Number(outputLimit) : editing ? null : undefined,
  });

  const check = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      setCheckResult(await api.checkProvider({ baseURL: baseURL.trim(), apiKey: apiKey.trim(), model: model.trim() }));
    } catch (err) {
      setCheckResult({ reachable: false, status: null, modelListed: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (editing) await api.updateProvider(editing.id, fields());
      else await api.createProvider(fields());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="card provider-form"
      aria-label={editing ? `Edit ${editing.name}` : 'Add a provider'}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void save();
      }}
    >
      <h3>{editing ? `✏️ Edit ${editing.name}` : '➕ Add a provider'}</h3>
      <label className="field" htmlFor={`${id}-endpoint`}>
        <span>API endpoint</span>
        <input id={`${id}-endpoint`} value={baseURL} placeholder="http://host:port/v1" aria-invalid={baseURL !== '' && !urlOk} onChange={(e) => setBaseURL(e.target.value)} />
      </label>
      <label className="field" htmlFor={`${id}-key`}>
        <span>API key</span>
        <input
          id={`${id}-key`}
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={editing ? 'leave empty to keep the current key' : 'required'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <label className="field" htmlFor={`${id}-model`}>
        <span>Model name</span>
        <input id={`${id}-model`} value={model} placeholder="required" onChange={(e) => setModel(e.target.value)} />
      </label>
      <label className="field" htmlFor={`${id}-name`}>
        <span>Name</span>
        <input id={`${id}-name`} value={name} placeholder={model.trim() || 'defaults to the model name'} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field" htmlFor={`${id}-context`}>
        <span>Context window</span>
        <input id={`${id}-context`} type="number" min={1} value={contextLimit} placeholder="OpenCode's default" onChange={(e) => setContextLimit(e.target.value)} />
      </label>
      <label className="field" htmlFor={`${id}-output`}>
        <span>Max output tokens</span>
        <input id={`${id}-output`} type="number" min={1} value={outputLimit} placeholder="OpenCode's default" onChange={(e) => setOutputLimit(e.target.value)} />
      </label>
      {error && (
        <p className="term-error small" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <button type="button" className="btn btn-small" disabled={!canCheck || checking} onClick={() => void check()}>
          {checking ? 'Checking…' : '🔎 Check connection'}
        </button>
        <button type="submit" className="btn btn-small btn-good" disabled={!canSave || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {checkResult && <CheckResult result={checkResult} />}
    </form>
  );
}

function BuiltInRow({ p }: { p: BuiltInProvider }) {
  return (
    <div className="row wrap provider-row provider-row-builtin">
      <span className="grow">
        <b>{p.label}</b> <span className="muted small">{p.command}</span>
      </span>
      <span className="muted small">{p.installed ? p.version ?? 'installed' : 'not installed'}</span>
    </div>
  );
}

function CustomProviderRow({ p, onEdit }: { p: CustomProviderView; onEdit: () => void }) {
  const agents = useStore((s) => s.agents);
  const defaultCli = useStore((s) => s.settings.defaultCli);
  const [deleteError, setDeleteError] = useState('');
  const [busy, setBusy] = useState(false);
  const count = Object.values(agents).filter((a) => a.cli === p.id).length + (defaultCli === p.id ? 1 : 0);
  const del = async () => {
    const ok = await confirmDialog({ tone: 'danger', title: `Delete ${p.name}?`, body: 'Agents on it must move to another coding agent first.', confirm: 'Delete' });
    if (!ok) return;
    setBusy(true);
    setDeleteError('');
    try {
      await api.deleteProvider(p.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="provider-row">
      <div className="row wrap">
        <span className="grow">
          <b>{p.name}</b>{' '}
          <span className="muted small">
            {p.baseURL} · {p.model} · 🔑 key set · {count ? `used by ${count}` : 'unused'}
          </span>
        </span>
        <button className="btn btn-small" onClick={onEdit}>
          Edit
        </button>
        <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => void del()}>
          Delete
        </button>
      </div>
      {deleteError && (
        <p className="term-error small" role="alert">
          {deleteError}
        </p>
      )}
    </div>
  );
}

/** Settings → Providers: which custom provider (if any) the look tool (#123) asks. */
function LookProviderPicker({ custom }: { custom: CustomProviderView[] }) {
  const lookProvider = useStore((s) => s.settings.lookProvider);
  const [error, setError] = useState('');
  const save = (id: string) => void api.updateSettings({ lookProvider: id || null }).then(() => setError(''), (err) => setError(err instanceof Error ? err.message : String(err)));
  return (
    <div className="row wrap">
      <label className="field">
        <span>👁 The look tool uses:</span>
        <select value={lookProvider ?? ''} onChange={(e) => save(e.target.value)}>
          <option value="">None (off everywhere)</option>
          {custom.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="term-error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ProvidersTab() {
  const [list, setList] = useState<{ builtIn: BuiltInProvider[]; custom: CustomProviderView[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<'add' | CustomProviderView | null>(null);
  // The clis event (server/swarm.ts's emitProviders) fires on every provider change: refetch the fuller list then.
  const clisVersion = useStore((s) => s.clis.length + s.clis.map((c) => c.id).join(','));

  const load = () =>
    api.providers().then(
      (l) => {
        setList(l);
        setFailed(false);
      },
      () => setFailed(true),
    );
  useEffect(() => void load(), [clisVersion]);

  const onDone = () => {
    setOpen(null);
    void load();
  };

  return (
    <div>
      <div className="card">
        <div className="row wrap">
          <h3 className="grow">🔌 Providers</h3>
          <button className="btn btn-small btn-good" disabled={open === 'add'} onClick={() => setOpen('add')}>
            ➕ Add provider
          </button>
        </div>
        <p className="muted small">Built-in coding agents can't be edited or deleted here. A custom provider runs OpenCode against your own OpenAI-compatible endpoint.</p>
        {failed && !list && <p className="muted small">Couldn't load the providers.</p>}
        {!list && !failed && <p className="muted small">Loading…</p>}
        {list && (
          <>
            {list.builtIn.map((p) => (
              <BuiltInRow key={p.id} p={p} />
            ))}
            {list.custom.map((p) => (open !== 'add' && open?.id === p.id ? null : <CustomProviderRow key={p.id} p={p} onEdit={() => setOpen(p)} />))}
            {list.custom.length === 0 && <p className="muted small">No custom providers yet.</p>}
            {list.custom.length > 0 && <LookProviderPicker custom={list.custom} />}
          </>
        )}
      </div>
      {/* Keyed on what's being edited, so switching the target (Edit A then Edit B) remounts with fresh state
          instead of keeping the previous form's typed values. */}
      {open && <ProviderForm key={open === 'add' ? 'add' : open.id} editing={open === 'add' ? null : open} onDone={onDone} onCancel={() => setOpen(null)} />}
    </div>
  );
}
