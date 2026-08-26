export class InvalidSpotRequestError extends Error {
  readonly code = "invalid_spot_request";

  constructor() {
    super("The Spot request is invalid");
    this.name = "InvalidSpotRequestError";
  }
}

export class SpotUnavailableError extends Error {
  readonly code = "spot_unavailable";

  constructor() {
    super("Spot is unavailable");
    this.name = "SpotUnavailableError";
  }
}

export class SpotWalletBindingRequiredError extends Error {
  readonly code = "spot_wallet_binding_required";

  constructor() {
    super("A verified wallet binding is required");
    this.name = "SpotWalletBindingRequiredError";
  }
}

export class SpotVersionConflictError extends Error {
  readonly code = "spot_version_conflict";

  constructor() {
    super("The Spot resource version conflicts");
    this.name = "SpotVersionConflictError";
  }
}
