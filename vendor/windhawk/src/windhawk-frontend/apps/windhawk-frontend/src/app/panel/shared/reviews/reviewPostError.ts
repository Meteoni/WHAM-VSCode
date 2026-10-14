/**
 * A post the server answered with a refusal it explained: a `400` for a rule
 * the client did not catch, a `429` past the per-IP rate limit. `message` is
 * the server's own text, which the form draws as it is. Any other failure - a
 * network error, a refused preflight, a body that is not `{ error }` - is not
 * one of these, and the form says only that the post did not go.
 */
export class ReviewPostError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ReviewPostError';
    this.status = status;
  }
}
