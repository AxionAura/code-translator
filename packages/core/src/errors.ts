// Base class for every engine error (AGENTS.md §7): machine-readable `code`, human
// message, optional `cause`. Subclasses never use bare `throw new Error`.
export class CTransError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}
