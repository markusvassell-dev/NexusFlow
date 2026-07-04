import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Settings & Active Adapters — workflow gates, global brand voice (injected
// into every generation request), UTM reference and per-adapter toggles the
// saga reads at fan-out time. Admin-only writes; responsive two-column → one.

interface Settings {
  seo_auto_approve_threshold: number;
  auto_approve_enabled: boolean;
  adapters_enabled: { ads: boolean; email: boolean; social: boolean };
  brand_voice: string;
}

const ADAPTERS: Array<{ key: keyof Settings['adapters_enabled']; name: string; desc: string; phase: string }> = [
  { key: 'ads', name: 'Meta Ads', desc: 'Lead-gen campaign per post · sandbox until app review · limiter 10 req/10s', phase: 'Phase 3' },
  { key: 'email', name: 'ActiveCampaign email', desc: 'Campaign to subscribers + ad leads · limiter 5 req/s', phase: 'Phase 2' },
  { key: 'social', name: 'Organic social', desc: 'LinkedIn · Facebook · Instagram — independent, non-blocking', phase: 'Phase 2' }
];

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [s, setS] = useState<Settings | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    api.get<{ settings: Settings }>('/api/settings').then((r) => setS(r.settings));
  }, []);

  const save = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));
    await api.put(`/api/settings/${key}`, { value });
    setSavedAt(Date.now());
  };

  if (!s) return <div className="p-10 text-sm text-stone-500">Loading settings…</div>;

  return (
    <div className="grid max-w-4xl grid-cols-1 gap-4 p-6 md:grid-cols-2">
      {/* ---- Workflow gates ---- */}
      <section className="rounded-lg border border-stone-200 bg-white p-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-stone-500">Workflow gates</p>

        <div className="mt-4 flex items-baseline justify-between">
          <span className="text-sm font-medium">SEO auto-approve threshold</span>
          <span className="text-2xl font-semibold text-emerald-800">{s.seo_auto_approve_threshold}</span>
        </div>
        <input
          type="range"
          min={50}
          max={100}
          value={s.seo_auto_approve_threshold}
          disabled={!isAdmin}
          onChange={(e) => save('seo_auto_approve_threshold', Number(e.target.value))}
          className="mt-2 w-full accent-emerald-700"
        />

        <div className="mt-4 flex items-center justify-between border-t border-stone-100 pt-4">
          <div>
            <p className="text-sm font-medium">Auto-approve above threshold</p>
            <p className="mt-0.5 text-[11px] text-stone-500">
              Gate 1 only — the distribution gate always requires a human.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={s.auto_approve_enabled}
            disabled={!isAdmin}
            onClick={() => save('auto_approve_enabled', !s.auto_approve_enabled)}
            className={`h-6 w-10 rounded-full transition ${s.auto_approve_enabled ? 'bg-emerald-700' : 'bg-stone-300'}`}
          >
            <span className={`block h-4 w-4 rounded-full bg-white shadow transition ${s.auto_approve_enabled ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>

        <div className="mt-4 border-t border-stone-100 pt-4">
          <p className="text-sm font-medium">Retry policy</p>
          <p className="mt-1 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[11px] text-stone-600">
            3 attempts · exponential 2s → 4s → 8s · terminal failure posts “Workflow Failed” to Karbon timeline
          </p>
        </div>
      </section>

      {/* ---- Brand voice + UTM ---- */}
      <section className="rounded-lg border border-stone-200 bg-white p-5">
        <p className="font-mono text-[10px] uppercase tracking-widest text-stone-500">Global brand voice</p>
        <p className="mt-1 text-[11px] text-stone-500">
          Sent as <code>brandVoice</code> in every Replit generation payload and prepended to the GPT-4o system prompt for distribution copy.
        </p>
        <textarea
          value={s.brand_voice}
          rows={6}
          disabled={!isAdmin}
          onChange={(e) => setS({ ...s, brand_voice: e.target.value })}
          onBlur={(e) => save('brand_voice', e.target.value)}
          className="mt-2 w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-xs leading-relaxed outline-none focus:border-emerald-700 disabled:opacity-60"
        />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-stone-400">
          <span>{s.brand_voice.length} chars</span>
          {Date.now() - savedAt < 3000 && <span className="text-emerald-700">saved ✓ · applies to next run</span>}
        </div>

        <div className="mt-4 border-t border-stone-100 pt-4">
          <p className="text-sm font-medium">UTM enforcement</p>
          <p className="mt-1 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-stone-600">
            meta_ads · paid_social<br />activecampaign · email<br />linkedin | facebook · organic_social<br />utm_campaign = run slug — all channels
          </p>
        </div>
      </section>

      {/* ---- Active adapters ---- */}
      <section className="rounded-lg border border-stone-200 bg-white p-5 md:col-span-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-stone-500">Active adapters</p>
        {ADAPTERS.map((a) => (
          <div key={a.key} className="mt-3 flex items-center gap-4 border-t border-stone-100 pt-3 first:mt-2">
            <div className="flex-1">
              <p className="text-sm font-medium">
                {a.name} <span className="ml-1 rounded-full bg-violet-50 px-1.5 py-0.5 font-mono text-[9px] uppercase text-violet-700">{a.phase}</span>
              </p>
              <p className="mt-0.5 text-[11px] text-stone-500">{a.desc}</p>
            </div>
            <span className={`font-mono text-[10px] ${s.adapters_enabled[a.key] ? 'text-emerald-700' : 'text-stone-400'}`}>
              {s.adapters_enabled[a.key] ? 'active' : 'skipped'}
            </span>
            <button
              role="switch"
              aria-checked={s.adapters_enabled[a.key]}
              disabled={!isAdmin}
              onClick={() => save('adapters_enabled', { ...s.adapters_enabled, [a.key]: !s.adapters_enabled[a.key] })}
              className={`h-6 w-10 rounded-full transition ${s.adapters_enabled[a.key] ? 'bg-emerald-700' : 'bg-stone-300'}`}
            >
              <span className={`block h-4 w-4 rounded-full bg-white shadow transition ${s.adapters_enabled[a.key] ? 'translate-x-5' : 'translate-x-1'}`} />
            </button>
          </div>
        ))}
        <p className="mt-3 text-[11px] text-stone-500">
          Disabled adapters are skipped by the saga at publish fan-out — downstream stages still run.
        </p>
      </section>
    </div>
  );
}
