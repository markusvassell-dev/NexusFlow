import axios from 'axios';
import { env } from '../config/env';
import { appendUtm } from '../utils/utm';
import { AdPlatform, AdCreateResult } from './types';

// Meta Marketing API adapter (AdPlatform). Scopes required at app review:
// ads_management, pages_read_engagement, instagram_basic.
// Runs in SANDBOX MODE (META_SANDBOX_MODE=true) until Meta app review clears:
// sandbox logs the exact structural payloads and returns synthetic IDs, so the
// saga, dashboards and audit trail behave identically to production.

const GRAPH = 'https://graph.facebook.com/v19.0';

export class MetaAdsAdapter implements AdPlatform {
  readonly name = 'meta-ads';

  async createLeadGenCampaign(input: {
    headline: string;
    primaryText: string;
    destinationUrl: string;
    campaignSlug: string;
  }): Promise<AdCreateResult> {
    // UTM enforcement happens HERE, at publish time (rule 8) — after any manual
    // payload overrides, so edits can never strip tracking.
    const link = appendUtm(input.destinationUrl, 'meta_ads', input.campaignSlug);

    const campaignPayload = {
      name: `nexusflow-${input.campaignSlug}`,
      objective: 'OUTCOME_LEADS',
      status: 'PAUSED', // launched paused; a human flips it live in Ads Manager
      special_ad_categories: []
    };
    const adSetPayload = {
      name: `${input.campaignSlug}-adset`,
      optimization_goal: 'LEAD_GENERATION',
      billing_event: 'IMPRESSIONS',
      daily_budget: 2000, // minor units — £20.00/day starting point
      targeting: { geo_locations: { countries: ['GB'] } },
      status: 'PAUSED'
    };
    const creativePayload = {
      name: `${input.campaignSlug}-creative`,
      object_story_spec: {
        page_id: env.meta.pageId,
        link_data: {
          message: input.primaryText, // ≤125 chars, enforced upstream
          name: input.headline,       // ≤40 chars, enforced upstream
          link,
          call_to_action: { type: 'DOWNLOAD', value: { link } }
        }
      }
    };

    if (env.meta.sandbox || !env.meta.accessToken) {
      console.info('[meta:sandbox] campaign', JSON.stringify(campaignPayload));
      console.info('[meta:sandbox] adset', JSON.stringify(adSetPayload));
      console.info('[meta:sandbox] creative', JSON.stringify(creativePayload));
      const stamp = Date.now().toString().slice(-6);
      return {
        campaignId: `camp_sbx_${stamp}`,
        adSetId: `adset_sbx_${stamp}`,
        adId: `ad_sbx_${stamp}`,
        sandbox: true
      };
    }

    const auth = { access_token: env.meta.accessToken };
    const act = `${GRAPH}/${env.meta.adAccountId}`;

    const campaign = await axios.post(`${act}/campaigns`, { ...campaignPayload, ...auth }, { timeout: 20_000 });
    const adset = await axios.post(
      `${act}/adsets`,
      { ...adSetPayload, campaign_id: campaign.data.id, ...auth },
      { timeout: 20_000 }
    );
    const creative = await axios.post(`${act}/adcreatives`, { ...creativePayload, ...auth }, { timeout: 20_000 });
    const ad = await axios.post(
      `${act}/ads`,
      {
        name: `${input.campaignSlug}-ad`,
        adset_id: adset.data.id,
        creative: { creative_id: creative.data.id },
        status: 'PAUSED',
        ...auth
      },
      { timeout: 20_000 }
    );

    return { campaignId: campaign.data.id, adSetId: adset.data.id, adId: ad.data.id, sandbox: false };
  }
}
