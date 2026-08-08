export class SatomiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SatomiError";
  }
}

export class ValidationError extends SatomiError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class AmbiguousPublishError extends SatomiError {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousPublishError";
  }
}
