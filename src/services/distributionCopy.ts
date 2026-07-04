import axios from 'axios';
import { env } from '../config/env';

// Distribution copy generation (CLAUDE.md rules 5 + 7).
// This is the ONLY direct OpenAI call in the system — blog + lead magnet
// generation is offloaded to the Replit app (ReplitGenerationAdapter).
// The global brand voice is prepended to the system prompt (rule 7).

export interface MetaAdsPayload {
  headline: string;    // ≤ 40 chars
  primaryText: string; // ≤ 125 chars
  link: string;        // ActiveCampaign sign-up form URL (UTM appended at publish)
}
export interface AcEmailPayload {
  subject: string;
  body: string; // plain text; {{ first_name }} merge tag allowed
}
export interface SocialPayload {
  linkedin: string;
  facebook: string;
  instagram: string; // no links — "link in bio"
}
export interface DistributionPayloads {
  metaAds: MetaAdsPayload;
  acEmail: AcEmailPayload;
  social: SocialPayload;
}

export async function generateDistributionPayloads(input: {
  topic: string;
  blogTitle: string;
  metaDescription: string;
  liveUrl: string;
  leadMagnetUrl: string;
  leadMagnetName: string;
  keywords: string[];
  brandVoice: string;
}): Promise<DistributionPayloads> {
  if (!env.openaiApiKey) return deterministicFallback(input);

  const system = [
    'You write distribution copy for a financial advisory firm.',
    `BRAND VOICE (must be followed exactly): ${input.brandVoice}`,
    'Return STRICT JSON with keys: metaAds {headline, primaryText, link}, acEmail {subject, body}, social {linkedin, facebook, instagram}.',
    'Constraints: headline ≤ 40 chars; primaryText ≤ 125 chars; email body is plain text, greets with {{ first_name }}, includes the lead magnet link then the blog link; linkedin/facebook captions include the blog URL; instagram caption has NO links and ends with "link in bio" plus 2–3 niche hashtags.',
    'Business-focused, zero fluff. Never use exclamation marks.'
  ].join('\n');

  const user = JSON.stringify({
    topic: input.topic,
    blogTitle: input.blogTitle,
    teaser: input.metaDescription,
    blogUrl: input.liveUrl,
    leadMagnet: { name: input.leadMagnetName, url: input.leadMagnetUrl },
    keywords: input.keywords
  });

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      temperature: 0.4,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    {
      headers: { Authorization: `Bearer ${env.openaiApiKey}` },
      timeout: 45_000
    }
  );

  const parsed = JSON.parse(res.data.choices[0].message.content) as DistributionPayloads;
  // Hard-enforce Meta limits even if the model drifts.
  parsed.metaAds.headline = parsed.metaAds.headline.slice(0, 40);
  parsed.metaAds.primaryText = parsed.metaAds.primaryText.slice(0, 125);
  parsed.metaAds.link ||= env.activeCampaign.signupFormUrl;
  return parsed;
}

/** Keeps the pipeline runnable in dev/CI without an OpenAI key. */
function deterministicFallback(input: {
  topic: string;
  blogTitle: string;
  metaDescription: string;
  liveUrl: string;
  leadMagnetUrl: string;
  leadMagnetName: string;
}): DistributionPayloads {
  const t = input.blogTitle || input.topic;
  return {
    metaAds: {
      headline: `Free: ${input.leadMagnetName}`.slice(0, 40),
      primaryText:
        `Get the checklist our advisory team uses to stabilise cash flow — free download.`.slice(0, 125),
      link: env.activeCampaign.signupFormUrl
    },
    acEmail: {
      subject: `Your ${input.leadMagnetName} (download inside)`,
      body: [
        'Hi {{ first_name }},',
        '',
        `New on the blog: ${t}.`,
        '',
        input.metaDescription,
        '',
        `Download the ${input.leadMagnetName}:`,
        input.leadMagnetUrl,
        '',
        'Read the full post:',
        input.liveUrl,
        '',
        '— The Aegis Advisory team'
      ].join('\n')
    },
    social: {
      linkedin: `New guide: ${t}.\n\n${input.metaDescription}\n\nFull breakdown + the free checklist: ${input.liveUrl}`,
      facebook: `${t} — new on the blog, plus a free checklist. Read it: ${input.liveUrl}`,
      instagram: `New on the blog: ${t}. The full guide + free checklist — link in bio.\n\n#AdvisoryFirm #HealthAndSafety`
    }
  };
}
