import {
  notificationInboxContextRoutes,
  notificationInboxEventCategory,
} from "../alerts/notification-contract.js";
import type { RecordNotificationInput } from "../../database/notification-repository.js";
import { launchReviewReasonText } from "../launch/launch-contract.js";
import { formatBeijingMinute } from "./notification-inbox-contract.js";

/**
 * Decision 0178 (S291): the project owner's launch review / deployment
 * progress notifications. Four events, all to the account that owns the
 * launch project (`launch_projects.owner_user_id`, the account that
 * submitted it and signed the deployment task), all under the
 * `launch.round` preference category, all hidden until
 * `LAUNCH_REVIEW_INBOX_EMIT` is on.
 *
 * | event                    | written by                                   | entityRef                    | contextRoute            |
 * | ------------------------ | -------------------------------------------- | ---------------------------- | ----------------------- |
 * | `launch.review_approved` | config approval (API, review transaction)    | `launchProject:<projectId>`  | `launch2-project-sign`  |
 * | `launch.review_rejected` | material / config rejection (API, same tx)   | `launchProject:<projectId>`  | `launch2-projects-mine` |
 * | `launch.activated`       | notification_inbox lane, once per instance   | `launch2Instance:<id>`       | `launch2-instance`      |
 * | `launch.deploy_failed`   | executor final failure (worker, same tx)     | `launchProject:<projectId>`  | `launch2-projects-mine` |
 *
 * The payload carries `taskId` = the launch project ID (the row of 我的项目
 * and the `id` of the sign page), `projectId` (same value), and — once a
 * deployment task exists — `jobId`.
 */

export const launchReviewInboxSources = Object.freeze({
  review: "launch_review",
  executor: "hooks_launch_executor",
  launch2: "launch2_indexer",
} as const);

/** Instances registered more than this before the lane sees them get no row. */
export const launchActivationFreshnessSeconds = 24 * 60 * 60;
export const launchActivationBatch = 20;

/** Bounded like every payload value (512 code points). */
function bounded(value: string): string {
  const points = Array.from(value);
  return points.length <= 512 ? value : points.slice(0, 512).join("");
}

function projectRef(projectId: string): string {
  return `launchProject:${projectId}`;
}

function symbolField(symbol: string | null): { readonly symbol?: string } {
  return symbol === null || symbol === "" ? {} : { symbol };
}

export function launchReviewApprovedNotification(input: {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly symbol: string | null;
  readonly configVersion: number;
  readonly approvedAt: string;
}): RecordNotificationInput {
  const eventType = "launch.review_approved" as const;
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: notificationInboxEventCategory[eventType],
    eventType,
    entityRef: projectRef(input.projectId),
    contextRoute: notificationInboxContextRoutes[eventType],
    contextParams: Object.freeze({ projectId: input.projectId }),
    payload: Object.freeze({
      event: eventType,
      title: bounded(`${input.projectName} 审核已通过`),
      body: "请完成签名，发射才会部署",
      projectName: bounded(input.projectName),
      ...symbolField(input.symbol),
      taskId: input.projectId,
      projectId: input.projectId,
      configVersion: String(input.configVersion),
    }),
    // A config version is approved at most once.
    dedupeKey: `launch.review_approved:${input.projectId}:v${String(input.configVersion)}`,
    source: launchReviewInboxSources.review,
    observedAt: input.approvedAt,
  });
}

/** The applicant-facing reason: the reviewer's note, else the code's text. */
export function launchRejectionReasonText(
  reasonCode: string,
  note: string | null,
): string {
  const trimmed = note?.trim() ?? "";
  if (trimmed !== "") return trimmed;
  return launchReviewReasonText("rejected", reasonCode) ?? "审核未通过";
}

export function launchReviewRejectedNotification(input: {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly symbol: string | null;
  /**
   * What was rejected: the catalog material (one rejection row, keyed by
   * its ID) or one config version.
   */
  readonly decision:
    | { readonly kind: "material"; readonly rejectionId: string }
    | { readonly kind: "config"; readonly configVersion: number };
  readonly reasonCode: string;
  readonly note: string | null;
  readonly rejectedAt: string;
}): RecordNotificationInput {
  const eventType = "launch.review_rejected" as const;
  const reasonText = bounded(
    launchRejectionReasonText(input.reasonCode, input.note),
  );
  const decisionKey =
    input.decision.kind === "material"
      ? `material:${input.decision.rejectionId}`
      : `config:v${String(input.decision.configVersion)}`;
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: notificationInboxEventCategory[eventType],
    eventType,
    entityRef: projectRef(input.projectId),
    contextRoute: notificationInboxContextRoutes[eventType],
    contextParams: Object.freeze({ projectId: input.projectId }),
    payload: Object.freeze({
      event: eventType,
      title: bounded(`${input.projectName} 审核未通过`),
      body: reasonText,
      projectName: bounded(input.projectName),
      ...symbolField(input.symbol),
      taskId: input.projectId,
      projectId: input.projectId,
      reasonCode: input.reasonCode,
      reasonText,
      ...(input.decision.kind === "config"
        ? { configVersion: String(input.decision.configVersion) }
        : {}),
    }),
    dedupeKey: `launch.review_rejected:${input.projectId}:${decisionKey}`,
    source: launchReviewInboxSources.review,
    observedAt: input.rejectedAt,
  });
}

export function launchActivatedNotification(input: {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly instanceId: string;
  readonly projectName: string;
  readonly symbol: string | null;
  readonly saleStartAt: string;
  readonly activatedAt: string;
  /** When the row is written; decides 「… 开售」 or 「已开售」. */
  readonly now: Date;
}): RecordNotificationInput {
  const eventType = "launch.activated" as const;
  const saleStarted = Date.parse(input.saleStartAt) <= input.now.getTime();
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: notificationInboxEventCategory[eventType],
    eventType,
    entityRef: `launch2Instance:${input.instanceId}`,
    contextRoute: notificationInboxContextRoutes[eventType],
    contextParams: Object.freeze({ instanceId: input.instanceId }),
    payload: Object.freeze({
      event: eventType,
      title: bounded(`${input.projectName} 已上链`),
      body: saleStarted
        ? "已开售"
        : `${formatBeijingMinute(input.saleStartAt)}（北京时间）开售`,
      projectName: bounded(input.projectName),
      ...symbolField(input.symbol),
      taskId: input.projectId,
      projectId: input.projectId,
      jobId: input.jobId,
      instanceId: input.instanceId,
      saleStartAt: input.saleStartAt,
    }),
    dedupeKey: `launch.activated:${input.instanceId}`,
    source: launchReviewInboxSources.launch2,
    observedAt: input.activatedAt,
  });
}

/** Decision 0112 executor failure codes → one short sentence for the owner. */
const deployFailureTexts: Readonly<Record<string, string>> = Object.freeze({
  HOOKS_CONFIG_SUPERSEDED: "发射配置已更新，本次签名作废，请重新签名",
  HOOKS_CONFIG_NOT_APPROVED: "发射配置未通过审核，未部署",
  HOOKS_AUTHORIZATION_INVALID: "签名无效，请重新签名",
  HOOKS_SIGNATURE_EXPIRED: "签名已过期，请重新签名",
  HOOKS_OWNER_NONCE_CONSUMED: "签名已失效，请重新签名",
  HOOKS_LAUNCH_ALREADY_DEPLOYED: "该配置版本已部署过",
  HOOKS_ACTIVATION_WINDOW_CLOSED: "距开售时间太近，无法激活",
  HOOKS_DEPLOY_SIMULATION_REVERTED: "部署预检未通过",
  HOOKS_LAUNCH_NAME_INVALID: "项目名称不符合链上要求",
  HOOKS_LAUNCH_TICKER_INVALID: "代币符号不符合链上要求",
  HOOKS_DEPLOY_GAS_ABOVE_CAP: "部署所需 Gas 超出上限",
  HOOKS_EXECUTOR_FUNDS_INSUFFICIENT: "平台部署账户余额不足",
  HOOKS_BROADCAST_REJECTED: "部署交易被节点拒绝",
  HOOKS_TX_DROPPED: "部署交易未能上链",
  HOOKS_DEPLOY_REVERTED: "部署交易执行失败",
  HOOKS_VERIFICATION_MISMATCH: "部署结果核验未通过",
  HOOKS_ACTIVATION_STATE_UNEXPECTED: "激活前链上状态异常",
  HOOKS_ACTIVATION_SIMULATION_REVERTED: "激活预检未通过",
  HOOKS_ACTIVATION_REVERTED: "激活交易执行失败",
});

export function launchDeployFailureText(failureCode: string | null): string {
  return (
    (failureCode === null ? undefined : deployFailureTexts[failureCode]) ??
    "部署未完成，请联系平台"
  );
}

export function launchDeployFailedNotification(input: {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly projectName: string;
  readonly symbol: string | null;
  readonly failureCode: string | null;
  readonly failedAt: string;
}): RecordNotificationInput {
  const eventType = "launch.deploy_failed" as const;
  const reasonText = launchDeployFailureText(input.failureCode);
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    type: notificationInboxEventCategory[eventType],
    eventType,
    entityRef: projectRef(input.projectId),
    contextRoute: notificationInboxContextRoutes[eventType],
    contextParams: Object.freeze({ projectId: input.projectId }),
    payload: Object.freeze({
      event: eventType,
      title: bounded(`${input.projectName} 部署失败`),
      body: reasonText,
      projectName: bounded(input.projectName),
      ...symbolField(input.symbol),
      taskId: input.projectId,
      projectId: input.projectId,
      jobId: input.jobId,
      ...(input.failureCode === null ? {} : { failureCode: input.failureCode }),
    }),
    // One final failure per deployment task.
    dedupeKey: `launch.deploy_failed:${input.jobId}`,
    source: launchReviewInboxSources.executor,
    observedAt: input.failedAt,
  });
}
