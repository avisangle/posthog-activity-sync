export class TwentyRateLimitError extends Error {
  constructor(message = 'Twenty rate limit reached', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TwentyRateLimitError';
  }
}

// twenty-client-sdk 2.54.3 drops the HTTP status: a non-2xx throws Error(`${statusText}: ${body}`),
// and NestJS's throttler body is `ThrottlerException: Too Many Requests`. Correct here if live differs.
export const isTwentyRateLimit = (error: unknown): boolean =>
  error instanceof Error && /too many requests/i.test(error.message);

// Runs one Twenty call, rethrowing a throttled response as TwentyRateLimitError.
export const withRateLimit = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    if (isTwentyRateLimit(error)) {
      throw new TwentyRateLimitError((error as Error).message, { cause: error });
    }
    throw error;
  }
};
