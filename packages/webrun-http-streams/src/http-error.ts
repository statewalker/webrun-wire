export interface HttpErrorOptions {
  status?: number;
  statusText?: string;
  message?: string;
  [key: string]: unknown;
}

export class HttpError extends Error {
  status?: number;
  statusText?: string;

  constructor(options: HttpErrorOptions = {}) {
    super(options.message ?? options.statusText ?? "HTTP Error");
    this.status = options.status;
    this.statusText = options.statusText;
  }

  getResponseOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...this.toJson(), ...options };
  }

  toJson(): { status?: number; statusText?: string; message: string } {
    return {
      status: this.status,
      statusText: this.statusText,
      message: this.message,
    };
  }

  static fromError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new HttpError({ status: 500, statusText: "Bad Request", message });
  }

  static errorResourceNotFound(options: HttpErrorOptions = {}): HttpError {
    return new HttpError({
      status: 404,
      statusText: "Error 404: Resource not found",
      ...options,
    });
  }

  static errorForbidden(options: HttpErrorOptions = {}): HttpError {
    return new HttpError({
      status: 403,
      statusText: "Error 403: Forbidden",
      ...options,
    });
  }

  static errorResourceGone(options: HttpErrorOptions = {}): HttpError {
    return new HttpError({
      status: 410,
      statusText: "Error 410: Resource Gone",
      ...options,
    });
  }

  static errorInternalError(options: HttpErrorOptions = {}): HttpError {
    return new HttpError({
      ...options,
      status: 500,
      statusText: "Error 500: Internal error",
    });
  }
}
