// UTM enforcement (CLAUDE.md rule 8): adapters append channel parameters to every
// outbound link AT PUBLISH TIME, after manual payload edits — so overrides in the
// distribution review UI can never strip tracking.

export type UtmChannel =
  | 'meta_ads'
  | 'activecampaign'
  | 'linkedin'
  | 'facebook'
  | 'instagram';

const CHANNEL_PARAMS: Record<UtmChannel, { source: string; medium: string }> = {
  meta_ads:       { source: 'meta_ads',       medium: 'paid_social' },
  activecampaign: { source: 'activecampaign', medium: 'email' },
  linkedin:       { source: 'linkedin',       medium: 'organic_social' },
  facebook:       { source: 'facebook',       medium: 'organic_social' },
  instagram:      { source: 'instagram',      medium: 'organic_social' }
};

/** Slug used as utm_campaign on every channel for a run. */
export function campaignSlug(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-');
}

/** Appends (and overwrites) utm_* params on a URL. Non-URLs are returned untouched. */
export function appendUtm(rawUrl: string, channel: UtmChannel, campaign: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch {
    return rawUrl;
  }
  const p = CHANNEL_PARAMS[channel];
  url.searchParams.set('utm_source', p.source);
  url.searchParams.set('utm_medium', p.medium);
  url.searchParams.set('utm_campaign', campaign);
  return url.toString();
}

/** Rewrites every http(s) URL found in a block of text (email bodies, captions). */
export function appendUtmToAllLinks(text: string, channel: UtmChannel, campaign: string): string {
  return text.replace(/https?:\/\/[^\s)"'<>]+/g, (m) => appendUtm(m, channel, campaign));
}
