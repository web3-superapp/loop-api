import { randomUUID } from "node:crypto";

import type {
  Launch2CampaignAction,
  Launch2CampaignRecord,
  Launch2CampaignRepository,
} from "../../src/features/launch2/launch2-campaigns.js";

/**
 * Decision 0140: in-memory `Launch2CampaignRepository`. `listPublic`
 * deliberately returns every row unfiltered, so route tests exercise the
 * service's own selection (the SQL filter is covered by the integration
 * suite).
 */

export interface FakeCampaignAudit {
  readonly action: string;
  readonly targetId: string;
  readonly actor: string;
  readonly actorAccountId: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

export interface InMemoryLaunch2CampaignRepository extends Launch2CampaignRepository {
  readonly rows: Launch2CampaignRecord[];
  readonly audits: FakeCampaignAudit[];
  readonly covers: Map<
    string,
    { readonly mediaId: string; readonly requestSha256: string }
  >;
  seed(record: Partial<Launch2CampaignRecord>): Launch2CampaignRecord;
  failing: boolean;
}

export function createInMemoryLaunch2CampaignRepository(): InMemoryLaunch2CampaignRepository {
  const rows: Launch2CampaignRecord[] = [];
  const audits: FakeCampaignAudit[] = [];
  const covers = new Map<
    string,
    { readonly mediaId: string; readonly requestSha256: string }
  >();
  const createKeys = new Map<
    string,
    { readonly campaignId: string; readonly requestSha256: string }
  >();
  const auditRefs = new Map<
    string,
    { auditId: string; seq: number; at: string }
  >();
  const fail = (): Promise<never> =>
    Promise.reject(new Error("fake repository down"));

  const pushAudit = (
    action: Launch2CampaignAction | "create",
    record: Launch2CampaignRecord,
    actor: { actor: string; actorAccountId: string | null },
    before: unknown,
    at: Date,
  ) => {
    audits.push({
      action: `launch2.campaign.${action}`,
      targetId: record.campaignId,
      actor: actor.actor,
      actorAccountId: actor.actorAccountId,
      before,
      after: { ...record },
    });
    const ref = {
      auditId: randomUUID(),
      seq: audits.length,
      at: at.toISOString(),
    };
    if (action === "create") auditRefs.set(record.campaignId, ref);
    return ref;
  };

  const repository: InMemoryLaunch2CampaignRepository = {
    rows,
    audits,
    covers,
    failing: false,
    seed(record) {
      const full: Launch2CampaignRecord = {
        campaignId: randomUUID(),
        title: "Airdrop week",
        subtitle: null,
        coverMediaId: null,
        startsAt: "2026-10-01T00:00:00.000Z",
        endsAt: "2026-12-01T00:00:00.000Z",
        ctaLabel: "查看",
        link: { kind: "route", value: "/launch2" },
        pinned: false,
        sortOrder: 0,
        status: "published",
        createdBy: null,
        createdByActor: "operator",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        ...record,
      };
      rows.push(full);
      return full;
    },
    listPublic() {
      if (repository.failing) return fail();
      return Promise.resolve([...rows]);
    },
    listAll(input) {
      if (repository.failing) return fail();
      return Promise.resolve(
        rows
          .filter((row) => input.status === null || row.status === input.status)
          .slice(0, input.limit),
      );
    },
    get(campaignId) {
      if (repository.failing) return fail();
      return Promise.resolve(
        rows.find((row) => row.campaignId === campaignId) ?? null,
      );
    },
    create(input) {
      if (repository.failing) return fail();
      if (input.idempotency !== null) {
        const earlier = createKeys.get(input.idempotency.key);
        if (earlier !== undefined) {
          if (earlier.requestSha256 !== input.idempotency.requestSha256) {
            return Promise.resolve({ status: "conflict" as const });
          }
          const campaign = rows.find(
            (row) => row.campaignId === earlier.campaignId,
          ) as Launch2CampaignRecord;
          return Promise.resolve({
            status: "replayed" as const,
            campaign,
            audit: auditRefs.get(campaign.campaignId) as {
              auditId: string;
              seq: number;
              at: string;
            },
          });
        }
      }
      const at = input.now.toISOString();
      const campaign: Launch2CampaignRecord = {
        campaignId: input.campaignId,
        ...input.fields,
        status: "draft",
        createdBy: input.audit.actorAccountId,
        createdByActor: input.audit.actor,
        createdAt: at,
        updatedAt: at,
      };
      rows.push(campaign);
      if (input.idempotency !== null) {
        createKeys.set(input.idempotency.key, {
          campaignId: campaign.campaignId,
          requestSha256: input.idempotency.requestSha256,
        });
      }
      const audit = pushAudit("create", campaign, input.audit, null, input.now);
      return Promise.resolve({ status: "created" as const, campaign, audit });
    },
    transition(input) {
      if (repository.failing) return fail();
      const index = rows.findIndex(
        (row) => row.campaignId === input.campaignId,
      );
      const current = rows[index];
      if (current === undefined) {
        return Promise.resolve({ status: "not_found" as const });
      }
      const decision = input.decide(current);
      if (decision.kind === "refuse") {
        return Promise.resolve({
          status: "refused" as const,
          reasonCode: decision.reasonCode,
          campaign: current,
        });
      }
      const campaign: Launch2CampaignRecord = {
        ...current,
        ...decision.fields,
        status: decision.status,
        updatedAt: input.now.toISOString(),
      };
      rows[index] = campaign;
      const audit = pushAudit(
        input.action,
        campaign,
        input.audit,
        { ...current },
        input.now,
      );
      return Promise.resolve({ status: "written" as const, campaign, audit });
    },
    coverExists(mediaId) {
      if (repository.failing) return fail();
      return Promise.resolve(
        [...covers.values()].some((cover) => cover.mediaId === mediaId),
      );
    },
    insertCover(input) {
      if (repository.failing) return fail();
      const earlier = covers.get(input.idempotencyKey);
      if (earlier !== undefined) {
        return Promise.resolve(
          earlier.requestSha256 === input.requestSha256
            ? { status: "replayed" as const, mediaId: earlier.mediaId }
            : { status: "conflict" as const },
        );
      }
      covers.set(input.idempotencyKey, {
        mediaId: input.mediaId,
        requestSha256: input.requestSha256,
      });
      return Promise.resolve({
        status: "stored" as const,
        mediaId: input.mediaId,
      });
    },
  };
  return repository;
}
