export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

export const nonRetryableJobError = (message: string) => new NonRetryableJobError(message);

