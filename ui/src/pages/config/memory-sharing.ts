import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

type ProjectionTarget = Readonly<{
  kind: "conversation" | "role" | "agent-shared";
  id: string;
}>;

type SharingStatus = Readonly<{
  postboxMode: "off" | "review-required";
  projections: readonly Readonly<{
    projectionId: string;
    target: ProjectionTarget;
    purpose: string;
    preview: string;
    state: string;
    expiresAt: number | null;
  }>[];
  postboxItems: readonly Readonly<{
    itemId: string;
    state: string;
    sourceChannelRef: string;
    createdAt: number;
  }>[];
}>;

type ProjectionForm = {
  projectionId: string;
  sourceRevisionId: string;
  targetKind: ProjectionTarget["kind"];
  targetId: string;
  targetStoreId: string;
  purpose: string;
  preview: string;
  content: string;
  expiresAt: string;
  noExpiryAuditReason: string;
};

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseTarget(value: unknown): ProjectionTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value.kind;
  const id = asText(value.id);
  return (kind === "conversation" || kind === "role" || kind === "agent-shared") && id
    ? { kind, id }
    : null;
}

function isProjectionTargetKind(value: string): value is ProjectionTarget["kind"] {
  return value === "conversation" || value === "role" || value === "agent-shared";
}

function parseStatus(value: unknown): SharingStatus | null {
  if (
    !isRecord(value) ||
    (value.postboxMode !== "off" && value.postboxMode !== "review-required")
  ) {
    return null;
  }
  const projections = Array.isArray(value.projections)
    ? value.projections.flatMap((entry) => {
        if (!isRecord(entry)) {
          return [];
        }
        const projectionId = asText(entry.projectionId);
        const target = parseTarget(entry.target);
        const purpose = asText(entry.purpose);
        const preview = asText(entry.preview);
        const state = asText(entry.state);
        const expiresAt = entry.expiresAt;
        return projectionId &&
          target &&
          purpose &&
          preview &&
          state &&
          (expiresAt === null || typeof expiresAt === "number")
          ? [{ projectionId, target, purpose, preview, state, expiresAt }]
          : [];
      })
    : [];
  const postboxItems = Array.isArray(value.postboxItems)
    ? value.postboxItems.flatMap((entry) => {
        if (!isRecord(entry)) {
          return [];
        }
        const itemId = asText(entry.itemId);
        const state = asText(entry.state);
        const sourceChannelRef = asText(entry.sourceChannelRef);
        return itemId && state && sourceChannelRef && typeof entry.createdAt === "number"
          ? [{ itemId, state, sourceChannelRef, createdAt: entry.createdAt }]
          : [];
      })
    : [];
  return { postboxMode: value.postboxMode, projections, postboxItems };
}

function emptyProjectionForm(): ProjectionForm {
  return {
    projectionId: "",
    sourceRevisionId: "",
    targetKind: "conversation",
    targetId: "",
    targetStoreId: "",
    purpose: "",
    preview: "",
    content: "",
    expiresAt: "",
    noExpiryAuditReason: "",
  };
}

/** Profile-derived sharing controls. This element never accepts or renders a principal or store id. */
class MemorySharingElement extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) canAdmin = false;
  @property({ type: Boolean }) methodsAvailable = false;
  @property() agentId: string | null = null;

  @state() private status: SharingStatus | null = null;
  @state() private form = emptyProjectionForm();
  @state() private inspectedBodies = new Map<string, string>();
  @state() private impact = new Map<string, readonly string[]>();
  @state() private previewReady = false;
  @state() private busy = false;
  @state() private error: string | null = null;

  private loadGeneration = 0;

  protected override willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has("client") ||
      changed.has("connected") ||
      changed.has("canAdmin") ||
      changed.has("methodsAvailable") ||
      changed.has("agentId")
    ) {
      this.status = null;
      this.inspectedBodies = new Map();
      this.impact = new Map();
      this.previewReady = false;
      if (changed.has("agentId")) {
        this.form = emptyProjectionForm();
      }
      void this.load();
    }
  }

  private canUse(): this is this & { client: GatewayBrowserClient; agentId: string } {
    return Boolean(
      this.connected && this.canAdmin && this.methodsAvailable && this.client && this.agentId,
    );
  }

  private async load() {
    if (!this.canUse()) {
      return;
    }
    const generation = ++this.loadGeneration;
    try {
      const response = await this.client.request("memory.sharing.status", {
        agentId: this.agentId,
      });
      if (!this.canUse() || generation !== this.loadGeneration) {
        return;
      }
      const status = parseStatus(response);
      if (!status) {
        throw new Error("invalid sharing status");
      }
      this.status = status;
    } catch {
      if (generation === this.loadGeneration) {
        this.error = t("memoryPage.sharing.requestFailed");
      }
    }
  }

  private async request(method: string, payload: Record<string, unknown>): Promise<unknown | null> {
    if (!this.canUse() || this.busy) {
      return null;
    }
    this.busy = true;
    this.error = null;
    try {
      return await this.client.request(method, { agentId: this.agentId, ...payload });
    } catch {
      this.error = t("memoryPage.sharing.requestFailed");
      return null;
    } finally {
      this.busy = false;
    }
  }

  private updateForm(key: keyof ProjectionForm, value: string) {
    this.form = { ...this.form, [key]: value };
    this.previewReady = false;
  }

  private projectionPayload(options: {
    content: boolean;
    refresh: boolean;
  }): Record<string, unknown> | null {
    const form = this.form;
    const sourceRevisionId = form.sourceRevisionId.trim();
    const purpose = form.purpose.trim();
    const preview = form.preview.trim();
    const expiry = form.expiresAt.trim();
    const noExpiryAuditReason = form.noExpiryAuditReason.trim();
    if (
      !sourceRevisionId ||
      !purpose ||
      !preview ||
      Boolean(expiry) === Boolean(noExpiryAuditReason) ||
      (options.content && !form.content.trim()) ||
      (options.refresh && !form.projectionId.trim())
    ) {
      this.error = t("memoryPage.sharing.completeRequiredFields");
      return null;
    }
    if (!options.refresh && !form.targetId.trim()) {
      this.error = t("memoryPage.sharing.completeRequiredFields");
      return null;
    }
    if (!isProjectionTargetKind(form.targetKind)) {
      this.error = t("memoryPage.sharing.completeRequiredFields");
      return null;
    }
    if (form.targetKind === "agent-shared" && form.targetId.trim() !== this.agentId) {
      this.error = t("memoryPage.sharing.invalidAgentSharedTarget");
      return null;
    }
    return {
      sourceRevisionId,
      purpose,
      preview,
      ...(options.refresh
        ? { projectionId: form.projectionId.trim() }
        : { targetKind: form.targetKind, targetId: form.targetId.trim() }),
      ...(options.content ? { content: form.content.trim() } : {}),
      ...(expiry ? { expiresAt: expiry } : { noExpiryAuditReason }),
    };
  }

  private async previewProjection() {
    const payload = this.projectionPayload({ content: false, refresh: false });
    if (!payload) {
      return;
    }
    const response = await this.request("memory.sharing.projection.preview", payload);
    if (response !== null) {
      this.previewReady = true;
    }
  }

  private async registerProjectionTarget() {
    const targetId = this.form.targetId.trim();
    const storeId = this.form.targetStoreId.trim();
    if (!targetId || !storeId) {
      this.error = t("memoryPage.sharing.completeRequiredFields");
      return;
    }
    if (!isProjectionTargetKind(this.form.targetKind)) {
      this.error = t("memoryPage.sharing.completeRequiredFields");
      return;
    }
    if (this.form.targetKind === "agent-shared" && targetId !== this.agentId) {
      this.error = t("memoryPage.sharing.invalidAgentSharedTarget");
      return;
    }
    await this.request("memory.sharing.projection.target.register", {
      targetKind: this.form.targetKind,
      targetId,
      storeId,
    });
  }

  private async saveProjection() {
    const refreshing = Boolean(this.form.projectionId.trim());
    if (!this.previewReady && !refreshing) {
      this.error = t("memoryPage.sharing.previewRequired");
      return;
    }
    const payload = this.projectionPayload({ content: true, refresh: refreshing });
    if (!payload) {
      return;
    }
    const response = await this.request(
      refreshing ? "memory.sharing.projection.refresh" : "memory.sharing.projection.create",
      payload,
    );
    if (response !== null) {
      this.form = emptyProjectionForm();
      this.previewReady = false;
      await this.load();
    }
  }

  private async revokeProjection(projectionId: string) {
    const response = await this.request("memory.sharing.projection.revoke", { projectionId });
    if (response !== null) {
      await this.load();
    }
  }

  private prepareRefresh(projection: SharingStatus["projections"][number]) {
    this.form = {
      ...emptyProjectionForm(),
      projectionId: projection.projectionId,
      purpose: projection.purpose,
      preview: projection.preview,
    };
    this.previewReady = false;
  }

  private async loadImpact(projectionId: string) {
    const response = await this.request("memory.sharing.projection.impact", { projectionId });
    if (!isRecord(response) || !Array.isArray(response.exposureSetIds)) {
      return;
    }
    const exposureSetIds = response.exposureSetIds.filter(
      (entry): entry is string => typeof entry === "string",
    );
    this.impact = new Map(this.impact).set(projectionId, exposureSetIds);
  }

  private async setPostboxMode(mode: "off" | "review-required") {
    const response = await this.request("memory.sharing.postbox.mode.set", { mode });
    if (response !== null) {
      await this.load();
    }
  }

  private async inspectPostbox(itemId: string) {
    const response = await this.request("memory.sharing.postbox.inspect", { itemId });
    if (!isRecord(response) || typeof response.content !== "string") {
      return;
    }
    this.inspectedBodies = new Map(this.inspectedBodies).set(itemId, response.content);
  }

  private async reviewPostbox(itemId: string, decision: "approve" | "reject") {
    const reviewedContent = this.inspectedBodies.get(itemId)?.trim();
    const response = await this.request("memory.sharing.postbox.review", {
      itemId,
      decision,
      ...(decision === "approve" && reviewedContent ? { reviewedContent } : {}),
    });
    if (response !== null) {
      this.inspectedBodies = new Map(this.inspectedBodies);
      this.inspectedBodies.delete(itemId);
      await this.load();
    }
  }

  private async purgePostbox(itemId: string) {
    const response = await this.request("memory.sharing.postbox.purge", { itemId });
    if (response !== null) {
      this.inspectedBodies = new Map(this.inspectedBodies);
      this.inspectedBodies.delete(itemId);
      await this.load();
    }
  }

  private renderProjectionForm() {
    const form = this.form;
    const refresh = Boolean(form.projectionId);
    return renderSettingsSection(
      {
        title: t("memoryPage.sharing.projection.title"),
        description: t("memoryPage.sharing.projection.description"),
      },
      html`
        <div class="settings-form-grid">
          <label
            >${t("memoryPage.sharing.projection.id")}<input
              .value=${form.projectionId}
              @input=${(event: Event) =>
                this.updateForm("projectionId", (event.target as HTMLInputElement).value)}
          /></label>
          <label
            >${t("memoryPage.sharing.projection.sourceRevision")}<input
              .value=${form.sourceRevisionId}
              @input=${(event: Event) =>
                this.updateForm("sourceRevisionId", (event.target as HTMLInputElement).value)}
          /></label>
          ${refresh
            ? nothing
            : html`
                <label
                  >${t("memoryPage.sharing.projection.targetKind")}
                  <select
                    .value=${form.targetKind}
                    @change=${(event: Event) =>
                      this.updateForm("targetKind", (event.target as HTMLSelectElement).value)}
                  >
                    <option value="conversation">
                      ${t("memoryPage.sharing.targets.conversation")}
                    </option>
                    <option value="role">${t("memoryPage.sharing.targets.role")}</option>
                    <option value="agent-shared">
                      ${t("memoryPage.sharing.targets.agentShared")}
                    </option>
                  </select>
                </label>
                <label
                  >${t("memoryPage.sharing.projection.targetId")}<input
                    .value=${form.targetId}
                    @input=${(event: Event) =>
                      this.updateForm("targetId", (event.target as HTMLInputElement).value)}
                /></label>
                <label
                  >${t("memoryPage.sharing.projection.targetStoreId")}<input
                    .value=${form.targetStoreId}
                    @input=${(event: Event) =>
                      this.updateForm("targetStoreId", (event.target as HTMLInputElement).value)}
                /></label>
              `}
          <label
            >${t("memoryPage.sharing.projection.purpose")}<input
              .value=${form.purpose}
              @input=${(event: Event) =>
                this.updateForm("purpose", (event.target as HTMLInputElement).value)}
          /></label>
          <label
            >${t("memoryPage.sharing.projection.preview")}<input
              .value=${form.preview}
              @input=${(event: Event) =>
                this.updateForm("preview", (event.target as HTMLInputElement).value)}
          /></label>
          <label
            >${t("memoryPage.sharing.projection.expiry")}<input
              type="datetime-local"
              .value=${form.expiresAt}
              @input=${(event: Event) =>
                this.updateForm("expiresAt", (event.target as HTMLInputElement).value)}
          /></label>
          <label
            >${t("memoryPage.sharing.projection.noExpiryReason")}<input
              .value=${form.noExpiryAuditReason}
              @input=${(event: Event) =>
                this.updateForm("noExpiryAuditReason", (event.target as HTMLInputElement).value)}
          /></label>
        </div>
        <label
          >${t("memoryPage.sharing.projection.content")}<textarea
            .value=${form.content}
            @input=${(event: Event) =>
              this.updateForm("content", (event.target as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        <p>
          ${refresh
            ? nothing
            : html`<button
                  class="btn btn--sm"
                  ?disabled=${this.busy}
                  @click=${() => void this.registerProjectionTarget()}
                >
                  ${t("memoryPage.sharing.projection.registerTarget")}
                </button>
                <button
                  class="btn btn--sm"
                  ?disabled=${this.busy}
                  @click=${() => void this.previewProjection()}
                >
                  ${t("memoryPage.sharing.projection.previewAction")}
                </button>`}
          <button
            class="btn btn--sm"
            ?disabled=${this.busy}
            @click=${() => void this.saveProjection()}
          >
            ${refresh
              ? t("memoryPage.sharing.projection.refresh")
              : t("memoryPage.sharing.projection.create")}
          </button>
        </p>
      `,
    );
  }

  override render() {
    if (!this.canUse()) {
      return nothing;
    }
    const status = this.status;
    return html`
      <section class="settings-page" aria-label=${t("memoryPage.sharing.title")}>
        <h2>${t("memoryPage.sharing.title")}</h2>
        <p class="settings-page__intro">${t("memoryPage.sharing.intro")}</p>
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        ${renderSettingsSection(
          { title: t("memoryPage.sharing.statusTitle") },
          html`
            ${renderSettingsRow({
              title: t("memoryPage.sharing.postboxMode"),
              control: html`<select
                .value=${status?.postboxMode ?? "off"}
                ?disabled=${this.busy}
                @change=${(event: Event) =>
                  void this.setPostboxMode(
                    (event.target as HTMLSelectElement).value as "off" | "review-required",
                  )}
              >
                <option value="off">${t("memoryPage.sharing.postboxOff")}</option>
                <option value="review-required">
                  ${t("memoryPage.sharing.postboxReviewRequired")}
                </option>
              </select>`,
            })}
            ${renderSettingsRow({
              title: t("memoryPage.sharing.projectionCount"),
              control: renderSettingsValue(String(status?.projections.length ?? 0)),
            })}
            ${renderSettingsRow({
              title: t("memoryPage.sharing.postboxCount"),
              control: renderSettingsValue(String(status?.postboxItems.length ?? 0)),
            })}
          `,
        )}
        ${this.renderProjectionForm()}
        ${renderSettingsSection(
          { title: t("memoryPage.sharing.projections") },
          status?.projections.length
            ? status.projections.map(
                (projection) => html`
                  ${renderSettingsRow({
                    title: projection.purpose,
                    description: `${projection.target.kind}: ${projection.target.id} · ${projection.preview}`,
                    control: renderSettingsValue(projection.state),
                  })}
                  <p>
                    <button
                      class="btn btn--sm"
                      ?disabled=${this.busy || projection.state !== "active"}
                      @click=${() => this.prepareRefresh(projection)}
                    >
                      ${t("memoryPage.sharing.projection.refresh")}
                    </button>
                    <button
                      class="btn btn--sm"
                      ?disabled=${this.busy}
                      @click=${() => this.loadImpact(projection.projectionId)}
                    >
                      ${t("memoryPage.sharing.impact")}
                    </button>
                    <button
                      class="btn btn--sm btn--danger"
                      ?disabled=${this.busy || projection.state !== "active"}
                      @click=${() => void this.revokeProjection(projection.projectionId)}
                    >
                      ${t("memoryPage.sharing.revoke")}
                    </button>
                  </p>
                  ${(this.impact.get(projection.projectionId) ?? []).length
                    ? html`<p>
                        ${t("memoryPage.sharing.priorExposure", {
                          count: String(this.impact.get(projection.projectionId)?.length ?? 0),
                        })}
                      </p>`
                    : nothing}
                `,
              )
            : renderSettingsRow({ title: t("memoryPage.sharing.emptyProjections") }),
        )}
        ${renderSettingsSection(
          { title: t("memoryPage.sharing.postbox") },
          status?.postboxItems.length
            ? status.postboxItems.map(
                (item) => html`
                  ${renderSettingsRow({
                    title: item.sourceChannelRef,
                    description: item.state,
                    control: renderSettingsValue(item.itemId, { mono: true }),
                  })}
                  ${this.inspectedBodies.has(item.itemId)
                    ? html`<textarea
                        .value=${this.inspectedBodies.get(item.itemId) ?? ""}
                        @input=${(event: Event) => {
                          this.inspectedBodies = new Map(this.inspectedBodies).set(
                            item.itemId,
                            (event.target as HTMLTextAreaElement).value,
                          );
                        }}
                      ></textarea>`
                    : nothing}
                  <p>
                    <button
                      class="btn btn--sm"
                      ?disabled=${this.busy || item.state !== "postbox"}
                      @click=${() => void this.inspectPostbox(item.itemId)}
                    >
                      ${t("memoryPage.sharing.inspect")}
                    </button>
                    <button
                      class="btn btn--sm"
                      ?disabled=${this.busy || item.state !== "postbox"}
                      @click=${() => void this.reviewPostbox(item.itemId, "approve")}
                    >
                      ${t("memoryPage.sharing.approve")}
                    </button>
                    <button
                      class="btn btn--sm"
                      ?disabled=${this.busy || item.state !== "postbox"}
                      @click=${() => void this.reviewPostbox(item.itemId, "reject")}
                    >
                      ${t("memoryPage.sharing.reject")}
                    </button>
                    <button
                      class="btn btn--sm btn--danger"
                      ?disabled=${this.busy}
                      @click=${() => void this.purgePostbox(item.itemId)}
                    >
                      ${t("memoryPage.sharing.purge")}
                    </button>
                  </p>
                `,
              )
            : renderSettingsRow({ title: t("memoryPage.sharing.emptyPostbox") }),
        )}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-memory-sharing")) {
  customElements.define("openclaw-memory-sharing", MemorySharingElement);
}
