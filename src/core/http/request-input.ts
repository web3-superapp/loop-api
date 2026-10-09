import type { FastifyRequest } from "fastify";

import { ApiError } from "./api-error.js";

export function assertNoBody(request: FastifyRequest): Promise<void> {
  if (request.body !== undefined) {
    throw ApiError.invalidRequest();
  }

  return Promise.resolve();
}

export function assertNoBodyOrQuery(request: FastifyRequest): Promise<void> {
  const query = request.query as Record<string, unknown>;

  if (request.body !== undefined || Object.keys(query).length > 0) {
    throw ApiError.invalidRequest();
  }

  return Promise.resolve();
}
