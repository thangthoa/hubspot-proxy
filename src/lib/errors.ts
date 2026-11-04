/** An error that is safe to return to the partner as-is. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A non-2xx answer (or no answer) from HubSpot. Never returned to partners directly. */
export class HubSpotError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HubSpot responded with status ${status}`);
    this.name = 'HubSpotError';
  }
}

/**
 * Translates a HubSpot failure into a partner-facing error.
 * HubSpot auth failures become 502: they mean our token is wrong, not the partner's.
 */
export function fromHubSpotError(err: HubSpotError): ApiError {
  switch (err.status) {
    case 400:
      return new ApiError(400, 'INVALID_REQUEST', hubSpotMessage(err.body) ?? 'The CRM rejected the request.');
    case 404:
      return new ApiError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');
    case 409:
      return new ApiError(409, 'CONTACT_ALREADY_EXISTS', 'A contact with this email already exists.');
    case 429:
      return new ApiError(429, 'RATE_LIMITED', 'Too many requests. Retry later.');
    default:
      return new ApiError(502, 'UPSTREAM_ERROR', 'The CRM is unavailable. Retry later.');
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hubSpotMessage(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
    return body.message.slice(0, 500);
  }
  return undefined;
}
