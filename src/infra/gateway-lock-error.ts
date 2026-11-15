export class GatewayLockError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
    public readonly databasePath?: string,
  ) {
    super(message);
    this.name = "GatewayLockError";
  }
}
