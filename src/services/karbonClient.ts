import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';

// Karbon callback client (CLAUDE.md rule 2).
// ALL completion/failure notifications go through the Karbon TIMELINE API as
// notes on the work item. Never write work-item custom fields — those are
// restricted to the contact level and the write will 403/422.

export interface WorkflowLinks {
  liveUrl?: string | null;
  leadMagnetUrl?: string | null;
  adCampaignId?: string | null;
  emailCampaignId?: string | null;
  social?: { linkedin?: string; facebook?: string; instagram?: string };
}

function client(): AxiosInstance {
  return axios.create({
    baseURL: env.karbon.apiBase,
    timeout: 15_000,
    headers: {
      Authorization: `Bearer ${env.karbon.bearerToken}`,
      AccessKey: env.karbon.accessKey,
      'Content-Type': 'application/json'
    }
  });
}

/** Low-level: post one timeline note against a work item. */
export async function postTimelineNote(
  workItemId: string,
  subject: string,
  htmlBody: string
): Promise<void> {
  // Karbon Notes API — notes attached to a work item surface on its timeline.
  await client().post('/Notes', {
    Subject: subject,
    Body: htmlBody,
    TimelineItems: [{ EntityType: 'WorkItem', EntityKey: workItemId }]
  });
}

/** Success path: final links + completion summary. */
export async function postCompletionNote(
  workItemId: string,
  topic: string,
  links: WorkflowLinks,
  partialNotes: string[] = []
): Promise<void> {
  const lines: string[] = [
    `<p><strong>NexusFlow — workflow complete</strong></p>`,
    `<p>Topic: ${escapeHtml(topic)}</p>`,
    '<ul>'
  ];
  if (links.liveUrl) lines.push(`<li>Blog post: <a href="${links.liveUrl}">${links.liveUrl}</a></li>`);
  if (links.leadMagnetUrl)
    lines.push(`<li>Lead magnet: <a href="${links.leadMagnetUrl}">${links.leadMagnetUrl}</a></li>`);
  if (links.adCampaignId) lines.push(`<li>Meta campaign: ${escapeHtml(links.adCampaignId)}</li>`);
  if (links.emailCampaignId)
    lines.push(`<li>ActiveCampaign: ${escapeHtml(links.emailCampaignId)}</li>`);
  if (links.social) {
    const s = links.social;
    lines.push(
      `<li>Social: LinkedIn ${s.linkedin ? '✓' : '—'} · Facebook ${s.facebook ? '✓' : '—'} · Instagram ${s.instagram ? '✓' : '—'}</li>`
    );
  }
  lines.push('</ul>');
  for (const note of partialNotes) lines.push(`<p>⚠ ${escapeHtml(note)}</p>`);

  await postTimelineNote(workItemId, 'Marketing workflow complete', lines.join('\n'));
}

/** Terminal failure path (rule 2): retries exhausted → notify the team on the timeline. */
export async function postFailureNote(
  workItemId: string,
  topic: string,
  failure: { step: string; message: string; httpStatus?: number; responseBody?: string; attempts: number }
): Promise<void> {
  const body = [
    `<p><strong>⚠ NexusFlow — Workflow Failed</strong></p>`,
    `<p>Topic: ${escapeHtml(topic)}</p>`,
    `<p>Failed step: <strong>${escapeHtml(failure.step)}</strong> after ${failure.attempts} attempts (exponential backoff exhausted).</p>`,
    `<p>Error: ${escapeHtml(failure.message)}${failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ''}</p>`,
    failure.responseBody
      ? `<pre>${escapeHtml(failure.responseBody.slice(0, 1500))}</pre>`
      : '',
    `<p>The run is parked in the dashboard — retry manually from the run detail view.</p>`
  ].join('\n');

  await postTimelineNote(workItemId, 'Marketing workflow FAILED', body);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
