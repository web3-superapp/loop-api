export interface InternalUser {
  readonly id: string;
}

export interface InternalUserRepository {
  getOrCreateByPrivyUserId(privyUserId: string): Promise<InternalUser>;
}
