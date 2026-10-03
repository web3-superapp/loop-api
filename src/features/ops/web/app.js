/* global AbortController, document, window, URLSearchParams, fetch, crypto, structuredClone, setTimeout, clearTimeout */
"use strict";
(() => {
  const preview =
    new URLSearchParams(window.location.search).get("preview") === "1";
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const append = (parent, ...children) => {
    children.filter(Boolean).forEach((child) => parent.append(child));
    return parent;
  };
  const button = (text, action, className = "", disabled = false) => {
    const node = el("button", text, className);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  };
  const clone = (value) => structuredClone(value);
  const uuid = () => crypto.randomUUID();
  const time = (value) =>
    value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
  const short = (value) =>
    String(value || "—").length > 25
      ? `${String(value).slice(0, 12)}…${String(value).slice(-8)}`
      : String(value || "—");
  const labels = {
    approved: "生效中",
    retired: "已退休",
    pending_approval: "待审批",
    draft: "草稿",
    review: "待独立审批",
    published: "已发布",
    verified: "已通过",
    rejected: "已拒绝",
    pending: "待审核",
    open: "待回复",
    answered: "已回复",
    closed: "已关闭",
    complete: "完整",
    incomplete: "不完整",
    invalidated: "已撤回",
    queued: "待执行",
    held: "已挂起",
    succeeded: "成功",
    unknown: "结果未知",
    connected: "API 已连接",
    app: "App 管理",
    contract_pending: "待补契约",
    script: "现有脚本",
    deployment: "部署配置",
    code_policy: "代码规则",
    confirmation_required: "待产品确认",
    restricted: "技术角色受限",
    handoff_only: "仅合约交接",
  };
  const badge = (value) =>
    el(
      "span",
      labels[value] || value || "未配置",
      `badge ${["approved", "verified", "complete", "succeeded", "connected", "published"].includes(value) ? "good" : ["review", "pending", "open", "queued"].includes(value) ? "warn" : ["rejected", "invalidated", "held", "unknown"].includes(value) ? "bad" : ""}`,
    );
  let token = "",
    session = null,
    page = "mining",
    data = {},
    catalog = [],
    pending = null,
    noticeTimer,
    lastFocus,
    loading = false;
  let versionWeights = {},
    auditFilters = {};
  let viewGeneration = 0,
    drawerGeneration = 0;
  const resourceGenerations = {};
  let sessionGeneration = 0,
    recoveryOperationId = null;
  const can = (permission, scope = "*") =>
    Boolean(
      session?.grants.some(
        (grant) =>
          grant.permission === permission &&
          (grant.scope === "*" || grant.scope === scope),
      ),
    );
  const nav = [
    ["mining", "◈", "挖矿配置", "mining.read"],
    ["drafts", "≡", "草稿与审批", "mining.read"],
    ["snapshots", "▦", "快照记录", "mining.read"],
    ["communities", "◎", "社区审核", "community.review"],
    ["support", "◇", "客服工单", "support.manage"],
    ["catalog", "⊞", "运营能力清单", null],
    ["audit", "↗", "操作记录", "audit.read"],
  ];
  function toast(message) {
    $("notice").textContent = message;
    $("notice").hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      $("notice").hidden = true;
    }, 6000);
  }
  function showDrawer(title) {
    drawerGeneration++;
    lastFocus = document.activeElement;
    $("drawer-title").textContent = title;
    $("drawer-body").replaceChildren();
    if (!$("drawer").open) $("drawer").showModal();
    return $("drawer-body");
  }
  function closeDrawer() {
    drawerGeneration++;
    $("drawer").close();
    lastFocus?.focus();
  }
  $("close-drawer").addEventListener("click", closeDrawer);
  $("drawer").addEventListener("cancel", () => {
    drawerGeneration++;
  });
  const drawerCurrent = (generation) =>
    session && $("drawer").open && drawerGeneration === generation;
  const messages = {
    SESSION_REPLACED: "旧会话请求已丢弃，请重新验证身份。",
    OPS_FORBIDDEN: "当前身份没有此操作权限，请联系授权管理员。",
    OPS_SELF_APPROVAL: "参与编辑的操作员不能审批此版本。",
    OPS_ACTIVE_VERSION_CONFLICT: "生效版本已变化，请刷新后重新核对。",
    OPS_VERSION_CONFLICT: "记录已被更新，请刷新后重新编辑。",
    OPS_COMMUNITY_BINDING_CHANGED: "社区绑定资产已变化，请修订草稿后重新提交。",
    OPS_UNAVAILABLE: "管理服务当前不可用，请检查开发环境配置。",
    OPS_MINING_RUNTIME_UNAVAILABLE: "计算依赖未就绪，任务尚未执行。",
    OPS_JOB_HELD: "任务已挂起，需要重新授权或审核。",
    OPS_INVALID_INPUT:
      "参数格式未通过校验，请检查版本、资产 ID、系数与价格规则。",
    OPS_NOT_FOUND: "未找到记录。若操作结果未知，请保留操作编号并稍后再次查询。",
    AUTHENTICATION_REQUIRED:
      "凭据无效或已过期，请退出并使用当前访问令牌重新验证。",
  };
  const errorText = (error) =>
    messages[error.code] ||
    `${error.code || "NETWORK_ERROR"}：请求未确认，请保留操作编号并查询结果。`;
  function invalidateSession() {
    recoveryOperationId = pending?.command.operationId || recoveryOperationId;
    sessionGeneration++;
    viewGeneration++;
    token = "";
    session = null;
    data = {};
    catalog = [];
    versionWeights = {};
    auditFilters = {};
    pending = null;
    loading = false;
    closeDrawer();
    $("drawer-body").replaceChildren();
    $("drawer-title").textContent = "";
    lastFocus = null;
    auth();
  }
  async function api(path, body) {
    if (preview) throw new Error("PREVIEW_NETWORK_DISABLED");
    const generation = sessionGeneration;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(`/ops/api/${path}`, {
        signal: controller.signal,
        method: body === undefined ? "GET" : "POST",
        credentials: "omit",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (generation !== sessionGeneration)
        throw Object.assign(new Error("SESSION_REPLACED"), {
          code: "SESSION_REPLACED",
        });
      if (!response.ok) {
        const error = new Error(result.code || "OPS_REQUEST_FAILED");
        error.code = result.code;
        error.status = response.status;
        if (response.status === 401 || result.code === "OPS_FORBIDDEN") {
          invalidateSession();
          toast(errorText(error));
        }
        throw error;
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
  function renderNav() {
    $("navigation").replaceChildren();
    for (const [id, icon, title, permission] of nav) {
      if (
        session &&
        permission &&
        !session.grants.some((g) => g.permission === permission)
      )
        continue;
      const item = button(
        "",
        () => {
          page = id;
          renderNav();
          void refresh();
        },
        `nav-item ${page === id ? "active" : ""}`,
      );
      append(item, el("span", icon, "nav-icon"), el("span", title));
      if (page === id) item.setAttribute("aria-current", "page");
      $("navigation").append(item);
    }
  }
  function auth() {
    $("identity").textContent = "尚未验证身份";
    $("mode").textContent = "运营控制台 / 开发环境";
    $("mode").className = "";
    renderNav();
    const main = $("main");
    main.replaceChildren();
    const layout = el("div", undefined, "auth-layout"),
      copy = el("div", undefined, "auth-copy"),
      form = el("form", undefined, "auth-card");
    append(
      copy,
      el("p", "LOOP / OPERATIONS", "eyebrow"),
      el("h1", "每一次调整，\n都有据可循。"),
      el(
        "p",
        "在同一工作区管理社区审核、挖矿参数与客服处理。修改留痕，发布由独立操作员审批。",
      ),
    );
    append(
      form,
      el("h2", "验证操作员身份"),
      el(
        "p",
        "开发环境入口。使用当前 Privy 访问令牌，由服务端校验身份及授权。",
        "section-caption",
      ),
    );
    const input = el("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.required = true;
    input.id = "access-token";
    const label = el("label", "当前 Privy access token");
    label.htmlFor = input.id;
    const submit = el("button", "验证并进入", "primary");
    submit.type = "submit";
    const error = el("p", "", "error-text login-error");
    const demo = el("a", "查看本地演示 →");
    demo.href = "/ops?preview=1";
    append(
      form,
      label,
      input,
      el("div", "令牌仅存于当前页面内存，刷新或退出即清除。", "note"),
      submit,
      error,
      demo,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      sessionGeneration++;
      const loginGeneration = sessionGeneration;
      token = input.value.trim();
      input.value = "";
      submit.disabled = true;
      error.textContent = "";
      try {
        session = await api("session");
        await enter();
      } catch (failure) {
        if (loginGeneration !== sessionGeneration) return;
        token = "";
        session = null;
        error.textContent = errorText(failure);
        submit.disabled = false;
      }
    });
    append(layout, copy, form);
    main.append(layout);
    if (recoveryOperationId)
      main.append(
        el(
          "p",
          `待查询操作编号：${recoveryOperationId}。重新验证后使用「查询操作 / 任务」恢复；服务端只返回当前身份拥有的操作。`,
          "note mono",
        ),
      );
  }
  async function enter() {
    $("mode").textContent = preview
      ? "本地演示 · 数据仅保留在本页"
      : `运营控制台 / ${session.environment}`;
    $("mode").className = preview ? "demo" : "";
    $("identity").replaceChildren(
      el("span", session.label),
      button("查询操作 / 任务", recoveryDialog, "small"),
      button(
        preview ? "退出演示" : "退出",
        () => {
          token = "";
          session = null;
          data = {};
          pending = null;
          window.location.assign("/ops");
        },
        "small",
      ),
    );
    catalog = preview ? demoCatalog : (await api("catalog")).items;
    page = nav.find(
      ([, , , permission]) =>
        !permission || session.grants.some((g) => g.permission === permission),
    )[0];
    renderNav();
    await refresh();
  }
  async function load(resource, more = false) {
    const generation = (resourceGenerations[resource] =
      (resourceGenerations[resource] || 0) + 1);
    const view = viewGeneration;
    if (preview) {
      data[resource] = {
        items: clone(demoData[resource] || []).filter(
          (row) =>
            resource !== "audit" ||
            Object.entries(auditFilters).every(([key, value]) => {
              if (key === "from") return row.created_at >= value;
              if (key === "to") return row.created_at <= value;
              return (
                String(
                  row[
                    { actorId: "actor_id", configVersion: "config_version" }[
                      key
                    ] || key
                  ] || "",
                ) === value
              );
            }),
        ),
        nextCursor: null,
      };
      return;
    }
    const cursor = more ? data[resource]?.nextCursor : null;
    const query = new URLSearchParams(resource === "audit" ? auditFilters : {});
    if (cursor) query.set("before", cursor);
    const result = await api(
      `resources/${resource}${query.size ? `?${query.toString()}` : ""}`,
    );
    if (generation !== resourceGenerations[resource] || view !== viewGeneration)
      return;
    data[resource] = {
      ...result,
      items: more
        ? [...(data[resource]?.items || []), ...result.items]
        : result.items,
    };
  }
  async function loadVersionWeights(version) {
    const rows = [];
    let cursor = null;
    do {
      const result = preview
        ? {
            items: clone(
              demoData.weights.filter((w) => w.config_version === version),
            ),
            configVersion: version,
            nextCursor: null,
          }
        : await api(
            `resources/weights?configVersion=${encodeURIComponent(version)}${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
          );
      if (result.configVersion !== version)
        throw Object.assign(new Error("OPS_WEIGHT_VERSION_MISMATCH"), {
          code: "OPS_WEIGHT_VERSION_MISMATCH",
        });
      rows.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);
    const result = {
      items: rows,
      configVersion: version,
      nextCursor: null,
      complete: rows.every(
        (row) =>
          row.config_version === version &&
          Boolean(row.bound_asset_id || row.approved_asset_id),
      ),
    };
    versionWeights[version] = result;
    return result;
  }
  async function refresh() {
    if (!session) return auth();
    const view = ++viewGeneration;
    loading = true;
    closeDrawer();
    if (["mining", "drafts", "snapshots"].includes(page)) versionWeights = {};
    render();
    try {
      const resources = ["mining", "drafts", "snapshots"].includes(page)
        ? ["mining", "drafts", ...(page === "snapshots" ? ["snapshots"] : [])]
        : page === "catalog"
          ? []
          : [page];
      await Promise.all(resources.map((resource) => load(resource)));
      if (view !== viewGeneration) return;
      if (resources.includes("mining") && active()) {
        delete versionWeights[active().config_version];
        const weights = await loadVersionWeights(active().config_version);
        if (view !== viewGeneration) return;
        data.weights = weights;
      }
    } catch (error) {
      if (view !== viewGeneration) return;
      toast(errorText(error));
    }
    if (view !== viewGeneration) return;
    loading = false;
    render();
  }
  const items = (resource) => data[resource]?.items || [];
  const active = () => items("mining").find((row) => row.status === "approved");
  function heading(title, description, actions = []) {
    const head = el("div", undefined, "page-head");
    append(
      head,
      append(
        el("div"),
        el("p", "WORKSPACE / DEVELOPMENT", "eyebrow"),
        el("h1", title),
        el("p", description),
      ),
      append(el("div", undefined, "actions"), ...actions),
    );
    return head;
  }
  function metric(label, value, foot) {
    return append(
      el("div", undefined, "metric"),
      el("div", label, "label"),
      el("div", value, "value"),
      el("div", foot, "foot"),
    );
  }
  function table(title, headers, rows, resource) {
    const panel = el("section", undefined, "panel"),
      t = el("table"),
      tr = el("tr"),
      body = el("tbody");
    headers.forEach((h) => tr.append(el("th", h)));
    append(t, append(el("thead"), tr), body);
    rows.forEach((cells) => {
      const row = el("tr");
      cells.forEach((cell) =>
        row.append(
          append(
            el("td"),
            typeof cell === "object" ? cell : el("span", String(cell ?? "—")),
          ),
        ),
      );
      body.append(row);
    });
    append(
      panel,
      append(
        el("div", undefined, "panel-head"),
        el("h3", title),
        el("span", `${rows.length} 条已加载`),
      ),
      rows.length
        ? append(el("div", undefined, "table-scroll"), t)
        : el(
            "div",
            loading
              ? "正在读取…"
              : "暂无记录。使用右上角操作开始，或刷新读取最新状态。",
            "empty",
          ),
    );
    if (data[resource]?.nextCursor)
      panel.append(
        button(
          "加载更多",
          async () => {
            try {
              await load(resource, true);
              render();
            } catch (error) {
              toast(errorText(error));
            }
          },
          "load-more",
        ),
      );
    return panel;
  }
  function identityCell(title, subtitle) {
    return append(
      el("div"),
      el("strong", title),
      el("span", subtitle, "subline mono"),
    );
  }
  function render() {
    if (!session) return;
    const main = $("main");
    main.replaceChildren();
    if (pending) main.append(pendingPanel());
    const reload = button(
      loading ? "读取中…" : "↻ 刷新",
      () => void refresh(),
      "",
      loading,
    );
    if (page === "mining" || page === "drafts") {
      const current = active();
      main.append(
        heading(
          page === "mining" ? "挖矿配置" : "草稿与审批",
          "资产权重与社区系数分别管理，发布完整版本后再生成快照。",
          [
            reload,
            button(
              "＋ 新建配置草稿",
              () => editDraft(),
              "primary",
              !can("mining.edit") ||
                !current ||
                loading ||
                !completeVersion(current),
            ),
          ],
        ),
      );
      append(
        main,
        append(
          el("div", undefined, "metrics"),
          metric(
            "当前生效版本",
            current ? short(current.config_version) : "未配置",
            "旧版本与历史快照保留",
          ),
          metric(
            "待独立审批",
            String(items("drafts").filter((r) => r.state === "review").length),
            "当前已加载记录",
          ),
          metric(
            "已载入绑定社区",
            String(items("weights").length),
            "按版本冻结资产与系数",
          ),
        ),
      );
      const strip = el("div", undefined, "version-strip");
      append(
        strip,
        append(
          el("div"),
          el("p", "ACTIVE CONFIGURATION", "eyebrow"),
          el("strong", current?.config_version || "尚无生效版本"),
          el("p", "开发基线 / 不代表可领取奖励或生产经济模型"),
        ),
        el("div", "草稿 → 独立审批 → 发布 → 快照", "flow"),
      );
      main.append(strip);
      if (!current)
        main.append(
          el(
            "p",
            "当前没有可复制的生效版本。先由部署管理员建立经过验证的开发基线，再创建配置草稿。",
            "note warning",
          ),
        );
      main.append(
        table(
          "配置草稿",
          ["版本 / 草稿编号", "状态", "修订", "更新时间", "操作"],
          items("drafts").map((r) => [
            identityCell(r.package.configVersion, r.id),
            badge(r.state),
            `R${r.revision}`,
            time(r.updated_at),
            button("查看详情 →", () => draftDetail(r), "link"),
          ]),
          "drafts",
        ),
      );
      if (page === "mining")
        main.append(
          table(
            "公式版本",
            ["版本", "状态", "资产权重项", "社区范围", "操作"],
            items("mining").map((r) => [
              identityCell(r.config_version, r.formula?.scope || "未声明范围"),
              badge(r.status),
              String(Object.keys(r.formula?.assetWeights || {}).length),
              r.weight_range?.community?.range
                ? `${r.weight_range.community.range.min} – ${r.weight_range.community.range.max}`
                : "未配置",
              button("参数详情", () => versionDetail(r), "link"),
            ]),
            "mining",
          ),
        );
    } else if (page === "snapshots") {
      main.append(
        heading(
          "快照记录",
          "保存计算版本、区块与结果；任务入队后需要明确执行。",
          [
            reload,
            button(
              "生成快照",
              () =>
                commandDialog(
                  "创建快照任务",
                  "mining.snapshot",
                  active()?.config_version,
                  { expectedActiveVersion: active()?.config_version },
                ),
              "primary",
              !can("mining.snapshot") || !active(),
            ),
          ],
        ),
      );
      main.append(
        table(
          "计算历史",
          ["快照 / 区块", "公式版本", "状态", "计算时间", "操作"],
          items("snapshots").map((r) => [
            identityCell(short(r.snapshot_id), `Block ${r.block_number}`),
            r.formula_version,
            badge(r.status),
            time(r.computed_at),
            button("查看详情", () => snapshotDetail(r), "link"),
          ]),
          "snapshots",
        ),
      );
    } else if (
      page === "communities" ||
      page === "support" ||
      page === "audit"
    ) {
      const isCommunity = page === "communities",
        isSupport = page === "support";
      main.append(
        heading(
          isCommunity ? "社区审核" : isSupport ? "客服工单" : "操作记录",
          isCommunity
            ? "仅展示授权范围内的社区。审核理由与记录版本共同留存。"
            : isSupport
              ? "回复写入用户工单记录；通知投递结果独立呈现。"
              : "按操作编号追踪结果。未知结果先查询，再决定是否重试。",
          [
            reload,
            ...(page === "audit"
              ? [button("查询操作 / 任务", recoveryDialog)]
              : []),
          ],
        ),
      );
      if (page === "audit") main.append(auditFilterPanel());
      const filter = el("input");
      filter.placeholder = "筛选已加载记录";
      filter.setAttribute("aria-label", "筛选已加载记录");
      const container = el("div");
      main.append(
        append(
          el("div", undefined, "toolbar"),
          filter,
          el("span", "仅筛选当前已加载的数据", "filter-count"),
        ),
        container,
      );
      const draw = () => {
        const rows = items(page).filter((row) =>
          JSON.stringify(row)
            .toLowerCase()
            .includes(filter.value.toLowerCase()),
        );
        container.replaceChildren(
          isCommunity
            ? table(
                "社区申请",
                ["社区 / 绑定资产", "状态", "记录版本", "操作"],
                rows.map((r) => [
                  identityCell(r.name, r.bound_asset_key || "尚未绑定资产"),
                  badge(r.verification_status),
                  `V${r.record_version}`,
                  button("审核详情", () => communityDetail(r), "link"),
                ]),
                page,
              )
            : isSupport
              ? table(
                  "工单目录",
                  ["工单 / 内容", "分类", "状态", "更新时间", "操作"],
                  rows.map((r) => [
                    identityCell(short(r.ticket_id), r.body),
                    r.category,
                    badge(r.status),
                    time(r.updated_at),
                    button("处理工单", () => supportDetail(r), "link"),
                  ]),
                  page,
                )
              : table(
                  "审计流水",
                  [
                    "动作 / 操作编号",
                    "对象 / 操作人或来源",
                    "结果",
                    "理由",
                    "时间",
                    "操作",
                  ],
                  rows.map((r) => [
                    identityCell(r.action, r.operation_id),
                    identityCell(
                      short(r.target),
                      r.source === "deployment_cli"
                        ? "部署管理员 CLI"
                        : r.actor_id,
                    ),
                    badge(r.outcome),
                    r.reason,
                    time(r.created_at),
                    button("审计详情", () => auditDetail(r), "link"),
                  ]),
                  page,
                ),
        );
      };
      filter.addEventListener("input", draw);
      draw();
    } else {
      main.append(
        heading(
          "运营能力清单",
          "可用性来自服务端目录。尚未接通的模块保留真实边界。",
          [reload],
        ),
      );
      main.append(
        table(
          "模块与消费入口",
          ["模块", "配置 / 操作", "当前状态", "消费入口"],
          catalog.map((r) => [
            r.module,
            r.name,
            r.entry
              ? button(
                  labels[r.status] || r.status,
                  () => {
                    page = r.entry;
                    renderNav();
                    void refresh();
                  },
                  "link",
                  !nav.some(
                    ([id, , , p]) =>
                      id === r.entry &&
                      (!p || session.grants.some((g) => g.permission === p)),
                  ),
                )
              : badge(r.status),
            r.consumer,
          ]),
          "catalog",
        ),
      );
    }
  }
  function auditDetail(row) {
    const body = showDrawer("审计详情");
    detailList(body, [
      ["动作", row.action],
      ["对象", row.target],
      [
        "来源",
        row.source === "deployment_cli"
          ? "部署管理员 CLI（deployment_cli）"
          : "运营 API",
      ],
      [
        "操作人",
        row.source === "deployment_cli"
          ? "终端人类身份未记录，请查部署访问日志"
          : row.actor_id,
      ],
      ["理由", row.reason],
      ["结果", labels[row.outcome] || row.outcome],
    ]);
    if (row.source === "deployment_cli") {
      jsonDetails(
        body,
        "变更前授权",
        row.before_state ?? "历史授权状态未知",
        true,
      );
      jsonDetails(
        body,
        "变更后授权",
        row.after_state ?? "历史授权状态未知",
        true,
      );
    }
  }
  function auditFilterPanel() {
    const panel = el("details", undefined, "note");
    panel.open = Object.keys(auditFilters).length > 0;
    panel.append(
      el("summary", "查询全部操作记录 · 操作人 / 对象 / 版本 / 时间"),
    );
    const form = el("form"),
      fields = el("div", undefined, "grid-two"),
      inputs = {};
    for (const [key, label] of [
      ["actorId", "操作人 UUID"],
      ["target", "操作对象"],
      ["action", "动作名称"],
      ["configVersion", "配置版本"],
      ["from", "开始时间"],
      ["to", "结束时间"],
    ]) {
      const input = field(fields, label, auditFilters[key] || "", {
        required: false,
      });
      if (key === "from" || key === "to") {
        input.type = "datetime-local";
        if (auditFilters[key]) {
          const date = new Date(auditFilters[key]);
          input.value = new Date(
            date.getTime() - date.getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16);
        }
      }
      inputs[key] = input;
    }
    const status = el("select");
    status.id = `outcome-${uuid()}`;
    const label = el("label", "操作结果");
    label.htmlFor = status.id;
    for (const [value, text] of [
      ["", "全部结果"],
      ["succeeded", "成功"],
      ["rejected", "拒绝"],
      ["unknown", "未知"],
    ]) {
      const option = el("option", text);
      option.value = value;
      status.append(option);
    }
    status.value = auditFilters.outcome || "";
    const submit = el("button", "查询全部记录", "primary");
    submit.type = "submit";
    const error = el("p", "", "error-text");
    append(
      form,
      fields,
      label,
      status,
      error,
      append(
        el("div", undefined, "actions"),
        submit,
        button("清空筛选", () => {
          auditFilters = {};
          void refresh();
        }),
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const next = {};
      for (const [key, input] of Object.entries(inputs)) {
        if (input.value.trim())
          next[key] = ["from", "to"].includes(key)
            ? new Date(input.value).toISOString()
            : input.value.trim();
      }
      if (next.from && next.to && next.from > next.to) {
        error.textContent = "开始时间不能晚于结束时间。";
        return;
      }
      if (status.value) next.outcome = status.value;
      auditFilters = next;
      delete data.audit;
      void refresh();
    });
    panel.append(form);
    return panel;
  }
  function detailList(parent, pairs) {
    const dl = el("dl", undefined, "details-list");
    pairs.forEach(([key, value]) =>
      append(dl, el("dt", key), el("dd", String(value ?? "—"))),
    );
    parent.append(dl);
  }
  function jsonDetails(parent, title, value, open = false) {
    const d = el("details");
    d.open = open;
    append(d, el("summary", title), el("pre", JSON.stringify(value, null, 2)));
    parent.append(d);
  }
  function completeVersion(row) {
    return Boolean(
      row &&
      row.community_weight_history_status === "versioned" &&
      versionWeights[row.config_version]?.complete,
    );
  }
  function packageFromVersion(row) {
    if (!completeVersion(row)) return null;
    return {
      configVersion: row.config_version,
      formula: clone(row.formula),
      weightRange: clone(row.weight_range),
      priceGuardRules: clone(row.price_guard_rules),
      communityWeights: versionWeights[row.config_version].items
        .filter(
          (w) => w.config_version === row.config_version && w.weight !== null,
        )
        .map((w) => ({
          communityId: w.community_id,
          weight: w.weight,
          boundAssetId: w.bound_asset_id || w.approved_asset_id,
        })),
    };
  }
  async function versionDetail(row) {
    const body = showDrawer("公式版本详情");
    const generation = drawerGeneration;
    detailList(body, [
      ["版本", row.config_version],
      ["状态", labels[row.status]],
      ["创建时间", time(row.created_at)],
    ]);
    try {
      await loadVersionWeights(row.config_version);
      if (!drawerCurrent(generation)) return;
      if (!completeVersion(row))
        body.append(
          el(
            "p",
            "此版本历史社区输入标记为 legacy_unknown，无法证明完整历史，不可作为完整配置包复制。",
            "note warning",
          ),
        );
      jsonDetails(
        body,
        "该版本公式及冻结社区系数",
        packageFromVersion(row) || {
          formula: row.formula,
          weightRange: row.weight_range,
          priceGuardRules: row.price_guard_rules,
          observedWeights: versionWeights[row.config_version].items,
          historyStatus: row.community_weight_history_status,
        },
        true,
      );
      if (row.status === "approved")
        body.append(
          button(
            "以此版本创建草稿",
            () => editDraft(),
            "primary",
            !can("mining.edit") || !completeVersion(row),
          ),
        );
    } catch (error) {
      if (drawerCurrent(generation))
        body.append(el("p", errorText(error), "error-text"));
    }
  }
  function draftDetail(row) {
    const body = showDrawer("配置草稿详情"),
      current = active();
    detailList(body, [
      ["配置版本", row.package.configVersion],
      ["状态 / 修订", `${labels[row.state]} / R${row.revision}`],
      ["内容指纹", row.content_hash],
      ["当前生效版本", current?.config_version || "无"],
      ["变更理由", row.reason],
      [
        "影响范围",
        `${Object.keys(row.package.formula.assetWeights).length} 项资产 / ${row.package.communityWeights.length} 个社区`,
      ],
    ]);
    if (current && completeVersion(current)) {
      const changes = [];
      const walk = (before, after, path) => {
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        if (Array.isArray(before) && Array.isArray(after)) {
          const keyed = (rows) =>
            Object.fromEntries(
              rows.map((item, index) => [
                item?.communityId || item?.ruleKey || index,
                item,
              ]),
            );
          walk(keyed(before), keyed(after), path);
          return;
        }
        if (
          before &&
          after &&
          typeof before === "object" &&
          typeof after === "object" &&
          !Array.isArray(before) &&
          !Array.isArray(after)
        ) {
          for (const key of new Set([
            ...Object.keys(before),
            ...Object.keys(after),
          ]))
            walk(before[key], after[key], path ? `${path}.${key}` : key);
        } else
          changes.push([
            path,
            `${before === undefined ? "未配置" : JSON.stringify(before)} → ${after === undefined ? "移除" : JSON.stringify(after)}`,
          ]);
      };
      walk(packageFromVersion(current), row.package, "");
      body.append(el("h3", `与生效版本的差异 · ${changes.length} 项`));
      detailList(body, changes);
    }
    if (current && !completeVersion(current))
      body.append(
        el(
          "p",
          "当前生效版本的完整冻结输入不可用，暂不能核对完整差异或批准。请刷新重试，历史来源不完整时联系管理员。",
          "note warning",
        ),
      );
    jsonDetails(body, "待发布完整内容", row.package);
    jsonDetails(
      body,
      "当前版本对照",
      current ? packageFromVersion(current) : null,
    );
    const self = row.contributors?.includes(session.actorId);
    if (self)
      body.append(
        el(
          "p",
          "你参与了此版本编辑，需由其他已授权操作员审批。",
          "note warning",
        ),
      );
    body.append(
      el(
        "p",
        "批准后立即替换生效版本；旧快照保留并可能变为过期。未配置实际奖励预算，不能据此承诺收益。",
        "note",
      ),
    );
    const actions = el("div", undefined, "drawer-actions");
    if (row.state !== "published")
      append(
        actions,
        button("修订草稿", () => editDraft(row), "", !can("mining.edit")),
        button(
          "创建试算任务",
          () =>
            commandDialog("创建试算任务", "mining.trial", row.id, {
              expectedRevision: row.revision,
              contentHash: row.content_hash,
            }),
          "",
          !can("mining.edit"),
        ),
      );
    if (row.state === "draft")
      actions.append(
        button(
          "提交独立审批",
          () =>
            commandDialog("提交独立审批", "mining.submit", row.id, {
              expectedRevision: row.revision,
            }),
          "primary",
          !can("mining.edit"),
        ),
      );
    if (row.state === "review")
      actions.append(
        button(
          "批准并立即发布",
          () =>
            commandDialog("批准并立即发布", "mining.publish", row.id, {
              expectedRevision: row.revision,
              contentHash: row.content_hash,
              expectedActiveVersion: current?.config_version || null,
            }),
          "primary",
          !can("mining.approve") ||
            self ||
            loading ||
            Boolean(current && !completeVersion(current)),
        ),
      );
    body.append(actions);
  }
  function field(parent, title, value, options = {}) {
    const wrapper = el("div", undefined, "field"),
      input = el(options.multiline ? "textarea" : "input"),
      label = el("label", title);
    input.id = `field-${uuid()}`;
    label.htmlFor = input.id;
    input.value = value || "";
    input.required = options.required !== false;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.code) input.className = "code-editor";
    if (options.readonly) input.readOnly = true;
    append(wrapper, label, input);
    parent.append(wrapper);
    return input;
  }
  function editDraft(row) {
    if (!row && (loading || !completeVersion(active())))
      return toast("社区系数尚未全部加载，请刷新后重试。");
    const source = row
      ? clone(row.package)
      : active()
        ? packageFromVersion(active())
        : null;
    if (!source) return;
    const body = showDrawer(row ? "修订配置草稿" : "新建配置草稿"),
      form = el("form");
    body.append(form);
    form.append(
      el(
        "p",
        "系数使用精确十进制字符串。保留基线原有公式、价格规则与占位预算；每次修订都会使旧审批失效。",
        "note",
      ),
    );
    const grid = el("div", undefined, "grid-two");
    form.append(grid);
    const version = field(grid, "新配置版本", row ? source.configVersion : "", {
      placeholder: "例如 dev-2026-10-v2",
    });
    const reason = field(grid, "修改理由", row?.reason || "", {
      placeholder: "填写调整依据",
    });
    reason.maxLength = 500;
    const range = el("div", undefined, "grid-two");
    form.append(range);
    const min = field(
      range,
      "社区系数下限",
      source.weightRange.community.range?.min || "",
    );
    const max = field(
      range,
      "社区系数上限",
      source.weightRange.community.range?.max || "",
    );
    const assetsSection = el("section", undefined, "editor-section");
    append(
      assetsSection,
      el("h3", "资产权重"),
      el("p", "使用 canonical assetId；资产权重与社区系数是不同因子。"),
    );
    form.append(assetsSection);
    const assets = el("div"),
      assetRows = [];
    assetsSection.append(assets);
    const addAsset = (id = "", weight = "") => {
      const wrap = el("div", undefined, "coefficient-row"),
        key = el("input"),
        value = el("input");
      key.value = id;
      key.placeholder = "eip155:56:0x…";
      key.setAttribute("aria-label", "资产 ID");
      value.value = weight;
      value.placeholder = "权重";
      value.setAttribute("aria-label", "资产权重");
      key.required = value.required = true;
      const record = { key, value, wrap };
      assetRows.push(record);
      append(
        wrap,
        key,
        value,
        button(
          "×",
          () => {
            assetRows.splice(assetRows.indexOf(record), 1);
            wrap.remove();
          },
          "small",
        ),
      );
      assets.append(wrap);
    };
    Object.entries(source.formula.assetWeights).forEach(([id, weight]) =>
      addAsset(id, weight),
    );
    assetsSection.append(button("＋ 添加资产", () => addAsset(), "small"));
    const communitySection = el("section", undefined, "editor-section");
    append(
      communitySection,
      el("h3", "社区系数与冻结资产"),
      el(
        "p",
        "资产绑定随草稿一起审核；发布时绑定发生变化会被拒绝。系数组合由服务端算力引擎计算。",
      ),
    );
    form.append(communitySection);
    const communities = el("div"),
      communityRows = [];
    communitySection.append(communities);
    const addCommunity = (value = {}) => {
      const wrap = el("div", undefined, "note"),
        rowFields = el("div", undefined, "grid-two");
      const id = field(rowFields, "社区 UUID", value.communityId || ""),
        weight = field(rowFields, "社区系数", value.weight || "");
      wrap.append(rowFields);
      const binding = field(wrap, "冻结绑定资产 ID", value.boundAssetId || "", {
        placeholder: "选择社区后从当前记录填写",
      });
      id.addEventListener("change", () => {
        const existing = items("weights").find(
          (w) => w.community_id === id.value.trim(),
        );
        if (existing) binding.value = existing.bound_asset_key || "";
      });
      const record = { id, weight, binding };
      communityRows.push(record);
      wrap.append(
        button(
          "移除此社区",
          () => {
            communityRows.splice(communityRows.indexOf(record), 1);
            wrap.remove();
          },
          "small danger",
        ),
      );
      communities.append(wrap);
    };
    source.communityWeights.forEach(addCommunity);
    communitySection.append(
      button("＋ 添加社区系数", () => addCommunity(), "small"),
    );
    const advanced = el("details");
    append(
      advanced,
      el("summary", "公式与价格规则 · 高级字段"),
      el(
        "p",
        "以下完整字段将保留；资产权重和范围使用上方表单。guardBps 为 1–10000 整数。",
        "section-caption",
      ),
    );
    form.append(advanced);
    const formula = field(
      advanced,
      "完整公式 JSON",
      JSON.stringify(source.formula, null, 2),
      { multiline: true, code: true },
    );
    const weightRange = field(
      advanced,
      "完整权重规则 JSON",
      JSON.stringify(source.weightRange, null, 2),
      { multiline: true, code: true },
    );
    const guards = field(
      advanced,
      "价格保护规则 JSON",
      JSON.stringify(source.priceGuardRules, null, 2),
      { multiline: true, code: true },
    );
    const error = el("p", "", "error-text"),
      submit = el("button", row ? "保存修订" : "保存草稿", "primary");
    submit.type = "submit";
    append(form, error, append(el("div", undefined, "drawer-actions"), submit));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const f = JSON.parse(formula.value),
          wr = JSON.parse(weightRange.value),
          weights = {};
        for (const asset of assetRows) {
          const id = asset.key.value.trim();
          if (Object.hasOwn(weights, id)) throw new Error("资产 ID 不可重复");
          weights[id] = asset.value.value.trim();
        }
        f.assetWeights = weights;
        wr.community.range = { min: min.value.trim(), max: max.value.trim() };
        const pkg = {
          configVersion: version.value.trim(),
          formula: f,
          weightRange: wr,
          priceGuardRules: JSON.parse(guards.value),
          communityWeights: communityRows.map((r) => ({
            communityId: r.id.value.trim(),
            weight: r.weight.value.trim(),
            boundAssetId: r.binding.value.trim(),
          })),
        };
        submit.disabled = true;
        await startCommand(
          row ? "mining.revise" : "mining.create",
          row?.id || uuid(),
          row ? { expectedRevision: row.revision, package: pkg } : pkg,
          reason.value.trim(),
        );
      } catch (failure) {
        error.textContent = failure.code
          ? errorText(failure)
          : `无法保存：${failure.message}`;
      } finally {
        submit.disabled = false;
      }
    });
  }
  function commandDialog(title, action, target, payload) {
    const body = showDrawer(title);
    detailList(body, [
      ["目标", target],
      ["动作", action],
      ["环境", preview ? "本地演示" : session.environment],
    ]);
    jsonDetails(body, "确认参数", payload, true);
    const form = el("form"),
      reason = field(form, "操作理由", "", { multiline: true });
    reason.maxLength = 500;
    const submit = el("button", title, "primary");
    submit.type = "submit";
    const error = el("p", "", "error-text");
    append(form, error, append(el("div", undefined, "drawer-actions"), submit));
    body.append(form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await startCommand(action, target, payload, reason.value.trim());
      } catch (failure) {
        error.textContent = errorText(failure);
      } finally {
        submit.disabled = false;
      }
    });
  }
  function communityDetail(row) {
    const body = showDrawer(row.name);
    detailList(body, [
      ["社区 ID", row.community_id],
      ["当前状态", labels[row.verification_status] || row.verification_status],
      ["绑定资产", row.bound_asset_key],
      ["记录版本", row.record_version],
      ["拒绝理由", row.rejected_reason],
    ]);
    jsonDetails(body, "原始记录", row);
    append(
      body,
      append(
        el("div", undefined, "drawer-actions"),
        button(
          "通过审核",
          () =>
            commandDialog(
              "通过社区审核",
              "community.review",
              row.community_id,
              { outcome: "verified", expectedVersion: row.record_version },
            ),
          "primary",
          !can("community.review", row.community_id) ||
            row.verification_status === "verified",
        ),
        button(
          "拒绝并记录理由",
          () =>
            commandDialog(
              "拒绝社区申请",
              "community.review",
              row.community_id,
              { outcome: "rejected", expectedVersion: row.record_version },
            ),
          "danger",
          !can("community.review", row.community_id) ||
            row.verification_status === "rejected",
        ),
      ),
    );
  }
  function supportDetail(row) {
    const body = showDrawer("处理客服工单");
    detailList(body, [
      ["工单", row.ticket_id],
      ["分类 / 状态", `${row.category} / ${labels[row.status]}`],
      ["内容", row.body],
    ]);
    if (row.status === "closed") return;
    const form = el("form"),
      note = field(form, "回复内容 / 关闭说明", "", { multiline: true });
    note.maxLength = 4000;
    const reason = field(form, "操作理由", "");
    reason.maxLength = 500;
    const status = el("select");
    status.setAttribute("aria-label", "处理方式");
    for (const [v, text] of [
      ["answered", "回复工单"],
      ["closed", "关闭工单"],
    ]) {
      const option = el("option", text);
      option.value = v;
      status.append(option);
    }
    const submit = el("button", "保存处理结果", "primary");
    submit.type = "submit";
    submit.disabled = !can("support.manage");
    const error = el("p", "", "error-text");
    append(
      form,
      status,
      error,
      append(el("div", undefined, "drawer-actions"), submit),
    );
    body.append(form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await startCommand(
          "support.answer",
          row.ticket_id,
          { status: status.value, note: note.value.trim() },
          reason.value.trim(),
        );
      } catch (failure) {
        error.textContent = errorText(failure);
      } finally {
        submit.disabled = false;
      }
    });
  }
  function snapshotDetail(row) {
    const body = showDrawer("快照详情");
    jsonDetails(body, "计算记录", row, true);
    if (row.status !== "invalidated")
      body.append(
        button(
          "撤回此快照",
          () =>
            commandDialog("撤回快照", "mining.invalidate", row.snapshot_id, {
              snapshotIds: [row.snapshot_id],
            }),
          "danger",
          !can("mining.snapshot"),
        ),
      );
  }
  async function startCommand(action, target, payload, reason) {
    if (pending) {
      const error = new Error("先处理未确认操作");
      error.code = "OPS_PENDING_OPERATION";
      throw error;
    }
    pending = {
      command: {
        operationId: uuid(),
        action,
        target,
        reason,
        payload: clone(payload),
      },
      generation: sessionGeneration,
      status: "sending",
      checkedMissing: false,
    };
    render();
    return sendPending();
  }
  async function sendPending() {
    const retained = pending;
    if (!retained || retained.status === "sending-retry") return;
    retained.status = "sending-retry";
    render();
    try {
      const response = preview
        ? demoCommand(retained.command)
        : await api("commands", retained.command);
      pending = null;
      closeDrawer();
      toast("操作已确认并记录");
      await refresh();
      if (response.result?.jobId) await jobDetail(response.result.jobId);
    } catch (error) {
      if (retained.generation !== sessionGeneration) throw error;
      retained.status = "unknown";
      retained.error = errorText(error);
      retained.definitiveFailure = [400, 403, 409, 422].includes(error.status);
      pending = retained;
      render();
      throw error;
    }
  }
  function pendingPanel() {
    const box = el("section", undefined, "pending-box");
    append(
      box,
      el(
        "h3",
        pending.status.startsWith("sending")
          ? "操作正在提交"
          : "有一项操作等待确认",
      ),
      el("p", `操作编号：${pending.command.operationId}`, "mono"),
      el("p", pending.error || "请等待服务端结果。此操作始终使用同一个编号。"),
    );
    if (!pending.status.startsWith("sending"))
      append(
        box,
        append(
          el("div", undefined, "actions"),
          button("查询此操作结果", () => void reconcile()),
          button(
            "使用原编号与内容重试",
            () => void sendPending().catch((error) => toast(errorText(error))),
            "",
            !pending.checkedMissing,
          ),
          button(
            "结束已拒绝的尝试",
            () => {
              pending = null;
              render();
            },
            "",
            !pending.checkedMissing || !pending.definitiveFailure,
          ),
        ),
      );
    return box;
  }
  async function reconcile() {
    if (!pending) return;
    const retained = pending;
    try {
      const response = preview
        ? demoOperations.get(retained.command.operationId)
        : await api(`operations/${retained.command.operationId}`);
      if (!response)
        throw Object.assign(new Error("not found"), { code: "OPS_NOT_FOUND" });
      pending = null;
      closeDrawer();
      toast("已从操作记录恢复结果");
      await refresh();
      if (response.result?.jobId) await jobDetail(response.result.jobId);
    } catch (error) {
      if (retained.generation !== sessionGeneration) return;
      retained.checkedMissing = error.code === "OPS_NOT_FOUND";
      retained.error = `${errorText(error)}${retained.checkedMissing ? " 可使用原编号和原内容重试。" : ""}`;
      render();
    }
  }
  function recoveryDialog() {
    const body = showDrawer("查询已有操作或任务");
    const generation = drawerGeneration;
    body.append(
      el(
        "p",
        "填写之前保留的编号。刷新页面会清除令牌与未提交表单，不会撤销服务端操作。",
        "note",
      ),
    );
    const id = field(body, "操作 / 任务 UUID", recoveryOperationId || "");
    append(
      body,
      append(
        el("div", undefined, "actions"),
        button("查询操作", async () => {
          try {
            const result = preview
              ? demoOperations.get(id.value.trim())
              : await api(`operations/${encodeURIComponent(id.value.trim())}`);
            if (!drawerCurrent(generation)) return;
            if (!result) return toast("本地演示中没有此操作");
            jsonDetails(body, "操作结果", result, true);
            if (result.result?.jobId)
              body.append(
                button(
                  "查看关联任务",
                  () => void jobDetail(result.result.jobId),
                ),
              );
          } catch (error) {
            toast(errorText(error));
          }
        }),
        button("查询任务", () => void jobDetail(id.value.trim())),
      ),
    );
  }
  async function jobDetail(id) {
    const body = showDrawer("计算任务详情");
    const generation = drawerGeneration;
    body.append(el("p", "正在读取任务…"));
    try {
      const row = preview
        ? demoJobs.get(id)
        : await api(`jobs/${encodeURIComponent(id)}`);
      if (!drawerCurrent(generation)) return;
      if (!row) return toast("未找到本地演示任务");
      body.replaceChildren();
      detailList(body, [
        ["任务编号", id],
        ["状态", labels[row.state] || row.state],
        ["动作", row.action],
        ["执行次数", row.attempts || 0],
      ]);
      jsonDetails(
        body,
        "真实任务结果",
        row.result || { state: row.state },
        true,
      );
      jsonDetails(
        body,
        "输入指纹与执行证据",
        {
          inputHash: row.input_hash || row.inputHash || null,
          evidence: row.evidence || null,
        },
        true,
      );
      append(
        body,
        el(
          "p",
          preview
            ? "演示任务不会运行算力引擎。"
            : "执行前服务端重新检查授权及版本；缺少计算依赖时保持未执行状态。",
          "note",
        ),
        append(
          el("div", undefined, "drawer-actions"),
          button("刷新状态", () => void jobDetail(id)),
          button(
            "执行此任务",
            async () => {
              try {
                if (preview) {
                  row.state = "held";
                  row.result = { code: "LOCAL_DEMO_NO_COMPUTE" };
                } else await api(`jobs/${encodeURIComponent(id)}/run`, {});
                if (drawerCurrent(generation)) await jobDetail(id);
              } catch (error) {
                toast(errorText(error));
                if (drawerCurrent(generation)) await jobDetail(id);
              }
            },
            "primary",
            row.state !== "queued",
          ),
        ),
      );
    } catch (error) {
      toast(errorText(error));
    }
  }
  const A = "eip155:56:native",
    B = "eip155:56:0x1111111111111111111111111111111111111111",
    C = "eip155:56:0x2222222222222222222222222222222222222222";
  const c1 = "10000000-0000-4000-8000-000000000001",
    c2 = "10000000-0000-4000-8000-000000000002";
  const demoActor = "90000000-0000-4000-8000-000000000001",
    otherActor = "90000000-0000-4000-8000-000000000002",
    date = "2026-10-03T02:30:00Z";
  const demoPackage = {
    configVersion: "dev-baseline-v3",
    formula: {
      kind: "holding_times_reference_price_times_weight",
      expressionKey: "mining.formula.holdingWeighted",
      dailyOutputKey: "mining.rules.dailyOutput",
      scope: "development_baseline",
      assetWeights: { [A]: "1", [B]: "1", [C]: "0.8" },
      referralBoost: { status: "pending_approval" },
      dailyOutput: {
        status: "development_placeholder",
        budget: "1000",
        unitKey: "mining.rules.dailyOutput.unit.loopTokenPending",
      },
    },
    weightRange: {
      loop: { status: "approved", descriptionKey: "mining.weight.loop" },
      community: {
        status: "approved",
        descriptionKey: "mining.weight.community",
        range: { min: "0.5", max: "2" },
      },
      reviewFactorKeys: [],
    },
    priceGuardRules: [],
    communityWeights: [
      { communityId: c1, boundAssetId: B, weight: "1.2" },
      { communityId: c2, boundAssetId: C, weight: "0.8" },
    ],
  };
  const nextPackage = clone(demoPackage);
  nextPackage.configVersion = "dev-community-v4";
  nextPackage.communityWeights[0].weight = "1.4";
  const demoData = {
    mining: [
      {
        config_version: demoPackage.configVersion,
        community_weight_history_status: "versioned",
        formula: demoPackage.formula,
        weight_range: demoPackage.weightRange,
        price_guard_rules: demoPackage.priceGuardRules,
        status: "approved",
        created_at: date,
      },
      {
        config_version: "dev-baseline-v2",
        community_weight_history_status: "legacy_unknown",
        formula: demoPackage.formula,
        weight_range: demoPackage.weightRange,
        price_guard_rules: [],
        status: "retired",
        created_at: "2026-09-29T02:00:00Z",
      },
    ],
    drafts: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        package: nextPackage,
        state: "review",
        revision: 2,
        content_hash: "a".repeat(64),
        contributors: [otherActor],
        reason: "按社区审核依据调整开发系数，供独立审批检查",
        updated_at: date,
      },
      {
        id: "20000000-0000-4000-8000-000000000002",
        package: { ...clone(demoPackage), configVersion: "dev-price-v5" },
        state: "draft",
        revision: 1,
        content_hash: "b".repeat(64),
        contributors: [demoActor],
        reason: "开发环境参数复核",
        updated_at: date,
      },
    ],
    weights: [
      {
        community_id: c1,
        name: "LOOP Builders",
        bound_asset_key: B,
        approved_asset_id: B,
        weight: "1.2",
        config_version: demoPackage.configVersion,
      },
      {
        community_id: c2,
        name: "链上研究社",
        bound_asset_key: C,
        approved_asset_id: C,
        weight: "0.8",
        config_version: demoPackage.configVersion,
      },
    ],
    communities: [
      {
        community_id: c1,
        name: "LOOP Builders",
        bound_asset_key: B,
        verification_status: "pending",
        record_version: 1,
        created_at: date,
      },
      {
        community_id: c2,
        name: "链上研究社",
        bound_asset_key: C,
        verification_status: "verified",
        record_version: 2,
        created_at: date,
      },
      {
        community_id: "10000000-0000-4000-8000-000000000003",
        name: "Web3 读书会",
        bound_asset_key: null,
        verification_status: "pending",
        record_version: 1,
        created_at: date,
      },
    ],
    support: [
      {
        ticket_id: "30000000-0000-4000-8000-000000000001",
        category: "mining",
        body: "社区新系数发布后，为什么当前显示的快照仍是旧版本？",
        status: "open",
        created_at: date,
        updated_at: date,
      },
      {
        ticket_id: "30000000-0000-4000-8000-000000000002",
        category: "community",
        body: "提交社区申请后，希望补充审核资料。",
        status: "answered",
        created_at: date,
        updated_at: date,
      },
    ],
    snapshots: [
      {
        snapshot_id: "40000000-0000-4000-8000-000000000001",
        formula_version: demoPackage.configVersion,
        price_version: "demo-prices-v3",
        status: "complete",
        block_number: "65002180",
        total_power: "12850.75",
        computed_at: date,
      },
      {
        snapshot_id: "40000000-0000-4000-8000-000000000002",
        formula_version: "dev-baseline-v2",
        price_version: "demo-prices-v2",
        status: "incomplete",
        block_number: "65001100",
        total_power: null,
        computed_at: "2026-10-02T08:00:00Z",
      },
    ],
    audit: [
      {
        id: "1",
        operation_id: "50000000-0000-4000-8000-000000000001",
        actor_id: otherActor,
        action: "mining.submit",
        target: "dev-community-v4",
        reason: "提交开发系数调整，等待独立审核",
        outcome: "succeeded",
        created_at: date,
      },
    ],
  };
  const demoCatalog = [
    {
      module: "挖矿",
      name: "公式、权重、版本审批与快照",
      status: "connected",
      consumer: "本地演示数据（未连接 API）",
      entry: "drafts",
    },
    {
      module: "社区",
      name: "申请审核与拒绝理由",
      status: "connected",
      consumer: "本地演示数据（未连接 API）",
      entry: "communities",
    },
    {
      module: "客服",
      name: "回复与关闭工单",
      status: "connected",
      consumer: "本地演示数据（未连接 API）",
      entry: "support",
    },
    ...[
      ["项目", "审核、里程碑、白名单、销售登记", "script"],
      ["资产", "资产与池登记", "script"],
      ["推荐", "社区推荐、活动与公告", "contract_pending"],
      ["AI", "文档导入、撤回与授权", "contract_pending"],
      ["客户端", "最低版本、条款与用户名规则", "deployment"],
      ["交易", "滑点、费用与 gas 预留", "confirmation_required"],
      ["运维", "回填与受限写入策略", "restricted"],
      ["合约", "双矿池、税率与资金执行", "handoff_only"],
    ].map(([module, name, status]) => ({
      module,
      name,
      status,
      consumer: "待对应消费链路验收",
      entry: null,
    })),
  ];
  const demoOperations = new Map(),
    demoJobs = new Map();
  function demoCommand(command) {
    if (demoOperations.has(command.operationId))
      return demoOperations.get(command.operationId);
    const { action, target, payload, reason } = command;
    let result;
    if (action === "mining.create") {
      result = {
        id: target,
        package: clone(payload),
        state: "draft",
        revision: 1,
        contributors: [demoActor],
        content_hash: "c".repeat(64),
        reason,
        updated_at: new Date().toISOString(),
      };
      demoData.drafts.unshift(result);
    } else if (
      ["mining.revise", "mining.submit", "mining.publish"].includes(action)
    ) {
      result = demoData.drafts.find((r) => r.id === target);
      if (!result || result.revision !== payload.expectedRevision)
        throw Object.assign(new Error("conflict"), {
          code: "OPS_VERSION_CONFLICT",
        });
      if (
        action === "mining.publish" &&
        result.contributors.includes(demoActor)
      )
        throw Object.assign(new Error("self"), { code: "OPS_SELF_APPROVAL" });
      result.revision++;
      result.updated_at = new Date().toISOString();
      if (action === "mining.revise") {
        result.package = clone(payload.package);
        result.state = "draft";
        result.reason = reason;
        result.contributors.push(demoActor);
      } else if (action === "mining.submit") result.state = "review";
      else {
        result.state = "published";
        demoData.mining.forEach((r) => {
          if (r.status === "approved") r.status = "retired";
        });
        const p = result.package;
        demoData.mining.unshift({
          config_version: p.configVersion,
          community_weight_history_status: "versioned",
          formula: p.formula,
          weight_range: p.weightRange,
          price_guard_rules: p.priceGuardRules,
          status: "approved",
          created_at: result.updated_at,
        });
        demoData.weights = p.communityWeights.map((w) => ({
          community_id: w.communityId,
          weight: w.weight,
          bound_asset_key: w.boundAssetId,
          approved_asset_id: w.boundAssetId,
          config_version: p.configVersion,
        }));
      }
    } else if (action === "community.review") {
      result = demoData.communities.find((r) => r.community_id === target);
      result.verification_status = payload.outcome;
      result.record_version++;
      result.rejected_reason = payload.outcome === "rejected" ? reason : null;
    } else if (action === "support.answer") {
      result = demoData.support.find((r) => r.ticket_id === target);
      result.status = payload.status;
      result.note = payload.note;
      result.updated_at = new Date().toISOString();
    } else if (action === "mining.invalidate") {
      result = demoData.snapshots.find((r) => r.snapshot_id === target);
      result.status = "invalidated";
      result.invalidation_reason = reason;
    } else {
      const jobId = uuid();
      demoJobs.set(jobId, { id: jobId, action, state: "queued", attempts: 0 });
      result = { jobId, state: "queued" };
    }
    const response = {
      operationId: command.operationId,
      result: clone(result),
    };
    demoOperations.set(command.operationId, response);
    demoData.audit.unshift({
      id: String(demoData.audit.length + 1),
      operation_id: command.operationId,
      actor_id: demoActor,
      action,
      target,
      reason,
      outcome: "succeeded",
      created_at: new Date().toISOString(),
    });
    return response;
  }
  if (preview) {
    session = {
      label: "演示操作员",
      actorId: demoActor,
      environment: "local-preview",
      grants: [
        "audit.read",
        "mining.read",
        "mining.edit",
        "mining.approve",
        "mining.snapshot",
        "community.review",
        "support.manage",
      ].map((permission) => ({ permission, scope: "*" })),
    };
    void enter();
  } else auth();
})();
