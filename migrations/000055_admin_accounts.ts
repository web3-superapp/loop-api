import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0109: operator console role separation (S128).
 *
 * - `admin_accounts`: individual console accounts with one immutable role
 *   (`platform_admin`, `reviewer`, `testnet_acceptor`, `auditor`). Reviewer
 *   and testnet acceptor accounts are bound to one LOOP user
 *   (`operator_user_id`), whose `ops_operators` / `ops_grants` rows (000052)
 *   are derived from the role. The `ADMIN_USERNAME` bootstrap administrator
 *   stays in the environment and is never stored here. Accounts are never
 *   deleted; `disabled_at` is terminal. `credentials_version` increments
 *   on every password change; a session cookie carries the version it was
 *   issued under, so a reset or change ends every older session.
 * - `admin_account_commands`: `Idempotency-Key` records of the account
 *   writes (create / disable / reset-password), bound to the actor and a
 *   keyed request fingerprint. Append-only.
 * - `admin_audit_log.actor_account_id`: the stable account ID beside the
 *   display username (null for the bootstrap administrator and anonymous
 *   rows). No foreign key (the audit log is never truncated).
 * - `ops_audit`: a third actor shape, `admin_account` / `admin_console`, for
 *   operator grants provisioned or revoked by a platform administrator
 *   through the console (before/after grant state, like the deployment CLI).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.admin_accounts (
      id uuid primary key,
      username text not null,
      password_hash text not null,
      role text not null,
      operator_user_id uuid references public.loop_users(id) on delete restrict,
      password_must_change boolean not null default true,
      credentials_version integer not null default 1,
      credentials_changed_at timestamptz not null default clock_timestamp(),
      created_at timestamptz not null default clock_timestamp(),
      created_by text not null,
      disabled_at timestamptz,
      disabled_by text,
      constraint admin_accounts_username_check
        check (username ~ '^[A-Za-z0-9._@-]{1,64}$'),
      constraint admin_accounts_password_hash_check
        check (password_hash ~ '^\\$argon2id\\$v=19\\$m=[0-9]{1,8},t=[0-9]{1,3},p=[0-9]{1,3}\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$'),
      constraint admin_accounts_credentials_version_check
        check (credentials_version >= 1),
      constraint admin_accounts_role_check
        check (role in ('platform_admin', 'reviewer', 'testnet_acceptor', 'auditor')),
      constraint admin_accounts_operator_binding_check
        check (
          (role in ('reviewer', 'testnet_acceptor')) = (operator_user_id is not null)
        ),
      constraint admin_accounts_created_by_check
        check (created_by ~ '^[A-Za-z0-9._@-]{1,64}$'),
      constraint admin_accounts_disabled_check
        check ((disabled_at is null) = (disabled_by is null)
          and (disabled_by is null or disabled_by ~ '^[A-Za-z0-9._@-]{1,64}$')),
      constraint admin_accounts_timestamp_check
        check (credentials_changed_at >= created_at
          and (disabled_at is null or disabled_at >= created_at))
    );

    create unique index admin_accounts_username_key
      on public.admin_accounts (lower(username));
    -- One active console account per LOOP user: a person cannot hold the
    -- reviewer and the testnet acceptor role at the same time.
    create unique index admin_accounts_active_operator_key
      on public.admin_accounts (operator_user_id)
      where operator_user_id is not null and disabled_at is null;
    create index admin_accounts_created_idx
      on public.admin_accounts (created_at desc, id desc);

    create function public.admin_accounts_guard()
      returns trigger
      language plpgsql
    as $$
    begin
      if TG_OP = 'DELETE' then
        raise exception 'admin_accounts rows are never deleted';
      end if;
      if NEW.id is distinct from OLD.id
        or NEW.username is distinct from OLD.username
        or NEW.role is distinct from OLD.role
        or NEW.operator_user_id is distinct from OLD.operator_user_id
        or NEW.created_at is distinct from OLD.created_at
        or NEW.created_by is distinct from OLD.created_by then
        raise exception 'admin_accounts identity columns are immutable';
      end if;
      if OLD.disabled_at is not null then
        raise exception 'a disabled admin account is terminal';
      end if;
      return NEW;
    end
    $$;
    create trigger admin_accounts_guard
      before update or delete on public.admin_accounts
      for each row execute function public.admin_accounts_guard();

    comment on table public.admin_accounts is
      'Decision 0109: individual operator console accounts with one immutable role. The ADMIN_USERNAME bootstrap administrator is not stored here.';

    create table public.admin_account_commands (
      idempotency_key uuid primary key,
      actor text not null,
      actor_account_id uuid references public.admin_accounts(id) on delete restrict,
      action text not null,
      target_account_id uuid not null references public.admin_accounts(id) on delete restrict,
      request_fingerprint text not null,
      created_at timestamptz not null default clock_timestamp(),
      constraint admin_account_commands_actor_check
        check (actor ~ '^[A-Za-z0-9._@-]{1,64}$'),
      constraint admin_account_commands_action_check
        check (action in ('account.create', 'account.disable', 'account.reset_password')),
      constraint admin_account_commands_fingerprint_check
        check (request_fingerprint ~ '^[a-f0-9]{64}$')
    );

    create function public.admin_account_commands_append_only()
      returns trigger
      language plpgsql
    as $$
    begin
      raise exception 'admin_account_commands is append-only';
    end
    $$;
    create trigger admin_account_commands_no_update_delete
      before update or delete on public.admin_account_commands
      for each row execute function public.admin_account_commands_append_only();

    -- No foreign key: admin_audit_log is never truncated (Decision 0102),
    -- and a key would drag it into every TRUNCATE ... CASCADE of
    -- loop_users -> admin_accounts. Accounts are never deleted, so the ID
    -- always resolves.
    alter table public.admin_audit_log
      add column actor_account_id uuid;

    alter table public.ops_audit
      add column admin_actor text,
      add column admin_account_id uuid references public.admin_accounts(id) on delete restrict;
    alter table public.ops_audit drop constraint ops_audit_actor_shape;
    alter table public.ops_audit drop constraint ops_audit_change_shape;
    alter table public.ops_audit add constraint ops_audit_actor_shape check (
      (actor_kind = 'user' and source = 'ops_api' and actor_id is not null
        and action <> 'operator.bootstrap'
        and admin_actor is null and admin_account_id is null)
      or (actor_kind = 'deployment_admin' and source = 'deployment_cli'
        and actor_id is null and action = 'operator.bootstrap'
        and admin_actor is null and admin_account_id is null
        and target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
      or (actor_kind = 'admin_account' and source = 'admin_console'
        and actor_id is null
        and admin_actor ~ '^[A-Za-z0-9._@-]{1,64}$'
        and action in ('operator.provision', 'operator.revoke')
        and target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
    );
    alter table public.ops_audit add constraint ops_audit_change_shape check (
      (before_state is null and after_state is null)
      or (source in ('deployment_cli', 'admin_console')
        and before_state is not null and after_state is not null
        and jsonb_typeof(before_state) = 'object' and jsonb_typeof(after_state) = 'object'
        and before_state ?& array['enabled','grants'] and after_state ?& array['enabled','grants']
        and before_state - 'enabled' - 'grants' = '{}'::jsonb
        and after_state - 'enabled' - 'grants' = '{}'::jsonb
        and jsonb_typeof(before_state->'enabled') in ('boolean','null')
        and jsonb_typeof(after_state->'enabled') in ('boolean','null')
        and jsonb_typeof(before_state->'grants') = 'array'
        and jsonb_typeof(after_state->'grants') = 'array')
    );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (select 1 from public.admin_accounts)
        or exists (select 1 from public.ops_audit where source = 'admin_console')
      then
        raise exception 'admin account facts exist; refusing to roll back 000055'
          using errcode = '55000';
      end if;
    end;
    $guard$;
    alter table public.ops_audit drop constraint ops_audit_actor_shape;
    alter table public.ops_audit drop constraint ops_audit_change_shape;
    alter table public.ops_audit drop column admin_account_id;
    alter table public.ops_audit drop column admin_actor;
    alter table public.ops_audit add constraint ops_audit_actor_shape check (
      (actor_kind = 'user' and source = 'ops_api' and actor_id is not null
        and action <> 'operator.bootstrap')
      or (actor_kind = 'deployment_admin' and source = 'deployment_cli'
        and actor_id is null and action = 'operator.bootstrap'
        and target ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
    );
    alter table public.ops_audit add constraint ops_audit_change_shape check (
      (before_state is null and after_state is null)
      or (source = 'deployment_cli' and before_state is not null and after_state is not null
        and jsonb_typeof(before_state) = 'object' and jsonb_typeof(after_state) = 'object'
        and before_state ?& array['enabled','grants'] and after_state ?& array['enabled','grants']
        and before_state - 'enabled' - 'grants' = '{}'::jsonb
        and after_state - 'enabled' - 'grants' = '{}'::jsonb
        and jsonb_typeof(before_state->'enabled') in ('boolean','null')
        and jsonb_typeof(after_state->'enabled') in ('boolean','null')
        and jsonb_typeof(before_state->'grants') = 'array'
        and jsonb_typeof(after_state->'grants') = 'array')
    );
    alter table public.admin_audit_log drop column actor_account_id;
    drop trigger admin_account_commands_no_update_delete on public.admin_account_commands;
    drop function public.admin_account_commands_append_only();
    drop table public.admin_account_commands;
    drop trigger admin_accounts_guard on public.admin_accounts;
    drop function public.admin_accounts_guard();
    drop table public.admin_accounts;
  `);
}
