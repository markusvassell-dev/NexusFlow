import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { appendUtm } from '../utils/utm';
import { SocialPublisher, SocialPostResult } from './types';

// Organic social adapters. Each platform is an independent SocialPublisher —
// one platform's failure must never block the others (original spec). The
// social worker calls all three and aggregates results; failures are recorded
// with the VERBATIM HTTP error body for the dashboard's audit modal.

const GRAPH = 'https://graph.facebook.com/v19.0';

function errBody(e: unknown): string {
  const ax = e as AxiosError;
  if (ax.response) {
    const body = typeof ax.response.data === 'string' ? ax.response.data : JSON.stringify(ax.response.data);
    return `HTTP ${ax.response.status} ${body.slice(0, 600)}`;
  }
  return (ax.message ?? String(e)).slice(0, 300);
}

// ---------- LinkedIn (company page, scope: w_organization_social) ----------
export class LinkedInPublisher implements SocialPublisher {
  readonly platform = 'linkedin' as const;

  async publish(input: { caption: string; linkUrl: string | null; campaignSlug: string }): Promise<SocialPostResult> {
    const link = input.linkUrl ? appendUtm(input.linkUrl, 'linkedin', input.campaignSlug) : null;
    try {
      if (!env.social.linkedinToken) {
        console.info('[linkedin:stub] would post', { org: env.social.linkedinOrgUrn, link });
        return { platform: this.platform, ok: true, postId: `li_stub_${Date.now()}` };
      }
      const res = await axios.post(
        'https://api.linkedin.com/v2/ugcPosts',
        {
          author: env.social.linkedinOrgUrn,
          lifecycleState: 'PUBLISHED',
          specificContent: {
            'com.linkedin.ugc.ShareContent': {
              shareCommentary: { text: input.caption },
              shareMediaCategory: link ? 'ARTICLE' : 'NONE',
              media: link ? [{ status: 'READY', originalUrl: link }] : []
            }
          },
          visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
        },
        {
          headers: {
            Authorization: `Bearer ${env.social.linkedinToken}`,
            'X-Restli-Protocol-Version': '2.0.0'
          },
          timeout: 15_000
        }
      );
      return { platform: this.platform, ok: true, postId: res.headers['x-restli-id'] ?? res.data.id };
    } catch (e) {
      return { platform: this.platform, ok: false, error: errBody(e) };
    }
  }
}

// ---------- Facebook Page (page access token, scope: pages_manage_posts) ----------
export class FacebookPublisher implements SocialPublisher {
  readonly platform = 'facebook' as const;

  async publish(input: { caption: string; linkUrl: string | null; campaignSlug: string }): Promise<SocialPostResult> {
    const link = input.linkUrl ? appendUtm(input.linkUrl, 'facebook', input.campaignSlug) : null;
    try {
      if (!env.social.fbPageToken) {
        console.info('[facebook:stub] would post', { page: env.social.fbPageId, link });
        return { platform: this.platform, ok: true, postId: `fb_stub_${Date.now()}` };
      }
      const res = await axios.post(
        `${GRAPH}/${env.social.fbPageId}/feed`,
        { message: input.caption, link: link ?? undefined, access_token: env.social.fbPageToken },
        { timeout: 15_000 }
      );
      return { platform: this.platform, ok: true, postId: res.data.id };
    } catch (e) {
      return { platform: this.platform, ok: false, error: errBody(e) };
    }
  }
}

// ---------- Instagram (business account, scope: instagram_content_publish) ----------
// Captions carry NO links (platform rule) — the CTA is "link in bio".
// Publishing is two-step: create a media container, then publish it.
export class InstagramPublisher implements SocialPublisher {
  readonly platform = 'instagram' as const;

  async publish(input: { caption: string; linkUrl: string | null; campaignSlug: string }): Promise<SocialPostResult> {
    try {
      if (!env.social.igToken) {
        console.info('[instagram:stub] would post', { user: env.social.igUserId });
        return { platform: this.platform, ok: true, postId: `ig_stub_${Date.now()}` };
      }
      // Image post: reuse the OG image WordPress generates for the article.
      // (IG requires media; text-only posts are not supported.)
      const imageUrl = input.linkUrl ? `${input.linkUrl.replace(/\/$/, '')}/og-image.jpg` : undefined;
      const container = await axios.post(
        `${GRAPH}/${env.social.igUserId}/media`,
        { caption: input.caption, image_url: imageUrl, access_token: env.social.igToken },
        { timeout: 20_000 }
      );
      const publish = await axios.post(
        `${GRAPH}/${env.social.igUserId}/media_publish`,
        { creation_id: container.data.id, access_token: env.social.igToken },
        { timeout: 20_000 }
      );
      return { platform: this.platform, ok: true, postId: publish.data.id };
    } catch (e) {
      // e.g. OAuthException code 190 (expired token) — surfaced verbatim in the
      // dashboard; non-blocking for the rest of the workflow.
      return { platform: this.platform, ok: false, error: errBody(e) };
    }
  }
}
