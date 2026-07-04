import axios from 'axios';
import { env } from '../config/env';
import { appendUtmToAllLinks } from '../utils/utm';
import { EmailProvider, EmailSendResult } from './types';

// ActiveCampaign adapter (EmailProvider). v3 API, api-token header.
// The worker queue that drives this adapter is rate-limited to 5 req/s
// (CLAUDE.md rule 3) — configured on the BullMQ Worker, not here.

export class ActiveCampaignAdapter implements EmailProvider {
  readonly name = 'activecampaign';

  async createAndSendCampaign(input: {
    subject: string;
    body: string;
    campaignSlug: string;
  }): Promise<EmailSendResult> {
    // UTM enforcement at publish time (rule 8): rewrite every link in the body.
    const bodyWithUtm = appendUtmToAllLinks(input.body, 'activecampaign', input.campaignSlug);
    const html = bodyWithUtm
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
      .join('\n')
      // AC uses %FIRSTNAME% personalisation tags.
      .replace(/\{\{\s*first_name\s*\}\}/g, '%FIRSTNAME%');

    if (!env.activeCampaign.apiKey) {
      console.info('[activecampaign:stub] would send', {
        subject: input.subject,
        listId: env.activeCampaign.listId,
        htmlBytes: html.length
      });
      return { campaignId: `cmp_stub_${Date.now().toString().slice(-6)}`, recipientCount: 0 };
    }

    const api = axios.create({
      baseURL: env.activeCampaign.apiUrl,
      headers: { 'Api-Token': env.activeCampaign.apiKey, 'Content-Type': 'application/json' },
      timeout: 20_000
    });

    // 1) Create the message (email content).
    const message = await api.post('/api/3/messages', {
      message: {
        fromemail: 'team@aegisadvisory.co.uk',
        fromname: 'Aegis Advisory',
        subject: input.subject,
        html
      }
    });

    // 2) Create + send the campaign to the subscriber list (new ad leads flow
    //    into the same list via the sign-up form automation).
    const campaign = await api.post('/api/3/campaigns', {
      campaign: {
        type: 'single',
        name: `nexusflow-${input.campaignSlug}`,
        status: 1, // 1 = scheduled/sending now
        public: 0,
        sdate: new Date().toISOString(),
        p: { [env.activeCampaign.listId]: env.activeCampaign.listId },
        m: { [message.data.message.id]: 100 }
      }
    });

    return {
      campaignId: String(campaign.data.campaign?.id ?? campaign.data.id),
      recipientCount: parseInt(campaign.data.campaign?.send_amt ?? '0', 10)
    };
  }
}
