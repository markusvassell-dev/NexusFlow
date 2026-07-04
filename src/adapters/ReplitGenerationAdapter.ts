import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { ContentGenerationProvider, GenerationRequest, GenerationResult } from './types';

// ReplitGenerationAdapter (CLAUDE.md rule 6).
// The BullMQ generation worker calls the external Replit app over authenticated
// HTTP instead of OpenAI directly. Errors are caught and re-thrown as clean
// Error instances so BullMQ's retry policy (3×, exponential 2s→4s→8s) runs
// before the saga's terminal-failure path posts to the Karbon timeline.

export class GenerationError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

interface ReplitResponse {
  blogTitle?: string;
  metaDescription?: string;
  blogMarkdown?: string;
  blogText?: string; // older generator builds use this key
  leadMagnetUrl?: string;
  leadMagnetName?: string;
}

export class ReplitGenerationAdapter implements ContentGenerationProvider {
  readonly name = 'replit-generator';

  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const started = Date.now();
    let data: ReplitResponse;

    try {
      const res = await axios.post<ReplitResponse>(
        env.replit.url,
        {
          topic: req.topic,
          keywords: req.keywords,
          tone: req.tone,
          brandVoice: req.brandVoice,
          revisionNote: req.revisionNote ?? null
        },
        {
          headers: {
            Authorization: `Bearer ${env.replit.serviceSecret}`,
            'Content-Type': 'application/json'
          },
          // Generous timeout: Replit deployments cold-start; 60–90s is normal
          // for the first request after idle. Do NOT lower this below 60s.
          timeout: env.replit.timeoutMs
        }
      );
      data = res.data;
    } catch (err) {
      throw this.classify(err);
    }

    const markdown = data.blogMarkdown ?? data.blogText ?? '';
    const wordCount = markdown.split(/\s+/).filter(Boolean).length;

    if (!markdown || !data.leadMagnetUrl) {
      // Malformed 200 — treat as retryable (generator may be mid-deploy).
      throw new GenerationError(
        'Replit generator returned 200 but the payload is missing blogMarkdown/leadMagnetUrl',
        200,
        JSON.stringify(data).slice(0, 800)
      );
    }
    if (wordCount < 1000) {
      throw new GenerationError(
        `Generated post is ${wordCount} words — contract requires 1000+`,
        200
      );
    }

    return {
      blogTitle: data.blogTitle ?? req.topic,
      metaDescription: data.metaDescription ?? '',
      blogMarkdown: markdown,
      leadMagnetUrl: data.leadMagnetUrl,
      leadMagnetName: data.leadMagnetName ?? 'Lead magnet PDF',
      wordCount,
      generatorLatencyMs: Date.now() - started
    };
  }

  private classify(err: unknown): GenerationError {
    const e = err as AxiosError;
    if (e.code === 'ECONNABORTED') {
      return new GenerationError(
        `Replit generator timed out after ${env.replit.timeoutMs}ms (cold start or overload) — will retry`
      );
    }
    if (e.response) {
      const body = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
      if (e.response.status === 401 || e.response.status === 403) {
        return new GenerationError(
          'Replit generator rejected REPLIT_SERVICE_SECRET (auth failure)',
          e.response.status,
          body.slice(0, 800)
        );
      }
      return new GenerationError(
        `Replit generator responded ${e.response.status}`,
        e.response.status,
        body.slice(0, 800)
      );
    }
    return new GenerationError(`Network error reaching Replit generator: ${e.message ?? String(err)}`);
  }
}
