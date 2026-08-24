import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";

const ROUTES = Object.freeze(new Set(["asset", "chat", "group", "market", "notifications", "perp", "privacy", "profile", "security", "token", "wallet"]));
const INTENT_ROUTES = Object.freeze({
  app_record_read: Object.freeze(new Set(["asset", "market", "privacy", "profile", "token", "wallet"])),
  app_record_write: Object.freeze(new Set(["asset", "market", "privacy", "profile", "token", "wallet"])),
  courier_issue_user_token: Object.freeze(new Set(["notifications"])),
  notification_deliver: Object.freeze(new Set(["notifications"])),
  price_alert_evaluate: Object.freeze(new Set(["asset", "market", "perp", "token"])),
});
const EVENTS = Object.freeze(new Set(["price_alert_triggered", "provider_activity_projected", "security_notice", "support_update"]));
const FACT_SOURCES = Object.freeze(new Set(["coingecko", "dexscreener", "hyperliquid"]));
const CONDITIONS = Object.freeze(new Set(["above", "at_or_above", "below", "at_or_below"]));
const PROVIDERS = Object.freeze(new Set(["privy", "stream", "hyperliquid", "market_data"]));
const VISIBILITY = Object.freeze(new Set(["private", "followers", "public"]));
const DELIVERY_STATUS = Object.freeze(new Set(["pending", "delivered", "failed"]));
const SEVERITY = Object.freeze(new Set(["low", "medium", "high", "critical"]));
const SUPPORT_STATUS = Object.freeze(new Set(["opened", "pending", "resolved"]));
const REQUIRED_CREDENTIALS = Object.freeze(["PRIVY_APP_ID", "PRIVY_VERIFICATION_KEY_REF", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_REF", "COURIER_API_KEY_REF", "TRIGGER_SECRET_KEY_REF"]);
const PORT_METHODS = Object.freeze(["verifyPrivyAccessToken", "verifyProviderEventRaw", "supabaseSelect", "supabaseUpsert", "courierIssueUserToken", "courierSend", "triggerSchedule"]);
const productionCapabilities = new WeakSet();
const consumedProductionCapabilities = new WeakSet();
const officialPortBundles = new WeakSet();
const productionClocks = new WeakSet();
const testCapabilities = new WeakSet();
const consumedTestCapabilities = new WeakSet();
const testPortBundles = new WeakSet();
const testClocks = new WeakSet();

const TABLES = Object.freeze({
  profiles: Object.freeze({ fields: Object.freeze(["privy_did", "alias", "avatar_ref", "updated_at"]), write: Object.freeze(["alias", "avatar_ref", "updated_at"]) }),
  privacy_preferences: Object.freeze({ fields: Object.freeze(["privy_did", "discoverable", "copy_trade_visibility", "updated_at"]), write: Object.freeze(["discoverable", "copy_trade_visibility", "updated_at"]) }),
  watchlists: Object.freeze({ fields: Object.freeze(["privy_did", "asset_key", "position", "updated_at"]), write: Object.freeze(["asset_key", "position", "updated_at"]) }),
  price_alert_definitions: Object.freeze({ fields: Object.freeze(["alert_id", "privy_did", "asset_key", "condition", "threshold_decimal", "source_allowlist", "expires_at", "updated_at"]), write: Object.freeze(["alert_id", "asset_key", "condition", "threshold_decimal", "source_allowlist", "expires_at", "updated_at"]) }),
  notification_preferences: Object.freeze({ fields: Object.freeze(["privy_did", "event_type", "enabled", "updated_at"]), write: Object.freeze(["event_type", "enabled", "updated_at"]) }),
  delivery_outbox_refs: Object.freeze({ fields: Object.freeze(["idempotency_key", "privy_did", "event_type", "provider_delivery_ref", "status", "updated_at"]), write: Object.freeze(["idempotency_key", "event_type", "provider_delivery_ref", "status", "updated_at"]) }),
});

function fail(code) { throw new Error(code); }

function safeString(value, code, minimum, maximum, pattern) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) fail(code);
  return value;
}

function safeId(value, code = "INVALID_ID") { return safeString(value, code, 1, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/); }
function safeDid(value) { return safeString(value, "INVALID_PRIVY_DID", 12, 203, /^did:privy:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/); }
function safeAsset(value) { return safeString(value, "INVALID_ASSET_KEY", 1, 64, /^[A-Z0-9][A-Z0-9:_-]{0,63}$/); }
function safeAlias(value) { return safeString(value, "INVALID_ALIAS", 1, 40, /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38}[A-Za-z0-9])?$/); }
function safeAvatar(value) { return value === null ? null : safeString(value, "INVALID_AVATAR_REF", 8, 135, /^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$/); }
function safeText(value, code, maximum = 280) { return safeString(value, code, 1, maximum, null); }
function safeInteger(value, code, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code); return value; }
function safeBoolean(value, code) { if (typeof value !== "boolean") fail(code); return value; }

function safeTimestamp(value, code) {
  safeString(value, code, 24, 24, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(code);
  return value;
}

function canonicalDecimal(value) {
  if (typeof value !== "string" || value.length > 96 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value === "-0") fail("NON_CANONICAL_DECIMAL");
  const negative = value[0] === "-";
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  return Object.freeze({ negative, digits: BigInt(whole + fraction), scale: fraction.length });
}

function compareDecimal(leftValue, rightValue) {
  const left = canonicalDecimal(leftValue), right = canonicalDecimal(rightValue);
  const scale = Math.max(left.scale, right.scale);
  const leftMagnitude = left.digits * (10n ** BigInt(scale - left.scale));
  const rightMagnitude = right.digits * (10n ** BigInt(scale - right.scale));
  const signedLeft = left.negative ? -leftMagnitude : leftMagnitude;
  const signedRight = right.negative ? -rightMagnitude : rightMagnitude;
  return signedLeft < signedRight ? -1 : signedLeft > signedRight ? 1 : 0;
}

function dataRecord(value, allowedKeys, requiredKeys, code) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) fail(code);
    if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) fail(code);
    const output = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.enumerable !== true) fail(code);
      output[key] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  }
}

function dataArray(value, maximum, code) {
  try {
    if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Reflect.ownKeys(descriptors).length !== length + 1) fail(code);
    const output = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.enumerable !== true) fail(code);
      output.push(descriptor.value);
    }
    return output;
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  }
}

function enumValue(value, allowed, code) { if (!allowed.has(value)) fail(code); return value; }

function validateField(name, value) {
  switch (name) {
    case "privy_did": return safeDid(value);
    case "alias": return safeAlias(value);
    case "avatar_ref": return safeAvatar(value);
    case "updated_at": case "expires_at": return safeTimestamp(value, `INVALID_${name.toUpperCase()}`);
    case "discoverable": case "enabled": return safeBoolean(value, `INVALID_${name.toUpperCase()}`);
    case "copy_trade_visibility": return enumValue(value, VISIBILITY, "INVALID_COPY_TRADE_VISIBILITY");
    case "asset_key": return safeAsset(value);
    case "position": return safeInteger(value, "INVALID_WATCHLIST_POSITION", 0, 10000);
    case "alert_id": return safeId(value, "INVALID_ALERT_ID");
    case "condition": return enumValue(value, CONDITIONS, "INVALID_ALERT_CONDITION");
    case "threshold_decimal": canonicalDecimal(value); return value;
    case "source_allowlist": {
      const sources = dataArray(value, 3, "INVALID_SOURCE_ALLOWLIST").map((source) => enumValue(source, FACT_SOURCES, "INVALID_SOURCE_ALLOWLIST"));
      if (new Set(sources).size !== sources.length || sources.length === 0) fail("INVALID_SOURCE_ALLOWLIST");
      return Object.freeze(sources);
    }
    case "event_type": return enumValue(value, EVENTS, "INVALID_EVENT_TYPE");
    case "idempotency_key": return safeString(value, "INVALID_IDEMPOTENCY_KEY", 64, 64, /^[a-f0-9]{64}$/);
    case "provider_delivery_ref": return safeId(value, "INVALID_PROVIDER_DELIVERY_REF");
    case "status": return enumValue(value, DELIVERY_STATUS, "INVALID_DELIVERY_STATUS");
    default: fail("UNKNOWN_APP_RECORD_FIELD");
  }
}

function projectRow(table, value, did, mode) {
  const schema = TABLES[table];
  if (!schema) fail("TABLE_DENIED");
  const keys = mode === "write" ? schema.write : schema.fields;
  const row = dataRecord(value, keys, keys, "APP_RECORD_SHAPE_DENIED");
  const output = {};
  for (const key of keys) output[key] = validateField(key, row[key]);
  if (mode === "write") output.privy_did = did;
  else if (output.privy_did !== did) fail("APP_RECORD_TENANT_DENIED");
  return Object.freeze(output);
}

function projectRows(table, value, did) {
  const rows = dataArray(value, 100, "APP_RECORD_RESULT_DENIED");
  return Object.freeze(rows.map((row) => projectRow(table, row, did, "read")));
}

function projectFilters(table, value, did) {
  const schema = TABLES[table];
  if (!schema) fail("TABLE_DENIED");
  const allowed = schema.fields.filter((field) => field !== "privy_did");
  const filters = dataRecord(value, allowed, [], "FILTER_DENIED");
  const output = {};
  for (const [key, item] of Object.entries(filters)) output[key] = validateField(key, item);
  output.privy_did = did;
  return Object.freeze(output);
}

function projectRequest(value, intent, keys) {
  const request = dataRecord(value, keys, keys, "REQUEST_SHAPE_DENIED");
  if (request.intent !== intent || !ROUTES.has(request.route) || !INTENT_ROUTES[intent]?.has(request.route)) fail("REQUEST_POLICY_DENIED");
  if (keys.includes("idempotencyKey")) safeId(request.idempotencyKey, "IDEMPOTENCY_REQUIRED");
  return Object.freeze(request);
}

function assertPrincipal(principal, brand) { if (!principal || !brand.has(principal)) fail("VERIFIED_PRIVY_DID_REQUIRED"); return safeDid(principal.did); }

function projectFact(value) {
  const fields = ["asset_key", "source", "value_decimal", "observed_at", "expires_at", "source_event_id", "verification_ref"];
  const fact = dataRecord(value, fields, fields, "PROVIDER_FACT_SHAPE_DENIED");
  const output = {
    asset_key: safeAsset(fact.asset_key),
    source: enumValue(fact.source, FACT_SOURCES, "FACT_SOURCE_DENIED"),
    value_decimal: fact.value_decimal,
    observed_at: safeTimestamp(fact.observed_at, "INVALID_FACT_OBSERVED_AT"),
    expires_at: safeTimestamp(fact.expires_at, "INVALID_FACT_EXPIRES_AT"),
    source_event_id: safeId(fact.source_event_id, "FACT_EVENT_ID_REQUIRED"),
    verification_ref: safeId(fact.verification_ref, "FACT_VERIFICATION_REF_REQUIRED"),
  };
  canonicalDecimal(output.value_decimal);
  return Object.freeze(output);
}

function assertFact(fact, nowMs, brand) {
  if (!fact || !brand.has(fact)) fail("VERIFIED_PROVIDER_FACT_REQUIRED");
  const observed = Date.parse(fact.observed_at), expires = Date.parse(fact.expires_at);
  if (observed > nowMs || nowMs - observed > 300000 || expires <= nowMs) fail("STALE_OR_INVALID_FACT");
  return fact;
}

function projectAlert(value, did) {
  const keys = ["alert_id", "privy_did", "asset_key", "condition", "threshold_decimal", "source_allowlist", "expires_at"];
  const alert = dataRecord(value, keys, keys, "ALERT_SHAPE_DENIED");
  const output = {};
  for (const key of keys) output[key] = validateField(key, alert[key]);
  if (output.privy_did !== did) fail("ALERT_POLICY_DENIED");
  return Object.freeze(output);
}

const EVENT_ROUTES = Object.freeze({
  price_alert_triggered: Object.freeze(new Set(["asset", "notifications", "perp", "token"])),
  provider_activity_projected: Object.freeze(new Set(["chat", "group", "notifications", "perp", "wallet"])),
  security_notice: Object.freeze(new Set(["notifications", "security"])),
  support_update: Object.freeze(new Set(["notifications"])),
});

function projectEventPayload(type, value) {
  let keys, output;
  if (type === "price_alert_triggered") {
    keys = ["alert_id", "asset_key", "condition", "threshold_decimal", "fact_ref"];
    const item = dataRecord(value, keys, keys, "NOTIFICATION_PAYLOAD_DENIED");
    output = { alert_id: safeId(item.alert_id), asset_key: safeAsset(item.asset_key), condition: enumValue(item.condition, CONDITIONS, "INVALID_ALERT_CONDITION"), threshold_decimal: item.threshold_decimal, fact_ref: safeId(item.fact_ref) };
    canonicalDecimal(output.threshold_decimal);
  } else if (type === "provider_activity_projected") {
    keys = ["provider", "activity_ref"];
    const item = dataRecord(value, keys, keys, "NOTIFICATION_PAYLOAD_DENIED");
    output = { provider: enumValue(item.provider, PROVIDERS, "INVALID_ACTIVITY_PROVIDER"), activity_ref: safeId(item.activity_ref) };
  } else if (type === "security_notice") {
    keys = ["notice_code", "severity"];
    const item = dataRecord(value, keys, keys, "NOTIFICATION_PAYLOAD_DENIED");
    output = { notice_code: safeId(item.notice_code, "INVALID_NOTICE_CODE"), severity: enumValue(item.severity, SEVERITY, "INVALID_NOTICE_SEVERITY") };
  } else if (type === "support_update") {
    keys = ["ticket_ref", "status"];
    const item = dataRecord(value, keys, keys, "NOTIFICATION_PAYLOAD_DENIED");
    output = { ticket_ref: safeId(item.ticket_ref, "INVALID_TICKET_REF"), status: enumValue(item.status, SUPPORT_STATUS, "INVALID_SUPPORT_STATUS") };
  } else fail("NOTIFICATION_EVENT_DENIED");
  return Object.freeze(output);
}

function projectNotificationEvent(value) {
  const keys = ["type", "source_event_id", "destination_route", "payload"];
  const event = dataRecord(value, keys, keys, "NOTIFICATION_EVENT_SHAPE_DENIED");
  const type = enumValue(event.type, EVENTS, "NOTIFICATION_EVENT_DENIED");
  if (!EVENT_ROUTES[type].has(event.destination_route)) fail("NOTIFICATION_ROUTE_DENIED");
  return Object.freeze({ type, source_event_id: safeId(event.source_event_id, "NOTIFICATION_SOURCE_EVENT_ID_REQUIRED"), destination_route: event.destination_route, payload: projectEventPayload(type, event.payload) });
}

function hashMaterial(parts) { return createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex"); }

function safeCredentialRef(value, key) {
  const code = `MISSING_CREDENTIAL_REF_${key}`;
  const credential = safeText(value, code, 256);
  if (credential.trim().length === 0) fail(code);
  return credential;
}

function validateCredentials(value) {
  const credentials = dataRecord(value, REQUIRED_CREDENTIALS, REQUIRED_CREDENTIALS, "CREDENTIAL_REFS_DENIED");
  for (const key of REQUIRED_CREDENTIALS) safeCredentialRef(credentials[key], key);
  return Object.freeze({ ...credentials });
}

function validatePortBundle(ports) {
  const bundle = dataRecord(ports, PORT_METHODS, PORT_METHODS, "OFFICIAL_PORT_BUNDLE_SHAPE_DENIED");
  for (const key of PORT_METHODS) if (typeof bundle[key] !== "function") fail(`OFFICIAL_SDK_PORT_REQUIRED_${key}`);
  return bundle;
}

function snapshotPortBundle(ports) {
  const bundle = validatePortBundle(ports);
  const snapshot = {};
  for (const key of PORT_METHODS) snapshot[key] = bundle[key].bind(ports);
  return Object.freeze(snapshot);
}

function snapshotClock(clock) {
  const record = dataRecord(clock, ["readServerTimeMs"], ["readServerTimeMs"], "AUTHORITATIVE_CLOCK_SHAPE_DENIED");
  if (typeof record.readServerTimeMs !== "function") fail("AUTHORITATIVE_CLOCK_REQUIRED");
  return Object.freeze({ readServerTimeMs: record.readServerTimeMs.bind(clock) });
}

function authoritativeClock(reader, brandSet) {
  if (!reader || !brandSet.has(reader)) fail("AUTHORITATIVE_CLOCK_REQUIRED");
  let last = -1;
  return () => {
    const now = reader.readServerTimeMs();
    if (!Number.isSafeInteger(now) || now < 0) fail("AUTHORITATIVE_CLOCK_INVALID");
    if (now < last) fail("AUTHORITATIVE_CLOCK_ROLLBACK");
    last = now;
    return now;
  };
}

function composeAdapters(ports, clockNow) {
  const verifiedPrincipals = new WeakSet();
  const verifiedFacts = new WeakSet();
  async function verifyPrivy(token) {
    const result = await ports.verifyPrivyAccessToken(safeText(token, "PRIVY_TOKEN_REQUIRED", 4096));
    const verified = dataRecord(result, ["privyDid"], ["privyDid"], "OFFICIAL_PRIVY_VERIFIER_REJECTED");
    const principal = Object.freeze({ did: safeDid(verified.privyDid) });
    verifiedPrincipals.add(principal);
    return principal;
  }
  async function verifyProviderFact(rawBody, rawHeaders) {
    if (!(rawBody instanceof Uint8Array) || utilTypes.isProxy(rawBody) || !rawHeaders || typeof rawHeaders !== "object") fail("RAW_PROVIDER_ENVELOPE_REQUIRED");
    const result = await ports.verifyProviderEventRaw(rawBody, rawHeaders);
    const verified = dataRecord(result, ["signatureValid", "timestampValid", "replayValid", "fact"], ["signatureValid", "timestampValid", "replayValid", "fact"], "PROVIDER_VERIFIER_RESULT_DENIED");
    if (verified.signatureValid !== true || verified.timestampValid !== true || verified.replayValid !== true) fail("PROVIDER_VERIFIER_REJECTED");
    const fact = projectFact(verified.fact);
    verifiedFacts.add(fact);
    return fact;
  }
  async function readAppRecords(principal, requestValue, table, filtersValue = {}) {
    const did = assertPrincipal(principal, verifiedPrincipals);
    projectRequest(requestValue, "app_record_read", ["route", "intent"]);
    const result = await ports.supabaseSelect({ table, columns: TABLES[table]?.fields, filters: projectFilters(table, filtersValue, did) });
    return projectRows(table, result, did);
  }
  async function writeAppRecord(principal, requestValue, table, input) {
    const did = assertPrincipal(principal, verifiedPrincipals);
    const request = projectRequest(requestValue, "app_record_write", ["route", "intent", "idempotencyKey"]);
    const row = projectRow(table, input, did, "write");
    const result = await ports.supabaseUpsert({ table, row, idempotencyKey: request.idempotencyKey });
    return projectRow(table, result, did, "read");
  }
  async function issueCourierUserToken(principal, requestValue) {
    const did = assertPrincipal(principal, verifiedPrincipals);
    projectRequest(requestValue, "courier_issue_user_token", ["route", "intent"]);
    return ports.courierIssueUserToken({ subject: did, idempotencyKey: hashMaterial(["courier_user_token", did]) });
  }
  async function deliverNotification(principal, requestValue, eventValue) {
    const did = assertPrincipal(principal, verifiedPrincipals);
    projectRequest(requestValue, "notification_deliver", ["route", "intent"]);
    const event = projectNotificationEvent(eventValue);
    const idempotencyKey = hashMaterial([event.type, did, event.source_event_id]);
    return ports.courierSend(Object.freeze({ recipient: did, event, idempotencyKey }));
  }
  async function evaluatePriceAlert(principal, requestValue, alertValue, fact) {
    const did = assertPrincipal(principal, verifiedPrincipals);
    projectRequest(requestValue, "price_alert_evaluate", ["route", "intent"]);
    const nowMs = clockNow();
    assertFact(fact, nowMs, verifiedFacts);
    const alert = projectAlert(alertValue, did);
    if (Date.parse(alert.expires_at) <= nowMs || alert.asset_key !== fact.asset_key || !alert.source_allowlist.includes(fact.source)) fail("ALERT_POLICY_DENIED");
    const comparison = compareDecimal(fact.value_decimal, alert.threshold_decimal);
    const triggered = alert.condition === "above" ? comparison > 0 : alert.condition === "at_or_above" ? comparison >= 0 : alert.condition === "below" ? comparison < 0 : comparison <= 0;
    const idempotencyKey = hashMaterial([alert.alert_id, did, alert.condition, alert.threshold_decimal, fact.source, fact.source_event_id, fact.observed_at]);
    if (!triggered) return Object.freeze({ triggered: false, idempotencyKey });
    await ports.triggerSchedule(Object.freeze({ task: "deliver-price-alert", idempotencyKey, payload: Object.freeze({ alert_id: alert.alert_id, recipient: did, fact_ref: fact.source_event_id }) }));
    return Object.freeze({ triggered: true, idempotencyKey });
  }
  return Object.freeze({ verifyPrivy, verifyProviderFact, readAppRecords, writeAppRecord, issueCourierUserToken, deliverNotification, evaluatePriceAlert });
}

function mintCredentialedProductionCapabilityForCompositionRoot() { const capability = Object.freeze(Object.create(null)); productionCapabilities.add(capability); return capability; }
function brandOfficialPortBundleForCompositionRoot(ports) { const snapshot = snapshotPortBundle(ports); officialPortBundles.add(snapshot); return snapshot; }
function brandProductionClockForCompositionRoot(clock) { const snapshot = snapshotClock(clock); productionClocks.add(snapshot); return snapshot; }

export function createProductionAdapters(capability, configValue) {
  if (!capability || !productionCapabilities.has(capability)) fail("PRODUCTION_ENABLEMENT_CAPABILITY_REQUIRED");
  if (consumedProductionCapabilities.has(capability)) fail("PRODUCTION_ENABLEMENT_CAPABILITY_ALREADY_CONSUMED");
  consumedProductionCapabilities.add(capability);
  const config = dataRecord(configValue, ["credentials", "officialSdkPorts", "authoritativeClock"], ["credentials", "officialSdkPorts", "authoritativeClock"], "PRODUCTION_CONFIG_DENIED");
  validateCredentials(config.credentials);
  if (!officialPortBundles.has(config.officialSdkPorts)) fail("OFFICIAL_PORT_BUNDLE_REQUIRED");
  validatePortBundle(config.officialSdkPorts);
  return composeAdapters(config.officialSdkPorts, authoritativeClock(config.authoritativeClock, productionClocks));
}

function createSelfTestHarness(ports, initialNowMs) {
  const capability = Object.freeze(Object.create(null));
  testCapabilities.add(capability);
  let current = initialNowMs;
  const clock = snapshotClock({ readServerTimeMs: () => current });
  const portSnapshot = snapshotPortBundle(ports);
  testClocks.add(clock);
  testPortBundles.add(portSnapshot);
  const create = () => {
    if (!testCapabilities.has(capability)) fail("TEST_CAPABILITY_REQUIRED");
    if (consumedTestCapabilities.has(capability)) fail("TEST_CAPABILITY_ALREADY_CONSUMED");
    consumedTestCapabilities.add(capability);
    if (!testPortBundles.has(portSnapshot) || !testClocks.has(clock)) fail("TEST_BRAND_REQUIRED");
    validatePortBundle(portSnapshot);
    return composeAdapters(portSnapshot, authoritativeClock(clock, testClocks));
  };
  return Object.freeze({ create, setClock: (value) => { current = value; } });
}

export function createOfflineFixtureAdapters(env = process.env) {
  if (env.LOOP_OFFLINE_APP_INTEGRATIONS_FIXTURE !== "1") fail("OFFLINE_FIXTURE_EXPLICIT_OPT_IN_REQUIRED");
  const denied = async () => fail("OFFLINE_FIXTURE_MUTATION_OR_NETWORK_FORBIDDEN");
  return Object.freeze({ mode: "EXPLICIT_OFFLINE_R0", production: false, readFixtureProjection: () => Object.freeze({ fixture: true, providerTruth: false }), verifyPrivy: denied, verifyProviderFact: denied, readAppRecords: denied, writeAppRecord: denied, issueCourierUserToken: denied, deliverNotification: denied, evaluatePriceAlert: denied });
}

async function selfTest() {
  const calls = [], state = { select: [], fact: null };
  const ports = {
    verifyPrivyAccessToken: async () => ({ privyDid: "did:privy:test-user" }),
    verifyProviderEventRaw: async () => ({ signatureValid: true, timestampValid: true, replayValid: true, fact: state.fact }),
    supabaseSelect: async () => state.select,
    supabaseUpsert: async (input) => { calls.push(["upsert", input]); return input.row; },
    courierIssueUserToken: async (input) => { calls.push(["token", input]); return Object.freeze({ token: "redacted-test" }); },
    courierSend: async (input) => { calls.push(["send", input]); return Object.freeze({ requestId: "courier-test" }); },
    triggerSchedule: async (input) => { calls.push(["schedule", input]); return Object.freeze({ runId: "trigger-test" }); },
  };
  const now = Date.parse("2026-08-24T00:01:00.000Z");
  const harness = createSelfTestHarness(ports, now), adapters = harness.create();
  let replayDenied = false;
  try { harness.create(); } catch (error) { replayDenied = error.message === "TEST_CAPABILITY_ALREADY_CONSUMED"; }
  if (!replayDenied) fail("SELF_TEST_CAPABILITY_REPLAY");
  const principal = await adapters.verifyPrivy("privy-access-token-test");
  const profile = { alias: "loop_user", avatar_ref: "avatar:loop-user", updated_at: "2026-08-24T00:00:00.000Z" };
  const written = await adapters.writeAppRecord(principal, { route: "profile", intent: "app_record_write", idempotencyKey: "record-write-1" }, "profiles", profile);
  if (written.alias !== profile.alias || !Object.isFrozen(written)) fail("SELF_TEST_TYPED_WRITE");
  let nestedDenied = false, getterCalls = 0;
  try { await adapters.writeAppRecord(principal, { route: "profile", intent: "app_record_write", idempotencyKey: "record-write-2" }, "profiles", { ...profile, alias: { wallet_balance: "100 BTC", market_price: "999" } }); } catch (error) { nestedDenied = error.message === "INVALID_ALIAS"; }
  const accessor = { avatar_ref: null, updated_at: profile.updated_at };
  Object.defineProperty(accessor, "alias", { enumerable: true, get() { getterCalls += 1; return "evil"; } });
  try { await adapters.writeAppRecord(principal, { route: "profile", intent: "app_record_write", idempotencyKey: "record-write-3" }, "profiles", accessor); } catch (error) { if (error.message !== "APP_RECORD_SHAPE_DENIED") fail("SELF_TEST_ACCESSOR_CODE"); }
  if (!nestedDenied || getterCalls !== 0) fail("SELF_TEST_TYPED_INPUT_ATTACKS");
  state.select = [{ privy_did: principal.did, ...profile }];
  const rows = await adapters.readAppRecords(principal, { route: "profile", intent: "app_record_read" }, "profiles");
  if (!Object.isFrozen(rows) || !Object.isFrozen(rows[0])) fail("SELF_TEST_READ_PROJECTION");
  state.select = [{ privy_did: principal.did, ...profile, wallet_balance: "DB truth" }];
  let outputDenied = false;
  try { await adapters.readAppRecords(principal, { route: "profile", intent: "app_record_read" }, "profiles"); } catch (error) { outputDenied = error.message === "APP_RECORD_SHAPE_DENIED"; }
  state.select = [{ privy_did: principal.did, ...profile, alias: { wallet_balance: "DB nested truth" } }];
  let nestedOutputDenied = false;
  try { await adapters.readAppRecords(principal, { route: "profile", intent: "app_record_read" }, "profiles"); } catch (error) { nestedOutputDenied = error.message === "INVALID_ALIAS"; }
  state.select = [{ privy_did: principal.did, ...profile, alias: "x".repeat(41) }];
  let oversizedOutputDenied = false;
  try { await adapters.readAppRecords(principal, { route: "profile", intent: "app_record_read" }, "profiles"); } catch (error) { oversizedOutputDenied = error.message === "INVALID_ALIAS"; }
  if (!outputDenied || !nestedOutputDenied || !oversizedOutputDenied) fail("SELF_TEST_MALICIOUS_SELECT");
  const notification = { type: "security_notice", source_event_id: "security-event-1", destination_route: "security", payload: { notice_code: "login-risk", severity: "high" } };
  await adapters.deliverNotification(principal, { route: "notifications", intent: "notification_deliver" }, notification);
  const firstSend = calls.find(([kind]) => kind === "send")?.[1];
  const expectedKey = hashMaterial([notification.type, principal.did, notification.source_event_id]);
  let callerKeyDenied = false, routingDenied = false, payloadDenied = false, missingSourceDenied = false;
  try { await adapters.deliverNotification(principal, { route: "notifications", intent: "notification_deliver", idempotencyKey: "attacker" }, notification); } catch (error) { callerKeyDenied = error.message === "REQUEST_SHAPE_DENIED"; }
  try { await adapters.deliverNotification(principal, { route: "notifications", intent: "notification_deliver" }, { ...notification, routing: { channel: "attacker" } }); } catch (error) { routingDenied = error.message === "NOTIFICATION_EVENT_SHAPE_DENIED"; }
  try { await adapters.deliverNotification(principal, { route: "notifications", intent: "notification_deliver" }, { ...notification, payload: { ...notification.payload, template: "attacker", channel: "sms" } }); } catch (error) { payloadDenied = error.message === "NOTIFICATION_PAYLOAD_DENIED"; }
  try { await adapters.deliverNotification(principal, { route: "notifications", intent: "notification_deliver" }, { type: notification.type, destination_route: notification.destination_route, payload: notification.payload }); } catch (error) { missingSourceDenied = error.message === "NOTIFICATION_EVENT_SHAPE_DENIED"; }
  if (!firstSend || firstSend.idempotencyKey !== expectedKey || Reflect.ownKeys(firstSend).sort().join(",") !== "event,idempotencyKey,recipient" || !callerKeyDenied || !routingDenied || !payloadDenied || !missingSourceDenied) fail("SELF_TEST_COURIER_BOUNDARY");
  state.fact = { asset_key: "BTC", source: "coingecko", value_decimal: "100.01", observed_at: "2026-08-24T00:00:00.000Z", expires_at: "2026-08-24T00:06:00.000Z", source_event_id: "fact-1", verification_ref: "official-verifier-1" };
  const fact = await adapters.verifyProviderFact(new Uint8Array([123, 125]), { "x-provider-signature": "test" });
  const alert = { alert_id: "alert-1", privy_did: principal.did, asset_key: "BTC", condition: "above", threshold_decimal: "100.00", source_allowlist: ["coingecko"], expires_at: "2026-08-24T00:10:00.000Z" };
  const result = await adapters.evaluatePriceAlert(principal, { route: "asset", intent: "price_alert_evaluate" }, alert, fact, Date.parse("2020-01-01T00:01:00.000Z"));
  if (!result.triggered) fail("SELF_TEST_AUTHORITATIVE_CLOCK");
  harness.setClock(now - 1);
  let rollbackDenied = false;
  try { await adapters.evaluatePriceAlert(principal, { route: "asset", intent: "price_alert_evaluate" }, alert, fact); } catch (error) { rollbackDenied = error.message === "AUTHORITATIVE_CLOCK_ROLLBACK"; }
  if (!rollbackDenied) fail("SELF_TEST_CLOCK_ROLLBACK");
  const nonFiniteHarness = createSelfTestHarness({ ...ports }, Number.NaN), nonFiniteAdapters = nonFiniteHarness.create(), nonFinitePrincipal = await nonFiniteAdapters.verifyPrivy("privy-access-token-test"), nonFiniteFact = await nonFiniteAdapters.verifyProviderFact(new Uint8Array([2]), { sig: "test" });
  let nonFiniteDenied = false;
  try { await nonFiniteAdapters.evaluatePriceAlert(nonFinitePrincipal, { route: "asset", intent: "price_alert_evaluate" }, { ...alert, privy_did: nonFinitePrincipal.did }, nonFiniteFact); } catch (error) { nonFiniteDenied = error.message === "AUTHORITATIVE_CLOCK_INVALID"; }
  if (!nonFiniteDenied) fail("SELF_TEST_NONFINITE_CLOCK");
  const expiredHarness = createSelfTestHarness({ ...ports }, now), expiredAdapters = expiredHarness.create(), expiredPrincipal = await expiredAdapters.verifyPrivy("privy-access-token-test"), expiredFact = await expiredAdapters.verifyProviderFact(new Uint8Array([3]), { sig: "test" });
  let expiredAlertDenied = false;
  try { await expiredAdapters.evaluatePriceAlert(expiredPrincipal, { route: "asset", intent: "price_alert_evaluate" }, { ...alert, privy_did: expiredPrincipal.did, expires_at: "2026-08-24T00:00:59.999Z" }, expiredFact); } catch (error) { expiredAlertDenied = error.message === "ALERT_POLICY_DENIED"; }
  if (!expiredAlertDenied) fail("SELF_TEST_EXPIRED_ALERT");
  const staleState = { fact: { ...state.fact, observed_at: "2020-01-01T00:00:00.000Z", expires_at: "2020-01-01T00:06:00.000Z" } };
  const stalePorts = { ...ports, verifyProviderEventRaw: async () => ({ signatureValid: true, timestampValid: true, replayValid: true, fact: staleState.fact }) };
  const staleHarness = createSelfTestHarness(stalePorts, now), staleAdapters = staleHarness.create(), stalePrincipal = await staleAdapters.verifyPrivy("privy-access-token-test"), staleFact = await staleAdapters.verifyProviderFact(new Uint8Array([1]), { sig: "test" });
  let crossCompositionDenied = false;
  try { await staleAdapters.evaluatePriceAlert(stalePrincipal, { route: "asset", intent: "price_alert_evaluate" }, { ...alert, privy_did: stalePrincipal.did }, fact); } catch (error) { crossCompositionDenied = error.message === "VERIFIED_PROVIDER_FACT_REQUIRED"; }
  if (!crossCompositionDenied) fail("SELF_TEST_CROSS_COMPOSITION_FACT");
  let staleDenied = false;
  try { await staleAdapters.evaluatePriceAlert(stalePrincipal, { route: "asset", intent: "price_alert_evaluate" }, { ...alert, privy_did: stalePrincipal.did }, staleFact, Date.parse("2020-01-01T00:01:00.000Z")); } catch (error) { staleDenied = error.message === "STALE_OR_INVALID_FACT"; }
  if (!staleDenied) fail("SELF_TEST_CALLER_CLOCK_INJECTION");
  const productionPortSource = { ...ports };
  const productionPorts = brandOfficialPortBundleForCompositionRoot(productionPortSource);
  let productionNow = now;
  const productionClockSource = { readServerTimeMs: () => productionNow };
  const productionClock = brandProductionClockForCompositionRoot(productionClockSource);
  const credentials = Object.fromEntries(REQUIRED_CREDENTIALS.map((key) => [key, `credential-ref-${key}`]));
  const whitespaceCredentialValues = [" ", "\u00a0", "\u1680", "\u2003", "\u202f", "\u205f", "\u3000", "\ufeff"];
  for (const key of REQUIRED_CREDENTIALS) {
    for (const whitespace of whitespaceCredentialValues) {
      const whitespaceCapability = mintCredentialedProductionCapabilityForCompositionRoot();
      let whitespaceDenied = false;
      try { createProductionAdapters(whitespaceCapability, { credentials: { ...credentials, [key]: whitespace }, officialSdkPorts: productionPorts, authoritativeClock: productionClock }); } catch (error) { whitespaceDenied = error.message === `MISSING_CREDENTIAL_REF_${key}`; }
      if (!whitespaceDenied) fail("SELF_TEST_CREDENTIAL_WHITESPACE");
    }
  }
  const productionCapability = mintCredentialedProductionCapabilityForCompositionRoot();
  const production = createProductionAdapters(productionCapability, { credentials, officialSdkPorts: productionPorts, authoritativeClock: productionClock });
  if (!production) fail("SELF_TEST_PRODUCTION_COMPOSITION");
  productionPortSource.verifyPrivyAccessToken = async () => ({ privyDid: "did:privy:drift-user" });
  productionClockSource.readServerTimeMs = () => 0;
  const stablePrincipal = await production.verifyPrivy("privy-access-token-test");
  const stableFact = await production.verifyProviderFact(new Uint8Array([4]), { sig: "test" });
  const stableResult = await production.evaluatePriceAlert(stablePrincipal, { route: "asset", intent: "price_alert_evaluate" }, { ...alert, privy_did: stablePrincipal.did }, stableFact);
  if (stablePrincipal.did !== "did:privy:test-user" || !stableResult.triggered) fail("SELF_TEST_COMPOSITION_DEPENDENCY_DRIFT");
  let productionReplay = false, copiedCapability = false, rawPortsDenied = false, failedAttemptConsumed = false;
  try { createProductionAdapters(productionCapability, { credentials, officialSdkPorts: productionPorts, authoritativeClock: productionClock }); } catch (error) { productionReplay = error.message === "PRODUCTION_ENABLEMENT_CAPABILITY_ALREADY_CONSUMED"; }
  try { createProductionAdapters({ ...productionCapability }, { credentials, officialSdkPorts: productionPorts, authoritativeClock: productionClock }); } catch (error) { copiedCapability = error.message === "PRODUCTION_ENABLEMENT_CAPABILITY_REQUIRED"; }
  const rawCapability = mintCredentialedProductionCapabilityForCompositionRoot();
  try { createProductionAdapters(rawCapability, { credentials, officialSdkPorts: { ...ports }, authoritativeClock: productionClock }); } catch (error) { rawPortsDenied = error.message === "OFFICIAL_PORT_BUNDLE_REQUIRED"; }
  try { createProductionAdapters(rawCapability, { credentials, officialSdkPorts: productionPorts, authoritativeClock: productionClock }); } catch (error) { failedAttemptConsumed = error.message === "PRODUCTION_ENABLEMENT_CAPABILITY_ALREADY_CONSUMED"; }
  const clockCapability = mintCredentialedProductionCapabilityForCompositionRoot();
  let copiedClockDenied = false;
  try { createProductionAdapters(clockCapability, { credentials, officialSdkPorts: productionPorts, authoritativeClock: { readServerTimeMs: () => now } }); } catch (error) { copiedClockDenied = error.message === "AUTHORITATIVE_CLOCK_REQUIRED"; }
  if (!productionReplay || !copiedCapability || !rawPortsDenied || !failedAttemptConsumed || !copiedClockDenied) fail("SELF_TEST_PRODUCTION_CAPABILITY");
  process.stdout.write("PASS app-integrations-p0 v3 adapter self-test: typed_rows courier_idempotency authoritative_clock one_shot_capability credential_whitespace\n");
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url)) && process.argv[2] === "--self-test") selfTest().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
