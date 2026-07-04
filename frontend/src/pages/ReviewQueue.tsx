import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Multi-channel review queue — both human gates in one page.
//   Gate 1 (status seo_review):  Blog Post tab active; approve / edit / request revision.
//   Gate 2 (status dist_review): Meta Ads / Email / Social tabs editable;
//     PATCH overrides freeze the payloads server-side BEFORE "Approve & Publish All"
//     fires the publishing workers. 409 responses render a conflict notice —
//     another reviewer got there first; nothing is overwritten.

type Tab = 'blog' | 'meta_ads' | 'ac_email' | 'social';

interface SeoReport {
  total: number;
  breakdown: { keywordDensity: number; readability: number; headingStructure: number; metaTags: number };
  suggestions: string[];
}

interface QueueItem {
  id: string;
  topic: string;
  client_name: string;
  status: 'seo_review' | 'dist_review';
  seo_score: number;
  seo_report: SeoReport;
  blog_title: string;
  blog_meta_description: string;
  blog_text: string;
  lead_magnet_url: string | null;
  live_url: string | null;
  meta_ads_payload: { headline: string; primaryText: string; link: string } | null;
  ac_email_payload: { subject: string; body: string } | null;
  social_payload: { linkedin: string; facebook: string; instagram: string } | null;
}

export default function ReviewQueue() {
  const { canApprove } = useAuth();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('blog');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'conflict' | 'error'; text: string } | null>(null);
  const [revisionNote, setRevisionNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Local editable copies of the distribution payloads (dirty until PATCHed).
  const [ads, setAds] = useState({ headline: '', primaryText: '', link: '' });
  const [email, setEmail] = useState({ subject: '', body: '' });
  const [social, setSocial] = useState({ linkedin: '', facebook: '', instagram: '' });

  const selected = useMemo(() => items.find((i) => i.id === selectedId) ?? items[0] ?? null, [items, selectedId]);

  const load = useCallback(async () => {
    const r = await api.get<{ items: QueueItem[] }>('/api/review-queue');
    setItems(r.items);
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 10_000); // poll — teammates' actions surface within 10s
    return () => clearInterval(iv);
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    setAds(selected.meta_ads_payload ?? { headline: '', primaryText: '', link: '' });
    setEmail(selected.ac_email_payload ?? { subject: '', body: '' });
    setSocial(selected.social_payload ?? { linkedin: '', facebook: '', instagram: '' });
    setTab(selected.status === 'dist_review' ? 'meta_ads' : 'blog');
  }, [selected?.id, selected?.status]);

  const run = async (fn: () => Promise<void>, okText: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice({ kind: 'ok', text: okText });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setNotice({ kind: 'conflict', text: err.message }); // e.g. approved by another user
        await load();
      } else if (err instanceof ApiError && err.status === 403) {
        setNotice({ kind: 'error', text: err.message });
      } else {
        setNotice({ kind: 'error', text: 'Something went wrong — retry.' });
      }
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    run(async () => void (await api.post(`/api/runs/${selected!.id}/approve`)), 'Approved — deploy queued.');

  const requestRevision = () =>
    run(async () => {
      await api.post(`/api/runs/${selected!.id}/request-revision`, { note: revisionNote });
      setRevisionNote('');
    }, 'Sent back to generation with your note.');

  // Freeze all edited payloads server-side, THEN enqueue publishing.
  const publishAll = () =>
    run(async () => {
      await api.patch(`/api/runs/${selected!.id}/distribution/meta_ads`, ads);
      await api.patch(`/api/runs/${selected!.id}/distribution/ac_email`, email);
      await api.patch(`/api/runs/${selected!.id}/distribution/social`, social);
      await api.post(`/api/runs/${selected!.id}/publish-all`);
    }, 'Overrides frozen — publish jobs enqueued (UTM enforced per channel).');

  if (!selected) {
    return <div className="p-10 text-sm text-stone-500">Queue clear — nothing awaiting review.</div>;
  }

  const isDist = selected.status === 'dist_review';
  const seo = selected.seo_report;
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'blog', label: 'Blog Post' },
    { key: 'meta_ads', label: 'Meta Ads' },
    { key: 'ac_email', label: 'Email' },
    { key: 'social', label: 'Social' }
  ];

  return (
    <div className="grid grid-cols-[16rem_1fr_19rem] gap-4 p-6">
      {/* ---- queue list ---- */}
      <aside className="space-y-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-stone-500">Awaiting review · {items.length}</p>
        {items.map((i) => (
          <button
            key={i.id}
            onClick={() => setSelectedId(i.id)}
            className={`w-full rounded-lg border bg-white p-3 text-left hover:border-emerald-700 ${
              i.id === selected.id ? 'border-emerald-700 shadow-sm' : 'border-stone-200'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`font-mono text-[9px] uppercase px-1.5 py-0.5 rounded-full ${i.status === 'dist_review' ? 'bg-cyan-50 text-cyan-700' : 'bg-violet-50 text-violet-700'}`}>
                {i.status === 'dist_review' ? 'distribution' : 'content'}
              </span>
              <span className="font-mono text-xs font-semibold text-emerald-800">{i.seo_score}/100</span>
            </div>
            <p className="mt-1.5 text-xs font-medium leading-snug">{i.blog_title || i.topic}</p>
            <p className="mt-1 text-[10px] text-stone-500">{i.client_name}</p>
          </button>
        ))}
      </aside>

      {/* ---- editor ---- */}
      <main className="rounded-lg border border-stone-200 bg-white p-6">
        {notice && (
          <div
            className={`mb-4 rounded-md border px-3 py-2 text-xs ${
              notice.kind === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : notice.kind === 'conflict'
                ? 'border-amber-300 bg-amber-50 text-amber-800'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {notice.text}
          </div>
        )}

        <nav className="flex gap-1 border-b border-stone-100 mb-5">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 pb-2.5 text-sm ${tab === t.key ? 'font-semibold border-b-2 border-emerald-700 -mb-px' : 'text-stone-500 hover:text-stone-900'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'blog' && (
          <article>
            <h1 className="text-xl font-semibold leading-snug">{selected.blog_title}</h1>
            <p className="mt-2 border-l-2 border-stone-200 pl-3 text-sm text-stone-600">{selected.blog_meta_description}</p>
            <div className="prose prose-sm mt-4 max-w-none whitespace-pre-wrap text-sm leading-relaxed text-stone-700">
              {selected.blog_text}
            </div>
            {selected.lead_magnet_url && (
              <a
                href={selected.lead_magnet_url}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-2 rounded-md border border-stone-300 px-3 py-2 text-xs font-medium hover:bg-stone-50"
              >
                <span className="rounded border border-stone-400 px-1 font-mono text-[9px]">PDF</span>
                Preview lead magnet before approval
              </a>
            )}
          </article>
        )}

        {tab === 'meta_ads' && (
          <div className="space-y-4">
            {!isDist && <p className="text-xs text-stone-500">Payloads generate after content approval + deploy, then pause here.</p>}
            <Field label={`Ad headline (${ads.headline.length}/40)`}>
              <input value={ads.headline} onChange={(e) => setAds({ ...ads, headline: e.target.value })} disabled={!isDist} className="input" maxLength={60} />
            </Field>
            <Field label={`Primary text (${ads.primaryText.length}/125)`}>
              <textarea value={ads.primaryText} onChange={(e) => setAds({ ...ads, primaryText: e.target.value })} disabled={!isDist} rows={3} className="input" />
            </Field>
            <Field label="Destination link (ActiveCampaign sign-up form)">
              <input value={ads.link} onChange={(e) => setAds({ ...ads, link: e.target.value })} disabled={!isDist} className="input font-mono text-xs" />
            </Field>
            <p className="font-mono text-[10px] text-stone-500">utm enforced at publish: ?utm_source=meta_ads&utm_medium=paid_social&utm_campaign=&#123;slug&#125;</p>
          </div>
        )}

        {tab === 'ac_email' && (
          <div className="space-y-4">
            <Field label="Subject line">
              <input value={email.subject} onChange={(e) => setEmail({ ...email, subject: e.target.value })} disabled={!isDist} className="input" />
            </Field>
            <Field label="Body ({{ first_name }} resolves per contact)">
              <textarea value={email.body} onChange={(e) => setEmail({ ...email, body: e.target.value })} disabled={!isDist} rows={12} className="input" />
            </Field>
            <p className="font-mono text-[10px] text-stone-500">utm enforced at publish: ?utm_source=activecampaign&utm_medium=email</p>
          </div>
        )}

        {tab === 'social' && (
          <div className="space-y-4">
            <Field label="LinkedIn (company page · w_organization_social)">
              <textarea value={social.linkedin} onChange={(e) => setSocial({ ...social, linkedin: e.target.value })} disabled={!isDist} rows={4} className="input" />
            </Field>
            <Field label="Facebook (page token · pages_manage_posts)">
              <textarea value={social.facebook} onChange={(e) => setSocial({ ...social, facebook: e.target.value })} disabled={!isDist} rows={3} className="input" />
            </Field>
            <Field label="Instagram (no links — 'link in bio' · instagram_content_publish)">
              <textarea value={social.instagram} onChange={(e) => setSocial({ ...social, instagram: e.target.value })} disabled={!isDist} rows={4} className="input" />
            </Field>
          </div>
        )}
      </main>

      {/* ---- SEO + gate actions ---- */}
      <aside className="space-y-4">
        <section className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-stone-500">SEO score</p>
          <p className="mt-1 text-4xl font-bold text-emerald-800">{seo?.total ?? '—'}</p>
          {seo &&
            Object.entries(seo.breakdown).map(([k, v]) => (
              <div key={k} className="mt-2">
                <div className="flex justify-between text-[11px] text-stone-600">
                  <span>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                  <span className="font-mono">{v}</span>
                </div>
                <div className="mt-1 h-1.5 rounded bg-stone-100">
                  <div className="h-1.5 rounded bg-emerald-700" style={{ width: `${v}%` }} />
                </div>
              </div>
            ))}
          {seo?.suggestions.map((s, i) => (
            <p key={i} className="mt-2 border-t border-dashed border-stone-100 pt-2 text-[11px] text-stone-600">→ {s}</p>
          ))}
        </section>

        <section className="rounded-lg border border-stone-200 bg-white p-4 space-y-2">
          {!isDist ? (
            <>
              <button onClick={approve} disabled={!canApprove || busy} className="btn-primary">Approve → deploy</button>
              <textarea
                value={revisionNote}
                onChange={(e) => setRevisionNote(e.target.value)}
                rows={2}
                placeholder="What should the generator change?"
                className="input text-xs"
              />
              <button onClick={requestRevision} disabled={!canApprove || busy} className="btn-danger">Request revision</button>
            </>
          ) : (
            <button onClick={publishAll} disabled={!canApprove || busy} className="btn-primary">Approve &amp; Publish All</button>
          )}
          <p className="text-[10px] leading-relaxed text-stone-500">
            {canApprove
              ? 'Nothing publishes without this sign-off. Edits are frozen as manual overrides and logged to the audit trail.'
              : 'Editor role: you can edit payloads, but approval needs an admin or reviewer.'}
          </p>
        </section>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-widest text-stone-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// Tailwind component classes (add to index.css):
// .input       → w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm outline-none focus:border-emerald-700 disabled:opacity-60
// .btn-primary → w-full rounded-lg bg-emerald-800 py-2.5 text-sm font-semibold text-white hover:bg-emerald-900 disabled:opacity-40 disabled:cursor-not-allowed
// .btn-danger  → w-full rounded-lg border border-red-200 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-40
