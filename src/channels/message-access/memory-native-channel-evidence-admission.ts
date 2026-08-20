/**
 * Opaque proof that a loaded channel adapter authenticated one native group or
 * channel conversation. This is intentionally separate from sender/profile
 * identity admission: group memory is owned by the conversation, never by the
 * latest sender or a Gateway collaboration member.
 */
import { normalizeAccountId } from "../../routing/account-id.js";

const nativeChannelMemoryEvidenceAdmissionBrand: unique symbol = Symbol(
  "openclaw.native-channel-memory-evidence-admission",
);

export type AdmittedNativeChannelMemoryEvidence = Readonly<{
  readonly [nativeChannelMemoryEvidenceAdmissionBrand]: true;
}>;

type NativeChannelEvidenceFacts = Readonly<{
  channel: string;
  accountId: string;
  nativeChannelId: string;
  adapterId: string;
  verificationMethod: string;
  evidenceRevision: string;
}>;

const admissions = new WeakMap<object, NativeChannelEvidenceFacts>();
const admissionsByInboundContext = new WeakMap<object, AdmittedNativeChannelMemoryEvidence>();

export type NativeChannelMemoryEvidenceAdmission = Readonly<{
  /**
   * A loaded adapter calls this only after authenticating its native envelope.
   * Core later compares it with the committed channel/account/conversation
   * row; model context, route keys, and sender fields cannot mint this proof.
   */
  attachVerifiedNativeConversation: (params: {
    context: object;
    channel: string;
    accountId: string;
    nativeChannelId: string;
  }) => void;
}>;

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function admitNativeChannelMemoryEvidence(params: {
  channel: string;
  accountId: string;
  nativeChannelId: string;
  adapterId: string;
  verificationMethod: string;
  evidenceRevision: string;
}): AdmittedNativeChannelMemoryEvidence {
  const proof = Object.freeze(
    Object.defineProperty(Object.create(null), nativeChannelMemoryEvidenceAdmissionBrand, {
      value: true,
      enumerable: false,
    }),
  ) as AdmittedNativeChannelMemoryEvidence;
  admissions.set(
    proof,
    Object.freeze({
      channel: requireText(params.channel, "channel").toLowerCase(),
      accountId: normalizeAccountId(requireText(params.accountId, "accountId")),
      nativeChannelId: requireText(params.nativeChannelId, "nativeChannelId"),
      adapterId: requireText(params.adapterId, "adapterId"),
      verificationMethod: requireText(params.verificationMethod, "verificationMethod"),
      evidenceRevision: requireText(params.evidenceRevision, "evidenceRevision"),
    }),
  );
  return proof;
}

/**
 * Loader-owned capability for native conversation evidence. It has no sender
 * parameter and does not expose a generic "channel member" authority.
 */
export function createNativeChannelMemoryEvidenceAdmission(params: {
  pluginId: string;
  adapterId: string;
  ownsChannel: (channel: string) => boolean;
  isActive: () => boolean;
}): NativeChannelMemoryEvidenceAdmission {
  const pluginId = requireText(params.pluginId, "pluginId");
  const adapterId = requireText(params.adapterId, "adapterId");
  const attachVerifiedNativeConversation = (input: {
    context: object;
    channel: string;
    accountId: string;
    nativeChannelId: string;
  }): void => {
    const channel = requireText(input.channel, "channel").toLowerCase();
    if (!params.isActive() || !params.ownsChannel(channel)) {
      return;
    }
    const proof = admitNativeChannelMemoryEvidence({
      channel,
      accountId: input.accountId,
      nativeChannelId: input.nativeChannelId,
      adapterId,
      verificationMethod: "channel-adapter-post-transport-auth",
      evidenceRevision: `channel:${channel}:plugin:${pluginId}`,
    });
    admissionsByInboundContext.set(input.context, proof);
  };
  return Object.freeze({ attachVerifiedNativeConversation });
}

/** Consume the one-use proof only at the session-subject persistence boundary. */
export function consumeAdmittedNativeChannelMemoryEvidenceFromContext(
  context: object,
): AdmittedNativeChannelMemoryEvidence | undefined {
  const proof = admissionsByInboundContext.get(context);
  admissionsByInboundContext.delete(context);
  return proof;
}

/** Core-only consumer for the shared-state evidence writer. */
export function consumeAdmittedNativeChannelMemoryEvidence(
  admission: unknown,
): NativeChannelEvidenceFacts | undefined {
  if (!admission || typeof admission !== "object") {
    return undefined;
  }
  const facts = admissions.get(admission);
  if (!facts) {
    return undefined;
  }
  admissions.delete(admission);
  return facts;
}
