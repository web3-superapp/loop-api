export interface InternalUser {
  readonly id: string;
}

export interface InternalUserRepository {
  findByPrivyUserId(privyUserId: string): Promise<InternalUser | null>;
  getOrCreateByPrivyUserId(privyUserId: string): Promise<InternalUser>;
}
