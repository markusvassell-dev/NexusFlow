import axios from 'axios';
import { env } from '../config/env';
import { CmsPublisher, CmsPublishResult } from './types';

// WordPress adapter (default CmsPublisher). Uses the REST API with an
// Application Password (Users → Profile → Application Passwords).
// Retries/backoff are BullMQ's job — this adapter throws clean errors.

export class WordPressAdapter implements CmsPublisher {
  readonly name = 'wordpress';

  private authHeader(): string {
    const token = Buffer.from(`${env.wordpress.username}:${env.wordpress.appPassword}`).toString('base64');
    return `Basic ${token}`;
  }

  async publishPost(input: {
    title: string;
    markdown: string;
    metaDescription: string;
    leadMagnetUrl: string;
    existingPostId?: string;
  }): Promise<CmsPublishResult> {
    if (!env.wordpress.baseUrl) {
      // Structural stub for local dev: log the exact payload we would send.
      console.info('[wordpress:stub] would publish', {
        title: input.title,
        excerpt: input.metaDescription,
        contentBytes: input.markdown.length
      });
      return {
        liveUrl: `https://blog.example.co.uk/${slugify(input.title)}`,
        cmsPostId: `stub_${Date.now()}`,
        leadMagnetUrl: input.leadMagnetUrl
      };
    }

    const html = markdownToHtml(input.markdown);
    // CTA block linking the lead magnet is appended to the post body itself.
    const content =
      html +
      `\n<hr />\n<p><strong>Free download:</strong> <a href="${input.leadMagnetUrl}">Get the checklist (PDF)</a></p>`;

    const base = `${env.wordpress.baseUrl}/wp-json/wp/v2/posts`;
    const url = input.existingPostId ? `${base}/${input.existingPostId}` : base;

    const res = await axios.post(
      url,
      {
        title: input.title,
        content,
        excerpt: input.metaDescription,
        status: 'publish'
      },
      {
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
        timeout: 20_000,
        // Surface non-2xx as throws with the verbatim body (shown in the
        // dashboard audit modal, e.g. "502 Bad Gateway").
        validateStatus: (s) => s >= 200 && s < 300
      }
    );

    return {
      liveUrl: res.data.link,
      cmsPostId: String(res.data.id),
      // The magnet stays on the generator's public URL; sideload into WP Media
      // here instead if you need same-origin hosting.
      leadMagnetUrl: input.leadMagnetUrl
    };
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/).slice(0, 6).join('-');
}

/** Minimal markdown → HTML (headings, bold, links, paragraphs). Swap for `marked` if richer output is needed. */
function markdownToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .split(/\n{2,}/)
    .map((block) => (block.startsWith('<h') ? block : `<p>${block.replace(/\n/g, '<br />')}</p>`))
    .join('\n');
}
